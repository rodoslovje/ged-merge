import type { Dataset } from "../gedcom/types";
import type { MatchCandidate, MatchResult } from "./types";

/**
 * Relationship distance (in graph hops) from the start person to every reachable
 * main individual, via parent/child/spouse edges. Unreachable people are
 * simply absent from the map.
 */
export function computeDistances(ds: Dataset, startId: string): Map<string, number> {
  const dist = new Map<string, number>();
  if (!ds.individuals.has(startId)) return dist;

  dist.set(startId, 0);
  const queue = [startId];
  // Parents, spouses and children are one hop each (siblings emerge at 2).
  // The neighbour walk is inlined: a generator per person cost ~10 µs a node,
  // which on a half-million-person file was seconds per start-person change.
  const visit = (next: string | undefined, d: number) => {
    if (next !== undefined && !dist.has(next)) {
      dist.set(next, d);
      queue.push(next);
    }
  };
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const d = dist.get(id)! + 1;
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    for (const famId of indi.childOf) {
      const fam = ds.families.get(famId);
      if (!fam) continue;
      visit(fam.husband, d);
      visit(fam.wife, d);
    }
    for (const famId of indi.spouseOf) {
      const fam = ds.families.get(famId);
      if (!fam) continue;
      visit(fam.husband === id ? fam.wife : fam.husband, d);
      for (const child of fam.children) visit(child, d);
    }
  }
  return dist;
}

/**
 * A ranking of a match list by kinship to the start person, as two arrays
 * aligned with the list it was computed for: `distance[k]` is candidate `k`'s
 * main-side hop count (-1 when unreachable), and `order` lists the candidate
 * positions by distance ascending, then score descending. This is what the
 * worker sends when the start person changes — a few bytes per candidate
 * instead of the whole list again.
 */
export interface KinshipRanking {
  order: Int32Array;
  distance: Int32Array;
}

export function kinshipRanking(
  individuals: readonly MatchCandidate[],
  mainDs: Dataset,
  startId: string,
): KinshipRanking {
  const distances = computeDistances(mainDs, startId);
  const distance = new Int32Array(individuals.length);
  individuals.forEach((c, k) => {
    distance[k] = distances.get(c.mainId) ?? -1;
  });
  // Sorted as a plain array over flat keys: a typed array's comparator sort
  // and per-comparison object reads were the bulk of the time at 500k rows.
  const rank = new Float64Array(individuals.length);
  const score = new Float64Array(individuals.length);
  const keys = new Array<number>(individuals.length);
  individuals.forEach((c, k) => {
    rank[k] = distance[k] < 0 ? Infinity : distance[k];
    score[k] = c.score;
    keys[k] = k;
  });
  keys.sort((a, b) => rank[a] - rank[b] || score[b] - score[a] || a - b);
  return { order: Int32Array.from(keys), distance };
}

/**
 * The list in ranking order, each reachable candidate carrying its distance.
 * Only those are copied; the rest are the list's own objects.
 */
export function rankedCandidates<C extends MatchCandidate>(individuals: readonly C[], ranking: KinshipRanking): C[] {
  const out = new Array<C>(ranking.order.length);
  ranking.order.forEach((k, i) => {
    const c = individuals[k];
    const d = ranking.distance[k];
    out[i] = d < 0 ? c : { ...c, distance: d };
  });
  return out;
}

/**
 * Annotate candidates with their main-side distance to the start person and
 * re-sort by (distance ascending, then score descending), so the matches most
 * relevant to the user surface first.
 */
export function applyDistanceRanking(
  result: MatchResult,
  mainDs: Dataset,
  startId: string,
): MatchResult {
  return { individuals: rankedCandidates(result.individuals, kinshipRanking(result.individuals, mainDs, startId)) };
}


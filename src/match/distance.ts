import type { Dataset } from "../gedcom/types";
import type { MatchResult } from "./types";

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
 * Annotate candidates with their main-side distance to the start person and
 * re-sort by (distance ascending, then score descending), so the matches most
 * relevant to the user surface first.
 */
export function applyDistanceRanking(
  result: MatchResult,
  mainDs: Dataset,
  startId: string,
): MatchResult {
  const distances = computeDistances(mainDs, startId);

  const individuals = result.individuals
    .map((c) => withDistance(c, distances.get(c.mainId)))
    .sort(byDistanceThenScore);

  return { individuals };
}

function withDistance<T extends { distance?: number }>(c: T, distance: number | undefined): T {
  return distance === undefined ? c : { ...c, distance };
}

/** Drop distance annotations and fall back to score-descending order (used when
 * the start person is cleared). */
export function clearDistanceRanking(result: MatchResult): MatchResult {
  const strip = <T extends { distance?: number; score: number }>(c: T): T => {
    const { distance, ...rest } = c;
    return rest as T;
  };
  const byScore = (a: { score: number }, b: { score: number }) => b.score - a.score;
  return {
    individuals: result.individuals.map(strip).sort(byScore),
  };
}

function byDistanceThenScore(
  a: { distance?: number; score: number },
  b: { distance?: number; score: number },
): number {
  const da = a.distance ?? Infinity;
  const db = b.distance ?? Infinity;
  return da - db || b.score - a.score;
}

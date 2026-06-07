import type { Dataset } from "../gedcom/types";
import type { MatchResult } from "./types";

/**
 * Relationship distance (in graph hops) from the home person to every reachable
 * master individual, via parent/child/spouse edges. Unreachable people are
 * simply absent from the map.
 */
export function computeDistances(ds: Dataset, homeId: string): Map<string, number> {
  const dist = new Map<string, number>();
  if (!ds.individuals.has(homeId)) return dist;

  dist.set(homeId, 0);
  const queue = [homeId];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const d = dist.get(id)!;
    for (const next of neighbors(id, ds)) {
      if (!dist.has(next)) {
        dist.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

/** Parents, spouses, and children — one hop each. (Siblings emerge at 2.) */
function* neighbors(id: string, ds: Dataset): Generator<string> {
  const indi = ds.individuals.get(id);
  if (!indi) return;

  for (const famId of indi.childOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    if (fam.husband) yield fam.husband;
    if (fam.wife) yield fam.wife;
  }
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const spouse = fam.husband === id ? fam.wife : fam.husband;
    if (spouse) yield spouse;
    for (const child of fam.children) yield child;
  }
}

/**
 * Annotate candidates with their master-side distance to the home person and
 * re-sort by (distance ascending, then score descending), so the matches most
 * relevant to the user surface first.
 */
export function applyDistanceRanking(
  result: MatchResult,
  masterDs: Dataset,
  homeId: string,
): MatchResult {
  const distances = computeDistances(masterDs, homeId);

  const individuals = result.individuals
    .map((c) => withDistance(c, distances.get(c.masterId)))
    .sort(byDistanceThenScore);

  return { individuals };
}

function withDistance<T extends { distance?: number }>(c: T, distance: number | undefined): T {
  return distance === undefined ? c : { ...c, distance };
}

/** Drop distance annotations and fall back to score-descending order (used when
 * the home person is cleared). */
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

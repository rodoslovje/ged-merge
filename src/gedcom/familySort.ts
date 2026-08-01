// Chronological ordering of a person's unions. Spouse-family lists (FAMS) come
// in file order, which often reflects entry order rather than life order — the
// display surfaces sort them by marriage date instead, estimating undated
// marriages from the children's births.

import type { Dataset, Family } from "./types";
import { dateToSortKey } from "./date";
import { birthSortKey } from "./lifespan";

/**
 * A comparable key placing a union in time: the MARR date when recorded, else
 * the earliest child's birth as a proxy (a marriage roughly precedes its first
 * child). `Infinity` when neither is dated, so such unions sort last.
 */
export function marriageSortKey(fam: Family, ds: Dataset): number {
  const marr = fam.events.find((e) => e.tag === "MARR");
  if (marr?.date?.year != null) return dateToSortKey(marr.date);
  let min = Infinity;
  for (const cid of fam.children) {
    const k = birthSortKey(ds.individuals.get(cid));
    if (k < min) min = k;
  }
  return min;
}

/**
 * Resolve spouse-family ids to their records ordered by {@link marriageSortKey},
 * dropping dangling refs. The sort is stable, so wholly undatable unions keep
 * their file order at the end.
 */
export function familiesByMarriage(ds: Dataset, ids: string[]): Family[] {
  const fams = ids.map((id) => ds.families.get(id)).filter((f): f is Family => f !== undefined);
  if (fams.length < 2) return fams;
  return fams
    .map((fam) => ({ fam, key: marriageSortKey(fam, ds) }))
    .sort((a, b) => (a.key === b.key ? 0 : a.key - b.key))
    .map((x) => x.fam);
}

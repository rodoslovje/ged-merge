import type { IndividualCandidate } from "../match/types";

export type Candidate = IndividualCandidate;

/** One decimal, except a perfect 100 which reads better (and aligns) as "100". */
export function formatScore(score: number): string {
  return score >= 100 ? "100" : score.toFixed(1);
}

export type SortKey = "score" | "distance" | "newCount" | "diffCount" | "linkCount" | "label";

export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

export const DEFAULT_DIR: Record<SortKey, "asc" | "desc"> = {
  score: "desc",
  distance: "asc",
  newCount: "desc",
  diffCount: "desc",
  linkCount: "desc",
  label: "asc",
};

/** Primary, then secondary sort. New clicks push the old primary to secondary. */
export const DEFAULT_SORT: SortState[] = [
  { key: "score", dir: "desc" },
  { key: "distance", dir: "asc" },
];

/**
 * Apply a column click to the current two-level sort: re-clicking the primary
 * key flips its direction; clicking any other column makes it the new primary
 * and demotes the previous primary to secondary.
 */
export function nextSort(sorts: SortState[], key: SortKey): SortState[] {
  const primary = sorts[0];
  if (primary?.key === key) {
    return [{ key, dir: primary.dir === "asc" ? "desc" : "asc" }, ...sorts.slice(1)];
  }
  const newPrimary: SortState = { key, dir: DEFAULT_DIR[key] };
  return primary ? [newPrimary, primary] : [newPrimary];
}

/** Active filters for the matches list. */
export interface Filters {
  /** Keep only matches that add new data (newCount > 0). */
  onlyNew: boolean;
  /** Keep only matches with conflicting fields (diffCount > 0). */
  onlyDiff: boolean;
  /** Keep only matches that add or change attached links (linkCount > 0). */
  onlyLinks: boolean;
  /** Keep only matches scoring at least this much (0..100). */
  minScore: number;
}

export const NO_FILTERS: Filters = {
  onlyNew: false,
  onlyDiff: false,
  onlyLinks: false,
  minScore: 0,
};

/** Initial filters: hide weak matches by defaulting the score gate to "strong". */
export const DEFAULT_FILTERS: Filters = {
  onlyNew: false,
  onlyDiff: false,
  onlyLinks: false,
  minScore: 80,
};

export function applyFilters<T extends Candidate>(list: T[], f: Filters): T[] {
  if (!f.onlyNew && !f.onlyDiff && !f.onlyLinks && f.minScore <= 0) return list;
  return list.filter(
    (c) =>
      (!f.onlyNew || (c.newCount ?? 0) > 0) &&
      (!f.onlyDiff || (c.diffCount ?? 0) > 0) &&
      (!f.onlyLinks || (c.linkCount ?? 0) > 0) &&
      c.score >= f.minScore,
  );
}

/** Sort a copy of the list by each key in turn; empty list keeps worker order. */
export function applySort<T extends Candidate>(list: T[], sorts: SortState[]): T[] {
  if (sorts.length === 0) return list;
  return [...list].sort((a, b) => {
    for (const s of sorts) {
      const mul = s.dir === "asc" ? 1 : -1;
      const c = mul * compareBy(a, b, s.key);
      if (c !== 0) return c;
    }
    return 0;
  });
}

function compareBy(a: Candidate, b: Candidate, key: SortKey): number {
  switch (key) {
    case "score":
      return a.score - b.score;
    case "distance":
      return (a.distance ?? Infinity) - (b.distance ?? Infinity);
    case "newCount":
      return (a.newCount ?? 0) - (b.newCount ?? 0);
    case "diffCount":
      return (a.diffCount ?? 0) - (b.diffCount ?? 0);
    case "linkCount":
      return (a.linkCount ?? 0) - (b.linkCount ?? 0);
    case "label":
      // Sort by the displayed person name (what the row shows), not the
      // master-centric diff title.
      return a.name.localeCompare(b.name);
  }
}

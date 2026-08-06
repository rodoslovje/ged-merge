import type { IndividualCandidate } from "../match/types";
import type { Dataset } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import { lifespanTooltipOf, lifespanWithAge } from "../gedcom/age";
import { datesTooltip, formatLifespan } from "../gedcom/lifespan";
import { decisionKey, type CandidateDecision, type MatchDecisionStatus } from "../review/types";
import { foldSearch, matchesTerms, queryTerms } from "./globalSearch";

export type Candidate = IndividualCandidate;

/**
 * A candidate's lifespan label and full-date hover tooltip, with the age
 * appended when `showAge` — the same treatment person cards get in Edit mode.
 * Resolves the live main record so the age reflects any edits; falls back to the
 * candidate's own year/date snapshot when the record can't be looked up.
 */
export function candidateLifespan(
  c: Candidate,
  mainDataset: Dataset | undefined,
  showAge: boolean,
  t: Translate,
): { span: string; title: string } {
  const indi = mainDataset?.individuals.get(c.mainId);
  if (indi) return { span: lifespanWithAge(indi, showAge), title: lifespanTooltipOf(indi, showAge, t) };
  return {
    span: formatLifespan(c.birthYear, c.deathYear, c.deceased),
    title: datesTooltip(c.birthDate, c.deathDate, c.deceased),
  };
}

/** Decision-status sort order (lower sorts first); undecided leads the list. */
export const STATUS_RANK: Record<MatchDecisionStatus, number> = {
  undecided: 0,
  confirmed: 1,
  deferred: 2,
  rejected: 3,
};

/** One decimal, except a perfect 100 which reads better (and aligns) as "100". */
export function formatScore(score: number): string {
  return score >= 100 ? "100" : score.toFixed(1);
}

export type SortKey =
  | "score"
  | "distance"
  | "newCount"
  | "diffCount"
  | "linkCount"
  | "importCount"
  | "label"
  | "status";

/** Total incoming-only relatives a match would bring in (ancestors + descendants). */
export function importTotal(c: Candidate): number {
  return (c.ancestorCount ?? 0) + (c.descendantCount ?? 0);
}

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
  importCount: "desc",
  label: "asc",
  status: "asc",
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
  /** Free-text name/surname search (case-insensitive substring). */
  nameQuery: string;
  /** Keep only matches that add new data (newCount > 0). */
  onlyNew: boolean;
  /** Keep only matches with conflicting fields (diffCount > 0). */
  onlyDiff: boolean;
  /** Keep only matches that add or change attached links (linkCount > 0). */
  onlyLinks: boolean;
  /** Keep only matches that bring in new people (importTotal > 0). */
  onlyImports: boolean;
  /** Keep only matches scoring at least this much (0..100). */
  minScore: number;
}

export const NO_FILTERS: Filters = {
  nameQuery: "",
  onlyNew: false,
  onlyDiff: false,
  onlyLinks: false,
  onlyImports: false,
  minScore: 0,
};

/** Initial filters: hide weak matches by defaulting the score gate to "strong". */
export const DEFAULT_FILTERS: Filters = {
  nameQuery: "",
  onlyNew: false,
  onlyDiff: false,
  onlyLinks: false,
  onlyImports: false,
  minScore: 80,
};

export function applyFilters<T extends Candidate>(list: T[], f: Filters): T[] {
  // Name terms match independently and accent-blind, like every other person
  // search: "sebas kala" finds "Sebastjan Kalan", "ziva" finds "Živa".
  const terms = queryTerms(f.nameQuery);
  if (!terms.length && !f.onlyNew && !f.onlyDiff && !f.onlyLinks && !f.onlyImports && f.minScore <= 0)
    return list;
  return list.filter(
    (c) =>
      matchesTerms(foldSearch(c.name), terms) &&
      (!f.onlyNew || (c.newCount ?? 0) > 0) &&
      (!f.onlyDiff || (c.diffCount ?? 0) > 0) &&
      (!f.onlyLinks || (c.linkCount ?? 0) > 0) &&
      (!f.onlyImports || importTotal(c) > 0) &&
      c.score >= f.minScore,
  );
}

/**
 * The match list's display filter: hides rejected matches (always — there's
 * no setting for it, they'd just clutter the list) on top of the user's active
 * `Filters`. Rejected candidates stay in the ranked list passed in, so undoing
 * a rejection (or clearing the flag from Edit mode) brings them straight back.
 */
export function visibleCandidates<T extends Candidate>(
  list: T[],
  filters: Filters,
  decisions: Map<string, CandidateDecision>,
): T[] {
  const notRejected = list.filter(
    (c) => decisions.get(decisionKey("individual", c.mainId, c.compareId))?.status !== "rejected",
  );
  return applyFilters(notRejected, filters);
}

/**
 * Sort a copy of the list by each key in turn; empty list keeps worker order.
 * `statusRank` maps a candidate to its decision-status order (lower first); it
 * is only consulted by the "status" key, so callers without decisions can omit it.
 */
export function applySort<T extends Candidate>(
  list: T[],
  sorts: SortState[],
  statusRank?: (c: Candidate) => number,
): T[] {
  if (sorts.length === 0) return list;
  return [...list].sort((a, b) => {
    for (const s of sorts) {
      const mul = s.dir === "asc" ? 1 : -1;
      const c = mul * compareBy(a, b, s.key, statusRank);
      if (c !== 0) return c;
    }
    return 0;
  });
}

function compareBy(
  a: Candidate,
  b: Candidate,
  key: SortKey,
  statusRank?: (c: Candidate) => number,
): number {
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
    case "importCount":
      return importTotal(a) - importTotal(b);
    case "label":
      // Sort by the displayed person name (what the row shows), not the
      // main-centric diff title.
      return a.name.localeCompare(b.name);
    case "status":
      // Groups rows by decision; undecided rows sort together via rank 0.
      return (statusRank?.(a) ?? 0) - (statusRank?.(b) ?? 0);
  }
}

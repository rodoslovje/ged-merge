import type { Individual, Sex } from "../gedcom/types";
import { lifespanOf, birthYear } from "../gedcom/lifespan";
import { nameSearchText } from "../match/relatives";
import type { MatchDecisionStatus } from "../review/types";

/**
 * One searchable projection of an individual, precomputed once per dataset so a
 * whole-file search doesn't re-derive name/place text on every keystroke.
 * `searchText` is already lower-cased and covers every name form (married, aka,
 * maiden, nickname…) plus the lifespan, mirroring the person picker's behaviour
 * so a person is found however they're written. The remaining fields back the
 * attribute facets (sex, birth year, place, attachments).
 */
export interface SearchRow {
  id: string;
  /** Display name honouring the user's name-display settings. */
  name: string;
  /** Lifespan suffix (e.g. "1841–1902"), or "" when no dates are known. */
  span: string;
  /** Lower-cased haystack: all name forms + lifespan. */
  searchText: string;
  sex: Sex;
  birthYear?: number;
  /** Lower-cased text of every event place/address, for the place facet. */
  placeText: string;
  hasLinks: boolean;
  hasNotes: boolean;
  hasSources: boolean;
}

/** Cap on rendered results — a whole-file query can match thousands. */
export const MAX_RESULTS = 50;

/** True when the individual carries a URL on the record or any of its events. */
function anyLinks(indi: Individual): boolean {
  return (indi.links?.length ?? 0) > 0 || indi.events.some((e) => (e.links?.length ?? 0) > 0);
}
function anyNotes(indi: Individual): boolean {
  return (indi.notes?.length ?? 0) > 0 || indi.events.some((e) => !!e.note);
}
function anySources(indi: Individual): boolean {
  return (indi.sources?.length ?? 0) > 0 || indi.events.some((e) => (e.sources?.length ?? 0) > 0);
}
function placeText(indi: Individual): string {
  const parts: string[] = [];
  for (const e of indi.events) {
    if (e.place?.raw) parts.push(e.place.raw);
    if (e.address?.raw) parts.push(e.address.raw);
  }
  return parts.join(" ").toLowerCase();
}

/**
 * Build the search index for a dataset. `nameOf` is the caller's name-display
 * formatter (from `useNameOf`) so results read the same as everywhere else; the
 * rows are re-sorted by display name for a stable, scannable list.
 */
export function buildSearchRows(
  individuals: Map<string, Individual>,
  nameOf: (indi: Individual) => string,
): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const indi of individuals.values()) {
    const span = lifespanOf(indi);
    const name = nameOf(indi);
    const searchText = span ? `${nameSearchText(indi)} ${span}`.toLowerCase() : nameSearchText(indi);
    rows.push({
      id: indi.id,
      name,
      span,
      searchText,
      sex: indi.sex,
      birthYear: birthYear(indi),
      placeText: placeText(indi),
      hasLinks: anyLinks(indi),
      hasNotes: anyNotes(indi),
      hasSources: anySources(indi),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

/** Active attribute facets layered on top of the free-text query. */
export interface GlobalFilters {
  /** Restrict to a sex, or undefined for any. */
  sex?: Sex;
  /** Inclusive birth-year bounds (undefined = open-ended). */
  bornFrom?: number;
  bornTo?: number;
  /** Case-insensitive substring over event places. */
  place: string;
  hasLinks: boolean;
  hasNotes: boolean;
  hasSources: boolean;
  /** Keep only people with unsaved edits. */
  edited: boolean;
  /** Keep only people whose match carries this decision, or undefined for any. */
  decision?: MatchDecisionStatus;
  /** Keep only people within this many relationship hops of the start person
   *  (undefined = any). Unreachable people are excluded when this is set. */
  maxKinship?: number;
}

export const NO_FILTERS: GlobalFilters = {
  place: "",
  hasLinks: false,
  hasNotes: false,
  hasSources: false,
  edited: false,
};

/** The cross-cutting state a filter needs but that isn't baked into a row
 *  (it changes without the dataset changing): edit and merge-decision status. */
export interface FilterContext {
  isEdited: (id: string) => boolean;
  decisionOf: (id: string) => MatchDecisionStatus | undefined;
  /** Relationship hops from the start person, or undefined when unreachable / no start. */
  kinshipHops: (id: string) => number | undefined;
}

/** True when at least one facet is narrowing the result set. */
export function hasActiveFilters(f: GlobalFilters): boolean {
  return (
    f.sex !== undefined ||
    f.bornFrom !== undefined ||
    f.bornTo !== undefined ||
    f.place.trim() !== "" ||
    f.hasLinks ||
    f.hasNotes ||
    f.hasSources ||
    f.edited ||
    f.decision !== undefined ||
    f.maxKinship !== undefined
  );
}

function matchesQuery(row: SearchRow, terms: string[]): boolean {
  return terms.every((term) => row.searchText.includes(term));
}

function matchesFilters(row: SearchRow, f: GlobalFilters, ctx: FilterContext): boolean {
  if (f.sex !== undefined && row.sex !== f.sex) return false;
  if (f.bornFrom !== undefined && (row.birthYear === undefined || row.birthYear < f.bornFrom)) return false;
  if (f.bornTo !== undefined && (row.birthYear === undefined || row.birthYear > f.bornTo)) return false;
  const place = f.place.trim().toLowerCase();
  if (place && !row.placeText.includes(place)) return false;
  if (f.hasLinks && !row.hasLinks) return false;
  if (f.hasNotes && !row.hasNotes) return false;
  if (f.hasSources && !row.hasSources) return false;
  if (f.edited && !ctx.isEdited(row.id)) return false;
  if (f.decision !== undefined && ctx.decisionOf(row.id) !== f.decision) return false;
  if (f.maxKinship !== undefined) {
    const hops = ctx.kinshipHops(row.id);
    if (hops === undefined || hops > f.maxKinship) return false;
  }
  return true;
}

/**
 * Filter rows by the free-text query and the active attribute facets, capped at
 * {@link MAX_RESULTS}. Every whitespace-separated query term must appear in the
 * row's search text (any order) — so "kov marija" finds "Marija Kovačič". Facets
 * then narrow by sex, birth-year range, place, attachments, edit and decision
 * status. An empty query with no facets returns the (name-sorted) list.
 */
export function searchPeople(
  rows: SearchRow[],
  query: string,
  filters: GlobalFilters,
  ctx: FilterContext,
): SearchRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const active = hasActiveFilters(filters);
  const out: SearchRow[] = [];
  for (const row of rows) {
    if (terms.length && !matchesQuery(row, terms)) continue;
    if (active && !matchesFilters(row, filters, ctx)) continue;
    out.push(row);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

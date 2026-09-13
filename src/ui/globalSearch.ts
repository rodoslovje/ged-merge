import type { GedNode, Individual, Sex } from "../gedcom/types";
import type { CropRegion } from "../gedcom/source";
import { lifespanOf, birthYear, birthSortKey, deathYear } from "../gedcom/lifespan";
import { nameSearchText } from "../match/relatives";
import type { MatchDecisionStatus } from "../review/types";
import { collectFirstImage } from "./PersonMedia";

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
  /** Sort keys behind the display name: full birth date, then death year, both
   *  `Infinity` when unknown so undated people sort last within a name. */
  birthKey: number;
  deathKey: number;
  /** Lower-cased text of every event place/address, for the place facet. */
  placeText: string;
  /** Lower-cased text of every note the person carries, record-level and on
   *  their events, for the note filter. Read from the verbatim note text rather
   *  than the display copy: the display one has its URLs stripped out, which
   *  would hide exactly the notes that are nothing *but* a URL. */
  noteText: string;
  hasLinks: boolean;
  hasNotes: boolean;
  hasSources: boolean;
  /** The person's profile photo (first local image, with its crop region when
   *  marked), shown as a row thumbnail once a media folder is loaded. */
  photo?: { file: string; crop?: CropRegion };
}

/** Cap on rendered results — a whole-file query can match thousands. */
export const MAX_RESULTS = 50;

/**
 * Lower-case and strip diacritics so a query typed without the accents still
 * finds accented names — "Ziva" matches "Živa", "Skofja" matches "Škofja".
 * Applied to both the indexed haystack and the query so the comparison is
 * accent-blind on both sides. (NFD splits a letter from its combining mark,
 * which `\p{Diacritic}` then removes — the same fold the matcher uses.)
 */
export function foldSearch(s: string): string {
  return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/**
 * Split a query into folded search terms; empty for a blank query.
 * Every person-search box in the app runs the query through this, so a typed
 * name never has to be contiguous: the terms are matched independently.
 */
export function queryTerms(query: string): string[] {
  return foldSearch(query.trim()).split(/\s+/).filter(Boolean);
}

/**
 * True when every term appears somewhere in the (already folded) haystack, in
 * any order — so "sebas kala" finds "Sebastjan Kalan" and "kov marija" finds
 * "Marija Kovačič". No terms means no restriction.
 */
export function matchesTerms(text: string, terms: readonly string[]): boolean {
  return terms.every((term) => text.includes(term));
}

/**
 * `matchesTerms` over text that is still raw — folded here, per call. The
 * list filters (places, addresses, sources, the places tree) read a row's own
 * text this way; an index built once up front (the search rows, the place
 * dropdown's lists) folds ahead of time and calls `matchesTerms` directly.
 */
export function matchesQuery(text: string, terms: readonly string[]): boolean {
  return matchesTerms(foldSearch(text), terms);
}

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
function noteText(indi: Individual): string {
  const parts: string[] = [];
  // `noteRefs` carries every record-level note verbatim, including the ones the
  // display copy hides because only a URL was left after stripping — which is
  // the case this filter exists for.
  for (const ref of indi.noteRefs ?? []) parts.push(ref.text);
  for (const e of indi.events) {
    const note = e.noteWithLinks ?? e.note;
    if (note) parts.push(note);
  }
  return foldSearch(parts.join(" "));
}

function placeText(indi: Individual): string {
  const parts: string[] = [];
  for (const e of indi.events) {
    if (e.place?.raw) parts.push(e.place.raw);
    if (e.address?.raw) parts.push(e.address.raw);
  }
  return foldSearch(parts.join(" "));
}

/** One collator for every name sort over the whole file. Bare
 *  `a.localeCompare(b)` re-derives the locale machinery per comparison, which
 *  on a sort over tens of thousands of rows is most of the sort's cost. */
export const nameCollator = new Intl.Collator();

/** One projected row; the sort happens afterwards in {@link startSearchIndex}. */
function rowOf(indi: Individual, nameOf: (indi: Individual) => string, records?: GedNode[]): SearchRow {
  const span = lifespanOf(indi);
  const searchText = foldSearch(span ? `${nameSearchText(indi)} ${span}` : nameSearchText(indi));
  return {
    id: indi.id,
    name: nameOf(indi),
    span,
    searchText,
    sex: indi.sex,
    birthYear: birthYear(indi),
    birthKey: birthSortKey(indi),
    deathKey: deathYear(indi) ?? Infinity,
    placeText: placeText(indi),
    noteText: noteText(indi),
    hasLinks: anyLinks(indi),
    hasNotes: anyNotes(indi),
    hasSources: anySources(indi),
    photo: records ? collectFirstImage(indi.raw, records) ?? undefined : undefined,
  };
}

/** Display name, then birth date, then death year (both `Infinity` when
 *  unknown, so undated namesakes come last), then the record id so the order
 *  is total. The id compares as a plain string: the collator's locale rules
 *  add nothing to `@I123@` and cost most of a large file's sort. */
function compareRows(a: SearchRow, b: SearchRow): number {
  return (
    (a.name === b.name ? 0 : nameCollator.compare(a.name, b.name)) ||
    a.birthKey - b.birthKey ||
    a.deathKey - b.deathKey ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Individuals projected per clock check while building rows. */
const ROW_BATCH = 256;
/** Rows dealt into buckets per clock check while splitting a large bucket. */
const SPLIT_BATCH = 4096;
/** A bucket of more rows than this is split by a longer name prefix before
 *  it is sorted, so no single step sorts more than a couple of thousand rows. */
const BUCKET_LIMIT = 2000;
/** Prefix length the split starts at, and how much longer each further split
 *  looks. */
const PREFIX_START = 2;
const PREFIX_STEP = 2;

/**
 * An index build that runs in slices — see {@link startSearchIndex}.
 * `step` does about `budgetMs` of work and says whether the build finished;
 * `progress` runs 0…1 and `rows` is empty until the build is complete.
 */
export interface SearchIndexBuild {
  step(budgetMs: number): boolean;
  readonly progress: number;
  readonly rows: SearchRow[];
}

/** Rows still to sort: a bucket of rows sharing the first `depth` characters
 *  of their lower-cased display name (`depth` 0 = everything). */
interface Bucket {
  rows: SearchRow[];
  depth: number;
}

/** A large bucket part-way through being dealt into sub-buckets by a longer
 *  prefix — the whole list is one such bucket at first, and dealing half a
 *  million rows takes longer than a slice. */
interface Splitting extends Bucket {
  buckets: Map<string, SearchRow[]>;
  next: number;
}

/**
 * Start building the search index for a dataset, to be driven by `step` in
 * time-bounded slices so a file of half a million people can be indexed in
 * idle moments without stalling the page. `nameOf` is the caller's
 * name-display formatter (from `useNameOf`) so results read the same as
 * everywhere else. The rows come out sorted by display name and then by birth
 * date (death year as a fallback), so namesakes read oldest-first instead of
 * in file order.
 *
 * The sort is bucketed so it too can be sliced: rows are grouped by a prefix
 * of the lower-cased name, the buckets are ordered by the collator on their
 * prefix, and each bucket is sorted on its own — a bucket still too large is
 * split again by a longer prefix. Within a bucket the comparison is the full
 * one, so the result is the collator's order of the whole list, reached in
 * many small sorts instead of one that would hold the page for seconds.
 */
export function startSearchIndex(
  individuals: Map<string, Individual>,
  nameOf: (indi: Individual) => string,
  /** The dataset's records, for resolving shared-`OBJE` profile photos into
   *  `photo`. Callers that never show thumbnails (batch tool) may omit it. */
  records?: GedNode[],
): SearchIndexBuild {
  const total = individuals.size;
  const source = individuals.values();
  const unsorted: SearchRow[] = [];
  const sorted: SearchRow[] = [];
  // Set once every individual has a row; the sort phase then works it down.
  let pending: Bucket[] | undefined;
  let splitting: Splitting | undefined;
  let done = total === 0;

  const sortInto = (rows: SearchRow[]) => {
    rows.sort(compareRows);
    for (const row of rows) sorted.push(row);
  };

  /** Deal the next batch of a large bucket into sub-buckets; true when dealt. */
  const dealSome = (s: Splitting): boolean => {
    const { rows, depth, buckets } = s;
    const end = Math.min(rows.length, s.next + SPLIT_BATCH);
    for (; s.next < end; s.next++) {
      const row = rows[s.next];
      const key = row.name.slice(0, depth).toLowerCase();
      const list = buckets.get(key);
      if (list) list.push(row);
      else buckets.set(key, [row]);
    }
    return s.next >= rows.length;
  };

  const finishSplit = ({ rows, depth, buckets }: Splitting, stack: Bucket[]) => {
    if (buckets.size === 1) {
      // Everyone shares this prefix: look further along the name, unless the
      // names end here — then they are equal and only the full sort orders them.
      if (rows.some((row) => row.name.length > depth)) stack.push({ rows, depth: depth + PREFIX_STEP });
      else sortInto(rows);
      return;
    }
    // Pushed in reverse so the buckets pop, and land in `sorted`, in order.
    const keys = [...buckets.keys()].sort(nameCollator.compare);
    for (let i = keys.length - 1; i >= 0; i--) {
      stack.push({ rows: buckets.get(keys[i])!, depth: depth + PREFIX_STEP });
    }
  };

  return {
    get progress() {
      if (done) return 1;
      // The projection and the sort take about the same time on a large file.
      return (unsorted.length + sorted.length) / (2 * total);
    },
    get rows() {
      return done ? sorted : [];
    },
    step(budgetMs: number): boolean {
      if (done) return true;
      const deadline = performance.now() + budgetMs;
      if (!pending) {
        do {
          for (let i = 0; i < ROW_BATCH; i++) {
            const next = source.next();
            if (next.done) {
              pending = [{ rows: unsorted, depth: PREFIX_START }];
              break;
            }
            unsorted.push(rowOf(next.value, nameOf, records));
          }
        } while (!pending && performance.now() < deadline);
        if (!pending) return false;
      }
      for (;;) {
        if (splitting) {
          while (!dealSome(splitting)) {
            if (performance.now() >= deadline) return false;
          }
          finishSplit(splitting, pending);
          splitting = undefined;
        } else if (pending.length === 0) {
          break;
        } else {
          const bucket = pending.pop()!;
          if (bucket.rows.length > BUCKET_LIMIT) splitting = { ...bucket, buckets: new Map(), next: 0 };
          else sortInto(bucket.rows);
        }
        if (performance.now() >= deadline) return splitting === undefined && pending.length === 0 && (done = true);
      }
      done = true;
      return true;
    },
  };
}

/**
 * Build the whole search index at once — {@link startSearchIndex} run to the
 * end. For callers that need the rows now (the batch tool, tests); the search
 * dialog's index is built in slices by `useSearchIndex`.
 */
export function buildSearchRows(
  individuals: Map<string, Individual>,
  nameOf: (indi: Individual) => string,
  records?: GedNode[],
): SearchRow[] {
  const build = startSearchIndex(individuals, nameOf, records);
  while (!build.step(Infinity)) { /* one slice with no budget finishes it */ }
  return build.rows;
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

function matchesFilters(row: SearchRow, f: GlobalFilters, ctx: FilterContext): boolean {
  if (f.sex !== undefined && row.sex !== f.sex) return false;
  if (f.bornFrom !== undefined && (row.birthYear === undefined || row.birthYear < f.bornFrom)) return false;
  if (f.bornTo !== undefined && (row.birthYear === undefined || row.birthYear > f.bornTo)) return false;
  const place = foldSearch(f.place.trim());
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
 * status. An empty query with no facets returns the (name/birth-sorted) list.
 */
export function searchPeople(
  rows: SearchRow[],
  query: string,
  filters: GlobalFilters,
  ctx: FilterContext,
): SearchRow[] {
  const terms = queryTerms(query);
  const active = hasActiveFilters(filters);
  const out: SearchRow[] = [];
  for (const row of rows) {
    if (!matchesTerms(row.searchText, terms)) continue;
    if (active && !matchesFilters(row, filters, ctx)) continue;
    out.push(row);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

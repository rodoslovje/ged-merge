import type { GedNode, SourceCitation } from "./types";
import type { SourceFormatProfile, SourceLayout } from "../normalize/types";
import { linkKey } from "../normalize/links";
import { childText, childValue, childrenByTag, firstChild, hasChild } from "./node";
import { isPointer, looksLikeUrl } from "./uri";

// Re-exported: callers across the app import these from the source module.
// `childText` now lives in ./node; keep re-exporting it here for existing callers.
export { isPointer, looksLikeUrl, childText };

/**
 * Resolves event-level `SOUR` citations into a displayable, linkable
 * `SourceCitation` — the source's title/agency/filing number plus, when
 * resolvable, a direct link to the cited page (or a fallback link to the
 * source's lone image or its holding repository).
 *
 * Source records vary a lot by exporter (MacFamilyTree archive scans,
 * Ancestry.com generic databases, plain book citations, or no `SOUR` record
 * at all — just inline text). Resolution is done per-citation from the
 * record's own shape rather than a single global assumption, so a single
 * file that mixes styles (as MacFamilyTree exports do) still resolves each
 * citation correctly. `inferSourceFormat` is a separate, standalone helper
 * that *reports* the file's dominant convention (shown in the load summary
 * like place/date format) — it does a full-dataset scan, so it's called only
 * once at load time, not as part of this context (which is rebuilt on every
 * edit and must stay cheap).
 */

/** Map of top-level `SOUR` record xref -> the record itself. */
export type SourceIndex = Map<string, GedNode>;

/** Map of top-level `OBJE` record xref -> its file URL, (nested) title, and any
 *  descriptive content fields (date the media depicts, place, free-text
 *  description). `file` is the raw `FILE` value (URL or bare local filename);
 *  `url` is set only when that value is a usable link. The `CHAN`/`CREA` edit
 *  timestamps are deliberately not captured — those are bookkeeping. */
export interface ObjeInfo {
  url?: string;
  file?: string;
  title?: string;
  /** A level-1 `DATE` — the date the media depicts (not an edit timestamp). */
  date?: string;
  place?: string;
  /** Free-text description, from `_DSCR` or `NOTE`. */
  description?: string;
}
export type ObjeIndex = Map<string, ObjeInfo>;

/** Map of top-level `REPO` record xref -> its name and website. */
export type RepoIndex = Map<string, { name?: string; url?: string }>;

export interface SourceContext {
  sourceIndex: SourceIndex;
  objeIndex: ObjeIndex;
  repoIndex: RepoIndex;
}

/**
 * The human-readable display name for a `SOUR` record. Exporters disagree on
 * which tag holds the title, so this mirrors the precedence used when resolving
 * event citations: `TITL`, then `PERI` (the periodical title MacFamilyTree's
 * newspaper templates use instead of `TITL`), then `ABBR` (which names the
 * actual archive/register when the others are absent), then `AUTH` + `PUBL`.
 * Returns undefined only when the record carries no descriptive text at all.
 */
export function sourceTitle(node: GedNode): string | undefined {
  const auth = childText(node, "AUTH");
  const publ = childText(node, "PUBL");
  const authPubl = [auth, publ].filter(Boolean).join(", ");
  return (
    childText(node, "TITL") ??
    childText(node, "PERI") ??
    childText(node, "ABBR") ??
    (authPubl || undefined)
  );
}

/** Structural/bookkeeping child tags excluded from the descriptive tooltip. */
const TOOLTIP_SKIP_TAGS = new Set(["OBJE", "REPO", "_STE", "CHAN", "CREA"]);

/**
 * Every descriptive scalar field on a record, one `TAG: value` per line, for a
 * hover tooltip — so a record whose label falls back to its bare xref (or even
 * a named one) still surfaces all of its detail. Pointers and the given
 * bookkeeping tags (media/repo links, edit timestamps) are omitted.
 */
function descriptiveTooltip(node: GedNode): string {
  const lines: string[] = [];
  for (const c of node.children) {
    if (TOOLTIP_SKIP_TAGS.has(c.tag)) continue;
    const v = c.value?.trim();
    if (!v || isPointer(v)) continue;
    lines.push(`${c.tag}: ${v}`);
  }
  return lines.join("\n");
}

/** Descriptive fields of a `SOUR` record, for a hover tooltip. */
export function sourceTooltip(node: GedNode): string {
  return descriptiveTooltip(node);
}

/** Descriptive fields of a `REPO` record (name, address, contact), for a hover tooltip. */
export function repoTooltip(node: GedNode): string {
  return descriptiveTooltip(node);
}

export function buildSourceIndex(records: GedNode[]): SourceIndex {
  const map: SourceIndex = new Map();
  for (const rec of records) {
    if (rec.tag === "SOUR" && rec.xref) map.set(rec.xref, rec);
  }
  return map;
}

/**
 * Cache of a records array → its xref-to-top-level-`OBJE`-node map, for O(1)
 * pointer resolution. Keyed by the array reference (stable per dataset, rebuilt
 * only when the dataset changes), so the map is built once and reused across
 * every photo lookup instead of each collector linearly scanning all records.
 */
const objeNodeCache = new WeakMap<GedNode[], Map<string, GedNode>>();

/** xref → top-level `OBJE` node for `records`, built once per array and cached. */
export function objeNodesFor(records: GedNode[]): Map<string, GedNode> {
  let index = objeNodeCache.get(records);
  if (!index) {
    index = new Map();
    for (const rec of records) {
      if (rec.tag === "OBJE" && rec.xref) index.set(rec.xref, rec);
    }
    objeNodeCache.set(records, index);
  }
  return index;
}

/** Drop the cached xref→`OBJE` map for `records`. Call after adding or removing
 * a top-level `OBJE` record in place, so the next `objeNodesFor` rebuilds it
 * (the cache is keyed on the array reference, which edits mutate in place). */
export function clearObjeNodeCache(records: GedNode[]): void {
  objeNodeCache.delete(records);
}

/**
 * The displayable content of one `OBJE` node — equally a top-level shared media
 * record or an inline event-level link. `file` is the raw `FILE` value (URL or
 * bare local filename); `url` is set only when that value is a usable link.
 * `childText` reads direct children only, so `DATE` here is the level-1 content
 * date — never a CHAN/CREA edit timestamp nested a level deeper.
 */
export function objeInfoOf(node: GedNode): ObjeInfo {
  const fileNode = firstChild(node, "FILE");
  const file = fileNode?.value?.trim();
  const url = file && looksLikeUrl(file) ? file : undefined;
  const title = childText(fileNode ?? node, "TITL") ?? childText(node, "TITL");
  // Family Historian's `_KEYS` keywords ride along with the free-text
  // description so they stay visible in the viewer.
  const description = [childText(node, "_DSCR") ?? childText(node, "NOTE"), childText(node, "_KEYS")]
    .filter(Boolean)
    .join(" · ") || undefined;
  return {
    url,
    file,
    title,
    date: childText(node, "DATE"),
    place: childText(node, "PLAC"),
    description,
  };
}

/**
 * A GEDCOM 7 multimedia-link crop region — the rectangle of a (group) photo that
 * depicts the linking record, in source-image pixels. `top`/`left` default to 0
 * when absent; `width`/`height` are required for a meaningful region. Lives on the
 * `OBJE` *link* (the `1 OBJE @x@` child of an INDI/FAM), not the shared `OBJE`
 * record, so two people can mark different regions of the same image.
 */
export interface CropRegion {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Read the `CROP` region from an `OBJE` link node, or undefined when there's no
 *  crop or it lacks usable width/height. Integer subtags per the GEDCOM 7 spec.
 *  Falls back to MyHeritage's `_POSITION x1 y1 x2 y2` (two corner points in
 *  source-image pixels), the same region in that program's vocabulary. */
export function cropOf(linkNode: GedNode): CropRegion | undefined {
  const crop = firstChild(linkNode, "CROP");
  if (crop) {
    const num = (tag: string): number | undefined => {
      const raw = childValue(crop, tag)?.trim();
      if (!raw) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    const width = num("WIDTH");
    const height = num("HEIGHT");
    if (!width || !height || width <= 0 || height <= 0) return undefined;
    return { top: num("TOP") ?? 0, left: num("LEFT") ?? 0, width, height };
  }
  const pos = childValue(linkNode, "_POSITION")?.trim();
  if (pos) {
    const nums = pos.split(/\s+/).map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite)) {
      const [x1, y1, x2, y2] = nums;
      if (x2 > x1 && y2 > y1) return { top: y1, left: x1, width: x2 - x1, height: y2 - y1 };
    }
  }
  return undefined;
}

export function buildObjeIndex(records: GedNode[]): ObjeIndex {
  const map: ObjeIndex = new Map();
  for (const rec of records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    map.set(rec.xref, objeInfoOf(rec));
  }
  return map;
}

export function buildRepoIndex(records: GedNode[]): RepoIndex {
  const map: RepoIndex = new Map();
  for (const rec of records) {
    if (rec.tag !== "REPO" || !rec.xref) continue;
    map.set(rec.xref, { name: childText(rec, "NAME"), url: childText(rec, "WWW") });
  }
  return map;
}

export function buildSourceContext(records: GedNode[]): SourceContext {
  return {
    sourceIndex: buildSourceIndex(records),
    objeIndex: buildObjeIndex(records),
    repoIndex: buildRepoIndex(records),
  };
}

/**
 * Identity for de-duplicating/comparing citations across main and incoming.
 * Keyed by title+page rather than `sourceId`: a SOUR record's xref is a
 * GEDCOM pointer local to its own file (e.g. "@S5@"), so main and incoming
 * citations describing the exact same archival source never share one even
 * when every visible detail matches. The resolved title (which mirrors the
 * citation's own text for inline, pointer-less citations) is comparable
 * across files; `sourceId` is kept only as a fallback for the rare citation
 * with no title at all (an unresolved pointer).
 */
export function sourceCitationKey(c: SourceCitation): string {
  const title = (c.title ?? "").trim().toLowerCase();
  const page = (c.page ?? "").trim().toLowerCase();
  return title ? `${title}#${page}` : `id:${c.sourceId.toLowerCase()}#${page}`;
}

/** Incoming citations the main side lacks — the ones a merge would actually add. */
export function newSourceCitations(
  mainSources: SourceCitation[] | undefined,
  incomingSources: SourceCitation[] | undefined,
): SourceCitation[] {
  const have = new Set((mainSources ?? []).map(sourceCitationKey));
  return (incomingSources ?? []).filter((c) => !have.has(sourceCitationKey(c)));
}

/** A 1-2 digit run treated as a page number for comparison (drops leading zeros). */
function pageNumOf(s: string): number | undefined {
  const n = parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Whether an OBJE candidate's URL (`?pg=42`) or title (`#042 - …`) names the given page. */
function matchesPage(candidate: { url?: string; title?: string }, page: string): boolean {
  const target = pageNumOf(page);
  if (target === undefined) return false;
  const urlMatch = candidate.url ? /[?&]pg=(\d+)/i.exec(candidate.url) : null;
  if (urlMatch && pageNumOf(urlMatch[1]) === target) return true;
  const titleMatch = candidate.title ? /#0*(\d+)\b/.exec(candidate.title) : null;
  if (titleMatch && pageNumOf(titleMatch[1]) === target) return true;
  return false;
}

/**
 * Resolve one event-level `SOUR` child node (`2 SOUR @ID@` + `3 PAGE …`, or a
 * plain-text `SOUR` line) into a `SourceCitation`. Returns undefined only
 * when the citation node has no value at all.
 */
export function resolveSourceCitation(citationNode: GedNode, ctx: SourceContext): SourceCitation | undefined {
  const value = citationNode.value?.trim();
  if (!value) return undefined;
  const page = childText(citationNode, "PAGE");

  if (!isPointer(value)) {
    // Inline citation: the SOUR value itself is the bibliographic text.
    return { sourceId: value, title: value, page, exact: false };
  }

  const sourceNode = ctx.sourceIndex.get(value);
  if (!sourceNode) return { sourceId: value, page, exact: false };

  const title = sourceTitle(sourceNode);
  const agency = childText(sourceNode, "AGNC");
  const filingNumber = childText(sourceNode, "FILN");

  const candidates = sourceNode.children
    .filter((c) => c.tag === "OBJE" && c.value)
    .map((c) => ({ xref: c.value!.trim(), ...ctx.objeIndex.get(c.value!.trim()) }))
    .filter((c): c is { xref: string; url?: string; title?: string } => !!c.url);

  let url: string | undefined;
  let exact = false;
  let objeXref: string | undefined;
  if (page) {
    const match = candidates.find((c) => matchesPage(c, page));
    if (match) { url = match.url; exact = true; objeXref = match.xref; }
  }
  if (!url && candidates.length === 1) {
    url = candidates[0].url;
    exact = true;
    objeXref = candidates[0].xref;
  }
  if (!url) {
    const repoXref = sourceNode.children.find((c) => c.tag === "REPO" && c.value)?.value?.trim();
    const repo = repoXref ? ctx.repoIndex.get(repoXref) : undefined;
    if (repo?.url) url = repo.url;
  }

  return { sourceId: value, title, agency, filingNumber, page, url, exact, objeXref };
}

/**
 * Classify the dataset's dominant source-citation convention from its raw
 * records, for display in the load summary (like the detected place/date
 * format). See `SourceLayout` for the categories.
 */
export function inferSourceFormat(records: GedNode[]): SourceFormatProfile {
  const objeIndex = buildObjeIndex(records);
  let paginated = 0;
  let repository = 0;
  let literature = 0;
  let total = 0;
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    total++;
    // The vote weighs actual links (URLs), not source records: a register
    // book carrying 24 page links counts 24, a single-page grave/article
    // source counts its one (only OBJE with a real resolvable URL count — a
    // locally-cached filename isn't a page link), and a repo-only source
    // counts the one link it reaches through its repository's WWW.
    const objeCount = childrenByTag(rec, "OBJE").filter((c) => c.value && objeIndex.get(c.value.trim())?.url).length;
    const hasRepo = hasChild(rec, "REPO");
    const hasBiblio = hasChild(rec, ["TEXT", "AUTH", "PUBL", "PERI"]);
    if (objeCount >= 1) paginated += objeCount;
    else if (hasRepo) repository++;
    else if (hasBiblio) literature++;
  }

  let inlineCitations = 0;
  let pointerCitations = 0;
  forEachCitationValue(records, (value) => {
    if (isPointer(value)) pointerCitations++;
    else inlineCitations++;
  });

  let layout: SourceLayout;
  if (total === 0 && pointerCitations === 0 && inlineCitations === 0) layout = "unknown";
  else if (inlineCitations > pointerCitations) layout = "inline";
  else if (paginated > 0 && paginated >= repository && paginated >= literature) layout = "paginated";
  else if (repository > 0 && repository >= literature) layout = "repository";
  else if (literature > 0) layout = "literature";
  else layout = "unknown";

  return { layout };
}

/**
 * Whether the file's convention hangs sources off repository records —
 * independent of the page-link shape (most files with page-link sources ALSO
 * link each source to a REPO). Drives repository creation for new sources.
 */
export function prefersSourceRepos(records: GedNode[], exclude?: GedNode): boolean {
  const objeIndex = buildObjeIndex(records);
  let withRepo = 0;
  let without = 0;
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref || rec === exclude) continue;
    // Same link-weighted vote as inferSourceFormat: a book's many page links
    // count individually; a linkless source still counts once.
    const links = Math.max(
      1,
      childrenByTag(rec, "OBJE").filter((c) => c.value && objeIndex.get(c.value.trim())?.url).length,
    );
    if (hasChild(rec, "REPO")) withRepo += links;
    else without += links;
  }
  return withRepo > without;
}

/** `linkKey`, but with any `pg=` page-number query param stripped first, so two
 * URLs that cite different pages of the same paginated archive book compare equal. */
export function bookKeyOf(url: string): string {
  const [base, query] = url.split("?");
  if (!query) return linkKey(url);
  const params = query.split("&").filter((p) => !/^pg=/i.test(p));
  return linkKey(params.length ? `${base}?${params.join("&")}` : base);
}

/** The `pg=` query param of a URL, if any (Matricula-style page number). */
export function pageParamOf(url: string): string | undefined {
  return /[?&]pg=(\d+)/i.exec(url)?.[1];
}

/**
 * Find a `SOUR` record already in the dataset that a new citation for `url`
 * should reuse, rather than minting a duplicate — paginated archive registers
 * (Matricula, parish books) are cited page-by-page but share one `SOUR`.
 * - An existing `OBJE` whose URL matches exactly (mod language/case/slash) ⇒
 *   reuse that very `OBJE` too (no new records needed at all).
 * - One whose URL matches only with the page stripped (same book, different
 *   page) ⇒ reuse the `SOUR`, but the caller must add a new `OBJE` for this page.
 * - No match ⇒ undefined; caller creates a brand-new `SOUR`+`OBJE`.
 */
export function findExistingSource(
  records: GedNode[],
  url: string,
): { sourceXref: string; objeXref?: string; page?: string } | undefined {
  const objeIndex = buildObjeIndex(records);
  const incomingKey = linkKey(url);
  const incomingBookKey = bookKeyOf(url);
  const page = pageParamOf(url);

  let bookMatch: string | undefined;
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    for (const child of rec.children) {
      if (child.tag !== "OBJE" || !child.value) continue;
      const objeXref = child.value.trim();
      const objeUrl = objeIndex.get(objeXref)?.url;
      if (!objeUrl) continue;
      if (linkKey(objeUrl) === incomingKey) return { sourceXref: rec.xref, objeXref, page };
      if (!bookMatch && bookKeyOf(objeUrl) === incomingBookKey) bookMatch = rec.xref;
    }
  }
  return bookMatch ? { sourceXref: bookMatch, page } : undefined;
}

/** Tags that point to another top-level record rather than describing this
 * one's own content — excluded from `sourceContentKey` since the pointed-to
 * record is its own (separately comparable) thing. */
const SOURCE_RELATIONAL_TAGS = new Set(["OBJE", "REPO"]);

/**
 * A content-identity key for a top-level `SOUR` or `REPO` record: every
 * descendant tag/value pair except relational pointers (`OBJE`, `REPO`) and
 * custom `_`-prefixed tags (cosmetic exporter markup, e.g. `_ITALIC`). Two
 * records with the same key describe the same real-world source even under
 * different xrefs — two GEDCOM exports of overlapping family lines routinely
 * cite the same parish register under unrelated `@S..@` numbering. Empty
 * string means the record has no identity-bearing content to key on (the
 * caller should treat that as "no match", not match every other empty one).
 */
export function sourceContentKey(node: GedNode): string {
  const parts: string[] = [];
  const walk = (n: GedNode): void => {
    for (const child of n.children) {
      if (SOURCE_RELATIONAL_TAGS.has(child.tag) || child.tag.startsWith("_")) continue;
      parts.push(`${child.tag}=${(child.value ?? "").trim()}`);
      walk(child);
    }
  };
  walk(node);
  return parts.join("|");
}

/** Depth-first visit of every sub-record `SOUR` citation's value (skips top-level `SOUR` records, which have an xref). */
function forEachCitationValue(records: GedNode[], visit: (value: string) => void): void {
  const stack: GedNode[] = [...records];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.tag === "SOUR" && !node.xref && node.value?.trim()) visit(node.value.trim());
    for (const child of node.children) stack.push(child);
  }
}

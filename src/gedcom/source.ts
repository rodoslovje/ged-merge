import type { GedNode, SourceCitation } from "./types";
import type { SourceFormatProfile, SourceLayout } from "../normalize/types";
import { linkKey } from "../normalize/links";

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
 * citation correctly. `inferSourceFormat` exists alongside this to *report*
 * the file's dominant convention (shown in the load summary like place/date
 * format), not to gate the per-citation resolution logic.
 */

/** Map of top-level `SOUR` record xref -> the record itself. */
export type SourceIndex = Map<string, GedNode>;

/** Map of top-level `OBJE` record xref -> its file URL and (nested) title. */
export type ObjeIndex = Map<string, { url?: string; title?: string }>;

/** Map of top-level `REPO` record xref -> its name and website. */
export type RepoIndex = Map<string, { name?: string; url?: string }>;

export interface SourceContext {
  sourceIndex: SourceIndex;
  objeIndex: ObjeIndex;
  repoIndex: RepoIndex;
  format: SourceFormatProfile;
}

function isPointer(v: string): boolean {
  return /^@[^@]+@$/.test(v);
}

/** A `FILE` value can be an absolute URL or a bare local filename ("12345.jpg") —
 * only the former is a usable link. */
function looksLikeUrl(v: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(v);
}

function childText(node: GedNode, tag: string): string | undefined {
  const v = node.children.find((c) => c.tag === tag)?.value?.trim();
  return v || undefined;
}

export function buildSourceIndex(records: GedNode[]): SourceIndex {
  const map: SourceIndex = new Map();
  for (const rec of records) {
    if (rec.tag === "SOUR" && rec.xref) map.set(rec.xref, rec);
  }
  return map;
}

export function buildObjeIndex(records: GedNode[]): ObjeIndex {
  const map: ObjeIndex = new Map();
  for (const rec of records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    const fileNode = rec.children.find((c) => c.tag === "FILE");
    const rawFile = fileNode?.value?.trim();
    const url = rawFile && looksLikeUrl(rawFile) ? rawFile : undefined;
    const title = childText(fileNode ?? rec, "TITL") ?? childText(rec, "TITL");
    map.set(rec.xref, { url, title });
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
    format: inferSourceFormat(records),
  };
}

/** Identity for de-duplicating/comparing citations across master and incoming. */
export function sourceCitationKey(c: SourceCitation): string {
  return `${c.sourceId.toLowerCase()}#${(c.page ?? "").toLowerCase()}`;
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

  const titl = childText(sourceNode, "TITL");
  // MacFamilyTree's newspaper/periodical templates (T37/T72) use PERI
  // ("Kmetski list, 4 Apr 1934") instead of TITL.
  const peri = childText(sourceNode, "PERI");
  // ABBR ("NŠAL Rovte P 1816 - 1889") names the actual archive/register when
  // TITL/PERI are absent — preferred over AUTH, which often just names the
  // record's compiler/contributor rather than the source itself.
  const abbr = childText(sourceNode, "ABBR");
  const auth = childText(sourceNode, "AUTH");
  const publ = childText(sourceNode, "PUBL");
  const authPubl = [auth, publ].filter(Boolean).join(", ");
  const title = titl ?? peri ?? abbr ?? (authPubl || undefined);
  const agency = childText(sourceNode, "AGNC");
  const filingNumber = childText(sourceNode, "FILN");

  const candidates = sourceNode.children
    .filter((c) => c.tag === "OBJE" && c.value)
    .map((c) => ctx.objeIndex.get(c.value!.trim()))
    .filter((c): c is { url?: string; title?: string } => !!c?.url);

  let url: string | undefined;
  let exact = false;
  if (page) {
    const match = candidates.find((c) => matchesPage(c, page));
    if (match) { url = match.url; exact = true; }
  }
  if (!url && candidates.length === 1) {
    url = candidates[0].url;
    exact = true;
  }
  if (!url) {
    const repoXref = sourceNode.children.find((c) => c.tag === "REPO" && c.value)?.value?.trim();
    const repo = repoXref ? ctx.repoIndex.get(repoXref) : undefined;
    if (repo?.url) url = repo.url;
  }

  return { sourceId: value, title, agency, filingNumber, page, url, exact };
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
    // Only OBJE children with a real (resolvable) URL count as "page media" —
    // a source whose only OBJE is a locally-cached filename isn't paginated.
    const objeCount = rec.children.filter((c) => c.tag === "OBJE" && c.value && objeIndex.get(c.value.trim())?.url).length;
    const hasRepo = rec.children.some((c) => c.tag === "REPO");
    const hasBiblio = rec.children.some((c) => c.tag === "TEXT" || c.tag === "AUTH" || c.tag === "PUBL" || c.tag === "PERI");
    if (objeCount >= 2) paginated++;
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

/** `linkKey`, but with any `pg=` page-number query param stripped first, so two
 * URLs that cite different pages of the same paginated archive book compare equal. */
function bookKeyOf(url: string): string {
  const [base, query] = url.split("?");
  if (!query) return linkKey(url);
  const params = query.split("&").filter((p) => !/^pg=/i.test(p));
  return linkKey(params.length ? `${base}?${params.join("&")}` : base);
}

/** The `pg=` query param of a URL, if any (Matricula-style page number). */
function pageParamOf(url: string): string | undefined {
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

/** Depth-first visit of every sub-record `SOUR` citation's value (skips top-level `SOUR` records, which have an xref). */
function forEachCitationValue(records: GedNode[], visit: (value: string) => void): void {
  const stack: GedNode[] = [...records];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.tag === "SOUR" && !node.xref && node.value?.trim()) visit(node.value.trim());
    for (const child of node.children) stack.push(child);
  }
}

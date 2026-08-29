import {
  addObjeToSource,
  attachSourceCitation,
  createMediaRecord,
  createSourceRecord,
  EVENT_CHILD_ORDER,
  EVENT_LINK_TAG,
  FAM_CHILD_ORDER,
  getMediaAndSourceCtx,
  getSourceLookup,
  INDI_CHILD_ORDER,
  insertOrdered,
  linkPageMedia,
  markEventTouched,
  sourceCitationNodes,
} from "../gedcom/edit";
import { childText, findExistingSource, objeInfoOf, objeNodesFor, resolveSourceCitation, sourceTitle } from "../gedcom/source";
import { looksLikeUrl } from "../gedcom/builder";
import { firstChild } from "../gedcom/node";
import type { FormatOverrides } from "../normalize/formatOverrides";
import type { Dataset, GedNode, SourceCitation } from "../gedcom/types";
import {
  applySiteSourceExtras,
  cachedBookMeta,
  detectPageMediaStyle,
  isFetchableSite,
  pageObjeTitle,
  recognizeSourceUrl,
  siteQuay,
  siteSourceTitle,
  smartCitationTarget,
  type PageMediaStyle,
  type ReshapeSite,
  type RecognizedSourceUrl,
} from "../tools/sourceReshape";

/**
 * How the main file stores a record-level link.
 *  - "WWW": a plain `WWW <url>` line (RootsMagic, Ancestry, Synium, …).
 *  - "WEBTAG": Family Historian's `_WEBTAG` block, with the URL on a `URL`
 *    sub-line (`1 _WEBTAG` / `2 URL <url>`).
 *  - "OBJE": a shared multimedia record holding the URL in `FILE`
 *    (`0 @On@ OBJE` / `1 FILE <url>`), referenced via `1 OBJE @On@`.
 */
export type LinkFormat = "WWW" | "WEBTAG" | "OBJE";

/**
 * Everything an incoming link needs to be written the way this file writes its
 * own — the merge's half of the Add Source dialog, which asks the same
 * questions of the same file before it writes anything.
 */
export interface LinkPlacement {
  /** How a link that stays a plain link is written. */
  linkFormat: LinkFormat;
  /** "event": the cited page's image is linked beside the citation as well as
   *  under the source record — the file's own habit (Settings → Page links). */
  pageMedia: PageMediaStyle;
  /** Settings → GEDCOM, for the citation-placement questions the file's own
   *  habit would otherwise answer. */
  overrides?: FormatOverrides;
  /** Book URLs whose source this merge minted from the offline proposal alone,
   *  and which a lookup could still name properly. The save reads these pages
   *  before it writes, when the reader has allowed link lookups; each is listed
   *  once, in the order the merge reached them. */
  pendingLookups?: string[];
}

/** The link-writing questions answered once for a whole merge: how this file
 *  writes plain links, and whether it keeps a cited page's image beside the
 *  citation. `overrides` (Settings → GEDCOM) wins over the file's own habit,
 *  exactly as it does in the Add Source dialog. */
export function linkPlacementFor(main: Dataset, overrides?: FormatOverrides): LinkPlacement {
  return {
    linkFormat: detectLinkFormat(main),
    pageMedia: overrides?.pageMedia ?? detectPageMediaStyle(main.records),
    overrides,
    pendingLookups: [],
  };
}

/**
 * Which `LinkFormat` the main file uses for its own record-level links, so
 * newly added links are written the same way. Counts `WWW` lines, `_WEBTAG`
 * blocks, and `OBJE` pointers to a media record whose `FILE` is a URL, across
 * all individuals and families (including their events), and picks whichever
 * the main already uses most; defaults to plain `WWW` lines when the main
 * has none of these (or is ambiguous).
 */
export function detectLinkFormat(main: Dataset): LinkFormat {
  const objeFiles = new Map<string, string>();
  for (const rec of main.records) {
    if (rec.tag !== "OBJE" || !rec.xref) continue;
    const file = firstChild(rec, "FILE")?.value?.trim();
    if (file) objeFiles.set(rec.xref, file);
  }

  let www = 0;
  let webtag = 0;
  let obje = 0;
  const visit = (node: GedNode): void => {
    if (node.tag === "WWW" && node.value) www++;
    else if (node.tag === "_WEBTAG") webtag++;
    else if (node.tag === "OBJE" && node.value) {
      const file = objeFiles.get(node.value.trim());
      if (file && looksLikeUrl(file)) obje++;
    }
    for (const child of node.children) visit(child);
  };
  for (const indi of main.individuals.values()) visit(indi.raw);
  for (const fam of main.families.values()) visit(fam.raw);

  const max = Math.max(www, webtag, obje);
  if (max === 0) return "WWW";
  if (obje === max) return "OBJE";
  if (webtag === max) return "WEBTAG";
  return "WWW";
}

/** What became of one incoming link the merge wrote into the main file. */
export interface PlacedLink {
  /** The URL, as the incoming file gave it. */
  url: string;
  /** The event node the link landed on — the one it arrived on, or the one its
   *  register documents. Absent when it stayed at record level. */
  event?: GedNode;
  /** The citation written for it, for the save preview's source icons. Absent
   *  when the URL stayed a plain link. */
  citation?: SourceCitation;
  /** Set when a brand-new `SOUR` record was minted to hold the link, rather
   *  than a source the main already had being cited again. */
  createdSource?: true;
}

/**
 * Write one record-level incoming link into the main record, respecting the
 * main file's own source structure instead of leaving a disconnected link.
 *
 * Three outcomes, in order of preference:
 *  1. The main already cites the book this URL belongs to (Matricula, a
 *     FamilySearch film, a Geneanet cemetery, …) ⇒ a `SOUR` citation on that
 *     source, reusing its page `OBJE` or adding one for this page.
 *  2. The URL is of a site we recognize but the main has no source for ⇒ a
 *     brand-new `SOUR` — with the title, page `OBJE` and `PLAC`/`DATE`/`REPO`
 *     extras the Add Source dialog and the Organize sources tool write — and a
 *     citation to it.
 *  3. Neither ⇒ the plain link the merge has always written, in the main's own
 *     `LinkFormat`.
 *
 * The citation goes on the event the register documents (grave → `BURI`,
 * death → `DEAT`, baptism → the file's own `BIRT`/`BAPM`) when the main file's
 * habit is to cite events and the record already carries that event —
 * including one this very merge has just brought in, since record-level links
 * are written after every other row (see `applyLinks`); otherwise it stays on
 * the record. It is never placed on an event the merge would have to invent:
 * an event appearing with no decision behind it is a change the save preview
 * cannot explain, and the Organize sources tool relocates such links later
 * with the whole file in view.
 */
export function placeRecordLink(
  record: GedNode,
  url: string,
  records: GedNode[],
  placement: LinkPlacement,
  /** Xrefs already promised to compare shared records — a minted `SOUR`/`OBJE`
   *  must not squat on one, or the promised import would be skipped and its
   *  pointers would resolve here instead. */
  reserved?: ReadonlySet<string>,
): PlacedLink {
  const recognized = recognizeSourceUrl(url);
  const source = resolveSource(records, url, recognized, placement, reserved);
  if (!source) {
    insertOrdered(record, buildLinkNode(placement.linkFormat, url, records, reserved), childOrderOf(record));
    return { url };
  }
  const target = citationTarget(record, records, recognized, source.sourceXref, placement);
  return attach(target, url, records, source, placement);
}

/**
 * Write one incoming link that arrived attached to an event. The incoming file
 * has already said where it belongs, so this only decides *what* it becomes —
 * the same citation-over-plain-link ladder as {@link placeRecordLink}, with the
 * event's own link tag as the last resort.
 */
export function placeEventLink(
  event: GedNode,
  url: string,
  records: GedNode[],
  placement: LinkPlacement,
  reserved?: ReadonlySet<string>,
): PlacedLink {
  const source = resolveSource(records, url, recognizeSourceUrl(url), placement, reserved);
  if (!source) {
    insertOrdered(event, { level: event.level + 1, tag: EVENT_LINK_TAG, value: url, children: [] }, EVENT_CHILD_ORDER);
    markEventTouched(event, "changed");
    return { url, event };
  }
  return attach(event, url, records, source, placement);
}

/** The source a link is cited from, and everything written alongside that
 *  citation: which page of it (`PAGE`), that page's image, and how good the
 *  site's evidence is (`QUAY`) — the Add Source dialog's own proposals. */
interface ResolvedSource {
  sourceXref: string;
  page?: string;
  /** The top-level `OBJE` holding this page's image, once the source has one. */
  pageObje?: string;
  quay?: string;
  createdSource?: true;
}

/** The `SOUR` a link should be cited from: the one the main already has for this
 *  book, else one minted for a recognized site. Undefined ⇒ a plain link. */
function resolveSource(
  records: GedNode[],
  url: string,
  recognized: RecognizedSourceUrl | undefined,
  placement: LinkPlacement,
  reserved: ReadonlySet<string> | undefined,
): ResolvedSource | undefined {
  const quay = recognized && siteQuay(recognized.site, url);
  // The cached lookup makes this O(1) per link instead of a full-forest scan;
  // every record-minting helper bumps the cache version, so a source or page
  // OBJE created for one link is visible to the next link's lookup.
  const existing = findExistingSource(records, url, undefined, getSourceLookup(records));
  if (existing) {
    const pageObje =
      existing.objeXref ??
      addObjeToSource(records, existing.sourceXref, url, pageTitleFor(records, existing.sourceXref, recognized), reserved)
        .xref ??
      undefined;
    return { sourceXref: existing.sourceXref, page: existing.page, pageObje, quay };
  }
  if (!recognized) return undefined;
  const source = mintSource(records, recognized, url, placement, reserved);
  return { ...source, page: recognized.page, quay, createdSource: true };
}

/**
 * The citation an incoming link would become, without writing anything — Edit
 * mode's preview of a confirmed match, which would otherwise show the bare
 * address and say nothing of the source it is about to join. Follows the same
 * ladder {@link placeRecordLink} writes by: the source the file already keeps
 * for this book, else the one a recognized link would mint (named from the
 * book's page where it has been read). Undefined where the link would stay a
 * plain link, which is what the preview then shows.
 */
export function previewLinkCitation(records: GedNode[], url: string): SourceCitation | undefined {
  const existing = findExistingSource(records, url, undefined, getSourceLookup(records));
  if (existing) {
    const node = records.find((r) => r.tag === "SOUR" && r.xref === existing.sourceXref);
    return {
      sourceId: existing.sourceXref,
      title: node && sourceTitle(node),
      agency: node && childText(node, "AGNC"),
      filingNumber: node && childText(node, "FILN"),
      page: existing.page,
      url,
      exact: true,
      objeXref: existing.objeXref,
    };
  }
  const recognized = recognizeSourceUrl(url);
  if (!recognized) return undefined;
  const p = recognized.proposed;
  const fetched = cachedBookMeta(recognized.site, recognized.bookUrl ?? url);
  const filingNumber = fetched?.filingNumber || p.filingNumber;
  return {
    sourceId: "",
    title: siteSourceTitle(recognized.site, fetched?.title ?? p.title, filingNumber) ?? p.title,
    agency: fetched?.agency ?? p.agency,
    filingNumber,
    page: recognized.page,
    url,
    exact: true,
  };
}

/**
 * The same preview, plus where the citation would land: the tag of the event
 * this register documents, when the merge would move the citation there (the
 * file cites events and the record — or, with `incomingEventTags`, the merge
 * itself — carries that one), and nothing when it would stay on the record.
 */
export function previewLinkPlacement(
  record: GedNode,
  url: string,
  records: GedNode[],
  opts: {
    overrides?: FormatOverrides;
    /** The file's page-image habit, resolved by the caller (it costs a scan of
     *  the whole forest, and a preview asks this of link after link). Only
     *  "event" puts the cited page's image beside the citation, so only then
     *  does the preview name one. */
    pageMedia?: PageMediaStyle;
    /** Events the incoming record brings that the main one lacks. The merge
     *  applies record-level links last, by which time such an event exists to
     *  receive the citation (see `applyLinks`) — so the review must offer the
     *  choice on that event's row, where the reader can see the burial the
     *  grave link documents, rather than on the person's own row. */
    incomingEventTags?: ReadonlySet<string>;
  } = {},
): { citation?: SourceCitation; eventTag?: string; pageImage?: string } {
  const citation = previewLinkCitation(records, url);
  if (!citation) return {};
  return {
    citation,
    eventTag: citationEventTag(record, records, recognizeSourceUrl(url)?.site, citation.title, opts.overrides, opts.incomingEventTags),
    pageImage: opts.pageMedia === "event" ? pageImageUrl(records, citation, url) : undefined,
  };
}

/** The file of the page image that would be linked beside the citation: the
 *  one the source already holds for this page, else the link itself — which is
 *  what a page `OBJE` minted for it would carry. */
function pageImageUrl(records: GedNode[], citation: SourceCitation, url: string): string {
  const node = citation.objeXref ? objeNodesFor(records).get(citation.objeXref) : undefined;
  return (node && objeInfoOf(node).url) || url;
}

/** The name a page image added to a source the file already has gets — the
 *  same `#40 - Krstna knjiga …` the Add Source dialog writes, built from the
 *  source's own title so the page says which book it is a page of. */
function pageTitleFor(
  records: GedNode[],
  sourceXref: string,
  recognized: RecognizedSourceUrl | undefined,
): string | undefined {
  const sourceNode = records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  if (!sourceNode) return undefined;
  return pageObjeTitle(recognized?.site, sourceTitle(sourceNode), recognized?.page, undefined, recognized?.collection);
}

/** Write the citation onto its container and describe it for the save preview. */
function attach(
  container: GedNode,
  url: string,
  records: GedNode[],
  source: ResolvedSource,
  placement: LinkPlacement,
): PlacedLink {
  const onEvent = container.tag !== "INDI" && container.tag !== "FAM";
  const order = onEvent ? EVENT_CHILD_ORDER : childOrderOf(container);
  attachSourceCitation(container, source.sourceXref, source.page, order, source.quay);
  // Files that keep a cited page's image beside the citation get it here too —
  // a merged citation and a hand-added one must leave the same shape behind.
  if (placement.pageMedia === "event") linkPageMedia(container, source.pageObje, order);
  if (onEvent) markEventTouched(container, "changed");
  const nodes = sourceCitationNodes(container);
  return {
    url,
    event: onEvent ? container : undefined,
    citation: resolveSourceCitation(nodes[nodes.length - 1], getMediaAndSourceCtx(records).sourceCtx),
    createdSource: source.createdSource,
  };
}

/**
 * Where a record-level citation belongs: the event this register documents,
 * when the main file cites events at all and already carries that event —
 * otherwise the record itself.
 *
 * The register's type is read off the source that will be cited, not off the
 * link: a Matricula address names its book by number, while the file's own
 * `SOUR` for it says "Krstna knjiga" and settles the question. The site is
 * consulted too, for the grave and obituary sites whose kind is inherent.
 */
function citationTarget(
  record: GedNode,
  records: GedNode[],
  recognized: RecognizedSourceUrl | undefined,
  sourceXref: string,
  placement: LinkPlacement,
): GedNode {
  const sourceNode = records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  const title = (sourceNode && sourceTitle(sourceNode)) || recognized?.proposed.title;
  const tag = citationEventTag(record, records, recognized?.site, title, placement.overrides);
  return (tag && firstChild(record, tag)) || record;
}

/**
 * The event tag a record-level citation of this book would move to, or nothing
 * when it stays on the record. Shared by the write and the preview so Edit
 * shows the citation where the save will actually put it.
 */
function citationEventTag(
  record: GedNode,
  records: GedNode[],
  site: ReshapeSite | undefined,
  title: string | undefined,
  overrides: FormatOverrides | undefined,
  /** Event tags the same merge is about to bring in from the incoming record,
   *  which may hold the citation even though the main record has none yet —
   *  see {@link previewLinkPlacement}. */
  incomingTags?: ReadonlySet<string>,
): string | undefined {
  const want = smartCitationTarget(records, site ?? "other", title, {
    citations: overrides?.citations ?? "auto",
    baptism: overrides?.baptism ?? "auto",
  });
  // A marriage register's citation belongs on the couple's `MARR`, which lives
  // on the family record — a record other than the one being applied, whose
  // change would never reach this record's preview card. Left at record level
  // for the Organize sources tool, which moves it with every record in view.
  if (!want || (want.onFam && record.tag !== "FAM")) return undefined;
  if (firstChild(record, want.eventTag)) return want.eventTag;
  return incomingTags?.has(want.eventTag) ? want.eventTag : undefined;
}

/**
 * Mint the `SOUR` record for a recognized link the main has nothing to cite —
 * the same title, page image and `PLAC`/`DATE`/`REPO` extras the Add Source
 * dialog and the Organize sources tool produce, so the merge leaves no cleanup
 * behind. Where the book's own page has already been read (the save's lookup
 * pass, an earlier Add Source, the Organize sources tool), what it said names
 * the source; where it has not, the link's own offline proposal does and the
 * book joins {@link LinkPlacement.pendingLookups} for the save to read.
 */
function mintSource(
  records: GedNode[],
  recognized: RecognizedSourceUrl,
  url: string,
  placement: LinkPlacement,
  reserved: ReadonlySet<string> | undefined,
): { sourceXref: string; pageObje?: string } {
  const p = recognized.proposed;
  const bookUrl = recognized.bookUrl ?? url;
  const fetched = cachedBookMeta(recognized.site, bookUrl);
  if (!fetched && isFetchableSite(recognized.site, bookUrl) && !placement.pendingLookups?.includes(bookUrl)) {
    placement.pendingLookups?.push(bookUrl);
  }
  const filingNumber = fetched?.filingNumber || p.filingNumber;
  const title = siteSourceTitle(recognized.site, fetched?.title ?? p.title, filingNumber) ?? p.title;
  const source = createSourceRecord(
    records,
    {
      title,
      author: fetched?.author ?? p.author,
      periodical: fetched?.periodical,
      publisher: fetched?.publisher,
      agency: fetched?.agency ?? p.agency,
      filingNumber,
      url,
    },
    reserved,
  );
  applySiteSourceExtras(records, source, recognized.site, bookUrl, {
    place: fetched?.place ?? p.place,
    dateRange: fetched?.dateRange ?? p.dateRange,
    collection: recognized.collection,
    collectionId: filingNumber,
  });
  const objeXref = firstChild(source, "OBJE")?.value;
  if (objeXref) {
    const objeNode = records.find((r) => r.tag === "OBJE" && r.xref === objeXref);
    const objeTitle = pageObjeTitle(recognized.site, title, recognized.page, undefined, recognized.collection);
    if (objeNode && objeTitle && !firstChild(objeNode, "TITL")) {
      objeNode.children.push({ level: objeNode.level + 1, tag: "TITL", value: objeTitle, children: [] });
    }
  }
  return { sourceXref: source.xref!, pageObje: objeXref };
}

/** The canonical child order for a top-level record's own children. */
function childOrderOf(record: GedNode): string[] {
  return record.tag === "FAM" ? FAM_CHILD_ORDER : INDI_CHILD_ORDER;
}

/**
 * Build a new plain link node for `url`, shaped per `format`. For "OBJE", the
 * shared `createMediaRecord` mints the top-level record — same FORM habit,
 * record grouping, xref bookkeeping and cache bump as an editor-added one —
 * and this returns a pointer to it.
 */
function buildLinkNode(
  format: LinkFormat,
  url: string,
  records: GedNode[],
  reserved?: ReadonlySet<string>,
): GedNode {
  if (format === "WEBTAG") {
    return { level: 0, tag: "_WEBTAG", children: [{ level: 1, tag: "URL", value: url, children: [] }] };
  }
  if (format === "OBJE") {
    const obje = createMediaRecord(records, url, undefined, reserved);
    return { level: 0, tag: "OBJE", value: obje.xref, children: [] };
  }
  return { level: 0, tag: "WWW", value: url, children: [] };
}

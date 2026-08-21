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
  markEventTouched,
  sourceCitationNodes,
} from "../gedcom/edit";
import { findExistingSource, resolveSourceCitation, sourceTitle } from "../gedcom/source";
import { looksLikeUrl } from "../gedcom/builder";
import { firstChild } from "../gedcom/node";
import type { Dataset, GedNode, SourceCitation } from "../gedcom/types";
import {
  applySiteSourceExtras,
  pageObjeTitle,
  recognizeSourceUrl,
  siteSourceTitle,
  smartCitationTarget,
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
 * habit is to cite events and the record already carries that event; otherwise
 * it stays on the record. It is never placed on an event the merge would have
 * to invent: an event appearing with no decision behind it is a change the save
 * preview cannot explain, and the Organize sources tool relocates such links
 * later with the whole file in view.
 */
export function placeRecordLink(
  record: GedNode,
  url: string,
  records: GedNode[],
  opts: {
    linkFormat: LinkFormat;
    /** Xrefs already promised to compare shared records — a minted `SOUR`/`OBJE`
     *  must not squat on one, or the promised import would be skipped and its
     *  pointers would resolve here instead. */
    reserved?: ReadonlySet<string>;
  },
): PlacedLink {
  const recognized = recognizeSourceUrl(url);
  const source = resolveSource(records, url, recognized, opts.reserved);
  if (!source) {
    insertOrdered(record, buildLinkNode(opts.linkFormat, url, records, opts.reserved), childOrderOf(record));
    return { url };
  }
  return attach(citationTarget(record, records, recognized, source.sourceXref), url, records, source);
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
  opts: { reserved?: ReadonlySet<string> } = {},
): PlacedLink {
  const source = resolveSource(records, url, recognizeSourceUrl(url), opts.reserved);
  if (!source) {
    insertOrdered(event, { level: event.level + 1, tag: EVENT_LINK_TAG, value: url, children: [] }, EVENT_CHILD_ORDER);
    markEventTouched(event, "changed");
    return { url, event };
  }
  return attach(event, url, records, source);
}

/** The `SOUR` a link should be cited from: the one the main already has for this
 *  book, else one minted for a recognized site. Undefined ⇒ a plain link. */
function resolveSource(
  records: GedNode[],
  url: string,
  recognized: RecognizedSourceUrl | undefined,
  reserved: ReadonlySet<string> | undefined,
): { sourceXref: string; page?: string; createdSource?: true } | undefined {
  // The cached lookup makes this O(1) per link instead of a full-forest scan;
  // every record-minting helper bumps the cache version, so a source or page
  // OBJE created for one link is visible to the next link's lookup.
  const existing = findExistingSource(records, url, undefined, getSourceLookup(records));
  if (existing) {
    if (!existing.objeXref) addObjeToSource(records, existing.sourceXref, url, undefined, reserved);
    return { sourceXref: existing.sourceXref, page: existing.page };
  }
  if (!recognized) return undefined;
  return { sourceXref: mintSource(records, recognized, url, reserved), page: recognized.page, createdSource: true };
}

/** Write the citation onto its container and describe it for the save preview. */
function attach(
  container: GedNode,
  url: string,
  records: GedNode[],
  source: { sourceXref: string; page?: string; createdSource?: true },
): PlacedLink {
  const onEvent = container.tag !== "INDI" && container.tag !== "FAM";
  attachSourceCitation(container, source.sourceXref, source.page, onEvent ? EVENT_CHILD_ORDER : childOrderOf(container));
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
): GedNode {
  const sourceNode = records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  const title = (sourceNode && sourceTitle(sourceNode)) || recognized?.proposed.title;
  const want = smartCitationTarget(records, recognized?.site ?? "other", title);
  // A marriage register's citation belongs on the couple's `MARR`, which lives
  // on the family record — a record other than the one being applied, whose
  // change would never reach this record's preview card. Left at record level
  // for the Organize sources tool, which moves it with every record in view.
  if (!want || (want.onFam && record.tag !== "FAM")) return record;
  return firstChild(record, want.eventTag) ?? record;
}

/**
 * Mint the `SOUR` record for a recognized link the main has nothing to cite —
 * the same title, page image and `PLAC`/`DATE`/`REPO` extras the Add Source
 * dialog and the Organize sources tool produce, so the merge leaves no cleanup
 * behind. Returns the new source's xref.
 */
function mintSource(
  records: GedNode[],
  recognized: RecognizedSourceUrl,
  url: string,
  reserved: ReadonlySet<string> | undefined,
): string {
  const p = recognized.proposed;
  const title = siteSourceTitle(recognized.site, p.title, p.filingNumber) ?? p.title;
  const source = createSourceRecord(
    records,
    { title, author: p.author, agency: p.agency, filingNumber: p.filingNumber, url },
    reserved,
  );
  applySiteSourceExtras(records, source, recognized.site, recognized.bookUrl ?? url, {
    place: p.place,
    dateRange: p.dateRange,
    collection: recognized.collection,
    collectionId: p.filingNumber,
  });
  const objeXref = firstChild(source, "OBJE")?.value;
  if (objeXref) {
    const objeNode = records.find((r) => r.tag === "OBJE" && r.xref === objeXref);
    const objeTitle = pageObjeTitle(recognized.site, title, recognized.page, undefined, recognized.collection);
    if (objeNode && objeTitle && !firstChild(objeNode, "TITL")) {
      objeNode.children.push({ level: objeNode.level + 1, tag: "TITL", value: objeTitle, children: [] });
    }
  }
  return source.xref!;
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

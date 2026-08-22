import type { Dataset, GedNode } from "../gedcom/types";
import { childrenByTag, cloneNode } from "../gedcom/node";
import { FAM_EVENT_TAGS, INDI_EVENT_TAGS } from "../gedcom/eventTags";
import { linkPageMedia, SOUR_TRAILING_TAGS } from "../gedcom/edit";
import { EVENT_CHILD_ORDER, FAM_CHILD_ORDER, INDI_CHILD_ORDER, insertGrouped } from "../gedcom/edit/shared";
import { bookKeyOf, buildObjeIndex, isPointer, looseKey, pageParamOf, sourceTitle, type ObjeIndex } from "../gedcom/source";
import { parseFamilySearchUrl } from "../normalize/links";
import type { PageMediaStyle } from "./sourceReshape";

/**
 * The citations whose record does not link the page image their source holds —
 * the one thing Organize sources could not see.
 *
 * That scan hunts for *links to convert*: a `WWW` line, a bare `OBJE` pointer,
 * a URL in note text. A citation that is already a proper citation carries no
 * link, so it produced no row however plainly its page image was missing from
 * the event beside it. This asks the opposite question — the file keeps page
 * images on its records (Settings → Page links, or its own habit); which
 * citations do not have theirs?
 *
 * Only that direction: a page pointer a "source only" file should not carry is
 * already an occurrence of the main scan (shape `obje`), and offering it twice
 * would be two rows for one piece of work.
 */

/** One citation that has a page image to link, and does not link it. */
export interface MissingPageMedia {
  /** The `INDI`/`FAM` record holding the citation. */
  recordXref: string;
  /** The event the citation sits on, or undefined for a record-level one. */
  eventTag?: string;
  /** The cited page, as the citation states it. */
  page?: string;
  /** The image the record would link. */
  objeXref: string;
}

/** A page image beside a citation that its own book does not hold — the same
 *  trouble read from the other end. */
export interface UnfiledPageImage {
  /** The `INDI`/`FAM` record whose citation carries the image. */
  recordXref: string;
  /** The event it sits on, or undefined for a record-level citation. */
  eventTag?: string;
  /** The image, to be filed under the book it is a page of. */
  objeXref: string;
  /** The page it states, where its own address says one. */
  page?: string;
}

/** One source: the citations of it missing their page image, and the pages of
 *  it the file keeps on records without ever filing them under the book. */
export interface PageMediaGroup {
  /** Stable identity (`pm:${sourceXref}`), the selection/React key. */
  id: string;
  sourceXref: string;
  title: string;
  missing: MissingPageMedia[];
  /**
   * Pages sitting beside a citation of this source that the source record does
   * not hold. A book that does not know its own pages is why a citation
   * elsewhere cannot be given the right one — this is the root the other list
   * grows from, and the two are fixed in one pass.
   */
  unfiled: UnfiledPageImage[];
  /**
   * Citations of this source whose image could not be told from another: the
   * source holds several pages and the citation names none, or names one no
   * image answers to. Reported, never guessed — and never silently dropped,
   * or the count would promise a completeness the run does not deliver.
   */
  ambiguous: number;
}

export interface PageMediaReport {
  groups: PageMediaGroup[];
  /** Citations that would get their page image. */
  total: number;
  /** Pages that would be filed under the book they belong to. */
  unfiled: number;
  /** Citations left alone because which image they mean is not knowable. */
  ambiguous: number;
}

const EMPTY: PageMediaReport = { groups: [], total: 0, unfiled: 0, ambiguous: 0 };

/** The page number an image's own URL states — the `pg=` a register link
 *  carries, or the image a FamilySearch ark was copied at. */
function pageOfImage(url: string): string | undefined {
  return pageParamOf(url) ?? parseFamilySearchUrl(url)?.image;
}

/** The page images a `SOUR` record holds, in file order. */
function pageImagesOf(source: GedNode, objes: ObjeIndex): { xref: string; url: string; page?: string }[] {
  const out: { xref: string; url: string; page?: string }[] = [];
  for (const child of childrenByTag(source, "OBJE")) {
    const xref = child.value?.trim();
    if (!xref || !isPointer(xref)) continue;
    const url = objes.get(xref)?.url;
    if (url) out.push({ xref, url, page: pageOfImage(url) });
  }
  return out;
}

/**
 * Whether a media record beside a citation really is a page of the book that
 * citation names — the question that decides a stray page from a link that
 * merely keeps it company.
 *
 * Being the only citation on the fact proves nothing: a record commonly
 * carries links that have no book behind them at all (a Facebook page, a
 * memorial notice) while citing one source. So the page has to say so itself,
 * in one of the three ways a page of a book can:
 *
 *  - it carries the very page the citation cites;
 *  - it is titled after the book, which is how every page image this app
 *    writes is named (`#126 - Births …, Ravna Gora`);
 *  - its address is another page of a book this source already holds.
 */
function isPageOfSource(
  image: { url: string; title?: string },
  source: GedNode,
  held: { url: string }[],
  citationPage: string | undefined,
): boolean {
  const page = pageOfImage(image.url);
  if (citationPage && page && citationPage === page) return true;
  const book = sourceTitle(source)?.trim();
  const title = image.title?.trim();
  if (book && title) {
    const bookKey = looseKey(book);
    const titleKey = looseKey(title);
    if (bookKey && (titleKey === bookKey || titleKey.endsWith(bookKey))) return true;
  }
  return held.some((h) => bookKeyOf(h.url) === bookKeyOf(image.url));
}

/**
 * Which image a citation means, or why it cannot be said. A source with one
 * page image answers for every citation of it; with several, only the cited
 * page tells them apart, and a citation that names no page (or names one no
 * image carries) is left alone.
 */
function imageForCitation(
  images: { xref: string; url: string; page?: string }[],
  page: string | undefined,
): { xref: string } | "ambiguous" | undefined {
  if (images.length === 0) return undefined; // not a paginated source at all
  if (images.length === 1) return images[0];
  const cited = page?.trim();
  if (!cited) return "ambiguous";
  const matches = images.filter((i) => i.page && i.page === cited);
  return matches.length === 1 ? matches[0] : "ambiguous";
}

/** The containers a citation-plus-image pair may sit on: the record itself and
 *  its own events — the same two levels `detectPageMediaStyle` reads the file's
 *  habit from, and the same ones the editor writes. */
function containersOf(record: GedNode): GedNode[] {
  const eventTags = record.tag === "INDI" ? INDI_EVENT_TAGS : FAM_EVENT_TAGS;
  return [record, ...record.children.filter((c) => eventTags.has(c.tag))];
}

/**
 * Which citation on this container a stray page belongs to — and whether it is
 * a page of that book at all. Every candidate citation is held against
 * {@link isPageOfSource}: a record that cites one book while carrying links to
 * quite other things (a memorial notice, a family's page on a website) is the
 * ordinary case, not the exception, and its links are nobody's pages.
 *
 * Exactly one citation may claim it. Two books that both look like its home
 * leave it where it is — the page will not be split between them.
 */
function citationForImage(
  container: GedNode,
  sources: Map<string, GedNode>,
  image: { url: string; title?: string },
  imagesOf: (xref: string, node: GedNode) => { url: string }[],
): string | undefined {
  const claimants: string[] = [];
  for (const citation of childrenByTag(container, "SOUR")) {
    const xref = citation.value?.trim();
    if (!xref || !isPointer(xref)) continue;
    const source = sources.get(xref);
    if (!source || claimants.includes(xref)) continue;
    const page = childrenByTag(citation, "PAGE")[0]?.value?.trim();
    if (isPageOfSource(image, source, imagesOf(xref, source), page)) claimants.push(xref);
  }
  return claimants.length === 1 ? claimants[0] : undefined;
}

/** Walk every citation in the file, reporting the ones whose container is
 *  missing the cited page's image — and the pages beside a citation that the
 *  cited book does not hold. Shared by the scan and the apply, so the rows
 *  offered and the pointers written can never diverge. */
function collect(
  records: GedNode[],
  sources: Map<string, GedNode>,
  objes: ObjeIndex,
  onMissing: (container: GedNode, record: GedNode, sourceXref: string, objeXref: string, page: string | undefined) => void,
  onAmbiguous?: (sourceXref: string) => void,
  onUnfiled?: (record: GedNode, container: GedNode, sourceXref: string, objeXref: string, page: string | undefined) => void,
): void {
  const imagesBySource = new Map<string, { xref: string; url: string; page?: string }[]>();
  const imagesOf = (xref: string, node: GedNode) => {
    const cached = imagesBySource.get(xref);
    if (cached) return cached;
    const images = pageImagesOf(node, objes);
    imagesBySource.set(xref, images);
    return images;
  };

  for (const record of records) {
    if ((record.tag !== "INDI" && record.tag !== "FAM") || !record.xref) continue;
    for (const container of containersOf(record)) {
      const linked = new Set(
        childrenByTag(container, "OBJE").map((c) => c.value?.trim()).filter((v): v is string => !!v),
      );
      // A page beside a citation whose own book does not hold it. The book is
      // where a page belongs — it is what lets every other citation of it be
      // given the right page — so this is reported wherever it is found, and
      // fixed before the pass below reads which pages a source has.
      if (onUnfiled) {
        for (const xref of linked) {
          const info = objes.get(xref);
          if (!info?.url) continue;
          const owner = citationForImage(container, sources, { url: info.url, title: info.title }, imagesOf);
          if (!owner) continue;
          const source = sources.get(owner)!;
          const held = childrenByTag(source, "OBJE").some((c) => c.value?.trim() === xref);
          if (!held) onUnfiled(record, container, owner, xref, pageOfImage(info.url));
        }
      }
      // A page *link* is already beside this fact: the reader has answered
      // which page documents it, and a second link would not be a completion
      // but a contradiction — that is how a page whose image never joined its
      // source record got another one hung next to it.
      //
      // A local file — a portrait, or the reader's own downloaded scan of the
      // page — is not that answer and does not hold the link off: an image on
      // the disk and the register's own page are different things to have, and
      // a fact is welcome to both.
      if ([...linked].some((xref) => objes.get(xref)?.url)) continue;
      for (const citation of childrenByTag(container, "SOUR")) {
        const sourceXref = citation.value?.trim();
        if (!sourceXref || !isPointer(sourceXref)) continue;
        const source = sources.get(sourceXref);
        if (!source) continue;
        const page = childrenByTag(citation, "PAGE")[0]?.value?.trim();
        const image = imageForCitation(imagesOf(sourceXref, source), page);
        if (!image) continue;
        if (image === "ambiguous") {
          onAmbiguous?.(sourceXref);
          continue;
        }
        if (linked.has(image.xref)) continue;
        onMissing(container, record, sourceXref, image.xref, page);
        // Written or merely reported, this page is spoken for on this
        // container: a record citing the same page twice needs one pointer.
        linked.add(image.xref);
      }
    }
  }
}

function sourceIndex(records: GedNode[]): Map<string, GedNode> {
  const map = new Map<string, GedNode>();
  for (const rec of records) if (rec.tag === "SOUR" && rec.xref) map.set(rec.xref, rec);
  return map;
}

/**
 * Scan the file for citations missing their page image. `style` is the file's
 * page-link style as the reader's settings resolve it: under "source only"
 * there is nothing to report — the images belong under the source there, and
 * the main scan already offers the pointers that should not be beside a
 * citation.
 */
export function findMissingPageMedia(dataset: Dataset, style: PageMediaStyle): PageMediaReport {
  if (style !== "event") return EMPTY;
  const records = dataset.records;
  const sources = sourceIndex(records);
  if (sources.size === 0) return EMPTY;
  const objes = buildObjeIndex(records);
  const bySource = new Map<string, PageMediaGroup>();
  const groupFor = (sourceXref: string): PageMediaGroup => {
    const existing = bySource.get(sourceXref);
    if (existing) return existing;
    const source = sources.get(sourceXref)!;
    const group: PageMediaGroup = {
      id: `pm:${sourceXref}`,
      sourceXref,
      title: sourceTitle(source) || sourceXref,
      missing: [],
      unfiled: [],
      ambiguous: 0,
    };
    bySource.set(sourceXref, group);
    return group;
  };

  collect(
    records,
    sources,
    objes,
    (container, record, sourceXref, objeXref, page) => {
      groupFor(sourceXref).missing.push({
        recordXref: record.xref!,
        eventTag: container === record ? undefined : container.tag,
        page,
        objeXref,
      });
    },
    (sourceXref) => {
      groupFor(sourceXref).ambiguous++;
    },
    (record, container, sourceXref, objeXref, page) => {
      groupFor(sourceXref).unfiled.push({
        recordXref: record.xref!,
        eventTag: container === record ? undefined : container.tag,
        objeXref,
        page,
      });
    },
  );

  // A source whose citations are all ambiguous has nothing to offer, and a row
  // that can only say "no" is not worth a line in the list.
  const groups = [...bySource.values()].filter((g) => g.missing.length + g.unfiled.length > 0);
  const work = (g: PageMediaGroup) => g.missing.length + g.unfiled.length;
  groups.sort((a, b) => work(b) - work(a) || a.title.localeCompare(b.title));
  return {
    groups,
    total: groups.reduce((n, g) => n + g.missing.length, 0),
    unfiled: groups.reduce((n, g) => n + g.unfiled.length, 0),
    ambiguous: groups.reduce((n, g) => n + g.ambiguous, 0),
  };
}

/**
 * Link the missing page images for the selected sources, on a fresh clone of
 * `records` — the input is never touched, like every other whole-file tool
 * here. The pass re-derives what to write rather than replaying positions the
 * scan recorded: an edit (or an earlier pass of the same apply) between scan
 * and apply then costs a row, never a pointer on the wrong node.
 */
export function linkMissingPageMedia(
  records: GedNode[],
  sourceXrefs: ReadonlySet<string>,
): { records: GedNode[]; count: number } {
  if (sourceXrefs.size === 0) return { records, count: 0 };
  const clone = records.map(cloneNode);
  const sources = sourceIndex(clone);
  let count = 0;

  // 1. Every page beside a citation joins the book it is a page of. First, and
  // for one reason: the pass below then reads a book that knows all its own
  // pages, so a source that looked like it held a single page — and would have
  // answered for every citation of it — is no longer read that way.
  collect(clone, sources, buildObjeIndex(clone), () => {}, undefined, (_record, _container, sourceXref, objeXref) => {
    if (!sourceXrefs.has(sourceXref)) return;
    const source = sources.get(sourceXref);
    if (!source) return;
    insertGrouped(source, { level: source.level + 1, tag: "OBJE", value: objeXref, children: [] }, SOUR_TRAILING_TAGS);
    count++;
  });

  // 2. …and every citation gets the page its book now knows about.
  collect(clone, sources, buildObjeIndex(clone), (container, record, sourceXref, objeXref) => {
    // A source merged away by an earlier pass of the same apply is no longer
    // this run's to fix; the citation now points at the survivor, and the next
    // scan offers it under that one.
    if (!sourceXrefs.has(sourceXref)) return;
    const order =
      container === record ? (record.tag === "FAM" ? FAM_CHILD_ORDER : INDI_CHILD_ORDER) : EVENT_CHILD_ORDER;
    linkPageMedia(container, objeXref, order);
    count++;
  });
  return count > 0 ? { records: clone, count } : { records, count: 0 };
}

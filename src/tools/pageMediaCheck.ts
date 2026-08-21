import type { Dataset, GedNode } from "../gedcom/types";
import { childrenByTag, cloneNode } from "../gedcom/node";
import { FAM_EVENT_TAGS, INDI_EVENT_TAGS } from "../gedcom/eventTags";
import { linkPageMedia } from "../gedcom/edit";
import { EVENT_CHILD_ORDER, FAM_CHILD_ORDER, INDI_CHILD_ORDER } from "../gedcom/edit/shared";
import { buildObjeIndex, isPointer, pageParamOf, sourceTitle, type ObjeIndex } from "../gedcom/source";
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

/** One source, with the citations of it that are missing their page image. */
export interface PageMediaGroup {
  /** Stable identity (`pm:${sourceXref}`), the selection/React key. */
  id: string;
  sourceXref: string;
  title: string;
  missing: MissingPageMedia[];
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
  /** Citations left alone because which image they mean is not knowable. */
  ambiguous: number;
}

const EMPTY: PageMediaReport = { groups: [], total: 0, ambiguous: 0 };

/** The page number an image's own URL states — the `pg=` a register link
 *  carries, or the image a FamilySearch ark was copied at. */
function pageOfImage(url: string): string | undefined {
  return pageParamOf(url) ?? parseFamilySearchUrl(url)?.image;
}

/** The page images a `SOUR` record holds, in file order. */
function pageImagesOf(source: GedNode, objes: ObjeIndex): { xref: string; page?: string }[] {
  const out: { xref: string; page?: string }[] = [];
  for (const child of childrenByTag(source, "OBJE")) {
    const xref = child.value?.trim();
    if (!xref || !isPointer(xref)) continue;
    const url = objes.get(xref)?.url;
    if (url) out.push({ xref, page: pageOfImage(url) });
  }
  return out;
}

/**
 * Which image a citation means, or why it cannot be said. A source with one
 * page image answers for every citation of it; with several, only the cited
 * page tells them apart, and a citation that names no page (or names one no
 * image carries) is left alone.
 */
function imageForCitation(
  images: { xref: string; page?: string }[],
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

/** Walk every citation in the file, reporting the ones whose container is
 *  missing the cited page's image. Shared by the scan and the apply, so the
 *  rows offered and the pointers written can never diverge. */
function collect(
  records: GedNode[],
  sources: Map<string, GedNode>,
  objes: ObjeIndex,
  onMissing: (container: GedNode, record: GedNode, sourceXref: string, objeXref: string, page: string | undefined) => void,
  onAmbiguous?: (sourceXref: string) => void,
): void {
  // Every media record any source in the file holds as a page. A file that
  // downloaded its scans has them here without a URL to tell them by, and one
  // of those already beside a citation is that citation's page.
  const sourceMedia = new Set<string>();
  for (const source of sources.values()) {
    for (const child of childrenByTag(source, "OBJE")) {
      const xref = child.value?.trim();
      if (xref && isPointer(xref)) sourceMedia.add(xref);
    }
  }
  const imagesBySource = new Map<string, { xref: string; page?: string }[]>();
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
      // A page image is already beside this fact: the reader has answered which
      // page documents it, and a second one would not be a completion but a
      // contradiction. Two shapes count as one — a linked page URL, and a media
      // record some source holds as a page, which is what a *downloaded* scan
      // of that page looks like (no URL to recognize it by). A plain photo is
      // neither: a portrait says nothing about which register page documents
      // the fact, and must not hold the page image off.
      if ([...linked].some((xref) => objes.get(xref)?.url || sourceMedia.has(xref))) continue;
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
  );

  // A source whose citations are all ambiguous has nothing to offer, and a row
  // that can only say "no" is not worth a line in the list.
  const groups = [...bySource.values()].filter((g) => g.missing.length > 0);
  groups.sort((a, b) => b.missing.length - a.missing.length || a.title.localeCompare(b.title));
  return {
    groups,
    total: groups.reduce((n, g) => n + g.missing.length, 0),
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
  const objes = buildObjeIndex(clone);
  let count = 0;
  collect(clone, sources, objes, (container, record, sourceXref, objeXref) => {
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

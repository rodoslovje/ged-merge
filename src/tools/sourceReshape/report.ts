import {
  ALL_SITES,
  type BookType,
  DEFAULT_SITES,
  INLINE_VALUE_LINK_TAGS,
  type PageMediaStyle,
  type ReshapeGroup,
  type ReshapeOccurrence,
  type ReshapeOptions,
  type ReshapeReport,
  type ReshapeSite,
} from "./model";
import {
  ACCEPTABLE_TAGS,
  baptismTargetTag,
  bookEventTarget,
  classifyBookType,
  detectPageMediaStyle,
  prefersDoubledLinks,
  type ScanHit,
  scanOccurrences,
} from "./scan";
import type { Dataset, GedNode } from "../../gedcom/types";
import {
  bookKeyOf,
  buildObjeIndex,
  detectSourceCoverage,
  isPointer,
  type ObjeIndex,
  repoLinkWanted,
  sourceTitle,
} from "../../gedcom/source";
import { linkKey } from "../../normalize/links";
import { URL_RE } from "../../gedcom/builder";
import { cleanUrl } from "./urls";
import { childrenByTag, childText, firstChild } from "../../gedcom/node";
import type { FormatOverrides } from "../../normalize/formatOverrides";
import { label } from "../../match/relatives";
import { familySpouses } from "../sources";

// ---------------------------------------------------------------------------
// Grouping + report

const SITE_ORDER = new Map<ReshapeSite, number>(ALL_SITES.map((s, i) => [s, i]));

/** Sites whose record kind is inherent: graves → burial, obituaries and
 *  war-casualty records → death. */
export const SITE_BOOK_TYPE: Partial<Record<ReshapeSite, BookType>> = {
  geneanet: "burial",
  findagrave: "burial",
  billiongraves: "burial",
  legacy: "death",
  sistory: "death",
};

/**
 * The event a recognized site's page documents, where the site's own kind
 * settles it — a grave photograph is evidence of the burial, an obituary of the
 * death. {@link smartCitationTarget} asks the same question of a whole file;
 * this is for callers that have only the link, such as the index CSV import
 * hanging a cemetery link on the burial it came with.
 */
export function siteEventTag(site: ReshapeSite): string | undefined {
  const type = SITE_BOOK_TYPE[site];
  return type === "burial" ? "BURI" : type === "death" ? "DEAT" : undefined;
}

interface GroupState {
  group: ReshapeGroup;
  hits: ScanHit[];
  titleRank: number;
}

/** Re-do {@link mergeFsBooks}' fold on a freshly scanned group map: the pages
 *  of one book become one group, standing where the first of them stood — the
 *  order the panel listed them in, and so the order their records are made in. */
export function foldMergedGroups(
  groups: Map<string, GroupState>,
  mergeGroups: ReadonlyMap<string, string> | undefined,
): Map<string, GroupState> {
  if (!mergeGroups?.size) return groups;
  const folded = new Map<string, GroupState>();
  for (const [key, state] of groups) {
    const target = mergeGroups.get(key) ?? key;
    const into = folded.get(target);
    if (!into) {
      folded.set(target, target === key ? state : { ...state, group: { ...state.group, id: target } });
      continue;
    }
    into.hits.push(...state.hits);
    // The book's source is whichever of its pages the file already cites —
    // the panel resolved it the same way, so the apply must not decide to
    // create a new record just because the first page happened to be new.
    if (!into.group.existingSourceXref && state.group.existingSourceXref) {
      into.group.existingSourceXref = state.group.existingSourceXref;
      into.group.existingSourceTitle = state.group.existingSourceTitle;
      into.group.urlTitled = state.group.urlTitled;
    }
  }
  return folded;
}

export function buildGroups(records: GedNode[], hits: ScanHit[], foldDuplicates: boolean): Map<string, GroupState> {
  // Existing-source lookup built in ONE pass over the SOUR records (same
  // exact-URL-first / same-book-second precedence as findExistingSource) —
  // calling findExistingSource per group would rescan the whole forest each time.
  const objeIndex = buildObjeIndex(records);
  const exactSource = new Map<string, GedNode>();
  const bookSource = new Map<string, GedNode>();
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    for (const child of rec.children) {
      if (child.tag !== "OBJE" || !child.value) continue;
      const url = objeIndex.get(child.value.trim())?.url;
      if (!url) continue;
      const exactKey = linkKey(url);
      if (!exactSource.has(exactKey)) exactSource.set(exactKey, rec);
      const bookKey = bookKeyOf(url);
      if (!bookSource.has(bookKey)) bookSource.set(bookKey, rec);
    }
  }

  const groups = new Map<string, GroupState>();
  for (const hit of hits) {
    const { recognized } = hit;
    let state = groups.get(recognized.groupKey);
    if (!state) {
      // A URL-titled SOUR record in the group becomes its target: badge as reuse.
      const existingNode = exactSource.get(linkKey(hit.url)) ?? bookSource.get(bookKeyOf(hit.url));
      state = {
        group: {
          id: recognized.groupKey,
          site: recognized.site,
          bookType: "unknown",
          existingSourceXref: existingNode?.xref,
          existingSourceTitle: existingNode ? sourceTitle(existingNode) : undefined,
          proposed: recognized.proposed,
          bookUrl: recognized.bookUrl,
          pages: [],
          members: [],
        },
        hits: [],
        titleRank: recognized.titleRank ?? 0,
      };
      groups.set(recognized.groupKey, state);
    } else if ((recognized.titleRank ?? 0) > state.titleRank) {
      // A later member carries a more specific title (e.g. the person's name).
      state.group.proposed = recognized.proposed;
      state.titleRank = recognized.titleRank ?? 0;
    }
    if (!state.group.existingSourceXref && hit.shape === "sourTitle" && hit.rec.xref) {
      state.group.existingSourceXref = hit.rec.xref;
      state.group.existingSourceTitle = undefined; // it's the URL — will be rewritten
      state.group.urlTitled = true;
    }
    if (hit.recognized.page && !state.group.pages.includes(hit.recognized.page)) {
      state.group.pages.push(hit.recognized.page);
    }
    state.hits.push(hit);
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  for (const state of groups.values()) {
    // A record-level attachment duplicated by an event-level one on the same
    // person: in a file that keeps links in one place it folds into the event
    // (one citation, at the more precise spot); in a file that doubles links
    // (MacFamilyTree style) both citations are kept, matching the house style.
    // Event twins are indexed in one pass — groups can have hundreds of members.
    const eventTwins = new Map<string, string>();
    for (const h of state.hits) {
      if (!h.eventTag) continue;
      const twinKey = `${h.rec.xref}|${linkKey(h.url)}`;
      if (!eventTwins.has(twinKey)) eventTwins.set(twinKey, h.eventTag);
    }
    for (const hit of state.hits) {
      if (hit.eventTag || hit.shape === "sourTitle") continue;
      const twin = eventTwins.get(`${hit.rec.xref}|${linkKey(hit.url)}`);
      if (!twin) continue;
      if (foldDuplicates) hit.foldedInto = twin;
      else hit.twinEvent = twin;
    }
    state.group.pages.sort((a, b) => collator.compare(a, b));
    state.group.bookType =
      SITE_BOOK_TYPE[state.group.site] ??
      classifyBookType([
        state.group.existingSourceTitle,
        state.group.proposed.title,
        ...state.hits.map((h) => h.typeText),
        ...state.hits.map((h) => h.prefix),
        // Generic links often say what they are in the URL itself
        // ("…/obituaries/ann-vidmar", "…/pogreb-angela-zupancic").
        ...(state.group.site === "other" ? state.hits.map((h) => h.url) : []),
      ]);
  }
  return groups;
}

/** Record lookups the relocation decision needs beyond the hit itself
 *  (identifying which family a multi-marriage person's link belongs to). */
export interface RelocationContext {
  byXref: Map<string, GedNode>;
  urlOfObje: (xref: string) => string | undefined;
}

/** Whether a container's direct children carry the given link — a media
 *  pointer resolving to the URL, an inline OBJE FILE, or a bare link tag. */
function carriesLink(container: GedNode, urlKey: string, urlOfObje: (xref: string) => string | undefined): boolean {
  for (const c of container.children) {
    if (INLINE_VALUE_LINK_TAGS.has(c.tag) && c.value) {
      for (const m of c.value.matchAll(URL_RE)) if (linkKey(cleanUrl(m[0])) === urlKey) return true;
    } else if (c.tag === "OBJE") {
      const v = c.value?.trim();
      const url = v && isPointer(v) ? urlOfObje(v) : childText(c, "FILE");
      if (url && linkKey(url) === urlKey) return true;
    }
  }
  return false;
}

/** Whether a container already cites the source at exactly this page. */
function citesSourcePage(container: GedNode, sourceXref: string, page: string | undefined): boolean {
  return childrenByTag(container, "SOUR").some(
    (c) => c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === (page ?? ""),
  );
}

/**
 * The FAM a marriage-book link on a person belongs to. A single FAMS is
 * unambiguous; with several, exactly one family may be tied to the same page
 * by evidence: its MARR already cites the source at that page, the family (or
 * its MARR) carries the same link, or the other spouse does. Zero or several
 * matching families → undefined (the citation stays on the person).
 */
function resolveMarriageFam(hit: ScanHit, ctx: RelocationContext, sourceXref: string | undefined): string | undefined {
  const fams = childrenByTag(hit.rec, "FAMS")
    .map((c) => c.value?.trim())
    .filter((v): v is string => !!v && isPointer(v));
  if (fams.length <= 1) return fams[0];
  const urlKey = linkKey(hit.url);
  const matches = fams.filter((famXref) => {
    const fam = ctx.byXref.get(famXref);
    if (!fam) return false;
    const marrs = childrenByTag(fam, "MARR");
    if (sourceXref && marrs.some((m) => citesSourcePage(m, sourceXref, hit.recognized.page))) return true;
    if (carriesLink(fam, urlKey, ctx.urlOfObje) || marrs.some((m) => carriesLink(m, urlKey, ctx.urlOfObje))) {
      return true;
    }
    return ["HUSB", "WIFE"].some((tag) => {
      const spouseXref = childText(fam, tag);
      if (!spouseXref || spouseXref === hit.rec.xref) return false;
      const spouse = ctx.byXref.get(spouseXref);
      return !!spouse && carriesLink(spouse, urlKey, ctx.urlOfObje);
    });
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Resolve where a hit's citation should attach under the relocation option.
 *  Returns undefined when it stays at its original container; `famXref` names
 *  the FAM record hosting the event when the move crosses records. */
export function relocationTarget(
  hit: ScanHit,
  bookType: BookType,
  baptismTag: "BIRT" | "BAPM",
  ctx: RelocationContext,
  sourceXref: string | undefined,
): { eventTag: string; famXref?: string } | undefined {
  if (bookType === "unknown" || hit.shape === "sourTitle") return undefined;
  const acceptable = ACCEPTABLE_TAGS[bookType];
  if (hit.eventTag && acceptable.has(hit.eventTag)) return undefined;

  if (bookType === "marriage") {
    if (hit.rec.tag === "FAM") return hit.eventTag === "MARR" ? undefined : { eventTag: "MARR" };
    // From a person the move must name one family: the sole FAMS, or the one
    // the page's own evidence singles out among several.
    const famXref = resolveMarriageFam(hit, ctx, sourceXref);
    return famXref ? { eventTag: "MARR", famXref } : undefined;
  }

  const target = bookEventTarget(hit.rec.tag, hit.eventTag, bookType, baptismTag);
  return target ? { eventTag: target } : undefined;
}

/** An owned page-image pointer already sitting beside its final citation
 *  (same source and page) with no relocation left to make — the shape a
 *  previous apply leaves, and the shape a reader who cited the source by hand
 *  leaves too. The report hides it and the apply skips it, so reruns converge
 *  to zero.
 *
 *  The citation alone settles it. It used to have to carry a `QUAY` as well —
 *  a mark only a run with a citation quality chosen ever writes — so with the
 *  quality left unset the row was offered for ever: every apply found the
 *  citation already there, wrote nothing, and the re-scan listed it again. */
export function isSettledPointer(
  hit: ScanHit,
  move: { eventTag: string } | undefined,
  /** The source this run would cite, plus every other source in the file whose
   *  own page media is this very page. One image under two source records is a
   *  file's own doing (two books overlapping, a duplicate left behind), and
   *  which of them the scan picks is a matter of record order — so a citation
   *  of *either* is this pointer's citation. Reading only the picked one left
   *  the row offered for ever, and each apply hung a second citation of the
   *  other source on the same event. */
  sourceXrefs: readonly (string | undefined)[],
  pageMedia: PageMediaStyle,
  page: string | undefined,
  /** The quality this run would write, if the reader chose one — a citation
   *  still owed a `QUAY` has work left in it. */
  quay: string | undefined,
): boolean {
  if (hit.shape !== "obje" || !hit.objeXref || move || hit.foldedInto || hit.twinEvent) return false;
  const cites = new Set(sourceXrefs.filter((x): x is string => !!x));
  if (pageMedia !== "event" || cites.size === 0) return false;
  // With no page known this run, any citation of the source settles the
  // pointer: a PAGE that only enrichment knows (the grave plot) isn't
  // derivable from the URL, so an offline rerun must still converge instead
  // of re-attaching a page-less citation beside the enriched one.
  const cite = childrenByTag(hit.container, "SOUR").find(
    (c) => cites.has(c.value?.trim() ?? "") && (page === undefined || (childText(c, "PAGE") ?? "") === page),
  );
  return !!cite && (!quay || !!firstChild(cite, "QUAY"));
}

/** Which sources hold each page as their own media (`SOUR > OBJE > FILE`), by
 *  the page's link key — several where the file keeps the same image under
 *  more than one source. Built in one pass; see {@link isSettledPointer}. */
export function sourcesHoldingPages(records: GedNode[], objeIndex: ObjeIndex): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    for (const child of rec.children) {
      if (child.tag !== "OBJE" || !child.value) continue;
      const url = objeIndex.get(child.value.trim())?.url;
      if (!url) continue;
      const key = linkKey(url);
      const held = map.get(key);
      if (held) held.push(rec.xref);
      else map.set(key, [rec.xref]);
    }
  }
  return map;
}


/** The user's format overrides mapped to the reshape options the scan and the
 *  apply consume — absent overrides stay "auto" (detect from the file). The
 *  report (tools worker) and the apply MUST both run through this, or the
 *  preview can drift from what the download writes. */
export function reshapeOptionsFromOverrides(o: FormatOverrides | undefined): ReshapeOptions {
  return {
    pageMedia: o?.pageMedia ?? "auto",
    sourceLayout: o?.sourceLayout ?? "auto",
    baptism: o?.baptism ?? "auto",
    doubledLinks: o?.doubledLinks ?? "auto",
    sourceCoverage: o?.sourceCoverage ?? "auto",
  };
}

/** Resolve the "auto" members of {@link ReshapeOptions} against the records. */
export function resolveFormatOptions(records: GedNode[], opts: ReshapeOptions) {
  const auto = <T,>(v: T | "auto" | undefined, detect: () => T): T => (v && v !== "auto" ? v : detect());
  return {
    fold: auto(opts.doubledLinks, () => (prefersDoubledLinks(records) ? "keep" : "fold")) === "fold",
    pageMedia: auto(opts.pageMedia, () => detectPageMediaStyle(records)),
    baptismTag: auto(opts.baptism, () => baptismTargetTag(records)),
    coverage: auto(opts.sourceCoverage, () => detectSourceCoverage(records)),
    // Repository creation is its own habit, independent of the page-link
    // shape (files with page-link sources usually ALSO repo-link each one) —
    // see `repoLinkWanted`.
    createRepos: repoLinkWanted(records, opts.sourceLayout),
  };
}

/**
 * Scan the whole main file for reshapeable site links, grouped by archive book
 * / cemetery grave / FS film. Pure and synchronous; safe to run in the tools
 * worker (the report is plain data).
 */
export function findReshapableLinks(
  dataset: Dataset,
  sites: ReadonlySet<ReshapeSite> = DEFAULT_SITES,
  opts: ReshapeOptions = {},
): ReshapeReport {
  const relocate = opts.relocate !== false;
  const { fold, pageMedia, baptismTag } = resolveFormatOptions(dataset.records, opts);
  const hits = scanOccurrences(dataset.records, sites, fold ? pageMedia : undefined);
  const groups = buildGroups(dataset.records, hits, fold);
  const byXref = new Map<string, GedNode>();
  for (const r of dataset.records) if (r.xref) byXref.set(r.xref, r);
  const objeIndex = buildObjeIndex(dataset.records);
  const ctx: RelocationContext = { byXref, urlOfObje: (xref) => objeIndex.get(xref)?.url };
  const pageHolders = sourcesHoldingPages(dataset.records, objeIndex);

  const recordLabel = (rec: GedNode): string => {
    if (rec.tag === "INDI") {
      const indi = rec.xref ? dataset.individuals.get(rec.xref) : undefined;
      return indi ? label(indi) : rec.xref ?? "?";
    }
    if (rec.tag === "FAM" && rec.xref) {
      const spouses = familySpouses(dataset, rec.xref);
      if (spouses.length) return spouses.map((s) => s.label).join(" & ");
    }
    return rec.xref ?? "?";
  };

  const out: ReshapeGroup[] = [];
  let total = 0;
  const bySite = Object.fromEntries(ALL_SITES.map((s) => [s, 0])) as Record<ReshapeSite, number>;
  for (const state of groups.values()) {
    const g = state.group;
    g.members = state.hits.flatMap((hit) => {
      const move =
        relocate && !hit.foldedInto && !hit.twinEvent
          ? relocationTarget(hit, g.bookType, baptismTag, ctx, g.existingSourceXref)
          : undefined;
      const holders = [g.existingSourceXref, ...(pageHolders.get(linkKey(hit.url)) ?? [])];
      if (isSettledPointer(hit, move, holders, pageMedia, hit.recognized.page, opts.quay)) return [];
      return [
        {
          recordXref: hit.rec.xref ?? "?",
          recordLabel: recordLabel(hit.rec),
          recordTag: hit.rec.tag as ReshapeOccurrence["recordTag"],
          eventTag: hit.eventTag,
          eventIndex: hit.eventIndex,
          shape: hit.shape,
          url: hit.url,
          page: hit.recognized.page,
          prefix: hit.prefix,
          targetEvent: move?.eventTag,
          targetFam: move?.famXref,
          foldedInto: hit.foldedInto,
        },
      ];
    });
    if (g.members.length === 0) continue; // everything already in its final shape
    total += g.members.length;
    bySite[g.site] += g.members.length;
    out.push(g);
  }

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  out.sort(
    (a, b) => SITE_ORDER.get(a.site)! - SITE_ORDER.get(b.site)! || collator.compare(a.proposed.title, b.proposed.title),
  );
  return { groups: out, totalOccurrences: total, bySite };
}
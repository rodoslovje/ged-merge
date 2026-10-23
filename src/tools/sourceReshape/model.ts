import { SOUR_TRAILING_TAGS } from "../../gedcom/edit/sources";
import { parseFamilySearchUrl } from "../../normalize/links";
import type { SourceLayout } from "../../normalize/types";
import { EDITABLE_LINK_TAGS } from "../../gedcom/edit/shared";

/** Trailing block of a `SOUR` record that new links must stay ahead of —
 *  shared with the edit dialog's field writer (see gedcom/edit/sources). */
export const SOUR_TRAILING = SOUR_TRAILING_TAGS;
/** What sits at the tail of a media record — a title goes in front of it. */
export const MEDIA_TRAILING = ["NOTE", "CHAN", "CREA", "_UPD"] as const;

/** Every site category, in display/sort order — the single list every other
 *  per-site structure (defaults, ordering, counters, worker scan, view) is
 *  derived from. Add a new site here first. */
export const ALL_SITES = [
  "matricula",
  "geneanet",
  "geneanettree",
  "findagrave",
  "billiongraves",
  "legacy",
  "newspapers",
  "sistory",
  "dlib",
  "googlebooks",
  "youtube",
  "wikipedia",
  "biografija",
  "obrazi",
  "familysearch",
  "other",
] as const;

export type ReshapeSite = (typeof ALL_SITES)[number];

/** Sites the enrichment fetch can usefully contact — Newspapers.com sits behind
 *  a bot wall (verified: every relay gets the challenge page) and generic links
 *  have no parser. FamilySearch answers for one link shape only: an image page,
 *  whose ark serves the record's own citation as JSON. Indexed record pages need
 *  a login and catalog films carry no citation at all, so both keep their
 *  offline fields. Shared by the fetcher and the panel's button/progress so
 *  they can't disagree. */
export function isFetchableSite(site: ReshapeSite, bookUrl?: string): boolean {
  if (site === "familysearch") return bookUrl !== undefined && isFamilySearchImageArk(bookUrl);
  return site !== "newspapers" && site !== "other";
}

/** A FamilySearch image ark {@link parseFamilySearchArkJson} has something to
 *  read. The collection needs no `cc=` in the link — FamilySearch resolves it
 *  from the ark itself — but a catalog film (`cat=`) answers with the bare
 *  image and no citation, however the URL is written. */
export function isFamilySearchImageArk(url: string): boolean {
  const fs = parseFamilySearchUrl(url);
  return fs?.kind === "image" && !fs.cat;
}

export type ReshapeShape = "link" | "webtag" | "obje" | "note" | "inline" | "pageUrl" | "sourTitle";

/** Register type of a group's book, driving event placement. */
export type BookType = "baptism" | "marriage" | "death" | "burial" | "unknown";

/** One converted link occurrence — plain data (crosses `postMessage`). */
export interface ReshapeOccurrence {
  recordXref: string;
  recordLabel: string;
  recordTag: "INDI" | "FAM" | "SOUR";
  /** BIRT/DEAT/MARR/… when the link sits on an event; undefined = record level. */
  eventTag?: string;
  /** Index among same-tag events (two RESI), for display. */
  eventIndex?: number;
  shape: ReshapeShape;
  /** The original URL text (language/casing kept). */
  url: string;
  /** Page number (`?pg=` / FS image index), if any. */
  page?: string;
  /** Citation text around the URL (inline shape), e.g. "KK". */
  prefix?: string;
  /** Event tag the citation will move to when relocation applies. */
  targetEvent?: string;
  /** FAM xref the citation moves to (marriage books cited on a person). */
  targetFam?: string;
  /** Event tag whose identical citation supersedes this record-level one —
   *  the same URL is also attached to that event, so only the (more precise)
   *  event citation is written and this occurrence is just cleaned up. */
  foldedInto?: string;
  /** Per-citation QUAY override (set by the panel); falls back to the group's. */
  quay?: string;
  /** Panel-set: the link the reader put in this one's place in the ✎ editor —
   *  a FamilySearch record page (sign-in only, so no lookup reaches it) traded
   *  for the image it was indexed from. The apply writes this occurrence's page
   *  media with that URL and re-points the media record the file already holds;
   *  the citation itself is unaffected. It rides on the occurrence, not the
   *  group, so it survives the pages of one film being folded into one book. */
  swapUrl?: string;
}

/** All occurrences of one archive book / cemetery grave / FS film or collection. */
export interface ReshapeGroup {
  /** Stable identity (site-prefixed canonical key), the selection/React key. */
  id: string;
  site: ReshapeSite;
  bookType: BookType;
  /** Existing `SOUR` record new citations will reuse; undefined = create one. */
  existingSourceXref?: string;
  existingSourceTitle?: string;
  /** The reused record is a URL-titled SOUR the apply rewrites in place — it
   *  still wants enrichment, unlike a source with a real title. */
  urlTitled?: boolean;
  /** Offline-derived source fields; enrichment overrides them on apply. */
  proposed: { title: string; author?: string; agency?: string; place?: string; filingNumber?: string; dateRange?: string };
  /** Canonical page-independent URL — display + enrichment fetch target. */
  bookUrl: string;
  /** Distinct page numbers cited, numerically sorted. */
  pages: string[];
  members: ReshapeOccurrence[];
  /** Default QUAY for this group's written citations (set by the panel);
   *  each member may carry its own override. */
  quay?: string;
  /** Panel-set: the apply strips this group's link occurrences (dead or
   *  obsolete URLs) instead of converting them — surrounding citation prose
   *  and note text stay, no source is created or reused. */
  removeLinks?: boolean;
}

export interface ReshapeReport {
  groups: ReshapeGroup[];
  totalOccurrences: number;
  bySite: Record<ReshapeSite, number>;
}

/** Fetched metadata for one book — overrides the group's `proposed` on apply. */
export interface ReshapeMeta {
  title?: string;
  author?: string;
  periodical?: string;
  publisher?: string;
  agency?: string;
  place?: string;
  /** Sub-place detail (the cemetery name) — becomes the BURI event's
   *  ADDR in files whose place format keeps addresses separate. */
  address?: string;
  /** Where within the source, for every citation in the group — the grave
   *  plot ("P06"). A page id the link itself carries wins over this. */
  page?: string;
  dateRange?: string;
  bookType?: BookType;
  /** Set by the panel's manual field editor, or — for a FamilySearch image —
   *  the film (DGS) number its ark resolves to; page parsers never override
   *  the offline id otherwise. An empty string clears the proposed one. */
  filingNumber?: string;
  /** The published collection an image belongs to ("Croatia, Church Books,
   *  1516-1994") and its FamilySearch id. Not source fields: they name and find
   *  the repository, for files that keep one per FamilySearch collection. */
  collection?: string;
  collectionId?: string;
  /** The repository the reader picked in the panel's field editor for a source
   *  this run creates: an existing `REPO`'s xref, `"@create@"` for the one the
   *  site proposes (created even where the file's own habit would not), or `""`
   *  for none at all. Left undefined, the file's habit decides as before. */
  repoXref?: string;
  /** The register label the title was built from ("Births (Rođeni) 1892-1899
   *  Marriages (Vjenčani) 1858-1890"). Kept so a book naming several registers
   *  can be narrowed to the one being cited — see {@link splitFsRegisters}. */
  book?: string;
}

/** Per-group fetched metadata (keys = group ids). */
export type ReshapeEnrichment = Map<string, ReshapeMeta>;

/** Where a paginated source's page images are referenced from, besides the
 *  source record itself: "event" additionally links each cited page's OBJE on
 *  the event beside its citation (webtrees shows it inline with the fact);
 *  "source" keeps them on the source record only. */
export type PageMediaStyle = "event" | "source";

export interface ReshapeOptions {
  /** Move citations onto their matching event (baptism→BIRT/BAPM, marriage→MARR,
   *  death→DEAT, cemetery→BURI). Default true. */
  relocate?: boolean;
  /** Page-image placement; "auto" (default) detects the file's own habit. */
  pageMedia?: PageMediaStyle | "auto";
  /** Source layout override (drives repository creation); "auto" = detect. */
  sourceLayout?: SourceLayout | "auto";
  /** Baptism-citation target override; "auto" = the file's BIRT/BAPM habit. */
  baptism?: "BIRT" | "BAPM" | "auto";
  /** Original group id → the book it was folded into ({@link mergeFsBooks}),
   *  so the apply groups its own scan exactly as the panel showed it. */
  mergeGroups?: ReadonlyMap<string, string>;
  /** Also shorten the links already stored on the media the run touches, down
   *  to the page they name (FamilySearch's viewer state). Off by default: the
   *  records are otherwise fine, so trimming them is the reader's call. */
  tidyLinks?: boolean;
  /** Person+event doubled links: "fold" collapses to one, "keep" keeps both;
   *  "auto" = the file's own habit. */
  doubledLinks?: "fold" | "keep" | "auto";
  /** How a new source states what it covers: flat vendor PLAC/DATE fields, or
   *  the spec's `DATA > EVEN` structure; "auto" = the file's own habit. */
  sourceCoverage?: "vendor" | "standard" | "auto";
  /** The citation quality the run would write, when the reader chose one.
   *  The scan reads it to tell a pointer that is finished from one still owed
   *  a `QUAY`; the apply takes each group's own choice over it. */
  quay?: string;
}

export interface ReshapeCounts {
  sourcesCreated: number;
  sourcesReused: number;
  mediaCreated: number;
  citationsAdded: number;
  citationsRewritten: number;
  linksRemoved: number;
  notesRewritten: number;
  eventsCreated: number;
  /** Stored links shortened to the page they name (`tidyLinks`). */
  linksTidied: number;
  /** Media records re-pointed at a group's replacement link (`swapUrl`). */
  linksSwapped: number;
  /** Page media renamed from a placeholder title to the page's own. */
  mediaRetitled: number;
}

export const DEFAULT_SITES: ReadonlySet<ReshapeSite> = new Set(ALL_SITES.filter((s) => s !== "other"));

/** The editable link tags whose URL sits on the line itself — all but
 *  `_WEBTAG`, which carries it on a `URL`/`WWW` sub-line and is read apart. */
export const INLINE_VALUE_LINK_TAGS = new Set<string>(EDITABLE_LINK_TAGS.filter((t) => t !== "_WEBTAG"));
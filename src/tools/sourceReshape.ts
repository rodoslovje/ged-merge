import type { Dataset, GedNode } from "../gedcom/types";
import { childText, childrenByTag, cloneNode, firstChild } from "../gedcom/node";
import { stripTrailingPunct, URL_RE } from "../gedcom/builder";
import {
  bookKeyOf,
  buildObjeIndex,
  detectSourceCoverage,
  looseKey,
  repoLinkWanted,
  writesCallNumbers,
  isPointer,
  looksLikeUrl,
  pageParamOf,
  sourceTitle,
  type ObjeIndex,
} from "../gedcom/source";
import {
  familySearchImageIndex,
  familySearchImageNumber as imageNumber,
  familySearchPageUrl,
  linkKey,
  parseFamilySearchUrl,
  type FamilySearchUrlParts,
} from "../normalize/links";
import {
  countryCodeOfName,
  countryFacetName,
  countryNameOf,
  foldCountryName,
  placeCountryFacet,
  stateOf,
  titleCountryFacet,
} from "../geo/placeCountry";
import { detectPlaceLayout } from "../normalize/profile";
import { normalizeDateString } from "../normalize/date";
import { dateFixContext, proposeDateFix, type DateFixContext } from "./fixDates";
import type { NormChange, SourceLayout } from "../normalize/types";
import type { FormatOverrides } from "../normalize/formatOverrides";
import { decodeHtmlEntities, fetchDirect, pageTitleOf, type DirectResponse } from "../normalize/urlMetadata";
import { parseSourceInput } from "../gedcom/citationParse";
import { addObjeToSource, createSourceRecord, SOUR_FIELD_TRAILING, SOUR_TRAILING_TAGS } from "../gedcom/edit/sources";
import {
  EVENT_CHILD_ORDER,
  FAM_CHILD_ORDER,
  INDI_CHILD_ORDER,
  insertGrouped,
  insertOrdered,
  insertRecord,
  nextXref,
} from "../gedcom/edit/shared";

/** Trailing block of a `SOUR` record that new links must stay ahead of —
 *  shared with the edit dialog's field writer (see gedcom/edit/sources). */
const SOUR_TRAILING = SOUR_TRAILING_TAGS;
/** What sits at the tail of a media record — a title goes in front of it. */
const MEDIA_TRAILING = ["NOTE", "CHAN", "CREA", "_UPD"] as const;
import { FAM_EVENT_TAGS, INDI_EVENT_TAGS } from "../gedcom/eventTags";
import { isPrivateNode } from "../gedcom/private";
import { label } from "../match/relatives";
import { familySpouses } from "./sources";

/**
 * Whole-file "source reshape": convert Matricula Online / Geneanet Cemeteries /
 * FamilySearch URL links — wherever they appear on a record — into proper
 * top-level `SOUR` records cited via `SOUR @Sn@` + `PAGE n` (the "paginated"
 * shape `resolveSourceCitation` links page-accurately: `TITL/AGNC/PLAC/FILN`
 * plus one `OBJE` per page scan).
 *
 * Like `sourceDuplicates`, this is a pure, synchronous whole-file tool: the
 * scan (`findReshapableLinks`) reports what would change, the apply
 * (`reshapeSources`) clones the record forest and never mutates the input; the
 * caller serializes the result to a download. Metadata is extracted offline
 * from the URL itself; `fetchReshapeMeta` optionally enriches new sources with
 * the real book title / archive / date range from the Matricula book page
 * (one fetch per book, never per page).
 *
 * Not converted (deliberately): pointer NOTEs (shared records — rewriting them
 * has non-local effects), URLs appearing only in a `SOUR` record's own NOTE,
 * non-book Matricula URLs (archive indexes), and unrecognized hosts unless the
 * "other" site category is enabled. FamilySearch is enriched for collection
 * image links only (`parseFamilySearchArkJson`): everything else there — record
 * pages, catalog films — sits behind a login, and offline signals (quoted
 * collection titles, `cat`/`i` params) carry it. Deferred follow-ups: FS API
 * OAuth for record pages, and a placement audit for pre-existing pointer
 * citations.
 */

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
function isFamilySearchImageArk(url: string): boolean {
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

const DEFAULT_SITES: ReadonlySet<ReshapeSite> = new Set(ALL_SITES.filter((s) => s !== "other"));

const LINK_TAGS = new Set(["WWW", "URL", "_URL", "_LINK"]);

// ---------------------------------------------------------------------------
// URL recognition (offline)

/** A recognized site URL, resolved to its group identity and source fields. */
interface Recognized {
  site: ReshapeSite;
  groupKey: string;
  bookUrl: string;
  page?: string;
  proposed: ReshapeGroup["proposed"];
  /** Text hinting the register type (FS quoted collection, book id, …). */
  typeHint?: string;
  /** Specificity of `proposed.title` — a later member with a better title
   *  (e.g. a Geneanet URL naming the person) upgrades the group's. */
  titleRank?: number;
  /** The quoted collection the pasted FamilySearch citation names — what a
   *  repository kept per collection is matched (or named) by, before any
   *  online lookup runs. */
  collection?: string;
  /** The pasted text parsed as a FamilySearch citation: its details are
   *  already claimed by `proposed`/`page`, so the generic citation parse's
   *  leftovers (periodical, access date, note) say nothing new. */
  cited?: boolean;
}

/** The `{name} - {id} - {site}` title layout every grave/obituary/victim site
 *  uses, offline and enriched alike — absent parts are dropped. */
function siteTitle(name: string | undefined, id: string | undefined, siteLabel: string): string {
  return [name, id, siteLabel].filter(Boolean).join(" - ");
}

/** Strip punctuation a URL picked up from surrounding prose — the builder's
 *  shared rule, so the scan and the note-link harvester see the same URL. */
const cleanUrl = stripTrailingPunct;

/** Percent-decode up to twice (corpus has double-encoded Koper signatures),
 *  falling back to the input when malformed. `+` becomes a space. */
function decodeSegment(seg: string): string {
  let out = seg;
  for (let i = 0; i < 2; i++) {
    try {
      const dec = decodeURIComponent(out);
      if (dec === out) break;
      out = dec;
    } catch {
      break;
    }
  }
  return out.replace(/\+/g, " ").trim();
}

/** Best-effort display form of a URL slug — hyphens to spaces, Title Case.
 *  Diacritics are unrecoverable offline ("sentjur-pri-celju" → "Sentjur Pri
 *  Celju"); enrichment upgrades this to the real name. */
function prettySlug(slug: string): string {
  return decodeSegment(slug)
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\p{L}+/gu, (w) => w.charAt(0).toUpperCase() + w.slice(1));
}

/** A Matricula *book* URL: /{lang}/{country}/{archive}/{parish}/{book}/ —
 *  exactly five path segments, so archive-index URLs never match. */
const MATRICULA_BOOK_RE =
  /^https?:\/\/data\.matricula-online\.eu\/([a-z]{2})\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/?(?:[?#].*)?$/i;

export interface MatriculaUrlParts {
  lang: string;
  country: string;
  archiveSlug: string;
  parishSlug: string;
  bookId: string;
  page?: string;
}

export function parseMatriculaUrl(url: string): MatriculaUrlParts | undefined {
  const m = MATRICULA_BOOK_RE.exec(url.trim());
  if (!m) return undefined;
  return {
    lang: m[1].toLowerCase(),
    country: m[2],
    archiveSlug: m[3],
    parishSlug: m[4],
    bookId: decodeSegment(m[5]),
    page: pageParamOf(url),
  };
}

const GENEANET_VIEW_RE = /\/cemetery\/view\/([^/?#]+)/;

/** A Geneanet member-tree person page (GeneWeb): gw.geneanet.org/{tree}?…
 *  p={given}&n={surname}(&oc={n}) — parameters may be `;`-separated or
 *  HTML-escaped (`&amp;`) in pasted text. */
const GENEANET_TREE_RE = /^https?:\/\/gw\.geneanet\.org\/([a-z0-9_-]+)\?/i;

/** A Find a Grave memorial URL: /memorial/{id}(/{name-slug}). Cemetery and
 *  other Find a Grave pages are not grave records and fall through to "other". */
const FINDAGRAVE_MEMORIAL_RE = /^https?:\/\/(?:\w+\.)?findagrave\.com\/memorial\/(\d+)(?:\/([^/?#]+))?/i;

/** A BillionGraves grave page: /grave/{name-slug}/{id}. */
const BILLIONGRAVES_RE = /^https?:\/\/(?:\w+\.)?billiongraves\.com\/grave\/([^/?#]+)\/(\d+)/i;

/** A Google Books volume — the classic reader URL on any locale domain
 *  (books.google.si/books?id=…&pg=PA18…) or the newer edition URL. */
const GOOGLE_BOOKS_RE = /^https?:\/\/books\.google\.[a-z.]+\/books\?/i;
const GOOGLE_BOOKS_EDITION_RE = /^https?:\/\/(?:www\.)?google\.[a-z.]+\/books\/edition\/[^/?#]+\/([A-Za-z0-9_-]+)/i;

/** A YouTube video: watch?v={id} on any subdomain, or the youtu.be short link. */
const YOUTUBE_RE = /^https?:\/\/(?:\w+\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{6,})/i;
const YOUTU_BE_RE = /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{6,})/i;

/** A Legacy.com obituary URL — several vintages share the host, an
 *  "obituaries" path, a `{name}-obituary` slug and an `id`/`pid` param:
 *  /us/obituaries/{affiliate}/name/{slug}-obituary?id=…, /obituaries/name/…?pid=… */
const LEGACY_OBIT_RE = /^https?:\/\/(?:www\.)?legacy\.com\/[^?#]*obituar/i;

/** A Newspapers.com page image or clipping: newspapers.com/image/{id}/… (an
 *  `article=` uuid marks a clipping region on it) or newspapers.com/clip/{id}. */
const NEWSPAPERS_RE = /^https?:\/\/(?:www\.)?newspapers\.com\/(?:image|clip)\/(\d+)/i;

/** A Wikipedia article in any language, desktop or mobile: {lang}.wikipedia.org
 *  /wiki/{slug} or the /w/index.php?title={slug} form. */
const WIKIPEDIA_RE =
  /^https?:\/\/([a-z][a-z0-9-]*)\.(?:m\.)?wikipedia\.org\/(?:wiki\/|w\/index\.php\?(?:[^#]*&)?title=)([^?#&]+)/i;

/** A Slovenska biografija entry (ZRC SAZU): slovenska-biografija.si/{oseba|rodbina}/sbi{id}/. */
const SLOVENSKA_BIOGRAFIJA_RE = /^https?:\/\/(?:www\.)?slovenska-biografija\.si\/(oseba|rodbina)\/(sbi[a-z0-9]+)/i;

/** An Obrazi slovenskih pokrajin person page (regional libraries' biographical
 *  lexicon): obrazislovenskihpokrajin.si/oseba/{name-slug}/. */
const OBRAZI_RE = /^https?:\/\/(?:www\.)?obrazislovenskihpokrajin\.si\/oseba\/([^/?#]+)/i;

/** A dLib.si (Digital Library of Slovenia) document — newspapers, books,
 *  periodicals. Both the details page and a direct stream (PDF/TXT) link
 *  carry the same URN: /details/{urn}, /stream/{urn}/…. */
const DLIB_RE = /^https?:\/\/(?:www\.)?dlib\.si\/(?:details|stream)\/(urn:nbn:si:[a-z]+-[a-z0-9]+)/i;

/** A SIstory.si war-victims record — the Slovene WW1/WW2 casualty databases;
 *  one record per person, evidencing the death. WW2 ids are GUIDs, WW1 ids are
 *  short numbers — even 1-3 digits: /ww2/{guid}, /ww1/{id}. */
const SISTORY_WW_RE = /^https?:\/\/(?:\w+\.)?sistory\.si\/(ww[12])\/([0-9a-f-]+)/i;

/** The WW1 victims portal variant: zv1.sistory.si/zrtev?id={n}-{Surname}-{Given}-{birthyear}
 *  — the same record as /ww1/{n}, with the person's name encoded in the id. */
const SISTORY_ZV1_RE = /^https?:\/\/zv1\.sistory\.si\/zrtev\?id=([^&#\s]+)/i;

// The FamilySearch URL reading lives in `normalize/links` (the reuse scan in
// `gedcom/source` needs it too); kept exported here for its existing callers.
export { parseFamilySearchUrl, type FamilySearchUrlParts };

/**
 * What a page image of a register is called: the book's title with the cited
 * page in front of it (`#56 - Krstna knjiga …`), for the sites whose links
 * name a page of the book itself.
 *
 * A FamilySearch book is counted twice over — the film runs its own image
 * numbers, the book its printed pages — and neither a link nor a citation
 * says which of the two a number belongs to. A number in the title would
 * therefore be a claim the reader cannot check against what the page shows
 * when they open it, so those titles carry the register's name alone.
 * Undefined when there is no title to build on (a link nothing recognized).
 */
export function pageObjeTitle(
  site: ReshapeSite | undefined,
  title: string | undefined,
  page: string | undefined,
): string | undefined {
  if (!site || !title) return undefined;
  if (site === "familysearch") return title;
  return page ? `#${page} - ${title}` : title;
}

/**
 * A media title that names where the page came from rather than what it is:
 * empty, the site's own name (what its save button writes on every image
 * alike), or one carrying the raw address. Only those are renamed when the
 * page's book gets a name — a title someone wrote is theirs.
 */
function placeholderMediaTitle(title: string | undefined, site: ReshapeSite, url: string): boolean {
  const text = (title ?? "").trim();
  if (!text) return true;
  if (text === SITE_REPO[site]?.name) return true;
  if (/https?:\/\//i.test(text)) return true;
  return linkKey(text) === linkKey(url);
}

/** First quoted phrase in citation text — FamilySearch-style collection titles,
 *  e.g. `"Croatia, Church Books, 1516-1994," database with images, …`. */
function quotedCollection(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /["»“„]([^"«”‟]{6,120}?),?["«”‟]/.exec(text);
  return m?.[1].trim();
}

/** Recognize a URL for one of the reshapeable sites. `contextText` is the
 *  citation/note text around the URL (collection titles, type hints). */
function recognize(url: string, contextText: string | undefined, sites: ReadonlySet<ReshapeSite>): Recognized | undefined {
  const mat = parseMatriculaUrl(url);
  if (mat) {
    if (!sites.has("matricula")) return undefined;
    const parish = prettySlug(mat.parishSlug);
    return {
      site: "matricula",
      groupKey: `m:${bookKeyOf(url)}`,
      bookUrl: url.replace(/\?.*$/, ""),
      page: mat.page,
      proposed: {
        title: `Matricula ${mat.bookId} | ${parish}`,
        place: parish,
        agency: prettySlug(mat.archiveSlug),
        filingNumber: mat.bookId,
      },
    };
  }

  const gene = GENEANET_VIEW_RE.exec(linkKey(url));
  if (gene) {
    if (!sites.has("geneanet")) return undefined;
    const person = /[?&]individu_filter=([^&#]+)/i.exec(url)?.[1];
    const who = person ? decodeSegment(person) : undefined;
    // `{name} - Geneanet Cemeteries`; without a name the view id stands in —
    // offline it's the only thing telling one grave from another (it stays
    // the filing number either way); enrichment upgrades to the cemetery name.
    return {
      site: "geneanet",
      groupKey: `g:${gene[1]}`,
      bookUrl: `https://en.geneanet.org/cemetery/view/${gene[1]}`,
      proposed: { title: siteTitle(who ?? gene[1], undefined, "Geneanet Cemeteries"), filingNumber: gene[1] },
      titleRank: who ? 1 : 0,
    };
  }

  const grave = FINDAGRAVE_MEMORIAL_RE.exec(url.trim());
  if (grave) {
    if (!sites.has("findagrave")) return undefined;
    const who = grave[2] ? prettySlug(grave[2]) : undefined;
    // `{person} - Find a Grave` — the memorial id means nothing to a reader,
    // it goes to the filing number; enrichment adds the cemetery.
    return {
      site: "findagrave",
      groupKey: `fg:${grave[1]}`,
      bookUrl: `https://www.findagrave.com/memorial/${grave[1]}`,
      proposed: { title: siteTitle(who, undefined, "Find a Grave"), filingNumber: grave[1] },
      titleRank: who ? 1 : 0,
    };
  }

  const gbId = GOOGLE_BOOKS_RE.test(url.trim())
    ? /[?&]id=([A-Za-z0-9_-]+)/.exec(url)?.[1]
    : GOOGLE_BOOKS_EDITION_RE.exec(url.trim())?.[1];
  if (gbId) {
    if (!sites.has("googlebooks")) return undefined;
    // Offline the volume id distinguishes books; enrichment replaces it with
    // the real book/newspaper title from the reader page. `pg=PA18` is the
    // cited page.
    const pg = /[?&]pg=([^&#]+)/i.exec(url)?.[1];
    return {
      site: "googlebooks",
      groupKey: `gb:${gbId}`,
      bookUrl: `https://books.google.com/books?id=${gbId}`,
      page: pg ? decodeSegment(pg).replace(/^PA(\d+)$/, "$1") : undefined,
      proposed: { title: siteTitle(gbId, undefined, "Google Books"), filingNumber: gbId },
    };
  }

  const yt = YOUTUBE_RE.exec(url.trim()) ?? YOUTU_BE_RE.exec(url.trim());
  if (yt) {
    if (!sites.has("youtube")) return undefined;
    // Offline the video id distinguishes videos; enrichment fills the video's
    // title and channel from YouTube's public oEmbed endpoint.
    return {
      site: "youtube",
      groupKey: `yt:${yt[1]}`,
      bookUrl: `https://www.youtube.com/watch?v=${yt[1]}`,
      proposed: { title: siteTitle(yt[1], undefined, "YouTube"), filingNumber: yt[1] },
    };
  }

  const gwTree = GENEANET_TREE_RE.exec(url.trim());
  if (gwTree) {
    if (!sites.has("geneanettree")) return undefined;
    // Normalize `;`-separated / HTML-escaped params, then read the person:
    // p={given}, n={surname}, oc={disambiguating ordinal}.
    const params = url.replace(/&amp;/gi, "&").replace(/;/g, "&");
    const given = /[?&]p=([^&#]+)/i.exec(params)?.[1];
    const surname = /[?&]n=([^&#]+)/i.exec(params)?.[1];
    const oc = /[?&]oc=(\d+)/i.exec(params)?.[1];
    if (given || surname) {
      const who = prettySlug([given, surname].filter(Boolean).map((s) => decodeSegment(s!)).join(" "));
      const canonical =
        `https://gw.geneanet.org/${gwTree[1].toLowerCase()}?lang=en&p=${encodeURIComponent(decodeSegment(given ?? ""))}` +
        `&n=${encodeURIComponent(decodeSegment(surname ?? ""))}${oc ? `&oc=${oc}` : ""}`;
      const tree = gwTree[1].toLowerCase();
      return {
        site: "geneanettree",
        groupKey: `gt:${tree}:${(surname ?? "").toLowerCase()}:${(given ?? "").toLowerCase()}:${oc ?? ""}`,
        bookUrl: canonical,
        // The member tree's owner is the source's author, shown in the title:
        // `{person} - {tree owner} - Geneanet Trees`.
        proposed: { title: siteTitle(who, tree, "Geneanet Trees"), author: tree },
        titleRank: 1,
      };
    }
  }

  const bg = BILLIONGRAVES_RE.exec(url.trim());
  if (bg) {
    if (!sites.has("billiongraves")) return undefined;
    const who = prettySlug(bg[1]);
    // `{person} - BillionGraves` — the grave id goes to the filing number;
    // enrichment adds the cemetery from the page's schema.org data.
    return {
      site: "billiongraves",
      groupKey: `bg:${bg[2]}`,
      bookUrl: `https://billiongraves.com/grave/${bg[1]}/${bg[2]}`,
      proposed: { title: siteTitle(who, undefined, "BillionGraves"), filingNumber: bg[2] },
      titleRank: who ? 1 : 0,
    };
  }

  if (LEGACY_OBIT_RE.test(url.trim())) {
    if (!sites.has("legacy")) return undefined;
    const id = /[?&]p?id=(\d+)/i.exec(url)?.[1];
    // The person's name lives in the path slug ("/{name}-obituary") or, on
    // the older obituary.aspx form, in the `n=` query parameter.
    const slug = /\/([^/?#]+)-obituary(?:[/?#]|$)/i.exec(url)?.[1] ?? /[?&]n=([^&#]+)/i.exec(url)?.[1];
    const who = slug ? prettySlug(decodeSegment(slug)) : undefined;
    // `{name} - Legacy.com`; without a name the obituary id stands in —
    // offline it's the only thing telling one obituary from another (it
    // stays the filing number either way).
    return {
      site: "legacy",
      groupKey: id ? `l:${id}` : `l:${linkKey(cleanUrl(url))}`,
      bookUrl: cleanUrl(url).replace(/([?&])p?id=(\d+).*$/i, "$1id=$2"),
      proposed: { title: siteTitle(who ?? id, undefined, "Legacy.com"), filingNumber: id },
      titleRank: who ? 1 : 0,
    };
  }

  const np = NEWSPAPERS_RE.exec(url.trim());
  if (np) {
    if (!sites.has("newspapers")) return undefined;
    const imageId = np[1];
    // Ancestry cites these as "The Windsor Star; Publication Date: 23 Jun
    // 1998; Publication Place: Windsor, Ontario, Canada; URL: https://…" —
    // the newspaper, issue date and place are already in the citation prose,
    // and the site itself sits behind a bot wall no relay gets past, so the
    // offline parse is the whole story. `{paper}, {date} - Newspapers.com`
    // names the issue; the page-image id is the filing number. Citations to
    // the same page image share one source; each clipping URL (its
    // `article`/`focus` params mark the region) stays its own media link.
    const ctx = contextText ?? "";
    const paper = /(^|[;\n])\s*([^;\n]{2,80}?)\s*;\s*Publication Date/i.exec(ctx)?.[2];
    const date = /Publication Date:\s*([^;\n]+)/i
      .exec(ctx)?.[1]
      .replace(/\//g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    const place = /Publication Place:\s*([^;\n]+)/i.exec(ctx)?.[1].trim();
    return {
      site: "newspapers",
      groupKey: `np:${imageId}`,
      bookUrl: `https://www.newspapers.com/image/${imageId}/`,
      proposed: {
        title: siteTitle(paper ? [paper, date].filter(Boolean).join(", ") : imageId, undefined, "Newspapers.com"),
        place,
        filingNumber: imageId,
        dateRange: date,
      },
      titleRank: paper ? 2 : 0,
      typeHint: contextText,
    };
  }

  const wiki = WIKIPEDIA_RE.exec(url.trim());
  if (wiki) {
    if (!sites.has("wikipedia")) return undefined;
    const lang = wiki[1].toLowerCase() === "www" ? "en" : wiki[1].toLowerCase();
    const slug = wiki[2].replace(/\/$/, "");
    // The slug IS the article name (underscores for spaces, case preserved) —
    // `{Article} - Wikipedia`; enrichment upgrades to the display title with
    // proper diacritics. One source per article per language edition.
    const article = decodeSegment(slug).replace(/_/g, " ").trim();
    return {
      site: "wikipedia",
      groupKey: `w:${lang}:${decodeSegment(slug).toLowerCase()}`,
      bookUrl: `https://${lang}.wikipedia.org/wiki/${slug}`,
      proposed: { title: siteTitle(article || slug, undefined, "Wikipedia") },
      titleRank: article ? 1 : 0,
    };
  }

  const sb = SLOVENSKA_BIOGRAFIJA_RE.exec(url.trim());
  if (sb) {
    if (!sites.has("biografija")) return undefined;
    const id = sb[2].toLowerCase();
    // The URL carries only the sbi id — it stands in offline and stays the
    // filing number; enrichment upgrades to the page's own heading
    // ("Trubar, Primož (med 1507 in 1509–1586) - Slovenska biografija").
    return {
      site: "biografija",
      groupKey: `sb:${id}`,
      bookUrl: `https://www.slovenska-biografija.si/${sb[1].toLowerCase()}/${id}/`,
      proposed: { title: siteTitle(id, undefined, "Slovenska biografija"), filingNumber: id },
      titleRank: 0,
    };
  }

  const obrazi = OBRAZI_RE.exec(url.trim());
  if (obrazi) {
    if (!sites.has("obrazi")) return undefined;
    const slug = obrazi[1].toLowerCase();
    // The slug is the person's name ("primoz-trubar") — enrichment upgrades
    // it to the page's own diacritic form ("Primož TRUBAR").
    return {
      site: "obrazi",
      groupKey: `os:${slug}`,
      bookUrl: `https://www.obrazislovenskihpokrajin.si/oseba/${slug}/`,
      proposed: { title: siteTitle(prettySlug(slug), undefined, "Obrazi slovenskih pokrajin") },
      titleRank: 1,
    };
  }

  const dlib = DLIB_RE.exec(url.trim());
  if (dlib) {
    if (!sites.has("dlib")) return undefined;
    const urn = dlib[1].toUpperCase();
    // Offline the URN is the only thing distinguishing one document from
    // another, so it stays in the title (`{urn} - dLib.si`) besides the
    // filing number; enrichment replaces it with the publication/issue/date.
    const who = quotedCollection(contextText);
    return {
      site: "dlib",
      groupKey: `dl:${urn.toLowerCase()}`,
      bookUrl: `https://dlib.si/details/${urn}`,
      proposed: { title: siteTitle(who, urn, "dLib.si"), filingNumber: urn },
      titleRank: who ? 1 : 0,
      typeHint: contextText,
    };
  }

  const sistory = SISTORY_WW_RE.exec(url.trim());
  if (sistory) {
    if (!sites.has("sistory")) return undefined;
    const war = sistory[1].toUpperCase();
    const id = sistory[2].toUpperCase();
    // The title prefers the person's name, which the SIstory citation text
    // carries in »…« quotes (`{name} - WWx - SIstory.si`); without one the
    // record id stands in after the war marker (`WWx - {id} - SIstory.si`) —
    // it's the only thing distinguishing records offline. The citation's
    // "(Ljubljana: Inštitut za novejšo zgodovino, 2026)" supplies the
    // publication place and the institute (the source's agency, matching
    // what a fetched record fills).
    const who = quotedCollection(contextText);
    const cit = contextText ? parseSourceInput(contextText) : {};
    return {
      site: "sistory",
      groupKey: `s:${sistory[1].toLowerCase()}:${id.toLowerCase()}`,
      bookUrl: `https://www.sistory.si/${sistory[1].toLowerCase()}/${id}`,
      proposed: {
        title: who ? siteTitle(who, war, "SIstory.si") : siteTitle(war, id, "SIstory.si"),
        filingNumber: id,
        agency: cit.publisher,
        place: cit.place,
      },
      titleRank: who ? 1 : 0,
      typeHint: contextText,
    };
  }

  const zv1 = SISTORY_ZV1_RE.exec(url.trim());
  if (zv1) {
    if (!sites.has("sistory")) return undefined;
    // "15691-Čehun-Matija-1877" → id + surname + given + birth year. Same
    // record as /ww1/{id}, so both variants share the group.
    const parts = decodeSegment(zv1[1]).split("-");
    const numId = parts[0];
    const who = parts.length >= 3 ? `${parts.slice(2, -1).join(" ")} ${parts[1]}`.trim() : undefined;
    const year = parts.length >= 4 ? parts[parts.length - 1] : undefined;
    return {
      site: "sistory",
      groupKey: `s:ww1:${numId.toLowerCase()}`,
      bookUrl: cleanUrl(url),
      proposed: {
        title: who
          ? siteTitle(`${who}${year ? ` (${year})` : ""}`, "WW1", "SIstory.si")
          : siteTitle("WW1", numId, "SIstory.si"),
        filingNumber: numId,
      },
      titleRank: who ? 2 : 0,
      typeHint: contextText,
    };
  }

  const fs = parseFamilySearchUrl(url);
  if (fs && fs.kind !== "tree") {
    if (!sites.has("familysearch")) return undefined;
    const collection = quotedCollection(contextText);
    // A citation copied from the page says far more than the link can: which
    // entry or image this is, the register type, the archive, the film. Its
    // *record* details (the entry) stay on the citation, its *source* details
    // on the source.
    const cited = parsePastedFsCitation(contextText ?? "");
    if (fs.kind === "image") {
      return {
        site: "familysearch",
        groupKey: fs.cat ? `f:cat:${fs.cat}` : `f:${linkKey(url)}`,
        bookUrl: fs.cat ? `https://www.familysearch.org/search/catalog/${fs.cat}` : cleanUrl(url),
        page: imageNumber(fs.image) ?? cited?.page,
        proposed: {
          title: collection ?? (fs.cat ? `FamilySearch film ${fs.cat}` : `FamilySearch ${fs.ark}`),
          agency: cited?.agency,
          place: cited?.place,
          dateRange: cited?.dateRange,
          // The film (Image Group / DGS) or catalog number identifies the
          // source; a lone image link has only its ARK id.
          filingNumber: cited?.filingNumber ?? fs.cat ?? fs.ark,
        },
        typeHint: collection,
        collection,
        cited: cited !== undefined,
      };
    }
    return {
      site: "familysearch",
      groupKey: collection ? `f:coll:${collection.toLowerCase()}` : `f:${linkKey(url)}`,
      bookUrl: cleanUrl(url),
      // "Entry for Anna Rakar and Martin Sadec, 9 July 1901" beats the bare
      // ARK id as the page — same record, in words.
      page: cited?.page ?? fs.ark,
      // A collection-grouped source spans many records, so no single record's
      // ARK can be its filing number — the id stays on each citation's PAGE.
      proposed: {
        title: collection ?? `FamilySearch ${fs.ark}`,
        agency: cited?.agency,
        place: cited?.place,
        dateRange: cited?.dateRange,
        filingNumber: cited?.filingNumber ?? (collection ? undefined : fs.ark),
      },
      typeHint: collection,
      collection,
      cited: cited !== undefined,
    };
  }

  if (!sites.has("other")) return undefined;
  // Generic links still get a readable offline title where possible: the
  // citation text around the link (minus the URL itself), else a name-like
  // path slug plus the host ("Ann Vidmar - tezakfuneralhome.com").
  const contextTitle = contextText ? firstLine(contextText.replace(URL_RE, " ")) : "";
  const slugTitle = slugTitleFromUrl(cleanUrl(url));
  return {
    site: "other",
    groupKey: `o:${linkKey(url)}`,
    bookUrl: cleanUrl(url),
    proposed: { title: contextTitle || slugTitle || cleanUrl(url) },
    titleRank: contextTitle ? 2 : slugTitle ? 1 : 0,
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim().slice(0, 120) || text.trim().slice(0, 120);
}

/**
 * A readable title for a generic link. A name-like last path segment (two or
 * more words: "ann-vidmar", "pogreb-angela-zupancic") becomes
 * "Ann Vidmar - tezakfuneralhome.com"; a document/image file name becomes
 * "16298754_1992_6_L.pdf - arhiv.gorenjskiglas.si". Id-like page segments
 * (digits, single tokens, hashes) yield nothing — the URL stays the title.
 */
function slugTitleFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.replace(/^www\./i, "");
  const segments = parsed.pathname.split("/").filter(Boolean).map(decodeSegment);
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i].replace(/\.(html?|php|aspx?|pdf|jpe?g|png|gif)$/i, "");
    if (!/^\p{L}/u.test(seg)) continue;
    const words = seg.split(/[-_ ]+/).filter(Boolean);
    if (words.length < 2 || words.filter((w) => /^\p{L}+$/u.test(w)).length < 2) continue;
    return `${prettySlug(seg)} - ${host}`;
  }
  const file = segments[segments.length - 1];
  if (file && /\.(pdf|jpe?g|png|gif|tiff?|webp|djvu?|docx?|txt)$/i.test(file)) return `${file} - ${host}`;
  return undefined;
}

/** The parts of a recognized site URL the Add Source dialog needs: the
 *  canonical book/record URL to fetch, the cited page, and the
 *  offline-proposed source fields. */
export type RecognizedSourceUrl = Pick<Recognized, "site" | "bookUrl" | "page" | "proposed" | "collection" | "cited">;

/**
 * Recognize a single pasted URL against the same site rules the Organize
 * sources tool uses — so a source added by hand gets the identical
 * title/place/agency/filing-number proposals and leaves no work for a later
 * cleanup pass. `contextText` is the rest of the pasted citation (quoted
 * collection titles, the person's name in SIstory quotes). URLs of unknown
 * sites return undefined — the caller keeps its generic handling.
 */
export function recognizeSourceUrl(url: string, contextText?: string): RecognizedSourceUrl | undefined {
  return recognize(cleanUrl(url.trim()), contextText, DEFAULT_SITES);
}

/** Site glyphs — the Organize sources chips, the Add Source recognized-link
 *  chip, and the source/link icons across Edit, Compare and chart panels. */
export const SITE_ICON: Record<ReshapeSite, string> = {
  matricula: "⛪",
  geneanet: "🪦",
  geneanettree: "🌲",
  findagrave: "🪦",
  billiongraves: "🪦",
  legacy: "📰",
  newspapers: "🗞️",
  sistory: "🎖️",
  dlib: "📚",
  googlebooks: "📖",
  youtube: "🎬",
  wikipedia: "🌐",
  biografija: "🪶",
  obrazi: "👤",
  familysearch: "🌳",
  other: "🔗",
};

const siteIconCache = new Map<string, string | undefined>();

/** The recognized site's glyph for a source/link URL, or undefined for URLs
 *  of unknown sites (the caller keeps its generic icon). Cached per URL —
 *  Edit/Compare rows re-render often over the same citations. */
export function siteIconForUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (siteIconCache.has(url)) return siteIconCache.get(url);
  const site = recognizeSourceUrl(url)?.site;
  const icon = site ? SITE_ICON[site] : undefined;
  siteIconCache.set(url, icon);
  return icon;
}

// ---------------------------------------------------------------------------
// Register-type classification (drives event placement)

const TYPE_KEYWORDS: Record<Exclude<BookType, "unknown">, RegExp> = {
  // Baptism covers birth registers too — the same book under a civil name, and
  // Croatian/Slovenian collection titles say "Rođeni"/"Rojeni" for it.
  baptism: /krst|tauf|baptiz|baptism|rojstn|rojen|rođen|rodjen|birth|\bkk\b/i,
  marriage: /poro[čc]|vjen[čc]an|trauung|matrimon|copulat|marriage|\bpk\b/i,
  // The tail (obituar|osmrtnic|pogreb|navc?ek|funeral) recognizes obituary and
  // funeral-announcement pages by their URLs/titles — funeral homes,
  // komunala pogreb notices, navcek.si.
  death: /mrli|sterbe|defunct|mortu|umrl|death|\bmk\b|obituar|osmrtnic|pogreb|nav[čc]ek|funeral/i,
  // Graves: cemetery indexes ("Pokopališče Kranj - Geneanet Cemeteries",
  // "Find a Grave® Index", BillionGraves) and burial registers. `SITE_BOOK_TYPE`
  // already pins the known grave sites by their URL; a title is all the
  // coverage pass and a pasted citation ever get, so it must say the same.
  burial: /pokopal|groblj|grobi[šs][čc]|cemeter|graveyard|\bgraves?\b|billiongraves|friedhof|begr[äa]bnis|sepult|burial|buried/i,
};

/** Classify a register's type from whatever text is available (source titles,
 *  quoted collection names, citation prefixes). Ambiguous → "unknown". */
export function classifyBookType(texts: (string | undefined)[]): BookType {
  const joined = texts.filter(Boolean).join(" \n ");
  if (!joined) return "unknown";
  const hits = (Object.keys(TYPE_KEYWORDS) as (keyof typeof TYPE_KEYWORDS)[]).filter((t) =>
    TYPE_KEYWORDS[t].test(joined),
  );
  if (hits.length === 1) return hits[0];
  // Death and burial are not rival readings the way baptism and marriage are:
  // a death register that also names the graveyard ("Cemetery and Funeral Home
  // Collection") is still a death register, and the two events accept each
  // other's citations anyway (ACCEPTABLE_TAGS). A grave site is pinned by
  // SITE_BOOK_TYPE before this ever runs, so it is unaffected.
  if (hits.length === 2 && hits.includes("death") && hits.includes("burial")) return "death";
  return "unknown";
}

/** Event tags an occurrence may already sit on without being moved. Death and
 *  burial accept each other — a death-book citation on BURI (or a grave photo
 *  on DEAT) is plausible and not worth churning. */
const ACCEPTABLE_TAGS: Record<Exclude<BookType, "unknown">, ReadonlySet<string>> = {
  baptism: new Set(["BIRT", "BAPM", "CHR"]),
  marriage: new Set(["MARR"]),
  death: new Set(["DEAT", "BURI"]),
  burial: new Set(["BURI", "DEAT"]),
};

/** The event a non-marriage book's citation belongs on, or undefined when the
 *  occurrence already sits acceptably (or the book can't say). One doctrine for
 *  the apply's relocation and the report's post-enrichment refresh — the row
 *  must show the same move the apply will make. */
function bookEventTarget(
  recordTag: string,
  eventTag: string | undefined,
  bookType: BookType,
  baptismTag: "BIRT" | "BAPM",
): string | undefined {
  if (bookType === "unknown" || bookType === "marriage" || recordTag !== "INDI") return undefined;
  if (eventTag && ACCEPTABLE_TAGS[bookType].has(eventTag)) return undefined;
  return bookType === "baptism" ? baptismTag : bookType === "death" ? "DEAT" : "BURI";
}

/** The file's own habit for baptism-book citations: whichever of BIRT/BAPM
 *  already carries more `SOUR` children (default BIRT). */
export function baptismTargetTag(records: GedNode[]): "BIRT" | "BAPM" {
  let birt = 0;
  let bapm = 0;
  for (const rec of records) {
    if (rec.tag !== "INDI") continue;
    for (const ev of rec.children) {
      if (ev.tag === "BIRT") birt += childrenByTag(ev, "SOUR").length;
      else if (ev.tag === "BAPM") bapm += childrenByTag(ev, "SOUR").length;
    }
  }
  return bapm > birt ? "BAPM" : "BIRT";
}

// ---------------------------------------------------------------------------
// Occurrence scan (shared by report and apply)

/** A scan hit with live node references — internal; the report maps these to
 *  plain {@link ReshapeOccurrence}s, the apply re-runs the scan on its clone. */
interface ScanHit {
  rec: GedNode;
  /** The node the citation attaches to: `rec` itself or one of its events. */
  container: GedNode;
  /** The link/citation/OBJE/TITL node being rewritten. */
  node: GedNode;
  shape: ReshapeShape;
  url: string;
  recognized: Recognized;
  prefix?: string;
  /** Top-level OBJE record the `obje` shape points at, if any. */
  objeXref?: string;
  /** Text usable for register-type classification. */
  typeText?: string;
  eventTag?: string;
  eventIndex?: number;
  /** See {@link ReshapeOccurrence.foldedInto}. */
  foldedInto?: string;
  /** Event tag carrying the same URL, in a file that *doubles* links — the
   *  record-level citation is kept (house style) and just not relocated. */
  twinEvent?: string;
}

/** Extract recognized URLs from a text value (may contain several). */
function recognizedUrls(text: string, contextText: string | undefined, sites: ReadonlySet<ReshapeSite>): { url: string; recognized: Recognized }[] {
  const out: { url: string; recognized: Recognized }[] = [];
  // One value can carry the same URL twice — an HTML note's
  // `<a href="url">url</a>` — which must stay ONE occurrence, or the apply
  // would write two identical citations.
  const seen = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0]);
    const key = linkKey(url);
    if (seen.has(key)) continue;
    const recognized = recognize(url, contextText, sites);
    if (recognized) {
      seen.add(key);
      out.push({ url, recognized });
    }
  }
  return out;
}

/** Top-level OBJE xrefs referenced by a `SOUR` record (its page images),
 *  mapped to their owning source's xref (first owner wins). */
function sourReferencedObjeXrefs(records: GedNode[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    for (const c of childrenByTag(rec, "OBJE")) {
      const v = c.value?.trim();
      if (v && isPointer(v) && !map.has(v)) map.set(v, rec.xref);
    }
  }
  return map;
}

/** Whether any source in the file organizes page images at all — without
 *  them the page-media style is moot (don't show/act on a trivial answer). */
export function hasSourcePageMedia(records: GedNode[]): boolean {
  return sourReferencedObjeXrefs(records).size > 0;
}

/**
 * The file's own habit for a cited page's image: "event" when records that
 * cite a paginated source typically also carry that source's page image
 * themselves — beside the citation on an event (webtrees-style) or anywhere
 * on the record (MyHeritage attaches the register photo to the person) —
 * else "source" (images only under the source record). Record-granular on
 * purpose: a person-level attachment is still evidence the user wants the
 * page visible on the person/fact, not only behind the source.
 */
export function detectPageMediaStyle(records: GedNode[]): PageMediaStyle {
  const owners = sourReferencedObjeXrefs(records);
  const paginated = new Set(owners.values());
  let paired = 0;
  let plain = 0;
  for (const rec of records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    const eventTags = rec.tag === "INDI" ? INDI_EVENT_TAGS : FAM_EVENT_TAGS;
    const cited = new Set<string>();
    let hasPageImage = false;
    const collect = (container: GedNode): void => {
      for (const c of container.children) {
        const v = c.value?.trim();
        if (!v || !isPointer(v)) continue;
        if (c.tag === "SOUR" && paginated.has(v)) cited.add(v);
        else if (c.tag === "OBJE" && owners.has(v)) hasPageImage = true;
      }
    };
    collect(rec);
    for (const child of rec.children) if (eventTags.has(child.tag)) collect(child);
    if (cited.size === 0) continue;
    if (hasPageImage) paired++;
    else plain++;
  }
  return paired > plain ? "event" : "source";
}

function scanContainer(
  rec: GedNode,
  container: GedNode,
  sites: ReadonlySet<ReshapeSite>,
  objeUrls: Map<string, string>,
  sourTitles: Map<string, string | undefined>,
  hits: ScanHit[],
  eventTag?: string,
  eventIndex?: number,
  privateObje?: ReadonlySet<string>,
): void {
  const base = { rec, container, eventTag, eventIndex };
  for (const child of container.children) {
    const value = child.value ?? "";
    // Private entries stay private: an inline NOTE/OBJE flagged private (or a
    // pointer to a private OBJE record) never becomes source material.
    if (isPrivateNode(child)) continue;
    if (child.tag === "OBJE" && value && isPointer(value.trim()) && privateObje?.has(value.trim())) continue;

    if (LINK_TAGS.has(child.tag) && value) {
      for (const { url, recognized } of recognizedUrls(value, undefined, sites)) {
        hits.push({ ...base, node: child, shape: "link", url, recognized });
      }
    } else if (child.tag === "_WEBTAG") {
      const urlChild = firstChild(child, ["URL", "WWW"]);
      const urlValue = urlChild?.value ?? "";
      for (const { url, recognized } of recognizedUrls(urlValue, childText(child, "NAME"), sites)) {
        hits.push({ ...base, node: child, shape: "webtag", url, recognized, typeText: childText(child, "NAME") });
      }
    } else if (child.tag === "OBJE") {
      const pointer = value.trim();
      if (pointer && isPointer(pointer)) {
        const url = objeUrls.get(pointer);
        if (url) {
          const recognized = recognize(url, undefined, sites);
          if (recognized) hits.push({ ...base, node: child, shape: "obje", url, recognized, objeXref: pointer });
        }
      } else {
        const file = childText(child, "FILE") ?? "";
        for (const { url, recognized } of recognizedUrls(file, undefined, sites)) {
          hits.push({ ...base, node: child, shape: "obje", url, recognized });
        }
      }
    } else if (child.tag === "NOTE" && value && !isPointer(value.trim())) {
      for (const { url, recognized } of recognizedUrls(value, value, sites)) {
        hits.push({ ...base, node: child, shape: "note", url, recognized, typeText: value });
      }
    } else if (child.tag === "SOUR") {
      const pointer = value.trim();
      if (pointer && isPointer(pointer)) {
        const pageChild = firstChild(child, "PAGE");
        const pageValue = pageChild?.value ?? "";
        const ownerTitle = sourTitles.get(pointer);
        // The PAGE prose is part of the context too — Ancestry-style
        // citations carry the publication/collection details right there.
        const context = [pageValue, ownerTitle].filter(Boolean).join("\n") || undefined;
        for (const { url, recognized } of recognizedUrls(pageValue, context, sites)) {
          hits.push({ ...base, node: child, shape: "pageUrl", url, recognized, typeText: ownerTitle });
        }
      } else if (value) {
        for (const { url, recognized } of recognizedUrls(value, value, sites)) {
          const prefix = value
            .replace(url, "")
            .replace(/\(\s*\)/g, "")
            .replace(/[\s:–—-]+$/, "")
            .trim();
          hits.push({
            ...base,
            node: child,
            shape: "inline",
            url,
            recognized,
            prefix: prefix || undefined,
            typeText: value,
          });
        }
      }
    }
  }
}

/**
 * The file's own habit for a link attached to both a person and one of their
 * events: MacFamilyTree-style files systematically double every event photo
 * onto the record, others keep a link in exactly one place. Counted over every
 * link/media URL on events: does the same URL also sit at record level of the
 * same person more often than not? Ties (and files without event links) read
 * as "folded" — a single citation at the more precise spot.
 */
export function prefersDoubledLinks(records: GedNode[]): boolean {
  const objeIndex = buildObjeIndex(records);
  let doubled = 0;
  let eventOnly = 0;
  const collect = (container: GedNode, into: Set<string>): void => {
    for (const c of container.children) {
      if (LINK_TAGS.has(c.tag) && c.value) {
        for (const m of c.value.matchAll(URL_RE)) into.add(linkKey(cleanUrl(m[0])));
      } else if (c.tag === "OBJE") {
        const v = c.value?.trim();
        const url = v && isPointer(v) ? objeIndex.get(v)?.url : childText(c, "FILE");
        if (url && looksLikeUrl(url)) into.add(linkKey(url));
      }
    }
  };
  for (const rec of records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    const eventTags = rec.tag === "INDI" ? INDI_EVENT_TAGS : FAM_EVENT_TAGS;
    const recordKeys = new Set<string>();
    const eventKeys = new Set<string>();
    collect(rec, recordKeys);
    for (const child of rec.children) if (eventTags.has(child.tag)) collect(child, eventKeys);
    for (const k of eventKeys) {
      if (recordKeys.has(k)) doubled++;
      else eventOnly++;
    }
  }
  return doubled > eventOnly;
}

function scanOccurrences(
  records: GedNode[],
  sites: ReadonlySet<ReshapeSite>,
  /** How pointers to a source's page media are treated: undefined (doubled-
   *  links file) leaves them alone; "source" converts them all away; "event"
   *  keeps the ones already sitting beside their citation on an event. */
  pointerStyle?: PageMediaStyle,
): ScanHit[] {
  const objeIndex = buildObjeIndex(records);
  const objeUrls = new Map<string, string>();
  for (const [xref, info] of objeIndex) if (info.url) objeUrls.set(xref, info.url);
  const sourReferenced = sourReferencedObjeXrefs(records);
  const sourTitles = new Map<string, string | undefined>();
  for (const rec of records) if (rec.tag === "SOUR" && rec.xref) sourTitles.set(rec.xref, sourceTitle(rec));

  // Private OBJE records: their URLs are private data, never source material.
  const privateObje = new Set(records.filter((r) => r.tag === "OBJE" && r.xref && isPrivateNode(r)).map((r) => r.xref!));

  const hits: ScanHit[] = [];
  for (const rec of records) {
    // A record flagged private (person, family) is meant to stay out of
    // publishing — none of its links become (shared) source citations.
    if (isPrivateNode(rec)) continue;
    if (rec.tag === "INDI" || rec.tag === "FAM") {
      const eventTags = rec.tag === "INDI" ? INDI_EVENT_TAGS : FAM_EVENT_TAGS;
      scanContainer(rec, rec, sites, objeUrls, sourTitles, hits, undefined, undefined, privateObje);
      const seen = new Map<string, number>();
      for (const child of rec.children) {
        if (!eventTags.has(child.tag)) continue;
        const idx = seen.get(child.tag) ?? 0;
        seen.set(child.tag, idx + 1);
        scanContainer(rec, child, sites, objeUrls, sourTitles, hits, child.tag, idx, privateObje);
      }
    } else if (rec.tag === "SOUR" && rec.xref) {
      // A SOUR record whose TITL *is* a site URL: rewrite the record in place.
      const titl = firstChild(rec, "TITL");
      const value = titl?.value ?? "";
      for (const { url, recognized } of recognizedUrls(value, childText(rec, "ABBR"), sites)) {
        hits.push({ rec, container: rec, node: titl!, shape: "sourTitle", url, recognized, typeText: childText(rec, "ABBR") });
      }
    }
  }

  // Person/event-level OBJE pointers to media that already hang off a SOUR as
  // its page images: in a links-on-events file they are redundant — the apply
  // reuses the owning SOUR, attaches a proper page citation on the matching
  // event (or dedupes against one already there) and drops the pointer. In
  // the "event" page-media style, a pointer already sitting beside its
  // citation on an event IS the house shape and stays; elsewhere-placed
  // pointers still convert (and re-materialize beside the citation). In a
  // doubled-links file every such pointer is house style and stays.
  return hits.filter((h) => {
    if (h.shape !== "obje" || !h.objeXref) return true;
    const owner = sourReferenced.get(h.objeXref);
    if (!owner) return true;
    if (!pointerStyle) return false;
    if (pointerStyle === "source") return true;
    const besideCitation =
      h.eventTag !== undefined && childrenByTag(h.container, "SOUR").some((c) => c.value?.trim() === owner);
    return !besideCitation;
  });
}

// ---------------------------------------------------------------------------
// Grouping + report

const SITE_ORDER = new Map<ReshapeSite, number>(ALL_SITES.map((s, i) => [s, i]));

/** Sites whose record kind is inherent: graves → burial, obituaries and
 *  war-casualty records → death. */
const SITE_BOOK_TYPE: Partial<Record<ReshapeSite, BookType>> = {
  geneanet: "burial",
  findagrave: "burial",
  billiongraves: "burial",
  legacy: "death",
  sistory: "death",
};

interface GroupState {
  group: ReshapeGroup;
  hits: ScanHit[];
  titleRank: number;
}

/** Re-do {@link mergeFsBooks}' fold on a freshly scanned group map: the pages
 *  of one book become one group, standing where the first of them stood — the
 *  order the panel listed them in, and so the order their records are made in. */
function foldMergedGroups(
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

function buildGroups(records: GedNode[], hits: ScanHit[], foldDuplicates: boolean): Map<string, GroupState> {
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
interface RelocationContext {
  byXref: Map<string, GedNode>;
  urlOfObje: (xref: string) => string | undefined;
}

/** Whether a container's direct children carry the given link — a media
 *  pointer resolving to the URL, an inline OBJE FILE, or a bare link tag. */
function carriesLink(container: GedNode, urlKey: string, urlOfObje: (xref: string) => string | undefined): boolean {
  for (const c of container.children) {
    if (LINK_TAGS.has(c.tag) && c.value) {
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
function relocationTarget(
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
function isSettledPointer(
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
function sourcesHoldingPages(records: GedNode[], objeIndex: ObjeIndex): Map<string, string[]> {
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
function resolveFormatOptions(records: GedNode[], opts: ReshapeOptions) {
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

// ---------------------------------------------------------------------------
// Apply

/** Remove one URL from free text, tidying leftover artifacts conservatively —
 *  never rewrapping or reformatting the user's remaining prose. */
function removeUrlFromText(text: string, url: string): string {
  return (
    text
      .replace(url, "")
      .replace(/\(\s*\)/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/^[\s:–—,-]+|[\s:–—,-]+$/g, "")
      // An Ancestry-style "…; URL: <link>" tail leaves its bare label
      // dangling once the link is gone.
      .replace(/[\s;,:]*\bURL$/i, "")
  );
}

/** Whether leftover note text still says anything (letters or digits). */
function hasContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function spliceChild(parent: GedNode, child: GedNode): boolean {
  const i = parent.children.indexOf(child);
  if (i === -1) return false;
  parent.children.splice(i, 1);
  return true;
}

/** Attach a `SOUR @x@` citation (+PAGE/QUAY) unless the same source+page is
 *  already cited on the container — dedupes repeated links and keeps the whole
 *  apply idempotent. */
function attachCitation(
  container: GedNode,
  sourceXref: string,
  page: string | undefined,
  quay: string | undefined,
  order: string[],
): boolean {
  const existing = childrenByTag(container, "SOUR").find(
    (c) => c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === (page ?? ""),
  );
  if (existing) {
    // The occurrence folds into this citation — the chosen quality still
    // applies to it. Filling a MISSING QUAY is an enrich; one already set is
    // the user's data and stays.
    if (quay && !firstChild(existing, "QUAY")) {
      existing.children.push({ level: existing.level + 1, tag: "QUAY", value: quay, children: [] });
    }
    return false;
  }
  const citation: GedNode = { level: container.level + 1, tag: "SOUR", value: sourceXref, children: [] };
  if (page) citation.children.push({ level: container.level + 2, tag: "PAGE", value: page, children: [] });
  if (quay) citation.children.push({ level: container.level + 2, tag: "QUAY", value: quay, children: [] });
  insertOrdered(container, citation, order);
  return true;
}

/** Diacritic- and case-insensitive comparison key for a place segment. */
function placeSegmentKey(segment: string): string {
  return segment
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Resolve a fetched or URL-derived place against the places the file already
 * uses: the input's first segment is matched (diacritic-insensitively) against
 * the first segment of every existing `PLAC` value, and the file's most
 * frequent full value wins — so "Žabnica, Slovenia" from a grave page, or the
 * diacritic-less slug guess "Sentjur Pri Celju", becomes the file's own
 * "Žabnica,Kranj,Slovenia" in its established place format.
 */
function buildPlaceResolver(records: GedNode[]): {
  resolve: (place: string | undefined) => string | undefined;
  /** The file keeps address detail in separate `ADDR` lines beside `PLAC`. */
  structuredAddr: boolean;
} {
  const bySegment = new Map<string, Map<string, number>>();
  const placeValues: string[] = [];
  let addrCount = 0;
  const walk = (n: GedNode): void => {
    for (const c of n.children) {
      if (c.tag === "ADDR") addrCount++;
      const full = c.tag === "PLAC" ? c.value?.trim() : undefined;
      if (full) {
        placeValues.push(full);
        const key = placeSegmentKey(full.split(",")[0]);
        if (key) {
          let values = bySegment.get(key);
          if (!values) bySegment.set(key, (values = new Map()));
          values.set(full, (values.get(full) ?? 0) + 1);
        }
      }
      walk(c);
    }
  };
  for (const r of records) walk(r);
  const best = new Map<string, string>();
  for (const [key, values] of bySegment) {
    let top: string | undefined;
    let topCount = 0;
    for (const [value, count] of values) {
      if (count > topCount) {
        top = value;
        topCount = count;
      }
    }
    if (top) best.set(key, top);
  }
  return {
    resolve: (place) => {
      if (!place) return place;
      return best.get(placeSegmentKey(place.split(",")[0])) ?? place;
    },
    structuredAddr: detectPlaceLayout(placeValues, addrCount) === "structured-addr",
  };
}

/** The file-format place resolver as a standalone function — the Add Source
 *  dialog uses it so the Kraj field shows the same resolved value ("Ljubljana"
 *  → "Ljubljana,Ljubljana,Slovenia") that commit/cleanup will write. */
export function makePlaceResolver(records: GedNode[]): (place: string | undefined) => string | undefined {
  return buildPlaceResolver(records).resolve;
}

/**
 * Where a source added on the *person* should actually land when the file
 * keeps its citations on events (more event-level `SOUR` citations than
 * record-level ones — a citation-less file counts as event-preferring, the
 * cleanup tool's own default): the event matching the source's register/record
 * type — baptism book → BIRT/BAPM (the file's habit), marriage book → the
 * sole family's MARR, death record → DEAT, grave → BURI. Undefined = keep the
 * record-level placement.
 */
/** The file's own citation-placement habit: whether existing citations sit
 *  mostly on records or on events. */
export function detectCitationPlacement(records: GedNode[]): "event" | "record" {
  let recordLevel = 0;
  let eventLevel = 0;
  for (const rec of records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    const eventTags = rec.tag === "INDI" ? INDI_EVENT_TAGS : FAM_EVENT_TAGS;
    for (const child of rec.children) {
      if (child.tag === "SOUR" && child.value) recordLevel++;
      else if (eventTags.has(child.tag)) eventLevel += childrenByTag(child, "SOUR").length;
    }
  }
  return recordLevel > eventLevel ? "record" : "event";
}

export function smartCitationTarget(
  records: GedNode[],
  site: ReshapeSite,
  title: string | undefined,
  opts: { citations?: "event" | "record" | "auto"; baptism?: "BIRT" | "BAPM" | "auto" } = {},
): { eventTag: string; onFam: boolean } | undefined {
  // Placement override: "record" pins citations to the record level; "event"
  // skips the file-habit gate; "auto"/absent follows the file's majority.
  if (opts.citations === "record") return undefined;
  if (opts.citations !== "event" && detectCitationPlacement(records) === "record") return undefined;

  const bookType = SITE_BOOK_TYPE[site] ?? classifyBookType([title]);
  if (bookType === "unknown") return undefined;
  if (bookType === "baptism") {
    const tag = opts.baptism && opts.baptism !== "auto" ? opts.baptism : baptismTargetTag(records);
    return { eventTag: tag, onFam: false };
  }
  if (bookType === "marriage") return { eventTag: "MARR", onFam: true };
  if (bookType === "death") return { eventTag: "DEAT", onFam: false };
  return { eventTag: "BURI", onFam: false };
}

/** Stable identity of one occurrence, for matching a report member to its
 *  re-scanned apply-time hit (per-citation QUAY overrides). */
function occurrenceQuayKey(
  recordXref: string,
  shape: ReshapeShape,
  eventTag: string | undefined,
  eventIndex: number | undefined,
  url: string,
): string {
  return [recordXref, shape, eventTag ?? "", eventIndex ?? "", url].join("|");
}

/** Citation child order for a container: record-level vs event-level. */
function childOrderFor(container: GedNode, rec: GedNode): string[] {
  if (container !== rec) return EVENT_CHILD_ORDER;
  return rec.tag === "FAM" ? FAM_CHILD_ORDER : INDI_CHILD_ORDER;
}

/** Recompute `level` down a subtree after a node moves containers. */
function relevel(node: GedNode, level: number): void {
  node.level = level;
  for (const c of node.children) relevel(c, level + 1);
}

/** Set a single-valued field only when the record doesn't already carry one —
 *  reshape enriches, it never overwrites user data. Inserted ahead of the
 *  record's media links and bookkeeping trailer, not appended after them. */
function fillField(rec: GedNode, tag: string, value: string | undefined): void {
  if (!value || childText(rec, tag)) return;
  insertGrouped(rec, { level: rec.level + 1, tag, value, children: [] }, SOUR_FIELD_TRAILING);
}

/**
 * Renders a fetched source date in the file's own date format, so a value
 * scraped off a page doesn't land in the file in a foreign shape. Sites report
 * dates however they please: "23 Jun 1998" (Ancestry prose), "Apr 12, 1979" (a
 * Google Books newspaper heading — which the GEDCOM parser can't even read),
 * "1784-1830" (a register's span). Readable values are re-rendered in the house
 * style; unreadable ones go through the same repair the Health Check offers, so
 * the tool can't create the very "unparseable date" that fix exists to clean up.
 * Whatever survives neither is written as it came. The file's format is derived
 * lazily (a full DATE walk) and reused — most groups carry no date at all.
 */
function houseDateFormatter(records: GedNode[]): (value: string | undefined) => string | undefined {
  let ctx: DateFixContext | undefined;
  return (value) => {
    if (!value?.trim()) return value;
    ctx ??= dateFixContext({ records });
    return proposeDateFix(value, ctx) ?? normalizeDateString(value, ctx.profile, ctx.sourceOrder) ?? value;
  };
}

/** One `EVEN` block of a source's standard coverage: the event type recorded,
 *  its period and the jurisdiction. */
interface CoverageEvent {
  type: string;
  date?: string;
  place?: string;
}

/** The event tag a register type records, for a coverage `EVEN` payload. */
function coverageTagOf(bookType: BookType, baptismTag: "BIRT" | "BAPM"): string | undefined {
  if (bookType === "baptism") return baptismTag;
  if (bookType === "marriage") return "MARR";
  if (bookType === "death") return "DEAT";
  if (bookType === "burial") return "BURI";
  return undefined;
}

/**
 * The `EVEN` blocks a source's standard coverage states: one per register of a
 * multi-register FamilySearch book ("Marriages … 1805-1812 Births … 1815-1843"
 * → `EVEN MARR` + `EVEN BIRT`, each with its own years), else a single block
 * for the book's own type. Empty when no type is known — a coverage claim
 * needs one, so the caller keeps the flat fields instead.
 */
function coverageEvents(
  bookType: BookType,
  baptismTag: "BIRT" | "BAPM",
  place: string | undefined,
  dateRange: string | undefined,
  book: string | undefined,
): CoverageEvent[] {
  const parts = splitFsRegisters(book);
  if (parts.length > 1) {
    const events = parts.flatMap((part) => {
      const tag = coverageTagOf(classifyBookType([part]), baptismTag);
      return tag ? [{ type: tag, date: yearSpan(part), place }] : [];
    });
    // Only when every register is understood — a partial split would claim
    // less than the book holds.
    if (events.length === parts.length) return events;
  }
  const tag = coverageTagOf(bookType, baptismTag);
  return tag ? [{ type: tag, date: dateRange, place }] : [];
}

/** A year range as the spec's period value ("1896-1911" → "FROM 1896 TO
 *  1911"); anything else is written as it came. */
function coveragePeriod(date: string | undefined): string | undefined {
  const m = date && /^(\d{4})\s*[-–]\s*(\d{4})$/.exec(date.trim());
  return m ? `FROM ${m[1]} TO ${m[2]}` : date;
}

/**
 * Write the standard coverage onto a source record: `1 DATA` holding one
 * `2 EVEN` per register (period + jurisdiction), with `AGNC` under `DATA` —
 * its spec spot, so a flat one moves along. Fill-only: a record already
 * stating an `EVEN` coverage keeps it. False when there is nothing to state
 * (no register type known), so the caller writes the flat fields instead.
 */
function applyStandardCoverage(rec: GedNode, events: CoverageEvent[], agency: string | undefined): boolean {
  if (events.length === 0) return false;
  let data = firstChild(rec, "DATA");
  if (!data) {
    data = { level: rec.level + 1, tag: "DATA", children: [] };
    insertGrouped(rec, data, SOUR_FIELD_TRAILING);
  }
  if (childrenByTag(data, "EVEN").length === 0) {
    for (const ev of events) {
      const even: GedNode = { level: data.level + 1, tag: "EVEN", value: ev.type, children: [] };
      const period = coveragePeriod(ev.date);
      if (period) even.children.push({ level: even.level + 1, tag: "DATE", value: period, children: [] });
      if (ev.place) even.children.push({ level: even.level + 1, tag: "PLAC", value: ev.place, children: [] });
      data.children.push(even);
    }
  }
  const flatAgnc = firstChild(rec, "AGNC");
  if (!childText(data, "AGNC")) {
    const value = flatAgnc?.value?.trim() || agency;
    if (value) data.children.push({ level: data.level + 1, tag: "AGNC", value, children: [] });
  }
  if (flatAgnc) spliceChild(rec, flatAgnc);
  return true;
}

/** The registers a source's own *title* names, when it names several — the
 *  `place - book - collection` titles this tool writes keep the multi-register
 *  book label as one segment, and each register in it becomes its own
 *  coverage entry. */
function coverageEventsFromTitle(
  title: string | undefined,
  abbr: string | undefined,
  place: string | undefined,
  dateRange: string | undefined,
  baptismTag: "BIRT" | "BAPM",
): CoverageEvent[] {
  for (const seg of (title ?? "").split(" - ")) {
    const parts = splitFsRegisters(seg.trim());
    if (parts.length > 1) {
      const events = parts.flatMap((part) => {
        const tag = coverageTagOf(classifyBookType([part]), baptismTag);
        return tag ? [{ type: tag, date: yearSpan(part), place }] : [];
      });
      if (events.length === parts.length) return events;
    }
  }
  const tag = coverageTagOf(classifyBookType([title, abbr]), baptismTag);
  return tag ? [{ type: tag, date: dateRange, place }] : [];
}

/**
 * The Normalize pass for source coverage: restate every existing `SOUR`
 * record in the target shape — flat vendor `PLAC`/`DATE` into the spec's
 * `DATA > EVEN` blocks (register type read from the title, `AGNC` moved to
 * its spot under `DATA`, `FILN` folded into an existing repository link's
 * `CALN`), or the reverse. Conservative on purpose: a record whose register
 * type can't be read, whose coverage names several places (inexpressible as
 * one flat `PLAC`), or whose flat fields disagree with its coverage keeps
 * its shape — nothing is invented and nothing is lost.
 */
/**
 * Move a source's `FILN` onto its repository link as the standard `CALN`, and
 * say which id moved. Nothing happens without a repository to hang it on (the
 * call number is part of the repository citation, so there is nowhere else for
 * it to go), nor where the link already states one.
 */
function foldFilingNumber(rec: GedNode): string | undefined {
  const repoLink = firstChild(rec, "REPO");
  const filn = firstChild(rec, "FILN");
  const value = filn?.value?.trim();
  if (!repoLink?.value || !value || firstChild(repoLink, "CALN")) return undefined;
  repoLink.children.push({ level: repoLink.level + 1, tag: "CALN", value, children: [] });
  spliceChild(rec, filn!);
  return value;
}

export function normalizeSourceCoverage(
  records: GedNode[],
  target: "vendor" | "standard",
  baptismTag: "BIRT" | "BAPM",
): { changed: number; examples: NormChange[] } {
  let changed = 0;
  const examples: NormChange[] = [];
  // Same discipline as the other Normalize passes: up to 12 examples, each a
  // *different* transformation — digit runs collapse in the signature, so a
  // hundred same-book pages give one row, while another register type, place
  // or a moved filing number each earn their own.
  const seen = new Set<string>();
  const note = (before: string, after: string) => {
    changed++;
    if (examples.length >= 12) return;
    const signature = `${before.replace(/\d+/g, "#")}→${after.replace(/\d+/g, "#")}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    examples.push({ before, after });
  };

  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    const data = firstChild(rec, "DATA");

    if (target === "standard") {
      // The filing number's standard spot is the repository link's call
      // number, whatever shape the source's coverage is already in — so this
      // runs before the "already standard" bail-out below. A source converted
      // by an earlier run (or written standard from the start) kept its FILN
      // for ever otherwise: the only pass that moves it never looked at it.
      const alreadyStandard = !!data && childrenByTag(data, "EVEN").length > 0;
      const early = alreadyStandard ? foldFilingNumber(rec) : undefined;
      if (early) note(`FILN ${early}`, `CALN ${early}`);
      if (alreadyStandard) continue;
      const plac = firstChild(rec, "PLAC");
      const date = firstChild(rec, "DATE");
      if (!plac?.value?.trim() && !date?.value?.trim()) continue;
      const events = coverageEventsFromTitle(
        sourceTitle(rec),
        childText(rec, "ABBR"),
        plac?.value?.trim(),
        date?.value?.trim(),
        baptismTag,
      );
      if (events.length === 0) continue; // no register type to state
      applyStandardCoverage(rec, events, undefined);
      if (plac) spliceChild(rec, plac);
      if (date) spliceChild(rec, date);
      const foldedFiln = foldFilingNumber(rec);
      note(
        [plac?.value && `PLAC ${plac.value}`, date?.value && `DATE ${date.value}`, foldedFiln && `FILN ${foldedFiln}`]
          .filter(Boolean)
          .join(" · "),
        [
          ...events.map((ev) =>
            [`EVEN ${ev.type}`, coveragePeriod(ev.date), ev.place && `PLAC ${ev.place}`].filter(Boolean).join(" "),
          ),
          foldedFiln && `CALN ${foldedFiln}`,
        ]
          .filter(Boolean)
          .join(" · "),
      );
      continue;
    }

    // target === "vendor": flatten the coverage back into the program fields.
    if (!data) continue;
    const evens = childrenByTag(data, "EVEN");
    const dataAgnc = firstChild(data, "AGNC");
    if (evens.length === 0 && !dataAgnc) continue;
    const places = [...new Set(evens.map((e) => childText(e, "PLAC")).filter(Boolean))] as string[];
    if (places.length > 1) continue; // one flat PLAC cannot carry two jurisdictions
    const years = yearSpan(evens.map((e) => childText(e, "DATE")).filter(Boolean).join(" "));
    const flatPlac = childText(rec, "PLAC");
    const flatDate = childText(rec, "DATE");
    if (flatPlac && places[0] && flatPlac !== places[0]) continue; // disagreement is not ours to settle
    if (flatDate && years && flatDate !== years) continue;
    const before = evens
      .map((e) => [`EVEN ${e.value ?? ""}`.trim(), childText(e, "DATE"), childText(e, "PLAC")].filter(Boolean).join(" "))
      .join(" · ");
    if (places[0] && !flatPlac) {
      insertGrouped(rec, { level: rec.level + 1, tag: "PLAC", value: places[0], children: [] }, SOUR_FIELD_TRAILING);
    }
    if (years && !flatDate) {
      insertGrouped(rec, { level: rec.level + 1, tag: "DATE", value: years, children: [] }, SOUR_FIELD_TRAILING);
    }
    if (dataAgnc?.value?.trim() && !childText(rec, "AGNC")) {
      insertGrouped(
        rec,
        { level: rec.level + 1, tag: "AGNC", value: dataAgnc.value.trim(), children: [] },
        SOUR_FIELD_TRAILING,
      );
    }
    for (const e of evens) spliceChild(data, e);
    if (dataAgnc) spliceChild(data, dataAgnc);
    if (data.children.length === 0 && !data.value?.trim()) spliceChild(rec, data);
    note(
      before || "DATA AGNC",
      [places[0] && `PLAC ${places[0]}`, years && `DATE ${years}`].filter(Boolean).join(" · ") || "AGNC",
    );
  }
  return { changed, examples };
}

/** Repository identity per site: how to spot an existing `REPO` (by its WWW
 *  host) and what to create when the file's convention hangs sources off
 *  repositories. Matricula derives name/WWW per archive instead. */
const SITE_REPO: Partial<Record<ReshapeSite, { hostRe: RegExp; name: string; www: string }>> = {
  matricula: { hostRe: /data\.matricula-online\.eu/i, name: "Matricula Online", www: "https://data.matricula-online.eu/" },
  geneanet: { hostRe: /geneanet\.org\/cemetery|en\.geneanet\.org/i, name: "Geneanet Cemeteries", www: "https://en.geneanet.org/cemetery/" },
  geneanettree: { hostRe: /gw\.geneanet\.org/i, name: "Geneanet", www: "https://gw.geneanet.org/" },
  findagrave: { hostRe: /findagrave\.com/i, name: "Find a Grave", www: "https://www.findagrave.com/" },
  billiongraves: { hostRe: /billiongraves\.com/i, name: "BillionGraves", www: "https://billiongraves.com/" },
  legacy: { hostRe: /legacy\.com/i, name: "Legacy.com", www: "https://www.legacy.com/" },
  newspapers: { hostRe: /newspapers\.com/i, name: "Newspapers.com", www: "https://www.newspapers.com/" },
  sistory: { hostRe: /sistory\.si/i, name: "SIstory.si", www: "https://www.sistory.si/" },
  dlib: { hostRe: /dlib\.si/i, name: "dLib.si — Digitalna knjižnica Slovenije", www: "https://www.dlib.si/" },
  googlebooks: { hostRe: /books\.google\./i, name: "Google Books", www: "https://books.google.com/" },
  youtube: { hostRe: /youtube\.com|youtu\.be/i, name: "YouTube", www: "https://www.youtube.com/" },
  wikipedia: { hostRe: /wikipedia\.org/i, name: "Wikipedia", www: "https://www.wikipedia.org/" },
  biografija: { hostRe: /slovenska-biografija\.si/i, name: "Slovenska biografija", www: "https://www.slovenska-biografija.si/" },
  obrazi: { hostRe: /obrazislovenskihpokrajin\.si/i, name: "Obrazi slovenskih pokrajin", www: "https://www.obrazislovenskihpokrajin.si/" },
  familysearch: { hostRe: /familysearch\.org/i, name: "FamilySearch.org", www: "https://www.familysearch.org/" },
};

/** The part of a repository's name after the site it belongs to —
 *  "FamilySearch.org - Croatia" holds "Croatia". */
export function repoNameTail(name: string): string {
  return /^.*?\s[-–—]\s(.+)$/.exec(name.trim())?.[1].trim() ?? "";
}

/**
 * The country a repository record stands for: the one its name gives after
 * the site, and only when that tail *is* a country's name. A repository kept
 * for a single collection ("FamilySearch.org - Illinois, Cook County Deaths,
 * 1871-1998") names a country inside a collection title, which is a different
 * thing and must not answer for the country's own record.
 */
export function repoCountryFacet(name: string | undefined): string {
  const tail = repoNameTail(name ?? "");
  if (!tail) return "";
  // A state's own record is its country and the state, and nothing else —
  // "United States, Illinois", or either order for a name typed by hand. A
  // collection title that merely names a state ("Illinois, Cook County Deaths,
  // 1871-1998") has more in it than that, and answers for nobody.
  const parts = tail.split(",").map((s) => s.trim()).filter(Boolean);
  const exactState = (text: string) => {
    const state = stateOf(text);
    return state && foldCountryName(state.name) === foldCountryName(text) ? state : undefined;
  };
  if (parts.length === 1) {
    const state = exactState(parts[0]);
    if (state) return `${state.country}:${looseKey(state.name)}`;
  }
  if (parts.length === 2) {
    for (const [countryPart, statePart] of [[parts[0], parts[1]], [parts[1], parts[0]]]) {
      const state = exactState(statePart);
      if (state && countryCodeOfName(countryPart) === state.country) {
        return `${state.country}:${looseKey(state.name)}`;
      }
    }
  }
  return countryCodeOfName(tail) ? placeCountryFacet(tail) : "";
}

/** Existing REPO for a site: one whose WWW is on the site's host, or one named
 *  after the site — a file keeping a repository per collection may name it
 *  "FamilySearch.org - Croatia Church Books 1516-1994" and give it no WWW at
 *  all. The country's own repository wins when one is wanted, then a record
 *  naming any of `prefer` (the Matricula archive); else the first match. */
function findSiteRepo(
  records: GedNode[],
  hostRe: RegExp,
  siteName: string,
  prefer: (string | undefined)[] = [],
  /** With a specific country wanted, fall back only to a *generic* site
   *  repository — one kept for another country, or for a single collection
   *  ("FamilySearch.org - Croatia Church Books 1516-1994"), would be the wrong
   *  home, and the caller proposes creating the right one. */
  strictFallback = false,
  /** The country the source belongs to, for sites grouped by country. */
  countryFacet = "",
): string | undefined {
  const wanted = prefer.map((p) => (p ? looseKey(p) : "")).filter(Boolean);
  const site = looseKey(siteName);
  let anyMatch: string | undefined;
  let genericMatch: string | undefined;
  for (const rec of records) {
    if (rec.tag !== "REPO" || !rec.xref) continue;
    const www = childText(rec, "WWW") ?? "";
    const name = childText(rec, "NAME") ?? "";
    if (!hostRe.test(www) && !looseKey(name).startsWith(site)) continue;
    if (countryFacet && repoCountryFacet(name) === countryFacet) return rec.xref;
    const haystack = looseKey(`${name} ${www}`);
    if (wanted.some((w) => haystack.includes(w))) return rec.xref;
    anyMatch ??= rec.xref;
    // Generic = named exactly after the site (no country or collection
    // suffix), or a nameless record matched by a bare-host WWW.
    if (name ? site.startsWith(looseKey(name)) : /^https?:\/\/[^/]+\/?$/i.test(www.trim())) genericMatch ??= rec.xref;
  }
  // Strict: only the wanted record, or the site's own general one. A file that
  // keeps a repository per place has several, and handing a link to whichever
  // came first files it under a country it has nothing to do with.
  return strictFallback ? genericMatch : anyMatch;
}

/** The site's REPO for a new source: an existing one matched by WWW host
 *  (preferring the Matricula archive's), else — only when the file's
 *  convention hangs sources off repositories — a newly created record. */
/**
 * What linking a recognized site's repository would do for a new source:
 * the existing `REPO` record it would reuse (matched by WWW host, preferring
 * the Matricula archive's), or the name of the record it would create.
 * Lets the Add Source dialog show/preselect the repository before saving.
 */
/**
 * The repository the file already keeps for a FamilySearch collection: the one
 * its other pages hang off, found by the collection id (`cc=`) their links
 * carry. A bare browse link says nothing about the country its records are
 * from — but the file has answered that question before, and its own answer
 * beats asking FamilySearch again.
 */
function repoOfCitedCollection(records: GedNode[], cc: string | undefined): string | undefined {
  if (!cc) return undefined;
  const objeIndex = buildObjeIndex(records);
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    const repo = firstChild(rec, "REPO")?.value?.trim();
    if (!repo) continue;
    for (const child of childrenByTag(rec, "OBJE")) {
      const objeUrl = child.value ? objeIndex.get(child.value.trim())?.url : undefined;
      if (objeUrl && parseFamilySearchUrl(objeUrl)?.cc === cc) return repo;
    }
  }
  return undefined;
}

export function proposedSiteRepo(
  records: GedNode[],
  site: ReshapeSite,
  url: string,
  agency: string | undefined,
  /** What the FamilySearch link covers, once known — the place read off it
   *  picks the file's repository for that place out of several. */
  collection?: FsCollection,
): { xref?: string; createName?: string } | undefined {
  const repoDef = SITE_REPO[site];
  if (!repoDef) return undefined;
  // A page of a collection the file already cites goes where its siblings are,
  // whatever the link alone can be made to say.
  if (site === "familysearch") {
    const sibling = repoOfCitedCollection(records, parseFamilySearchUrl(url)?.cc);
    if (sibling) return { xref: sibling };
  }
  const mat = site === "matricula" ? parseMatriculaUrl(url) : undefined;
  const country = site === "familysearch" ? fsRepoCountry(collection) : undefined;
  const existing = findSiteRepo(
    records,
    repoDef.hostRe,
    repoDef.name,
    [mat?.archiveSlug],
    // FamilySearch repositories are kept per place — a repository for another
    // country (or for one single collection) must not swallow this link, and
    // nor must any of them when the place is still unknown: the site's own
    // general record is the only honest home until the lookup, the citation or
    // a sibling page says where the records are from.
    site === "familysearch" || Boolean(country?.facet),
    country?.facet,
  );
  if (existing) return { xref: existing };
  // Matricula repositories are the holding archive; FamilySearch keeps one per
  // country of records; the other sites are their own repository.
  return { createName: siteRepoName(site, repoDef.name, agency, country?.name) };
}

/** What a FamilySearch link covers, as the repository logic needs it: the
 *  collection it belongs to (title and id) and the place its records are
 *  from. Any of them may be missing. */
export interface FsCollection {
  title?: string;
  id?: string;
  /** The place the records cover ("Chicago, Cook, Illinois, United States") —
   *  the surest statement of the country whose repository holds the source. */
  place?: string;
}

/**
 * The country a FamilySearch source belongs to: the one its place names,
 * else the one its collection title opens with ("Illinois, Cook County
 * Deaths, 1871-1998" is American). Named as the place itself writes it where
 * it says so outright, and in English otherwise — the site and its collection
 * titles are English, so a country read out of one is too.
 */
export function fsRepoCountry(collection: FsCollection | undefined): { facet: string; name: string } | undefined {
  const place = collection?.place?.trim();
  const title = collection?.title ?? "";
  const facet = (place && placeCountryFacet(place)) || titleCountryFacet(title);
  if (!facet) return undefined;
  const written = place && placeCountryFacet(place) === facet ? countryNameOf(place) : undefined;
  const country = written ?? countryFacetName(facet, "en");
  // Where a country's records are published state by state — American ones
  // are, and this file's own places say which state — the state is the
  // repository, since a single "United States" record would hold everything.
  // A national collection ("United States, Census, 1930") names no state and
  // keeps the country itself.
  const state = (place ? stateOf(place) : undefined) ?? stateOf(title);
  if (!state || state.country !== facet) return { facet, name: country };
  // Country first, so a state's record reads as a narrowing of the country's
  // and the two sort together — "United States", "United States, Illinois".
  return { facet: `${facet}:${looseKey(state.name)}`, name: `${country}, ${state.name}` };
}

/** What a new repository for the site is called: the holding archive for
 *  Matricula, the country of the records for FamilySearch, else the site
 *  itself. */
function siteRepoName(
  site: ReshapeSite,
  siteName: string,
  agency: string | undefined,
  country: string | undefined,
): string {
  if (site === "matricula" && agency) return agency;
  if (site === "familysearch" && country) return `${siteName} - ${country}`;
  return siteName;
}

/** Create the site's `REPO` record (name + WWW) — the Add Source dialog's
 *  explicit "＋ new repository" choice, unconditional on the file's layout.
 *  `nameOverride` is the dialog's edited name for the proposal — the record
 *  keeps the site/collection WWW either way. */
export function createSiteRepo(
  records: GedNode[],
  site: ReshapeSite,
  url: string,
  agency: string | undefined,
  collection?: FsCollection,
  nameOverride?: string,
): GedNode | undefined {
  const repoDef = SITE_REPO[site];
  if (!repoDef) return undefined;
  const mat = site === "matricula" ? parseMatriculaUrl(url) : undefined;
  const country = site === "familysearch" ? fsRepoCountry(collection) : undefined;
  const name = nameOverride?.trim() || siteRepoName(site, repoDef.name, agency, country?.name);
  // A country's repository spans many collections, so it carries the site's
  // own address rather than any one collection's page.
  const www = mat
    ? `https://data.matricula-online.eu/${mat.lang}/${mat.country}/${mat.archiveSlug}/`
    : repoDef.www;
  const repo: GedNode = { level: 0, xref: nextXref(records, "R"), tag: "REPO", children: [] };
  repo.children.push({ level: 1, tag: "NAME", value: name, children: [] });
  repo.children.push({ level: 1, tag: "WWW", value: www, children: [] });
  insertRecord(records, repo);
  return repo;
}

function ensureSiteRepo(
  records: GedNode[],
  site: ReshapeSite,
  url: string,
  agency: string | undefined,
  repositoryLayout: boolean,
  collection?: FsCollection,
): { xref: string; created?: GedNode } | undefined {
  const proposal = proposedSiteRepo(records, site, url, agency, collection);
  if (!proposal) return undefined;
  if (proposal.xref) return { xref: proposal.xref };
  if (!repositoryLayout) return undefined;
  const repo = createSiteRepo(records, site, url, agency, collection);
  return repo ? { xref: repo.xref!, created: repo } : undefined;
}

/**
 * Give a SOUR record newly created from a recognized site URL the same extras
 * the Organize sources tool writes on its own new sources: `PLAC` matched
 * against the file's established place format, the register's `DATE` range,
 * and a `REPO` link — reusing the site's existing repository, or creating one
 * only when the file's convention hangs sources off repositories. Returns the
 * newly created REPO record, if any, so the caller can patch/undo it.
 * Without a `site` (a hand-entered place on an unrecognized URL) only the
 * PLAC/DATE fills apply.
 */
export function applySiteSourceExtras(
  records: GedNode[],
  sourceNode: GedNode,
  site: ReshapeSite | undefined,
  url: string,
  meta: { place?: string; dateRange?: string; collection?: string; collectionId?: string },
  opts: {
    sourceLayout?: SourceLayout | "auto";
    repo?: "auto" | "none";
    sourceCoverage?: "vendor" | "standard" | "auto";
    baptism?: "BIRT" | "BAPM" | "auto";
  } = {},
): GedNode | undefined {
  const place = buildPlaceResolver(records).resolve(meta.place);
  const dateRange = houseDateFormatter(records)(meta.dateRange);
  const coverage =
    opts.sourceCoverage && opts.sourceCoverage !== "auto" ? opts.sourceCoverage : detectSourceCoverage(records);
  // The register type the coverage would claim: the site's inherent kind, or
  // whatever the title says ("… - Deaths (Umrli) 1896-1911 - …").
  const bookType = (site ? SITE_BOOK_TYPE[site] : undefined) ?? classifyBookType([childText(sourceNode, "TITL")]);
  const baptismTag = opts.baptism && opts.baptism !== "auto" ? opts.baptism : baptismTargetTag(records);
  const standard =
    coverage === "standard" &&
    applyStandardCoverage(
      sourceNode,
      coverageEvents(bookType, baptismTag, place, dateRange, undefined),
      undefined,
    );
  if (!standard) {
    fillField(sourceNode, "PLAC", place);
    fillField(sourceNode, "DATE", dateRange);
  }
  // "none": the caller handles the repository choice itself (the Add Source
  // dialog's explicit dropdown) — only the PLAC/DATE fills apply here.
  if (opts.repo === "none" || !site || firstChild(sourceNode, "REPO")) return undefined;
  // The source being enriched is already in `records` — it must not vote
  // against the habit it is about to follow.
  const createRepos = repoLinkWanted(records, opts.sourceLayout, sourceNode);
  const repo = ensureSiteRepo(records, site, url, childText(sourceNode, "AGNC"), createRepos, {
    title: meta.collection,
    id: meta.collectionId,
    place: meta.place,
  });
  if (!repo) return undefined;
  const link: GedNode = { level: sourceNode.level + 1, tag: "REPO", value: repo.xref, children: [] };
  // The same id, in the one place this file states it: the repository link's
  // call number where the file writes those, else the source's own FILN,
  // which is already there. Writing both would say it twice.
  const filn = childText(sourceNode, "FILN");
  if (filn && writesCallNumbers(records, coverage)) {
    link.children.push({ level: link.level + 1, tag: "CALN", value: filn, children: [] });
  }
  sourceNode.children.push(link);
  return repo.created;
}

/**
 * What a source from a recognized site is called: the lookup names the thing
 * itself — a cemetery, a register — while the id that tells one of them from
 * the next comes from the link. A Geneanet
 * cemetery is the case that needs both: every grave in one cemetery answers
 * with the same name, so a title without the view id leaves a file full of
 * sources called "Pokopališče Kranj - Geneanet Cemeteries" that nothing can
 * tell apart — the duplicate finder included, which reads two of them as one
 * record under different ids.
 */
export function siteSourceTitle(
  site: ReshapeSite | undefined,
  title: string | undefined,
  id: string | undefined,
): string | undefined {
  if (!title || site !== "geneanet" || !id || title.includes(id)) return title;
  const label = "Geneanet Cemeteries";
  const name = title.endsWith(` - ${label}`) ? title.slice(0, -label.length - 3) : title;
  return siteTitle(name, id, label);
}

/** The same, for a scanned group: the lookup's name over the offline one, and
 *  the id the link carried either way. */
function enrichedTitle(g: ReshapeGroup, extra: ReshapeMeta | undefined): string {
  return siteSourceTitle(g.site, extra?.title ?? g.proposed.title, g.proposed.filingNumber) ?? g.proposed.title;
}

/**
 * Apply the reshape for the selected groups on a fresh clone of `records` —
 * the input is never mutated. `enrichment` (from {@link fetchReshapeMeta})
 * overrides the offline-proposed source fields per group id.
 */
export function reshapeSources(
  records: GedNode[],
  selected: ReshapeGroup[],
  enrichment?: ReshapeEnrichment,
  opts: ReshapeOptions = {},
): { records: GedNode[]; counts: ReshapeCounts } {
  const counts: ReshapeCounts = {
    sourcesCreated: 0,
    sourcesReused: 0,
    mediaCreated: 0,
    citationsAdded: 0,
    citationsRewritten: 0,
    linksRemoved: 0,
    notesRewritten: 0,
    eventsCreated: 0,
    linksTidied: 0,
    linksSwapped: 0,
    mediaRetitled: 0,
  };
  if (selected.length === 0) return { records, counts };

  const selectedById = new Map(selected.map((g) => [g.id, g]));
  const sites = new Set<ReshapeSite>(selected.map((g) => g.site));
  const relocate = opts.relocate !== false;

  const clone = records.map(cloneNode);
  const byXref = new Map<string, GedNode>();
  for (const r of clone) if (r.xref) byXref.set(r.xref, r);

  const { fold, pageMedia, baptismTag, createRepos, coverage } = resolveFormatOptions(clone, opts);
  // Where this file states an archive's id: the repository link's call number,
  // or the source's own filing number. One or the other, never both.
  const callNumbers = writesCallNumbers(clone, coverage);
  // A link folded into a book is selected under the book's id, not its own.
  const hits = scanOccurrences(clone, sites, fold ? pageMedia : undefined).filter((h) =>
    selectedById.has(opts.mergeGroups?.get(h.recognized.groupKey) ?? h.recognized.groupKey),
  );
  const groups = foldMergedGroups(buildGroups(clone, hits, fold), opts.mergeGroups);
  // Media index built ONCE for the whole apply (a per-group rebuild is a full
  // forest scan each time); OBJEs this run creates are tracked alongside.
  const cloneObjeIndex = buildObjeIndex(clone);
  // Which sources hold each page as their own media — read before this run
  // links any, so a page already cited through another source is left as it is
  // rather than cited twice (see `isSettledPointer`).
  const pageHolders = sourcesHoldingPages(clone, cloneObjeIndex);
  const createdObjeUrls = new Map<string, string>();
  const urlOfObje = (xref: string): string | undefined =>
    cloneObjeIndex.get(xref)?.url ?? createdObjeUrls.get(xref);
  const ctx: RelocationContext = { byXref, urlOfObje };
  const { resolve: resolvePlace, structuredAddr } = buildPlaceResolver(clone);
  const houseDate = houseDateFormatter(clone);

  for (const [key, state] of groups) {
    const selection = selectedById.get(key);
    if (!selection) continue;
    const g = state.group;

    // Marked as a dead/obsolete link: strip every occurrence instead of
    // converting — note text and citation prose around the URL survive, the
    // bare link nodes go, and no source is created or reused.
    if (selection.removeLinks) {
      for (const hit of state.hits) {
        if (hit.shape === "sourTitle") continue; // a record's title, not a reference
        if (hit.shape === "pageUrl") {
          const pageChild = firstChild(hit.node, "PAGE");
          if (pageChild?.value) {
            const remaining = removeUrlFromText(pageChild.value, hit.url);
            if (hasContent(remaining)) pageChild.value = remaining;
            else spliceChild(hit.node, pageChild);
            counts.citationsRewritten++;
          }
          continue;
        }
        if ((hit.shape === "note" || hit.shape === "inline") && hit.node.value !== undefined) {
          const remaining = removeUrlFromText(hit.node.value, hit.url);
          if (hasContent(remaining)) {
            hit.node.value = remaining;
            counts.notesRewritten++;
            continue;
          }
        }
        if (spliceChild(hit.container, hit.node)) counts.linksRemoved++;
      }
      continue;
    }

    // Links the reader traded for another in the ✎ editor — a FamilySearch
    // record page for the image behind it. Keyed by the link they replace, so
    // a trade still finds its occurrences after the pages of one film have
    // been folded into a single book.
    const swapByUrl = new Map<string, string>();
    for (const m of selection.members) {
      if (m.swapUrl && linkKey(m.swapUrl) !== linkKey(m.url)) {
        swapByUrl.set(linkKey(m.url), familySearchPageUrl(m.swapUrl));
      }
    }
    const swapOf = (hit: ScanHit): string | undefined => swapByUrl.get(linkKey(hit.url));
    /** The URL a hit's page media is written with — its own, or the trade. */
    const urlFor = (hit: ScanHit): string => swapOf(hit) ?? hit.url;

    const extra = enrichment?.get(key);
    const bookType = extra?.bookType ?? g.bookType;
    const fields = {
      title: enrichedTitle(g, extra),
      author: extra?.author ?? g.proposed.author,
      periodical: extra?.periodical,
      publisher: extra?.publisher,
      agency: extra?.agency ?? g.proposed.agency,
      // Matched against the file's own places, so "Žabnica, Slovenia" (or a
      // diacritic-less slug guess) lands in the established place format.
      place: resolvePlace(extra?.place ?? g.proposed.place),
      filingNumber: extra?.filingNumber ?? g.proposed.filingNumber,
      dateRange: houseDate(extra?.dateRange ?? g.proposed.dateRange),
    };

    // --- Resolve the target SOUR record: reuse, adopt a URL-titled one, or create.
    let sourceNode = g.existingSourceXref ? byXref.get(g.existingSourceXref) : undefined;
    if (sourceNode) {
      counts.sourcesReused++;
      // A record made before the id was known keeps its own title, but the
      // empty id is the tool's to fill: it is what the link carries, and
      // without it nothing on the record says which grave (or which book)
      // this is. It goes in the one place this file states ids — the
      // repository link's call number, or the source's own filing number,
      // never both (see `writesCallNumbers`).
      const repoLink = callNumbers ? firstChild(sourceNode, "REPO") : undefined;
      if (repoLink) fillField(repoLink, "CALN", fields.filingNumber);
      else fillField(sourceNode, "FILN", fields.filingNumber);
    } else {
      sourceNode = createSourceRecord(clone, fields);
      byXref.set(sourceNode.xref!, sourceNode);
      counts.sourcesCreated++;
      // What the source covers: the spec's `DATA > EVEN` blocks in a
      // standard-coverage file, else the flat vendor fields
      // (`NewSourceFields` has neither — the paginated house shape does).
      const standard =
        coverage === "standard" &&
        applyStandardCoverage(
          sourceNode,
          coverageEvents(bookType, baptismTag, fields.place, fields.dateRange, extra?.book),
          fields.agency,
        );
      if (!standard) {
        fillField(sourceNode, "PLAC", fields.place);
        fillField(sourceNode, "DATE", fields.dateRange);
      }
      // The reader's own choice in the field editor, where they made one: a
      // repository of the file, the site's proposal outright, or none. Silence
      // leaves it to the file's habit, as before.
      const picked = extra?.repoXref;
      const repo =
        picked === ""
          ? undefined
          : picked && picked !== "@create@"
            ? { xref: picked }
            : ensureSiteRepo(clone, g.site, urlFor(state.hits[0]), fields.agency, createRepos || picked === "@create@", {
                title: extra?.collection ?? fields.title,
                id: extra?.collectionId,
                place: fields.place,
              });
      if (repo) {
        if (repo.created) byXref.set(repo.created.xref!, repo.created);
        const link: GedNode = { level: 1, tag: "REPO", value: repo.xref, children: [] };
        // The filing number doubles as the call number within that repository
        // (the Matricula book id, the FamilySearch film) — the standard spot a
        // strict reader looks for it is the repository link's CALN.
        if (fields.filingNumber && callNumbers) {
          link.children.push({ level: 2, tag: "CALN", value: fields.filingNumber, children: [] });
          // The call number now carries the id, so the source's own field must
          // not repeat it: a file holding the same id twice says it twice, and
          // a reader who edits one leaves the other stale. (A source that ends
          // up with no repository keeps its FILN — the id must live somewhere.)
          const filn = firstChild(sourceNode, "FILN");
          if (filn) spliceChild(sourceNode, filn);
        }
        sourceNode.children.push(link);
      }
    }
    const sourceXref = sourceNode.xref!;


    // Which page of the source each link is. A page number the URL itself
    // carries wins; then the one the report put on that member — for a book
    // folded out of many single-image links, that is where each image's own
    // number lives; then the group's own, for a source cited at one page.
    const pageByUrl = new Map<string, string>();
    for (const m of selection.members) if (m.page) pageByUrl.set(linkKey(m.url), m.page);
    // A traded link is a different page of the source, so the number read off
    // the link it replaced says nothing: the member carries the page the editor
    // settled on (that is what the reader saw), and the new link's own number
    // backs it up.
    const pageOf = (hit: ScanHit): string | undefined => {
      const swap = swapOf(hit);
      if (swap) return pageByUrl.get(linkKey(hit.url)) ?? recognizeSourceUrl(swap)?.page ?? extra?.page;
      return hit.recognized.page ?? pageByUrl.get(linkKey(hit.url)) ?? extra?.page;
    };

    /** The link this run stores for a page: canonical, and completed with what
     *  the run has learned that the copied link left out — the image its page
     *  number names, the collection its lookup resolved. What the link itself
     *  carries always stands. */
    const storedLink = (url: string, hit: ScanHit): string =>
      familySearchPageUrl(url, { image: familySearchImageIndex(pageOf(hit)), cc: extra?.collectionId });

    // Re-point what the media already holds: at the traded link where the
    // reader chose one, else — asked for it — at the same link in the form the
    // file stores, minus the viewer state that made one page look like several
    // and plus the page and collection the link was copied without.
    if (opts.tidyLinks || swapByUrl.size) {
      for (const hit of state.hits) {
        const xref = hit.objeXref;
        const obje = xref ? byXref.get(xref) : undefined;
        const file = obje && firstChild(obje, "FILE");
        const stored = file?.value?.trim();
        const swap = swapOf(hit);
        const next = swap ? storedLink(swap, hit) : opts.tidyLinks && stored ? storedLink(stored, hit) : undefined;
        if (xref && file && next && next !== stored) {
          file.value = next;
          // The index the OBJE-per-page pass reads was taken before this
          // rewrite — leave it saying what the record now holds.
          cloneObjeIndex.delete(xref);
          createdObjeUrls.set(xref, next);
          if (swap) counts.linksSwapped++;
          else counts.linksTidied++;
        }
      }
    }

    // --- Name the media the file already holds for these pages. A page image
    // saved from the site carries whatever the site's own button wrote — every
    // one of them "FamilySearch.org", or the raw address — which says where it
    // came from and nothing about what it is. Once the lookup has named the
    // book, its pages can be named after it, exactly as a media record this run
    // creates is. A title that already says something is left alone.
    for (const hit of state.hits) {
      const obje = hit.objeXref ? byXref.get(hit.objeXref) : undefined;
      if (!obje) continue;
      const titl = firstChild(obje, "TITL");
      if (!placeholderMediaTitle(titl?.value, g.site, hit.url)) continue;
      const named = pageObjeTitle(g.site, fields.title, pageOf(hit));
      if (!named || named === titl?.value?.trim()) continue;
      if (titl) titl.value = named;
      else insertGrouped(obje, { level: obje.level + 1, tag: "TITL", value: named, children: [] }, MEDIA_TRAILING);
      counts.mediaRetitled++;
    }

    // --- Rewrite URL-titled SOUR records in place (every one in the group, so
    // the duplicates tool can consolidate them afterwards).
    for (const hit of state.hits) {
      if (hit.shape !== "sourTitle") continue;
      hit.node.value = fields.title;
      fillField(hit.rec, "AUTH", fields.author);
      const std =
        coverage === "standard" &&
        applyStandardCoverage(
          hit.rec,
          coverageEvents(bookType, baptismTag, fields.place, fields.dateRange, extra?.book),
          fields.agency,
        );
      if (!std) {
        fillField(hit.rec, "AGNC", fields.agency);
        fillField(hit.rec, "PLAC", fields.place);
        fillField(hit.rec, "DATE", fields.dateRange);
      }
      fillField(hit.rec, "FILN", fields.filingNumber);
      counts.citationsRewritten++;
    }

    // --- Ensure one OBJE per distinct page URL under the target SOUR.
    const linkedKeys = new Set<string>();
    for (const c of childrenByTag(sourceNode, "OBJE")) {
      const v = c.value?.trim();
      const url = v && urlOfObje(v);
      if (url) linkedKeys.add(linkKey(url));
    }
    const seenUrls = new Set<string>();
    // Hits that point at an existing top-level OBJE record go first, so a
    // same-URL bare link elsewhere in the file can't win the race and mint a
    // duplicate media record while orphaning the existing one.
    const ensureOrder = [...state.hits].sort((a, b) => Number(!!b.objeXref) - Number(!!a.objeXref));
    for (const hit of ensureOrder) {
      const hitUrl = urlFor(hit);
      const urlKey = linkKey(hitUrl);
      if (seenUrls.has(urlKey) || linkedKeys.has(urlKey)) continue;
      seenUrls.add(urlKey);
      const page = pageOf(hit);
      const objeTitle = pageObjeTitle(g.site, fields.title, page) ?? fields.title;
      if (hit.objeXref && byXref.has(hit.objeXref)) {
        // Re-link the already-existing top-level OBJE under the source,
        // grouped with its other page media (not after CHAN/CREA).
        insertGrouped(sourceNode, { level: 1, tag: "OBJE", value: hit.objeXref, children: [] }, SOUR_TRAILING);
      } else {
        // Written stripped of viewer state but keeping what selects the page,
        // so a page linked twice by two readers lands as one media record and
        // still reopens where it was copied (see `familySearchPageUrl`).
        const obje = addObjeToSource(clone, sourceXref, storedLink(hitUrl, hit), objeTitle);
        if (obje.xref) createdObjeUrls.set(obje.xref, hitUrl);
        counts.mediaCreated++;
      }
      linkedKeys.add(urlKey);
    }

    // Where each cited page's image lives — in the "event" page-media style
    // the citation's container gets that OBJE linked beside it, so the page
    // shows inline with the fact (webtrees-style).
    const objeByUrlKey = new Map<string, string>();
    if (pageMedia === "event") {
      for (const c of childrenByTag(sourceNode, "OBJE")) {
        const v = c.value?.trim();
        const url = v && urlOfObje(v);
        if (v && url) objeByUrlKey.set(linkKey(url), v);
      }
    }
    const ensurePageMedia = (target: GedNode, targetOrder: string[], url: string) => {
      const xref = objeByUrlKey.get(linkKey(url));
      if (!xref) return;
      if (childrenByTag(target, "OBJE").some((c) => c.value?.trim() === xref)) return;
      insertOrdered(target, { level: target.level + 1, tag: "OBJE", value: xref, children: [] }, targetOrder);
    };

    // --- Rewrite each occurrence into a citation. Per-citation QUAY overrides
    // from the report's members are matched by a stable occurrence key (not by
    // position), so an edit between scan and apply can't shift an override
    // onto the wrong citation.
    const quayByKey = new Map<string, string[]>();
    for (const m of selection.members) {
      if (!m.quay) continue;
      const key = occurrenceQuayKey(m.recordXref, m.shape, m.eventTag, m.eventIndex, m.url);
      const queue = quayByKey.get(key);
      if (queue) queue.push(m.quay);
      else quayByKey.set(key, [m.quay]);
    }
    for (const hit of state.hits) {
      const quayFor =
        quayByKey
          .get(occurrenceQuayKey(hit.rec.xref ?? "?", hit.shape, hit.eventTag, hit.eventIndex, hit.url))
          ?.shift() ?? selection.quay;
      if (hit.shape === "sourTitle") continue;

      // Superseded by an identical event-level attachment: clean up only.
      if (hit.foldedInto) {
        if (hit.shape === "note" && hit.node.value !== undefined) {
          const remaining = removeUrlFromText(hit.node.value, hit.url);
          if (hasContent(remaining)) {
            hit.node.value = remaining;
            counts.notesRewritten++;
            continue;
          }
        }
        if (spliceChild(hit.container, hit.node)) counts.linksRemoved++;
        continue;
      }

      const page = pageOf(hit);
      const move = relocate && !hit.twinEvent ? relocationTarget(hit, bookType, baptismTag, ctx, sourceXref) : undefined;
      if (isSettledPointer(hit, move, [sourceXref, ...(pageHolders.get(linkKey(hit.url)) ?? [])], pageMedia, page, quayFor))
        continue;
      let container = hit.container;
      if (move) {
        const host = move.famXref ? byXref.get(move.famXref) : hit.rec;
        if (host) {
          let event = firstChild(host, move.eventTag);
          if (!event) {
            event = { level: host.level + 1, tag: move.eventTag, children: [] };
            insertOrdered(host, event, host.tag === "FAM" ? FAM_CHILD_ORDER : INDI_CHILD_ORDER);
            counts.eventsCreated++;
          }
          container = event;
        }
      }
      // A relocation target is always an event node; otherwise the original
      // container decides (record-level vs event-level order).
      const order = container === hit.container ? childOrderFor(container, hit.rec) : EVENT_CHILD_ORDER;

      // A grave record tells us where the burial is: fill the BURI event's
      // missing place from the source's location (never overwrite one). In a
      // place+address file, the cemetery name goes into the event's ADDR —
      // also when the event already carries a place of its own.
      if (bookType === "burial" && container.tag === "BURI") {
        if (fields.place && !firstChild(container, "PLAC")) {
          insertOrdered(
            container,
            { level: container.level + 1, tag: "PLAC", value: fields.place, children: [] },
            EVENT_CHILD_ORDER,
          );
        }
        if (structuredAddr && extra?.address && !firstChild(container, "ADDR")) {
          insertOrdered(
            container,
            { level: container.level + 1, tag: "ADDR", value: extra.address, children: [] },
            EVENT_CHILD_ORDER,
          );
        }
      }

      if (hit.shape === "inline" || hit.shape === "pageUrl") {
        // Convert the citation node itself, preserving its other children.
        const citation = hit.node;
        citation.value = sourceXref;
        const pageChild = firstChild(citation, "PAGE");
        if (hit.shape === "pageUrl" && pageChild?.value) {
          // Swap the URL for its page number in place, keeping surrounding
          // prose ("fol. 23, <url>" → "fol. 23, 5"); drop PAGE only when
          // nothing meaningful remains.
          const replaced = page
            ? pageChild.value.replace(hit.url, page).replace(/[ \t]{2,}/g, " ").trim()
            : removeUrlFromText(pageChild.value, hit.url);
          if (hasContent(replaced)) pageChild.value = replaced;
          else spliceChild(citation, pageChild);
        } else if (page) {
          if (pageChild) pageChild.value = page;
          else citation.children.push({ level: citation.level + 1, tag: "PAGE", value: page, children: [] });
        }
        if (hit.prefix && !childrenByTag(citation, "NOTE").some((n) => n.value?.trim() === hit.prefix)) {
          citation.children.push({ level: citation.level + 1, tag: "NOTE", value: hit.prefix, children: [] });
        }
        if (quayFor && !firstChild(citation, "QUAY")) {
          citation.children.push({ level: citation.level + 1, tag: "QUAY", value: quayFor, children: [] });
        }
        // Compare by the citation's *final* PAGE text (not just the page id):
        // Ancestry exports duplicate whole record-level citations verbatim,
        // and the identical twin must fold into one citation, not two.
        const pageText = childText(citation, "PAGE") ?? "";
        const duplicate = childrenByTag(container, "SOUR").find(
          (c) => c !== citation && c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === pageText,
        );
        // Folding into the surviving twin: fill its missing QUAY too.
        if (duplicate && quayFor && !firstChild(duplicate, "QUAY")) {
          duplicate.children.push({ level: duplicate.level + 1, tag: "QUAY", value: quayFor, children: [] });
        }
        if (container !== hit.container) {
          spliceChild(hit.container, citation);
          if (!duplicate) {
            relevel(citation, container.level + 1);
            insertOrdered(container, citation, order);
          }
        } else if (duplicate) {
          spliceChild(container, citation);
        }
        ensurePageMedia(container, order, urlFor(hit));
        counts.citationsRewritten++;
        continue;
      }

      // Relocating takes an identical citation at the link's old spot along —
      // the record-level citation an earlier run wrote while the marriage
      // family was still unresolved — instead of leaving a redundant copy.
      if (container !== hit.container) {
        const stale = childrenByTag(hit.container, "SOUR").find(
          (c) => c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === (page ?? ""),
        );
        if (stale) {
          spliceChild(hit.container, stale);
          const existing = childrenByTag(container, "SOUR").find(
            (c) => c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === (page ?? ""),
          );
          if (existing) {
            // Folds into the citation already there; carry its QUAY over.
            const quay = childText(stale, "QUAY");
            if (quay && !firstChild(existing, "QUAY")) {
              existing.children.push({ level: existing.level + 1, tag: "QUAY", value: quay, children: [] });
            }
          } else {
            relevel(stale, container.level + 1);
            insertOrdered(container, stale, order);
          }
          counts.citationsRewritten++;
        }
      }

      if (attachCitation(container, sourceXref, page, quayFor, order)) counts.citationsAdded++;

      if (hit.shape === "note") {
        if (hit.node.value !== undefined) {
          const remaining = removeUrlFromText(hit.node.value, hit.url);
          if (hasContent(remaining)) {
            hit.node.value = remaining;
            counts.notesRewritten++;
          } else if (spliceChild(hit.container, hit.node)) {
            counts.linksRemoved++;
          }
        }
      } else if (spliceChild(hit.container, hit.node)) {
        counts.linksRemoved++;
      }
      // After the original node is gone, so an in-place pointer re-checks
      // cleanly: the citation's container gets the cited page's image.
      ensurePageMedia(container, order, urlFor(hit));
    }
  }

  return { records: clone, counts };
}

// ---------------------------------------------------------------------------
// Enrichment (optional, online; main thread only)

/** Parse a Matricula page title — `Krstna knjiga / Taufbuch - 04406 | Vodice |
 *  Nadškofijski arhiv Ljubljana | Slovenia` with an optional trailing
 *  `| Matricula Online` (present in the raw `<title>`, absent in the rendering
 *  relay's version). */
export function parseMatriculaTitle(
  title: string,
): { title: string; agency?: string; place?: string } | undefined {
  const parts = title.split("|").map((p) => p.trim());
  if (/matricula\s*online/i.test(parts[parts.length - 1] ?? "")) parts.pop();
  if (parts.length < 4) return undefined;
  return { title: `${parts[0]} | ${parts[1]}`, place: parts[1], agency: parts[2] };
}

/** Strip markdown link syntax, keeping the link text: `[Naklo](url)` → `Naklo`. */
function stripMdLinks(s: string): string {
  return s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/**
 * The archive's full display name from the fetched Matricula page's
 * breadcrumb — the link to the archive index (`…/{country}/{archive}/`),
 * in HTML (`<a href>`) or the rendering relay's markdown. Fallback for pages
 * whose title doesn't carry the agency, upgrading the offline slug guess
 * ("Ljubljana" → "Nadškofijski arhiv Ljubljana").
 */
function matriculaArchiveName(text: string, mat: MatriculaUrlParts): string | undefined {
  const path = `/${mat.country}/${mat.archiveSlug}/`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const html = new RegExp(`<a[^>]+href="[^"]*${path}"[^>]*>([^<]+)</a>`, "i").exec(text)?.[1];
  const md = new RegExp(`\\[([^\\]]+)\\]\\([^)]*${path}\\)`, "i").exec(text)?.[1];
  const name = html ?? md;
  return name ? decodeHtmlEntities(name).replace(/\s+/g, " ").trim() || undefined : undefined;
}

/** Parse the metadata table of a Matricula book page (fetched via the `/en/`
 *  URL so the row labels are stable English). Accepts both the raw HTML
 *  `table-register-data` rows and the rendering relay's markdown table
 *  (`| Date from | Jan. 1, 1891 |`). */
export function parseMatriculaBookPage(
  html: string,
): { title?: string; type?: string; place?: string; agency?: string; dateFrom?: string; dateTo?: string } | undefined {
  const row = (label: string): string | undefined => {
    const h = new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>(.*?)</td>`, "is").exec(html);
    if (h) return decodeHtmlEntities(h[1].replace(/<[^>]+>/g, "")).trim() || undefined;
    const md = new RegExp(`^\\|\\s*${label}\\s*\\|\\s*([^|\\n]+?)\\s*\\|`, "im").exec(html);
    return md ? decodeHtmlEntities(stripMdLinks(md[1])).trim() || undefined : undefined;
  };
  const titleText = pageTitleOf(html);
  const fromTitle = titleText ? parseMatriculaTitle(titleText) : undefined;
  const type = row("Type");
  const place = row("Parish/place") ?? fromTitle?.place;
  const id = row("ID");
  const result = {
    title: fromTitle?.title ?? (type && id && place ? `${type} - ${id} | ${place}` : undefined),
    type,
    place,
    agency: fromTitle?.agency,
    dateFrom: row("Date from"),
    dateTo: row("Date to"),
  };
  return result.title || result.type || result.dateFrom ? result : undefined;
}

/**
 * Parse a Geneanet cemetery ("Save our Graves") view page. Geneanet's bot
 * protection 403s the plain relays, so in practice this sees the rendering
 * relay's markdown, whose "Localisation" block reads:
 *
 *     **Localisation**
 *     [Pokopališče Zgornje Bitnje](…/cemetery/collection/…) - P02
 *     [Žabnica](…/cemetery/search/…) (Slovenia)
 */
export function parseGeneanetCemeteryPage(
  text: string,
): { title?: string; cemetery?: string; plot?: string; town?: string; country?: string } | undefined {
  const title = pageTitleOf(text)?.replace(/\s*[-|]\s*Geneanet\s*$/i, "");
  const loc =
    /\*\*Localisation\*\*\s*\n+\[([^\]]+)\]\([^)]*\)[ \t]*(?:-[ \t]*([^\n]*?))?[ \t]*\n+\[([^\]]+)\]\([^)]*\)[ \t]*(?:\(([^)]+)\))?/.exec(
      text,
    );
  const result = {
    title,
    cemetery: loc?.[1]?.trim() || undefined,
    plot: loc?.[2]?.trim() || undefined,
    town: loc?.[3]?.trim() || undefined,
    country: loc?.[4]?.trim() || undefined,
  };
  return result.title || result.cemetery ? result : undefined;
}

/** Year-range (`1891-1920`) from the page's "Date from"/"Date to" values. */
function yearRange(from: string | undefined, to: string | undefined): string | undefined {
  const year = (s: string | undefined) => s && /(\d{4})/.exec(s)?.[1];
  const a = year(from);
  const b = year(to);
  if (a && b) return a === b ? a : `${a}-${b}`;
  return a ?? b ?? undefined;
}

/** The span of years a text names — a FamilySearch book step often holds two
 *  registers at once ("Births (Rođeni) 1892-1899 Marriages (Vjenčani)
 *  1858-1890"), and the source covers all of it. */
function yearSpan(text: string | undefined): string | undefined {
  const years = [...(text ?? "").matchAll(/\b(1[5-9]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  if (!years.length) return undefined;
  const from = Math.min(...years);
  const to = Math.max(...years);
  return from === to ? String(from) : `${from}-${to}`;
}

/** Media type that makes a FamilySearch ark answer with GedcomX JSON instead
 *  of the app shell — the whole reason an FS link can be read without a login. */
export const FS_GEDCOMX_ACCEPT = "application/x-gedcomx-v1+json";

interface FsArkJson {
  sourceDescriptions?: { resourceType?: string; citations?: { value?: string }[] }[];
}

/**
 * Read the GedcomX JSON a FamilySearch image ark serves. The citation
 * FamilySearch composes for the image is the richest thing in it:
 *
 *     "Croatia, Church Books, 1516-1994," database with images, FamilySearch
 *     (https://familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS… : 16 July 2014),
 *     Roman Catholic (Rimokatolička crkva) > Pakrac >
 *     Births (Rođeni) 1892-1899 Marriages (Vjenčani) 1858-1890 > image 556 of 689;
 *     Arhiva Hrvatske u Zagrebu (Croatia State Archives), Zagreb.
 *
 * — the collection, the browse path, the image number and the holding archive.
 * The path's last step is the book (its years date the source) and the one
 * before it the place; deeper category steps ("Roman Catholic …") stay in the
 * title. The image number is FamilySearch's own, one ahead of the URL's
 * zero-based `i=`. An image outside a published collection carries no citation
 * at all — nothing to read, and the offline fields stand.
 */
export function parseFamilySearchArkJson(json: string): ReshapeMeta | undefined {
  let parsed: FsArkJson;
  try {
    parsed = JSON.parse(json) as FsArkJson;
  } catch {
    return undefined;
  }
  const citation = parsed.sourceDescriptions
    ?.find((sd) => sd.resourceType?.endsWith("/DigitalArtifact"))
    ?.citations?.find((c) => c.value?.trim())?.value;
  const meta = citation ? parseFamilySearchCitation(citation) : undefined;
  if (!meta) return undefined;
  // The collection's id, which a link need not carry itself — a repository
  // kept for that collection is found by it.
  const id = /\/records\/collections\/(\d+)/.exec(json)?.[1];
  return id ? { ...meta, collectionId: id } : meta;
}

/** Words that name the institution holding the originals, as a FamilySearch
 *  citation's "citing …" chain runs through place, place, place, archive. */
const ARCHIVE_WORD_RE = /arhiv|archiv|archive|library|knji[žz]nic|mati[čc]n|museum|muzej|registry|record office/i;

/** The film/microfilm number a citation ends with ("FHL microfilm 005,498,154",
 *  "film 005498154", "DGS 4826234", "Image Group Number: 108918058" — the last
 *  is the DGS number under its current on-site name). */
const FILM_NUMBER_RE = /(?:FHL\s+)?(?:microfilm|film|DGS|image group number)\s*[#:]?\s*([\d][\d,\s]*\d|\d)/i;

/**
 * Read a citation copied from FamilySearch's own "Copy citation" button. Its
 * indexed **record** pages are sign-in-only — no lookup of any kind reaches
 * them — so a pasted citation is the one way their details reach the file:
 *
 *     "Croatia, Church Books, 1516-1994," database with images, FamilySearch
 *     (https://familysearch.org/ark:/61903/1:1:JFVN-KMV : 11 March 2018),
 *     Ana Renko in entry for Josip Renko, 1885; citing Baptism, Ravna Gora,
 *     Primorje-Gorski Kotar, Croatia, Državni arhiv u Rijeci (State Archives),
 *     Rijeka; FHL microfilm 005,498,154.
 *
 * The collection names the source, the "citing" chain gives the register type,
 * the place and the holding archive, and the tail gives the film number. The
 * person and entry the citation names are *this* record, not the source, and
 * stay out of the source's fields. An image citation pasted here is understood
 * too — same head, different tail.
 */
export function parsePastedFsCitation(text: string): ReshapeMeta | undefined {
  const plain = decodeHtmlEntities(text.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  if (!/familysearch/i.test(plain)) return undefined;
  if (/ > /.test(plain) && /image \d+/i.test(plain)) return parseFamilySearchCitation(plain);

  const collection = quotedCollection(plain);
  const rest = /\(https?:[^)]*\)\s*,?\s*(.*)$/i.exec(plain)?.[1] ?? plain;
  const parts = rest.split(";").map((s) => s.trim()).filter(Boolean);
  const citing = parts.find((p) => /^citing\b/i.test(p))?.replace(/^citing\s+/i, "");
  const film = FILM_NUMBER_RE.exec(rest)?.[1].replace(/[,\s]/g, "");
  // An image citation's tail is "image 23 of 35; National Archives and
  // Records Administration. Image Group Number: 108918058" — the image number
  // is the cited page, what follows the semicolon the holding institution.
  const image = /^image (\d+) of \d+\.?$/i.exec(parts[0] ?? "");
  // "Entry for Anna Rakar and Martin Sadec, 9 July 1901" — which record within
  // the collection this is. That is what a citation's PAGE says; the source
  // itself is the collection, so it never goes into the source's own fields.
  const entry = !image && parts[0] && !/^citing\b/i.test(parts[0]) ? parts[0].replace(/\.\s*$/, "") : undefined;

  let place: string | undefined;
  let agency: string | undefined;
  let type: BookType = "unknown";
  if (citing) {
    const tokens = citing.replace(/\.\s*$/, "").split(",").map((s) => s.trim()).filter(Boolean);
    if (tokens.length && classifyBookType([tokens[0]]) !== "unknown") type = classifyBookType([tokens.shift()]);
    const archiveAt = tokens.findIndex((tok) => ARCHIVE_WORD_RE.test(tok));
    const placeTokens = archiveAt === -1 ? tokens : tokens.slice(0, archiveAt);
    place = placeTokens.join(", ") || undefined;
    if (archiveAt !== -1) agency = tokens.slice(archiveAt).join(", ") || undefined;
  } else if (image && parts[1]) {
    // The holder, minus the film sentence the same part may carry.
    agency = parts[1].replace(FILM_NUMBER_RE, "").replace(/[\s.,:]+$/, "").trim() || undefined;
  }
  if (!collection && !place && !agency && !film) return undefined;
  return {
    title: collection ?? "FamilySearch",
    collection,
    place,
    agency,
    filingNumber: film,
    page: image?.[1] ?? entry,
    // The years the collection's own name gives ("…, 1892-1925") — all a
    // record page says about the source's span.
    dateRange: yearSpan(collection),
    bookType: type === "unknown" ? undefined : type,
  };
}

function parseFamilySearchCitation(raw: string): ReshapeMeta | undefined {
  const text = decodeHtmlEntities(raw.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  const collection = quotedCollection(text);
  // Everything past the "(url : accessed date)": the browse path, then the
  // holding archive after the last semicolon.
  const rest = /\(https?:[^)]*\)\s*,?\s*(.*)$/i.exec(text)?.[1] ?? "";
  const semi = rest.lastIndexOf(";");
  const holder = semi >= 0 ? rest.slice(semi + 1).replace(/\.\s*$/, "").replace(/^\s*citing\s+/i, "").trim() : "";
  // A published microfilm names its publisher the bibliographic way — "NARA
  // microfilm publication T715 and M237 (Washington D.C.: National Archives
  // and Records Administration, n.d.)" — where an archive's own holding names
  // only itself ("Arhiva Hrvatske u Zagrebu (Croatia State Archives), Zagreb").
  const published = /^(.*?)\s*\(([^:()]{2,60}):\s*([^()]+?)(?:,\s*(?:n\.d\.|\d{4}))?\)$/.exec(holder);
  const agency = published ? published[1].trim() : holder;
  const publisher = published?.[3].trim();
  const publishedPlace = published?.[2].trim();
  const steps = (semi >= 0 ? rest.slice(0, semi) : rest).split(">").map((s) => s.trim()).filter(Boolean);
  const image = /^image (\d+)\b/i.exec(steps[steps.length - 1] ?? "");
  if (image) steps.pop();
  const book = steps[steps.length - 1];
  const place = steps.length > 1 ? steps[steps.length - 2] : undefined;
  if (!collection && !book) return undefined;
  const type = classifyBookType([book]);
  return {
    // Most specific first, the collection naming the whole: "Pakrac - Births
    // (Rođeni) 1892-1899 … - Croatia, Church Books, 1516-1994".
    title: siteTitle(place, book, collection ?? "FamilySearch"),
    collection,
    book,
    // The browse path's own place first; the publication's city only where the
    // path named none.
    place: place ?? publishedPlace,
    agency: agency || undefined,
    publisher,
    page: image?.[1],
    dateRange: yearSpan(book),
    // A book holding births *and* marriages classifies as neither — "unknown"
    // must not clobber an offline guess from the citation text.
    bookType: type === "unknown" ? undefined : type,
  };
}

/**
 * The registers a FamilySearch book label names, when it names more than one:
 * "Births (Rođeni) 1892-1899 Marriages (Vjenčani) 1858-1890" is one browse
 * step covering two registers, and a page of it belongs to exactly one — which
 * only the person looking at the image knows (FamilySearch's own item-level
 * view of that film sits behind a sign-in). Each part runs up to and including
 * its year range; a label the parts don't fully account for names nothing to
 * choose between, and comes back empty.
 */
export function splitFsRegisters(book: string | undefined): string[] {
  if (!book) return [];
  const parts = book.match(/\S.*?\d{4}(?:\s*[-–]\s*\d{4})?(?=\s|$)/g) ?? [];
  if (parts.length < 2) return [];
  // Every word of the label must belong to a part — otherwise the split is a
  // guess about text it doesn't understand.
  return parts.join(" ").replace(/\s+/g, " ") === book.replace(/\s+/g, " ").trim() ? parts : [];
}

/** The same fetched metadata narrowed to one of {@link splitFsRegisters}'
 *  registers: its own title, year span and register type — the last of which
 *  puts the citation on the matching event. */
export function narrowFsRegister(meta: ReshapeMeta, register: string): ReshapeMeta {
  const type = classifyBookType([register]);
  return {
    ...meta,
    book: register,
    title: siteTitle(meta.place, register, meta.collection ?? "FamilySearch"),
    dateRange: yearSpan(register),
    bookType: type === "unknown" ? undefined : type,
  };
}

/** Rewrite a Matricula book URL to its `/en/` variant (stable table labels). */
function matriculaEnUrl(bookUrl: string): string {
  return bookUrl.replace(/^(https?:\/\/data\.matricula-online\.eu)\/[a-z]{2}\//i, "$1/en/");
}

/** Session-wide fetched-metadata cache, keyed by page-independent book key —
 *  re-opening the panel or re-running enrichment never refetches a book. */
const bookMetaCache = new Map<string, ReshapeMeta>();

/** FamilySearch's edge answers a burst of requests with a block page (403 from
 *  its security service) — which would also hit the user's own FamilySearch
 *  tab, on the same address. Ark lookups therefore run one at a time with a
 *  gap: a file full of links takes longer, and nothing gets locked out. */
const FS_GAP_MS = 600;
/** Should the edge block anyway (or the connection drop), wait this long and
 *  try that one link again — a whole file's worth of lookups must not be lost
 *  to a single refusal partway through. */
const FS_RETRY_MS = 5000;
let fsChain: Promise<unknown> = Promise.resolve();

function pacedFsFetch<T>(run: () => Promise<T>): Promise<T> {
  const result = fsChain.then(run, run);
  fsChain = result.then(
    () => new Promise((r) => setTimeout(r, FS_GAP_MS)),
    () => new Promise((r) => setTimeout(r, FS_GAP_MS)),
  );
  return result;
}

/** A refused request worth trying again: the edge's block/rate-limit answers,
 *  and a connection that produced no answer at all. A 401 (a record page
 *  wanting a sign-in) is a real answer — retrying it changes nothing. */
function fsWorthRetrying(status: number): boolean {
  return status === 0 || status === 403 || status === 429 || status >= 500;
}

async function fetchFsArk(
  fetchArk: (url: string, accept: string) => Promise<DirectResponse>,
  url: string,
): Promise<string | undefined> {
  const first = await fetchArk(url, FS_GEDCOMX_ACCEPT).catch(() => ({ status: 0 }) as DirectResponse);
  if (first.text || !fsWorthRetrying(first.status)) return first.text;
  await new Promise((r) => setTimeout(r, FS_RETRY_MS));
  const second = await fetchArk(url, FS_GEDCOMX_ACCEPT).catch(() => ({ status: 0 }) as DirectResponse);
  return second.text;
}

/** Parse one fetched book/record page into source metadata — the per-site
 *  rules shared by the cleanup tool's enrichment and the Add Source dialog. */
function parseBookMeta(site: ReshapeSite, bookUrl: string, html: string): ReshapeMeta | undefined {
  let meta: ReshapeMeta | undefined;
  if (site === "matricula") {
    const page = parseMatriculaBookPage(html);
    if (page) {
      // "unknown" must not clobber a correct offline classification
      // (e.g. baptism inferred from a "KK" citation prefix).
      const fetchedType = classifyBookType([page.type]);
      const mat = parseMatriculaUrl(bookUrl);
      meta = {
        title: page.title,
        // Title-derived agency first; else the breadcrumb's archive link.
        agency: page.agency ?? (mat && matriculaArchiveName(html, mat)),
        place: page.place,
        dateRange: yearRange(page.dateFrom, page.dateTo),
        bookType: fetchedType === "unknown" ? undefined : fetchedType,
      };
    }
  } else if (site === "geneanet") {
    const page = parseGeneanetCemeteryPage(html);
    if (page) {
      meta = {
        // PLAC is the *place* (town, country); the cemetery itself
        // names the source and stays in the title.
        place: [page.town, page.country].filter(Boolean).join(", ") || undefined,
        // The cemetery is address-level detail for the BURI event; the plot
        // says where within the cemetery, so it goes on the citation PAGE.
        address: page.cemetery,
        page: page.plot,
        // `{cemetery} - Geneanet Cemeteries` — the town stays out of the
        // title (PLAC carries it) and the view id is the filing number.
        title: page.cemetery ? siteTitle(page.cemetery, undefined, "Geneanet Cemeteries") : undefined,
      };
    }
  } else if (site === "findagrave") {
    // `Frank Gorishek (1881-1968) - Find a Grave Memorial` → the name;
    // the suffix may arrive ellipsized ("- Find a…"), match loosely.
    // Find a Grave blocks the plain relays, so in practice this sees the
    // rendering relay's markdown, whose Burial block reads:
    //
    //     [St. Theresa of Avila Catholic Church Cemetery](…/cemetery/2622358/…)
    //     Ravna Gora, Općina Ravna Gora, Primorsko-Goranska, Croatia[_Add to Map_](…)
    //
    // The cemetery names the grave (`{person} - {cemetery} - Find a Grave`)
    // and becomes the BURI address; the location line is the place.
    const name = pageTitleOf(html)?.replace(/\s*[-–]\s*Find a.*$/i, "").trim();
    const cem = /\[([^\]\n]+)\]\(https?:\/\/[^)]*findagrave\.com\/cemetery\/\d+\/(?!memorial-search)[^)]*\)\s*\n+([^\n[]+)/i.exec(html);
    const cemetery = cem?.[1]?.trim();
    const location = cem?.[2]?.trim().replace(/[,\s]+$/, "");
    if (name) {
      meta = {
        title: siteTitle(name, cemetery, "Find a Grave"),
        place: location || undefined,
        address: cemetery,
      };
    }
  } else if (site === "billiongraves") {
    // The grave page is server-rendered with a schema.org Person JSON-LD:
    // name, birth/death dates, and the cemetery (`deathPlace`) with its
    // postal address. `{person} - {cemetery} - BillionGraves` names the
    // grave; the cemetery is the BURI address, its town/country the place.
    interface BgPlace {
      name?: string;
      address?: { addressLocality?: string; addressRegion?: string; addressCountry?: string };
    }
    interface BgPerson {
      "@type"?: string;
      name?: string;
      deathPlace?: BgPlace;
    }
    let person: BgPerson | undefined;
    for (const m of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const parsed = JSON.parse(m[1]) as BgPerson | BgPerson[];
        person = (Array.isArray(parsed) ? parsed : [parsed]).find((x) => x?.["@type"] === "Person");
        if (person) break;
      } catch {
        // not JSON — try the next block
      }
    }
    const name = person?.name ?? pageTitleOf(html)?.replace(/\s*[-|]\s*BillionGraves.*$/i, "").trim();
    if (name) {
      const cemetery = person?.deathPlace?.name;
      const addr = person?.deathPlace?.address;
      const place =
        [...new Set([addr?.addressLocality, addr?.addressRegion, addr?.addressCountry].filter(Boolean))].join(", ") ||
        undefined;
      meta = { title: siteTitle(name, cemetery, "BillionGraves"), place, address: cemetery };
    }
  } else if (site === "geneanettree") {
    // The rendered page (Geneanet blocks plain relays) titles itself
    // `Family tree of Rajko Vute` — bookUrl carries lang=en for a stable
    // prefix. A trailing `(26)` is GeneWeb's occurrence ordinal that tells
    // same-named persons in the tree apart — technical, so it stays out of
    // the title (the URL keeps it). The tree's owner is the author:
    // `{person} - {owner} - Geneanet Trees`.
    const tree = /gw\.geneanet\.org\/([a-z0-9_-]+)\?/i.exec(bookUrl)?.[1];
    const name = pageTitleOf(html)
      ?.replace(/^\s*Family tree of\s+/i, "")
      .replace(/\s*[-|]\s*Geneanet\s*$/i, "")
      .replace(/\s*\(\d+\)\s*$/, "")
      .trim();
    if (name && !/^https?:\/\//i.test(name)) {
      meta = { title: siteTitle(name, tree, "Geneanet Trees"), author: tree };
    }
  } else if (site === "googlebooks") {
    // The reader page server-renders the volume heading, and for a newspaper
    // it carries the issue's date: `<h1 class="gb-volume-title">The Windsor
    // Star <span dir=ltr>May 23, 1969</span></h1>` (hl=en on the fetch pins
    // the date language). The rendering relay flattens the same heading to a
    // markdown `# The Windsor Star May 23, 1969` line, so the date is
    // tail-matched there. A dated issue is unique — `{name}, {date} - Google
    // Books` — and the date fills the source's DATE; undated volumes (books)
    // keep the volume id in the title, since one newspaper spans many
    // volumes and the page title alone can't tell them apart. A relay
    // sometimes titles a failed render with the URL itself — that's not a
    // name; the offline title stands.
    const pageName = pageTitleOf(html)?.replace(/\s*-\s*Google\s+\p{L}+\s*$/u, "").trim();
    const h1 = /<h1 class="gb-volume-title"[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
    let name: string | undefined;
    let date: string | undefined;
    if (h1) {
      const heading = decodeHtmlEntities(h1.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
      date = /<span[^>]*>([^<]+)<\/span>/i.exec(h1)?.[1].trim();
      name = (date ? heading.replace(date, "").replace(/[\s,]+$/, "") : heading).trim() || undefined;
    } else {
      // Markdown flattens the heading to `# {name} {date}`, with the date in
      // whatever shape the page used ("May 23, 1969" / "Dec 27, 1975" /
      // "13 Feb 1965") — the name is known from the page title, so the date
      // is simply the year-bearing remainder after it.
      const heading = /^#\s+(.+)$/m.exec(html)?.[1].trim();
      if (heading && pageName && heading.startsWith(pageName)) {
        const tail = heading.slice(pageName.length).replace(/^[\s,–—-]+/, "").trim();
        if (/\d{4}/.test(tail) && tail.length >= 4 && tail.length <= 24) date = tail;
      }
    }
    name = name ?? pageName;
    const volumeId = /[?&]id=([A-Za-z0-9_-]+)/.exec(bookUrl)?.[1];
    if (name && !/^https?:\/\//i.test(name)) {
      meta = date
        ? { title: siteTitle(`${name}, ${date}`, undefined, "Google Books"), dateRange: date }
        : { title: siteTitle(name, volumeId, "Google Books") };
    }
  } else if (site === "youtube") {
    // YouTube's public oEmbed endpoint returns JSON: the video's title and
    // channel. The watch page's title is the fallback.
    let data: { title?: string; author_name?: string } | undefined;
    try {
      data = JSON.parse(html) as { title?: string; author_name?: string };
    } catch {
      data = undefined;
    }
    const name = data?.title ?? pageTitleOf(html)?.replace(/\s*-\s*YouTube\s*$/i, "").trim();
    if (name) meta = { title: siteTitle(name, undefined, "YouTube"), author: data?.author_name };
  } else if (site === "legacy") {
    const name = pageTitleOf(html)?.replace(/\s*[-|]\s*Legacy\.com.*$/i, "").trim();
    if (name) meta = { title: siteTitle(name, undefined, "Legacy.com") };
  } else if (site === "wikipedia") {
    // `Primož Trubar - Wikipedija, prosta enciklopedija` / `… - Wikipedia` —
    // the display title (proper diacritics) replaces the URL-slug guess.
    const name = pageTitleOf(html)?.replace(/\s*[-–—]\s*Wikipedi\p{L}*.*$/iu, "").trim();
    if (name && !/^https?:\/\//i.test(name)) {
      meta = { title: siteTitle(name, undefined, "Wikipedia") };
    }
  } else if (site === "biografija") {
    // `Trubar, Primož (med 1507 in 1509–1586) - Slovenska biografija` — the
    // person's name with life years; a missing entry titles itself
    // "Stran ne obstaja", which is not a name.
    const name = pageTitleOf(html)?.replace(/\s*[-–—]\s*Slovenska biografija\s*$/i, "").trim();
    if (name && !/^https?:\/\//i.test(name) && !/^stran ne obstaja$/i.test(name)) {
      meta = { title: siteTitle(name, undefined, "Slovenska biografija") };
    }
  } else if (site === "obrazi") {
    // `Primož TRUBAR | Obrazi slovenskih pokrajin` — the name before the pipe.
    const name = pageTitleOf(html)?.replace(/\s*[|–—-]\s*Obrazi slovenskih pokrajin\s*$/i, "").trim();
    if (name && !/^https?:\/\//i.test(name)) {
      meta = { title: siteTitle(name, undefined, "Obrazi slovenskih pokrajin") };
    }
  } else if (site === "dlib") {
    // The dLib.si details page is server-rendered: a key/value metadata table
    // (Vir, Leto, Številčenje, Založnik, Izvor) plus a `dLib.si - {title}`
    // page title. `{publication}, {date}, {issue} - dLib.si` names the source;
    // the holding library is the agency.
    const row = (label: string): string | undefined => {
      const m = new RegExp(`class="[^"]*key">\\s*${label}\\s*</div>\\s*<div[^>]*class="[^"]*value">(.*?)</div>`, "is").exec(html);
      return m ? decodeHtmlEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() || undefined : undefined;
    };
    const publication = pageTitleOf(html)?.replace(/^\s*dLib\.si\s*[-–]\s*/i, "").trim() || row("Vir");
    const date = row("Leto");
    const numbering = row("Številčenje");
    if (publication) {
      meta = {
        title: siteTitle([publication, date, numbering].filter(Boolean).join(", "), undefined, "dLib.si"),
        periodical: row("Vir"),
        publisher: row("Založnik"),
        agency: row("Izvor"),
        dateRange: date,
      };
    }
  } else if (site === "sistory") {
    const war = /\/(ww[12])\//i.exec(bookUrl)?.[1].toUpperCase();
    // The record pages are client-rendered (Next.js): a plain relay sees an
    // empty <title> and no visible text, but the embedded __NEXT_DATA__ JSON
    // carries the record — the person's name, the contributor (author) list
    // and the publishing institute. The record id stays out of the title
    // (it's the filing number).
    const nextData = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
    let record:
      | {
          titles?: string[];
          contributors?: { firstName?: string; lastName?: string }[];
          contributorGroups?: { name?: string }[];
        }
      | undefined;
    if (nextData) {
      try {
        record = (JSON.parse(nextData) as { props?: { pageProps?: { data?: typeof record } } }).props?.pageProps?.data;
      } catch {
        record = undefined;
      }
    }
    if (record?.titles?.[0]) {
      const authors = (record.contributors ?? [])
        .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ").trim())
        .filter(Boolean)
        .join(", ");
      meta = {
        title: siteTitle(record.titles[0], war, "SIstory.si"),
        author: authors || undefined,
        // The corpus title and publication place the page's own Citiranje
        // section uses for the WW2 casualty database.
        periodical: war === "WW2" ? "Smrtne žrtve druge svetovne vojne in zaradi nje v Sloveniji" : undefined,
        place: war === "WW2" ? "Ljubljana" : undefined,
        agency: record.contributorGroups?.[0]?.name,
      };
    } else {
      // The rendering relay returns the composed page instead — its
      // "Citiranje" section is a full citation; parse it with the same
      // citation parser the paste box uses, so a fetched URL fills the same
      // fields as pasting the Citiranje content by hand.
      const citStart = html.search(/Citiranje/i);
      const citText =
        citStart >= 0
          ? decodeHtmlEntities(stripMdLinks(html.slice(citStart + "Citiranje".length, citStart + 800)).replace(/<[^>]+>/g, " "))
              .replace(/\s+/g, " ")
              .trim()
          : undefined;
      const cit = citText ? parseSourceInput(citText) : {};
      const name = cit.title ?? pageTitleOf(html)?.replace(/\s*[-|·]\s*S[Ii]story.*$/i, "").trim();
      if (name) {
        meta = {
          title: siteTitle(name, war, "SIstory.si"),
          author: cit.author,
          periodical: cit.periodical,
          // The citation's "(Ljubljana: Inštitut …)" — place + agency.
          place: cit.place,
          agency: cit.publisher,
        };
      }
    }
  } else if (site === "familysearch") {
    // JSON, not a page — and the app shell a relay would return says nothing
    // ("FamilySearch.org"), so there is no title fallback here.
    meta = parseFamilySearchArkJson(html);
  } else {
    const title = pageTitleOf(html);
    if (title) meta = { title: title.replace(/\s*[-|]\s*Geneanet\s*$/i, "") };
  }
  if (meta && !Object.values(meta).some(Boolean)) return undefined; // nothing usable parsed
  return meta;
}

/**
 * Fetch and parse the metadata for one book/record URL — cached session-wide
 * by book key, so the cleanup tool's enrichment and the Add Source dialog
 * never refetch the same book. Undefined on any fetch/parse failure.
 */
export async function fetchBookMeta(
  site: ReshapeSite,
  bookUrl: string,
  fetchHtml: (url: string) => Promise<string | undefined>,
  /** The no-relay fetch FamilySearch arks use; injectable for tests. */
  fetchArk: (url: string, accept: string) => Promise<DirectResponse> = fetchDirect,
): Promise<ReshapeMeta | undefined> {
  // A FamilySearch record page or catalog film would only answer 401/403 —
  // don't ask at all.
  if (site === "familysearch" && !isFamilySearchImageArk(bookUrl)) return undefined;
  const cacheKey = `${site}:${bookKeyOf(bookUrl)}`;
  const cached = bookMetaCache.get(cacheKey);
  if (cached) return cached;
  const url =
    site === "matricula"
      ? matriculaEnUrl(bookUrl)
      : site === "youtube"
        ? `https://www.youtube.com/oembed?url=${encodeURIComponent(bookUrl)}&format=json`
        : site === "googlebooks"
          ? // The bare volume URL redirects to the About page, which carries no
            // issue date — printsec=frontcover keeps the *reader* page, whose
            // heading dates a newspaper issue; hl=en pins the date language.
            `${bookUrl}&printsec=frontcover&hl=en`
          : bookUrl;
  // FamilySearch is asked directly: its ark answers cross-origin requests
  // itself, so no relay sees the URL and the answer is the site's own. The
  // image's film (DGS) number rides in the same paced slot — one more tiny
  // anonymous request against the ark, answering `dgs:005482250.…_00127`;
  // that number is the film the source's FILN and the repository's CALN cite.
  let meta: ReshapeMeta | undefined;
  if (site === "familysearch") {
    const ark = parseFamilySearchUrl(bookUrl)?.ark;
    const { json, film } = await pacedFsFetch(async () => {
      const json = await fetchFsArk(fetchArk, url);
      let film: string | undefined;
      if (json && ark) {
        const name = await fetchArk(
          `https://www.familysearch.org/das/v2/${ark}/name?namespace=dgs`,
          "text/plain",
        ).catch(() => ({ status: 0 }) as DirectResponse);
        film = /^dgs:(\d+)\./.exec(name.text?.trim() ?? "")?.[1];
      }
      return { json, film };
    });
    meta = json ? parseBookMeta(site, bookUrl, json) : undefined;
    if (meta && film) meta = { ...meta, filingNumber: meta.filingNumber ?? film };
  } else {
    const html = await fetchHtml(url).catch(() => undefined);
    meta = html ? parseBookMeta(site, bookUrl, html) : undefined;
  }
  // A dateless Google Books result usually means a relay was served the About
  // page instead of the reader — don't pin that for the session; a later run
  // through a different relay may land the dated reader heading.
  if (meta && !(site === "googlebooks" && !meta.dateRange)) bookMetaCache.set(cacheKey, meta);
  return meta;
}

/**
 * Fetch metadata for the given (new-source) groups — **one fetch per book**,
 * via the injected `fetchHtml` (the allorigins relay wrapper; injectable for
 * tests) — except FamilySearch arks, which are read directly from the site.
 * Geneanet blocks non-browser clients (kept best-effort via the page title if
 * the relay gets through). Failures are swallowed — offline fallbacks stay.
 */
export async function fetchReshapeMeta(
  groups: ReshapeGroup[],
  fetchHtml: (url: string) => Promise<string | undefined>,
  onProgress?: (done: number, total: number) => void,
  /** Called the moment one book resolves, so the UI can update incrementally. */
  onMeta?: (groupId: string, meta: ReshapeMeta) => void,
): Promise<ReshapeEnrichment> {
  const enrichment: ReshapeEnrichment = new Map();
  const targets = groups.filter((g) => isFetchableSite(g.site, g.bookUrl));
  let done = 0;
  onProgress?.(0, targets.length);

  const worker = async (queue: ReshapeGroup[]): Promise<void> => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      const meta = await fetchBookMeta(g.site, g.bookUrl, fetchHtml);
      if (meta) {
        enrichment.set(g.id, meta);
        onMeta?.(g.id, meta);
      }
      onProgress?.(++done, targets.length);
    }
  };

  const queue = [...targets];
  await Promise.all([worker(queue), worker(queue)]);
  return enrichment;
}

/**
 * Fold the FamilySearch groups that turned out to be pages of one book into a
 * single group — one source with a page citation per image, the shape a
 * paginated register wants, instead of one source per image.
 *
 * It can only run *after* enrichment: a FamilySearch image link says nothing
 * about the book it belongs to (`ark:/61903/3:1:…?view=index` and no more), so
 * which pages are one book is knowledge that arrives with the lookup. Each
 * image keeps its own page number, moved onto the member it belongs to.
 *
 * Groups already bound to a source in the file, and groups marked for removal,
 * are left alone. Returns the same report and enrichment untouched when there
 * is nothing to fold, and `keyOf` — the original group ids that went into each
 * book — for {@link reshapeSources} to fold its own scan the same way.
 */
export function mergeFsBooks(
  report: ReshapeReport,
  enrichment: ReshapeEnrichment,
  baptismTag: "BIRT" | "BAPM" = "BIRT",
): { report: ReshapeReport; enrichment: ReshapeEnrichment; keyOf: Map<string, string> } {
  // A member scanned before the lookup knew the book's type shows no move,
  // yet the apply relocates it with the enriched type — fill the display in
  // so the row promises the move the apply will make. Moves the scan *did*
  // compute (incl. marriage, which needs the family) are kept as they are.
  const refreshMove = (m: ReshapeOccurrence, bookType: BookType): ReshapeOccurrence => {
    if (m.targetEvent || m.foldedInto || m.shape === "sourTitle") return m;
    const target = bookEventTarget(m.recordTag, m.eventTag, bookType, baptismTag);
    return target ? { ...m, targetEvent: target } : m;
  };

  const byBook = new Map<string, { meta: ReshapeMeta; groups: ReshapeGroup[] }>();
  for (const g of report.groups) {
    if (g.site !== "familysearch" || g.removeLinks) continue;
    const meta = enrichment.get(g.id);
    if (!meta?.book) continue;
    const key = `f:book:${looseKey(`${meta.collection ?? ""} ${meta.place ?? ""} ${meta.book}`)}`;
    const slot = byBook.get(key);
    if (slot) slot.groups.push(g);
    else byBook.set(key, { meta, groups: [g] });
  }

  const keyOf = new Map<string, string>();
  const books = new Map<string, ReshapeGroup>();
  const bookMeta = new Map<string, ReshapeMeta>();
  for (const [key, { meta, groups }] of byBook) {
    if (groups.length < 2) continue; // one page is already its own group
    const bookType = meta.bookType ?? "unknown";
    const members: ReshapeOccurrence[] = [];
    for (const g of groups) {
      keyOf.set(g.id, key);
      const page = enrichment.get(g.id)?.page;
      for (const m of g.members) members.push(refreshMove(page && !m.page ? { ...m, page } : m, bookType));
    }
    // A page of this book that the file already cites names the source the
    // whole book belongs to: the new pages join *that* record instead of
    // minting a second source for one book.
    const bound = groups.find((g) => g.existingSourceXref);
    books.set(key, {
      id: key,
      site: "familysearch",
      bookType,
      existingSourceXref: bound?.existingSourceXref,
      existingSourceTitle: bound?.existingSourceTitle,
      urlTitled: bound?.urlTitled,
      proposed: {
        title: meta.title ?? groups[0].proposed.title,
        author: meta.author,
        agency: meta.agency,
        place: meta.place,
        // Not the ark (that named a single image) — the film (DGS) number,
        // when the lookup resolved it, is an id the whole book shares.
        filingNumber: meta.filingNumber,
        dateRange: meta.dateRange,
      },
      bookUrl: groups[0].bookUrl,
      pages: [...new Set(members.map((m) => m.page).filter((p): p is string => !!p))].sort(
        (a, b) => Number(a) - Number(b) || a.localeCompare(b),
      ),
      members,
    });
    // The book's own metadata: the page belongs to each image, not to the book.
    bookMeta.set(key, { ...meta, page: undefined });
  }
  // Each book takes the place of the first of its pages; the rest disappear.
  // A group left unfolded still takes its lookup's book type — the scan may
  // not have known it (a bare image link says nothing), and the apply will
  // relocate by the enriched type, so the row must say so too.
  let changed = keyOf.size > 0;
  const groups: ReshapeGroup[] = [];
  const emitted = new Set<string>();
  for (const g of report.groups) {
    const key = keyOf.get(g.id);
    if (!key) {
      const bookType = (!g.removeLinks && enrichment.get(g.id)?.bookType) || g.bookType;
      const members = g.members.map((m) => refreshMove(m, bookType));
      if (bookType !== g.bookType || members.some((m, i) => m !== g.members[i])) {
        groups.push({ ...g, bookType, members });
        changed = true;
      } else groups.push(g);
      continue;
    }
    if (emitted.has(key)) continue;
    emitted.add(key);
    groups.push(books.get(key)!);
  }
  if (!changed) return { report, enrichment, keyOf };
  const merged: ReshapeEnrichment = new Map(enrichment);
  // A hand-edited book keeps its edits — only an unseen one takes the fold's.
  for (const [key, meta] of bookMeta) if (!merged.has(key)) merged.set(key, meta);
  return { report: { ...report, groups }, enrichment: merged, keyOf };
}

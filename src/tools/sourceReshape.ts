import type { Dataset, GedNode } from "../gedcom/types";
import { childText, childrenByTag, cloneNode, firstChild } from "../gedcom/node";
import {
  bookKeyOf,
  buildObjeIndex,
  inferSourceFormat,
  isPointer,
  looksLikeUrl,
  pageParamOf,
  sourceTitle,
} from "../gedcom/source";
import { linkKey } from "../normalize/links";
import { detectPlaceLayout } from "../normalize/profile";
import { decodeHtmlEntities, pageTitleOf } from "../normalize/urlMetadata";
import { parseSourceInput } from "../gedcom/citationParse";
import { addObjeToSource, createSourceRecord } from "../gedcom/edit/sources";
import {
  EVENT_CHILD_ORDER,
  FAM_CHILD_ORDER,
  INDI_CHILD_ORDER,
  insertGrouped,
  insertOrdered,
  insertRecord,
  nextXref,
} from "../gedcom/edit/shared";

/** Trailing block of a `SOUR` record that new links/fields must stay ahead of. */
const SOUR_TRAILING = ["REPO", "CHAN", "CREA"] as const;
const SOUR_FIELD_TRAILING = ["OBJE", "REPO", "CHAN", "CREA"] as const;
import { FAM_EVENT_TAGS, INDI_EVENT_TAGS } from "../gedcom/eventTags";
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
 * "other" site category is enabled. FamilySearch gets no enrichment — record
 * and image pages sit behind a login the relay cannot pass; offline signals
 * (quoted collection titles, `cat`/`i` params) carry it. Deferred follow-ups:
 * probing FS catalog pages for server-rendered titles, FS API OAuth, and a
 * placement audit for pre-existing pointer citations.
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
  "familysearch",
  "other",
] as const;

export type ReshapeSite = (typeof ALL_SITES)[number];

/** Sites the enrichment fetch can usefully contact — FamilySearch sits behind
 *  a login, Newspapers.com behind a bot wall (verified: every relay gets the
 *  challenge page), and generic links have no parser. Shared by the fetcher
 *  and the panel's button/progress so they can't disagree. */
export function isFetchableSite(site: ReshapeSite): boolean {
  return site !== "familysearch" && site !== "newspapers" && site !== "other";
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
  /** Sub-place detail (the cemetery name + plot) — becomes the BURI event's
   *  ADDR in files whose place format keeps addresses separate. */
  address?: string;
  dateRange?: string;
  bookType?: BookType;
  /** Set by the panel's manual field editor only — page parsers never
   *  override the offline id. An empty string clears the proposed one. */
  filingNumber?: string;
}

/** Per-group fetched metadata (keys = group ids). */
export type ReshapeEnrichment = Map<string, ReshapeMeta>;

export interface ReshapeOptions {
  /** Move citations onto their matching event (baptism→BIRT/BAPM, marriage→MARR,
   *  death→DEAT, cemetery→BURI). Default true. */
  relocate?: boolean;
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
}

const DEFAULT_SITES: ReadonlySet<ReshapeSite> = new Set(ALL_SITES.filter((s) => s !== "other"));

const URL_RE = /https?:\/\/[^\s<>"]+/gi;

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
}

/** The `{name} - {id} - {site}` title layout every grave/obituary/victim site
 *  uses, offline and enriched alike — absent parts are dropped. */
function siteTitle(name: string | undefined, id: string | undefined, siteLabel: string): string {
  return [name, id, siteLabel].filter(Boolean).join(" - ");
}

/** Strip punctuation a URL picked up from surrounding prose. */
function cleanUrl(url: string): string {
  return url.replace(/[.,;:!?)\]}'"»«]+$/, "");
}

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

export interface FamilySearchUrlParts {
  kind: "image" | "record" | "tree";
  ark?: string;
  cat?: string;
  image?: string;
}

const FS_ARK_RE = /^https?:\/\/(?:www\.)?familysearch\.org\/ark:\/61903\/(\d:\d):([^/?#]+)/i;

export function parseFamilySearchUrl(url: string): FamilySearchUrlParts | undefined {
  const trimmed = url.trim();
  if (!/^https?:\/\/(?:www\.)?familysearch\.org\//i.test(trimmed)) return undefined;
  const ark = FS_ARK_RE.exec(trimmed);
  if (ark) {
    const id = `${ark[1]}:${ark[2]}`;
    if (ark[1] === "3:1") {
      return {
        kind: "image",
        ark: id,
        cat: /[?&]cat=(\d+)/i.exec(trimmed)?.[1],
        image: /[?&]i=(\d+)/i.exec(trimmed)?.[1],
      };
    }
    return { kind: "record", ark: id };
  }
  return { kind: "tree" };
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
    if (fs.kind === "image") {
      return {
        site: "familysearch",
        groupKey: fs.cat ? `f:cat:${fs.cat}` : `f:${linkKey(url)}`,
        bookUrl: fs.cat ? `https://www.familysearch.org/search/catalog/${fs.cat}` : cleanUrl(url),
        page: fs.image,
        proposed: {
          title: collection ?? (fs.cat ? `FamilySearch film ${fs.cat}` : `FamilySearch ${fs.ark}`),
          // The film/catalog number identifies the source; a lone image link
          // has only its ARK id.
          filingNumber: fs.cat ?? fs.ark,
        },
        typeHint: collection,
      };
    }
    return {
      site: "familysearch",
      groupKey: collection ? `f:coll:${collection.toLowerCase()}` : `f:${linkKey(url)}`,
      bookUrl: cleanUrl(url),
      page: fs.ark,
      // A collection-grouped source spans many records, so no single record's
      // ARK can be its filing number — the id stays on each citation's PAGE.
      proposed: { title: collection ?? `FamilySearch ${fs.ark}`, filingNumber: collection ? undefined : fs.ark },
      typeHint: collection,
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
export type RecognizedSourceUrl = Pick<Recognized, "site" | "bookUrl" | "page" | "proposed">;

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

const TYPE_KEYWORDS: Record<Exclude<BookType, "unknown" | "burial">, RegExp> = {
  baptism: /krst|tauf|baptiz|baptism|rojstn|\bkk\b/i,
  marriage: /poro[čc]|trauung|matrimon|copulat|marriage|\bpk\b/i,
  // The tail (obituar|osmrtnic|pogreb|navc?ek|funeral) recognizes obituary and
  // funeral-announcement pages by their URLs/titles — funeral homes,
  // komunala pogreb notices, navcek.si.
  death: /mrli|sterbe|defunct|mortu|umrl|death|\bmk\b|obituar|osmrtnic|pogreb|nav[čc]ek|funeral/i,
};

/** Classify a register's type from whatever text is available (source titles,
 *  quoted collection names, citation prefixes). Ambiguous → "unknown". */
export function classifyBookType(texts: (string | undefined)[]): BookType {
  const joined = texts.filter(Boolean).join(" \n ");
  if (!joined) return "unknown";
  const hits = (Object.keys(TYPE_KEYWORDS) as (keyof typeof TYPE_KEYWORDS)[]).filter((t) =>
    TYPE_KEYWORDS[t].test(joined),
  );
  return hits.length === 1 ? hits[0] : "unknown";
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

/** Top-level OBJE xrefs referenced by any `SOUR` record — already organized as
 *  source page media, so a person-level pointer to them is left alone only if
 *  the pointer itself is *the* SOUR link; person-level pointers still convert. */
function sourReferencedObjeXrefs(records: GedNode[]): Set<string> {
  const set = new Set<string>();
  for (const rec of records) {
    if (rec.tag !== "SOUR" || !rec.xref) continue;
    for (const c of childrenByTag(rec, "OBJE")) {
      const v = c.value?.trim();
      if (v && isPointer(v)) set.add(v);
    }
  }
  return set;
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
): void {
  const base = { rec, container, eventTag, eventIndex };
  for (const child of container.children) {
    const value = child.value ?? "";

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

function scanOccurrences(records: GedNode[], sites: ReadonlySet<ReshapeSite>): ScanHit[] {
  const objeIndex = buildObjeIndex(records);
  const objeUrls = new Map<string, string>();
  for (const [xref, info] of objeIndex) if (info.url) objeUrls.set(xref, info.url);
  const sourReferenced = sourReferencedObjeXrefs(records);
  const sourTitles = new Map<string, string | undefined>();
  for (const rec of records) if (rec.tag === "SOUR" && rec.xref) sourTitles.set(rec.xref, sourceTitle(rec));

  const hits: ScanHit[] = [];
  for (const rec of records) {
    if (rec.tag === "INDI" || rec.tag === "FAM") {
      const eventTags = rec.tag === "INDI" ? INDI_EVENT_TAGS : FAM_EVENT_TAGS;
      scanContainer(rec, rec, sites, objeUrls, sourTitles, hits);
      const seen = new Map<string, number>();
      for (const child of rec.children) {
        if (!eventTags.has(child.tag)) continue;
        const idx = seen.get(child.tag) ?? 0;
        seen.set(child.tag, idx + 1);
        scanContainer(rec, child, sites, objeUrls, sourTitles, hits, child.tag, idx);
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

  // Drop person-level OBJE occurrences whose record is already a source's page
  // media *and* whose group would go nowhere new — those convert via the group
  // that reuses the owning SOUR; a plain pointer next to it still converts.
  return hits.filter((h) => !(h.shape === "obje" && h.objeXref && sourReferenced.has(h.objeXref)));
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

/** Resolve where a hit's citation should attach under the relocation option.
 *  Returns undefined when it stays at its original container. */
function relocationTarget(
  hit: ScanHit,
  bookType: BookType,
  baptismTag: "BIRT" | "BAPM",
): { eventTag: string; onFam: boolean } | undefined {
  if (bookType === "unknown" || hit.shape === "sourTitle") return undefined;
  const acceptable = ACCEPTABLE_TAGS[bookType];
  if (hit.eventTag && acceptable.has(hit.eventTag)) return undefined;

  if (bookType === "marriage") {
    if (hit.rec.tag === "FAM") return hit.eventTag === "MARR" ? undefined : { eventTag: "MARR", onFam: false };
    // From a person, only an unambiguous single-family move is safe.
    const fams = childrenByTag(hit.rec, "FAMS")
      .map((c) => c.value?.trim())
      .filter((v): v is string => !!v && isPointer(v));
    return fams.length === 1 ? { eventTag: "MARR", onFam: true } : undefined;
  }

  if (hit.rec.tag !== "INDI") return undefined;
  const target = bookType === "baptism" ? baptismTag : bookType === "death" ? "DEAT" : "BURI";
  return hit.eventTag === target ? undefined : { eventTag: target, onFam: false };
}

/** Single FAMS xref of a person, when unambiguous. */
function soleFamsXref(rec: GedNode): string | undefined {
  const fams = childrenByTag(rec, "FAMS")
    .map((c) => c.value?.trim())
    .filter((v): v is string => !!v && isPointer(v));
  return fams.length === 1 ? fams[0] : undefined;
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
  const hits = scanOccurrences(dataset.records, sites);
  const groups = buildGroups(dataset.records, hits, !prefersDoubledLinks(dataset.records));
  const baptismTag = baptismTargetTag(dataset.records);

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
    g.members = state.hits.map((hit) => {
      const move =
        relocate && !hit.foldedInto && !hit.twinEvent ? relocationTarget(hit, g.bookType, baptismTag) : undefined;
      return {
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
        targetFam: move?.onFam ? soleFamsXref(hit.rec) : undefined,
        foldedInto: hit.foldedInto,
      };
    });
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
  const exists = childrenByTag(container, "SOUR").some(
    (c) => c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === (page ?? ""),
  );
  if (exists) return false;
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
export function smartCitationTarget(
  records: GedNode[],
  site: ReshapeSite,
  title: string | undefined,
): { eventTag: string; onFam: boolean } | undefined {
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
  if (recordLevel > eventLevel) return undefined;

  const bookType = SITE_BOOK_TYPE[site] ?? classifyBookType([title]);
  if (bookType === "unknown") return undefined;
  if (bookType === "baptism") return { eventTag: baptismTargetTag(records), onFam: false };
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
};

/** Existing REPO for a site (preferring one whose WWW contains `preferSlug`,
 *  e.g. the Matricula archive), or undefined. */
function findSiteRepo(records: GedNode[], hostRe: RegExp, preferSlug: string | undefined): string | undefined {
  let anyMatch: string | undefined;
  for (const rec of records) {
    if (rec.tag !== "REPO" || !rec.xref) continue;
    const www = childText(rec, "WWW") ?? "";
    if (!hostRe.test(www)) continue;
    if (preferSlug && www.toLowerCase().includes(`/${preferSlug.toLowerCase()}`)) return rec.xref;
    anyMatch ??= rec.xref;
  }
  return anyMatch;
}

/** The site's REPO for a new source: an existing one matched by WWW host
 *  (preferring the Matricula archive's), else — only when the file's
 *  convention hangs sources off repositories — a newly created record. */
function ensureSiteRepo(
  records: GedNode[],
  site: ReshapeSite,
  url: string,
  agency: string | undefined,
  repositoryLayout: boolean,
): { xref: string; created?: GedNode } | undefined {
  const repoDef = SITE_REPO[site];
  if (!repoDef) return undefined;
  const mat = site === "matricula" ? parseMatriculaUrl(url) : undefined;
  const existing = findSiteRepo(records, repoDef.hostRe, mat?.archiveSlug);
  if (existing) return { xref: existing };
  if (!repositoryLayout) return undefined;
  // Matricula repositories are the holding archive; the other sites
  // are their own repository.
  const name = (site === "matricula" && agency) || repoDef.name;
  const www = mat
    ? `https://data.matricula-online.eu/${mat.lang}/${mat.country}/${mat.archiveSlug}/`
    : repoDef.www;
  const repo: GedNode = { level: 0, xref: nextXref(records, "R"), tag: "REPO", children: [] };
  repo.children.push({ level: 1, tag: "NAME", value: name, children: [] });
  repo.children.push({ level: 1, tag: "WWW", value: www, children: [] });
  insertRecord(records, repo);
  return { xref: repo.xref!, created: repo };
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
  meta: { place?: string; dateRange?: string },
): GedNode | undefined {
  fillField(sourceNode, "PLAC", buildPlaceResolver(records).resolve(meta.place));
  fillField(sourceNode, "DATE", meta.dateRange);
  if (!site || firstChild(sourceNode, "REPO")) return undefined;
  const repo = ensureSiteRepo(
    records,
    site,
    url,
    childText(sourceNode, "AGNC"),
    inferSourceFormat(records).layout === "repository",
  );
  if (!repo) return undefined;
  sourceNode.children.push({ level: sourceNode.level + 1, tag: "REPO", value: repo.xref, children: [] });
  return repo.created;
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
  };
  if (selected.length === 0) return { records, counts };

  const selectedById = new Map(selected.map((g) => [g.id, g]));
  const sites = new Set<ReshapeSite>(selected.map((g) => g.site));
  const relocate = opts.relocate !== false;

  const clone = records.map(cloneNode);
  const byXref = new Map<string, GedNode>();
  for (const r of clone) if (r.xref) byXref.set(r.xref, r);

  const hits = scanOccurrences(clone, sites).filter((h) => selectedById.has(h.recognized.groupKey));
  const groups = buildGroups(clone, hits, !prefersDoubledLinks(clone));
  const baptismTag = baptismTargetTag(clone);
  const layout = inferSourceFormat(clone).layout;
  // Media index built ONCE for the whole apply (a per-group rebuild is a full
  // forest scan each time); OBJEs this run creates are tracked alongside.
  const cloneObjeIndex = buildObjeIndex(clone);
  const createdObjeUrls = new Map<string, string>();
  const urlOfObje = (xref: string): string | undefined =>
    cloneObjeIndex.get(xref)?.url ?? createdObjeUrls.get(xref);
  const { resolve: resolvePlace, structuredAddr } = buildPlaceResolver(clone);

  for (const [key, state] of groups) {
    const selection = selectedById.get(key);
    if (!selection) continue;
    const g = state.group;
    const extra = enrichment?.get(key);
    const bookType = extra?.bookType ?? g.bookType;
    const fields = {
      title: extra?.title ?? g.proposed.title,
      author: extra?.author ?? g.proposed.author,
      periodical: extra?.periodical,
      publisher: extra?.publisher,
      agency: extra?.agency ?? g.proposed.agency,
      // Matched against the file's own places, so "Žabnica, Slovenia" (or a
      // diacritic-less slug guess) lands in the established place format.
      place: resolvePlace(extra?.place ?? g.proposed.place),
      filingNumber: extra?.filingNumber ?? g.proposed.filingNumber,
      dateRange: extra?.dateRange ?? g.proposed.dateRange,
    };

    // --- Resolve the target SOUR record: reuse, adopt a URL-titled one, or create.
    let sourceNode = g.existingSourceXref ? byXref.get(g.existingSourceXref) : undefined;
    if (sourceNode) counts.sourcesReused++;
    else {
      sourceNode = createSourceRecord(clone, fields);
      byXref.set(sourceNode.xref!, sourceNode);
      counts.sourcesCreated++;
      // `NewSourceFields` has no place/date — the paginated house shape does.
      fillField(sourceNode, "PLAC", fields.place);
      fillField(sourceNode, "DATE", fields.dateRange);
      const repo = ensureSiteRepo(clone, g.site, state.hits[0].url, fields.agency, layout === "repository");
      if (repo) {
        if (repo.created) byXref.set(repo.created.xref!, repo.created);
        sourceNode.children.push({ level: 1, tag: "REPO", value: repo.xref, children: [] });
      }
    }
    const sourceXref = sourceNode.xref!;

    // --- Rewrite URL-titled SOUR records in place (every one in the group, so
    // the duplicates tool can consolidate them afterwards).
    for (const hit of state.hits) {
      if (hit.shape !== "sourTitle") continue;
      hit.node.value = fields.title;
      fillField(hit.rec, "AUTH", fields.author);
      fillField(hit.rec, "AGNC", fields.agency);
      fillField(hit.rec, "PLAC", fields.place);
      fillField(hit.rec, "FILN", fields.filingNumber);
      fillField(hit.rec, "DATE", fields.dateRange);
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
      const urlKey = linkKey(hit.url);
      if (seenUrls.has(urlKey) || linkedKeys.has(urlKey)) continue;
      seenUrls.add(urlKey);
      const page = hit.recognized.page;
      const objeTitle = page ? `#${page} - ${fields.title}` : fields.title;
      if (hit.objeXref && byXref.has(hit.objeXref)) {
        // Re-link the already-existing top-level OBJE under the source,
        // grouped with its other page media (not after CHAN/CREA).
        insertGrouped(sourceNode, { level: 1, tag: "OBJE", value: hit.objeXref, children: [] }, SOUR_TRAILING);
      } else {
        const obje = addObjeToSource(clone, sourceXref, hit.url, objeTitle);
        if (obje.xref) createdObjeUrls.set(obje.xref, hit.url);
        counts.mediaCreated++;
      }
      linkedKeys.add(urlKey);
    }

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

      const page = hit.recognized.page;
      const move = relocate && !hit.twinEvent ? relocationTarget(hit, bookType, baptismTag) : undefined;
      let container = hit.container;
      if (move) {
        const host = move.onFam ? byXref.get(soleFamsXref(hit.rec) ?? "") : hit.rec;
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
        const duplicate = childrenByTag(container, "SOUR").some(
          (c) => c !== citation && c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === pageText,
        );
        if (container !== hit.container) {
          spliceChild(hit.container, citation);
          if (!duplicate) {
            relevel(citation, container.level + 1);
            insertOrdered(container, citation, order);
          }
        } else if (duplicate) {
          spliceChild(container, citation);
        }
        counts.citationsRewritten++;
        continue;
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

/** Rewrite a Matricula book URL to its `/en/` variant (stable table labels). */
function matriculaEnUrl(bookUrl: string): string {
  return bookUrl.replace(/^(https?:\/\/data\.matricula-online\.eu)\/[a-z]{2}\//i, "$1/en/");
}

/** Session-wide fetched-metadata cache, keyed by page-independent book key —
 *  re-opening the panel or re-running enrichment never refetches a book. */
const bookMetaCache = new Map<string, ReshapeMeta>();

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
        // The cemetery (and plot) is address-level detail for the BURI event.
        address: [page.cemetery, page.plot].filter(Boolean).join(", ") || undefined,
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
): Promise<ReshapeMeta | undefined> {
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
  const html = await fetchHtml(url).catch(() => undefined);
  const meta = html ? parseBookMeta(site, bookUrl, html) : undefined;
  // A dateless Google Books result usually means a relay was served the About
  // page instead of the reader — don't pin that for the session; a later run
  // through a different relay may land the dated reader heading.
  if (meta && !(site === "googlebooks" && !meta.dateRange)) bookMetaCache.set(cacheKey, meta);
  return meta;
}

/**
 * Fetch metadata for the given (new-source) groups — **one fetch per book**,
 * via the injected `fetchHtml` (the allorigins relay wrapper; injectable for
 * tests). Matricula only: Geneanet blocks non-browser clients (kept
 * best-effort via the page title if the relay gets through) and FamilySearch
 * sits behind a login. Failures are swallowed — offline fallbacks stay.
 */
export async function fetchReshapeMeta(
  groups: ReshapeGroup[],
  fetchHtml: (url: string) => Promise<string | undefined>,
  onProgress?: (done: number, total: number) => void,
  /** Called the moment one book resolves, so the UI can update incrementally. */
  onMeta?: (groupId: string, meta: ReshapeMeta) => void,
): Promise<ReshapeEnrichment> {
  const enrichment: ReshapeEnrichment = new Map();
  const targets = groups.filter((g) => isFetchableSite(g.site));
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

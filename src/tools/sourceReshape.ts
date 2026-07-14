import type { Dataset, GedNode } from "../gedcom/types";
import { childText, childrenByTag, cloneNode, firstChild } from "../gedcom/node";
import {
  bookKeyOf,
  buildObjeIndex,
  findExistingSource,
  inferSourceFormat,
  isPointer,
  looksLikeUrl,
  pageParamOf,
  sourceTitle,
} from "../gedcom/source";
import { linkKey } from "../normalize/links";
import { decodeHtmlEntities, pageTitleOf } from "../normalize/urlMetadata";
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

export type ReshapeSite =
  | "matricula"
  | "geneanet"
  | "findagrave"
  | "legacy"
  | "sistory"
  | "familysearch"
  | "other";

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
  /** Offline-derived source fields; enrichment overrides them on apply. */
  proposed: { title: string; agency?: string; place?: string; filingNumber?: string };
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
  agency?: string;
  place?: string;
  dateRange?: string;
  bookType?: BookType;
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

const DEFAULT_SITES: ReadonlySet<ReshapeSite> = new Set([
  "matricula",
  "geneanet",
  "findagrave",
  "legacy",
  "sistory",
  "familysearch",
]);

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

/** A Find a Grave memorial URL: /memorial/{id}(/{name-slug}). Cemetery and
 *  other Find a Grave pages are not grave records and fall through to "other". */
const FINDAGRAVE_MEMORIAL_RE = /^https?:\/\/(?:\w+\.)?findagrave\.com\/memorial\/(\d+)(?:\/([^/?#]+))?/i;

/** A Legacy.com obituary URL — several vintages share the host, an
 *  "obituaries" path, a `{name}-obituary` slug and an `id`/`pid` param:
 *  /us/obituaries/{affiliate}/name/{slug}-obituary?id=…, /obituaries/name/…?pid=… */
const LEGACY_OBIT_RE = /^https?:\/\/(?:www\.)?legacy\.com\/[^?#]*obituar/i;

/** A SIstory.si war-victims record: /ww1/{guid} or /ww2/{guid} — the Slovene
 *  WW1/WW2 casualty databases; one record per person, evidencing the death. */
const SISTORY_WW_RE = /^https?:\/\/(?:\w+\.)?sistory\.si\/(ww[12])\/([0-9a-f-]{8,})/i;

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
    // Title format: `{id} - {what}, {where} - Geneanet Cemeteries` — the view
    // id stays identifiable, the site name trails.
    return {
      site: "geneanet",
      groupKey: `g:${gene[1]}`,
      bookUrl: `https://en.geneanet.org/cemetery/view/${gene[1]}`,
      proposed: { title: who ? `${gene[1]} - ${who} - Geneanet Cemeteries` : `${gene[1]} - Geneanet Cemeteries` },
      titleRank: who ? 1 : 0,
    };
  }

  const grave = FINDAGRAVE_MEMORIAL_RE.exec(url.trim());
  if (grave) {
    if (!sites.has("findagrave")) return undefined;
    const who = grave[2] ? prettySlug(grave[2]) : undefined;
    // Same shape as Geneanet: `{memorial id} - {person} - Find a Grave`.
    return {
      site: "findagrave",
      groupKey: `fg:${grave[1]}`,
      bookUrl: `https://www.findagrave.com/memorial/${grave[1]}`,
      proposed: { title: who ? `${grave[1]} - ${who} - Find a Grave` : `${grave[1]} - Find a Grave` },
      titleRank: who ? 1 : 0,
    };
  }

  if (LEGACY_OBIT_RE.test(url.trim())) {
    if (!sites.has("legacy")) return undefined;
    const id = /[?&]p?id=(\d+)/i.exec(url)?.[1];
    const slug = /\/([^/?#]+)-obituary(?:[/?#]|$)/i.exec(url)?.[1];
    const who = slug ? prettySlug(slug) : undefined;
    return {
      site: "legacy",
      groupKey: id ? `l:${id}` : `l:${linkKey(cleanUrl(url))}`,
      bookUrl: cleanUrl(url).replace(/([?&])p?id=(\d+).*$/i, "$1id=$2"),
      proposed: {
        title: [id, who, "Legacy.com"].filter(Boolean).join(" - "),
      },
      titleRank: who ? 1 : 0,
    };
  }

  const sistory = SISTORY_WW_RE.exec(url.trim());
  if (sistory) {
    if (!sites.has("sistory")) return undefined;
    const war = sistory[1].toUpperCase();
    const guid = sistory[2].toUpperCase();
    // The GUID means nothing to a reader — prefer the person's name, which the
    // SIstory citation text carries in »…« quotes.
    const who = quotedCollection(contextText);
    return {
      site: "sistory",
      groupKey: `s:${guid.toLowerCase()}`,
      bookUrl: `https://www.sistory.si/${sistory[1].toLowerCase()}/${guid}`,
      proposed: { title: who ? `${who} - SIstory.si ${war}` : `SIstory.si ${war} - ${guid}` },
      titleRank: who ? 1 : 0,
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
          filingNumber: fs.cat,
        },
        typeHint: collection,
      };
    }
    return {
      site: "familysearch",
      groupKey: collection ? `f:coll:${collection.toLowerCase()}` : `f:${linkKey(url)}`,
      bookUrl: cleanUrl(url),
      page: fs.ark,
      proposed: { title: collection ?? `FamilySearch ${fs.ark}` },
      typeHint: collection,
    };
  }

  if (!sites.has("other")) return undefined;
  return {
    site: "other",
    groupKey: `o:${linkKey(url)}`,
    bookUrl: cleanUrl(url),
    proposed: { title: contextText?.trim() ? firstLine(contextText) : cleanUrl(url) },
  };
}

function firstLine(text: string): string {
  return text.split("\n")[0].trim().slice(0, 120) || text.trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// Register-type classification (drives event placement)

const TYPE_KEYWORDS: Record<Exclude<BookType, "unknown" | "burial">, RegExp> = {
  baptism: /krst|tauf|baptiz|baptism|rojstn|\bkk\b/i,
  marriage: /poro[čc]|trauung|matrimon|copulat|marriage|\bpk\b/i,
  death: /mrli|sterbe|defunct|mortu|umrl|death|\bmk\b/i,
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
  for (const m of text.matchAll(URL_RE)) {
    const url = cleanUrl(m[0]);
    const recognized = recognize(url, contextText, sites);
    if (recognized) out.push({ url, recognized });
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
        for (const { url, recognized } of recognizedUrls(pageValue, ownerTitle, sites)) {
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

const SITE_ORDER: Record<ReshapeSite, number> = {
  matricula: 0,
  geneanet: 1,
  findagrave: 2,
  legacy: 3,
  sistory: 4,
  familysearch: 5,
  other: 6,
};

/** Sites whose record kind is inherent: graves → burial, obituaries and
 *  war-casualty records → death. */
const SITE_BOOK_TYPE: Partial<Record<ReshapeSite, BookType>> = {
  geneanet: "burial",
  findagrave: "burial",
  legacy: "death",
  sistory: "death",
};

interface GroupState {
  group: ReshapeGroup;
  hits: ScanHit[];
  titleRank: number;
}

function buildGroups(records: GedNode[], hits: ScanHit[], foldDuplicates: boolean): Map<string, GroupState> {
  const groups = new Map<string, GroupState>();
  for (const hit of hits) {
    const { recognized } = hit;
    let state = groups.get(recognized.groupKey);
    if (!state) {
      const existing = findExistingSource(records, hit.url);
      // A URL-titled SOUR record in the group becomes its target: badge as reuse.
      const existingXref = existing?.sourceXref;
      const existingNode = existingXref
        ? records.find((r) => r.tag === "SOUR" && r.xref === existingXref)
        : undefined;
      state = {
        group: {
          id: recognized.groupKey,
          site: recognized.site,
          bookType: "unknown",
          existingSourceXref: existingXref,
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
    for (const hit of state.hits) {
      if (hit.eventTag || hit.shape === "sourTitle") continue;
      const eventTwin = state.hits.find(
        (h) => h !== hit && h.rec === hit.rec && h.eventTag && linkKey(h.url) === linkKey(hit.url),
      );
      if (!eventTwin) continue;
      if (foldDuplicates) hit.foldedInto = eventTwin.eventTag;
      else hit.twinEvent = eventTwin.eventTag;
    }
    state.group.pages.sort((a, b) => collator.compare(a, b));
    state.group.bookType =
      SITE_BOOK_TYPE[state.group.site] ??
      classifyBookType([
        state.group.existingSourceTitle,
        state.group.proposed.title,
        ...state.hits.map((h) => h.typeText),
        ...state.hits.map((h) => h.prefix),
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
  const bySite: Record<ReshapeSite, number> = {
    matricula: 0,
    geneanet: 0,
    findagrave: 0,
    legacy: 0,
    sistory: 0,
    familysearch: 0,
    other: 0,
  };
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
    (a, b) => SITE_ORDER[a.site] - SITE_ORDER[b.site] || collator.compare(a.proposed.title, b.proposed.title),
  );
  return { groups: out, totalOccurrences: total, bySite };
}

// ---------------------------------------------------------------------------
// Apply

/** Remove one URL from free text, tidying leftover artifacts conservatively —
 *  never rewrapping or reformatting the user's remaining prose. */
function removeUrlFromText(text: string, url: string): string {
  return text
    .replace(url, "")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/^[\s:–—,-]+|[\s:–—,-]+$/g, "");
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

/** Existing REPO for Matricula (preferring the group's archive), or undefined. */
function findMatriculaRepo(records: GedNode[], archiveSlug: string | undefined): string | undefined {
  let anyMatch: string | undefined;
  for (const rec of records) {
    if (rec.tag !== "REPO" || !rec.xref) continue;
    const www = childText(rec, "WWW") ?? "";
    if (!/data\.matricula-online\.eu/i.test(www)) continue;
    if (archiveSlug && www.toLowerCase().includes(`/${archiveSlug.toLowerCase()}`)) return rec.xref;
    anyMatch ??= rec.xref;
  }
  return anyMatch;
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

  for (const [key, state] of groups) {
    const selection = selectedById.get(key);
    if (!selection) continue;
    const g = state.group;
    const extra = enrichment?.get(key);
    const bookType = extra?.bookType ?? g.bookType;
    const fields = {
      title: extra?.title ?? g.proposed.title,
      agency: extra?.agency ?? g.proposed.agency,
      place: extra?.place ?? g.proposed.place,
      filingNumber: g.proposed.filingNumber,
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
      if (extra?.dateRange) fillField(sourceNode, "DATE", extra.dateRange);
      if (g.site === "matricula") {
        const mat = parseMatriculaUrl(state.hits[0].url);
        let repoXref = findMatriculaRepo(clone, mat?.archiveSlug);
        if (!repoXref && layout === "repository" && mat) {
          const repo: GedNode = { level: 0, xref: nextXref(clone, "R"), tag: "REPO", children: [] };
          if (fields.agency) repo.children.push({ level: 1, tag: "NAME", value: fields.agency, children: [] });
          repo.children.push({
            level: 1,
            tag: "WWW",
            value: `https://data.matricula-online.eu/${mat.lang}/${mat.country}/${mat.archiveSlug}/`,
            children: [],
          });
          insertRecord(clone, repo);
          byXref.set(repo.xref!, repo);
          repoXref = repo.xref;
        }
        if (repoXref) sourceNode.children.push({ level: 1, tag: "REPO", value: repoXref, children: [] });
      }
    }
    const sourceXref = sourceNode.xref!;

    // --- Rewrite URL-titled SOUR records in place (every one in the group, so
    // the duplicates tool can consolidate them afterwards).
    for (const hit of state.hits) {
      if (hit.shape !== "sourTitle") continue;
      hit.node.value = fields.title;
      fillField(hit.rec, "AGNC", fields.agency);
      fillField(hit.rec, "PLAC", fields.place);
      fillField(hit.rec, "FILN", fields.filingNumber);
      if (extra?.dateRange) fillField(hit.rec, "DATE", extra.dateRange);
      counts.citationsRewritten++;
    }

    // --- Ensure one OBJE per distinct page URL under the target SOUR.
    const objeIndex = buildObjeIndex(clone);
    const linkedKeys = new Set<string>();
    for (const c of childrenByTag(sourceNode, "OBJE")) {
      const v = c.value?.trim();
      const url = v && objeIndex.get(v)?.url;
      if (url) linkedKeys.add(linkKey(url));
    }
    const seenUrls = new Set<string>();
    for (const hit of state.hits) {
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
        addObjeToSource(clone, sourceXref, hit.url, objeTitle);
        counts.mediaCreated++;
      }
      linkedKeys.add(urlKey);
    }

    // --- Rewrite each occurrence into a citation. The re-scanned hits align
    // index-for-index with the report's members (same deterministic scan and
    // grouping), so a member's per-citation QUAY override maps by position.
    for (let hitIndex = 0; hitIndex < state.hits.length; hitIndex++) {
      const hit = state.hits[hitIndex];
      const quayFor = selection.members[hitIndex]?.quay ?? selection.quay;
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

      if (hit.shape === "inline" || hit.shape === "pageUrl") {
        // Convert the citation node itself, preserving its other children.
        const citation = hit.node;
        citation.value = sourceXref;
        const pageChild = firstChild(citation, "PAGE");
        if (page) {
          if (pageChild) pageChild.value = page;
          else citation.children.push({ level: citation.level + 1, tag: "PAGE", value: page, children: [] });
        } else if (pageChild && hit.shape === "pageUrl") {
          spliceChild(citation, pageChild);
        }
        if (hit.prefix && !childrenByTag(citation, "NOTE").some((n) => n.value?.trim() === hit.prefix)) {
          citation.children.push({ level: citation.level + 1, tag: "NOTE", value: hit.prefix, children: [] });
        }
        if (quayFor && !firstChild(citation, "QUAY")) {
          citation.children.push({ level: citation.level + 1, tag: "QUAY", value: quayFor, children: [] });
        }
        if (container !== hit.container) {
          const duplicate = childrenByTag(container, "SOUR").some(
            (c) => c !== citation && c.value?.trim() === sourceXref && (childText(c, "PAGE") ?? "") === (page ?? ""),
          );
          spliceChild(hit.container, citation);
          if (!duplicate) {
            relevel(citation, container.level + 1);
            insertOrdered(container, citation, order);
          }
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
): Promise<ReshapeEnrichment> {
  const enrichment: ReshapeEnrichment = new Map();
  // FamilySearch sits behind a login and generic links have no parser — the
  // named archive/grave/obituary sites are all fetchable.
  const targets = groups.filter((g) => g.site !== "familysearch" && g.site !== "other");
  let done = 0;
  onProgress?.(0, targets.length);

  const worker = async (queue: ReshapeGroup[]): Promise<void> => {
    for (let g = queue.shift(); g; g = queue.shift()) {
      const cacheKey = `${g.site}:${bookKeyOf(g.bookUrl)}`;
      let meta = bookMetaCache.get(cacheKey);
      if (!meta) {
        const url = g.site === "matricula" ? matriculaEnUrl(g.bookUrl) : g.bookUrl;
        const html = await fetchHtml(url).catch(() => undefined);
        if (html) {
          if (g.site === "matricula") {
            const page = parseMatriculaBookPage(html);
            if (page) {
              meta = {
                title: page.title,
                agency: page.agency,
                place: page.place,
                dateRange: yearRange(page.dateFrom, page.dateTo),
                bookType: classifyBookType([page.type]),
              };
            }
          } else if (g.site === "geneanet") {
            const page = parseGeneanetCemeteryPage(html);
            if (page) {
              const viewId = /\/view\/([^/?#]+)/.exec(g.bookUrl)?.[1];
              meta = {
                // The grave's whereabouts: cemetery, plot, town, country.
                place:
                  [page.cemetery, page.plot, page.town, page.country].filter(Boolean).join(", ") || undefined,
                // `{id} - {cemetery}, {town} - Geneanet Cemeteries`.
                title:
                  page.cemetery && viewId
                    ? `${viewId} - ${page.cemetery}${page.town ? `, ${page.town}` : ""} - Geneanet Cemeteries`
                    : undefined,
              };
            }
          } else if (g.site === "findagrave") {
            // `Frank Gorishek (1881-1968) - Find a Grave Memorial` → the name;
            // the suffix may arrive ellipsized ("- Find a…"), match loosely.
            const name = pageTitleOf(html)?.replace(/\s*[-–]\s*Find a.*$/i, "").trim();
            const memorialId = /\/memorial\/(\d+)/.exec(g.bookUrl)?.[1];
            if (name) {
              meta = { title: memorialId ? `${memorialId} - ${name} - Find a Grave` : `${name} - Find a Grave` };
            }
          } else if (g.site === "legacy") {
            const name = pageTitleOf(html)?.replace(/\s*[-|]\s*Legacy\.com.*$/i, "").trim();
            const obitId = /[?&]id=(\d+)/i.exec(g.bookUrl)?.[1];
            if (name) meta = { title: [obitId, name, "Legacy.com"].filter(Boolean).join(" - ") };
          } else if (g.site === "sistory") {
            const name = pageTitleOf(html)?.replace(/\s*[-|·]\s*S[Ii]story.*$/i, "").trim();
            const war = /\/(ww[12])\//i.exec(g.bookUrl)?.[1].toUpperCase();
            if (name) meta = { title: `${name} - SIstory.si${war ? ` ${war}` : ""}` };
          } else {
            const title = pageTitleOf(html);
            if (title) meta = { title: title.replace(/\s*[-|]\s*Geneanet\s*$/i, "") };
          }
          if (meta && !Object.values(meta).some(Boolean)) meta = undefined; // nothing usable parsed
          if (meta) bookMetaCache.set(cacheKey, meta);
        }
      }
      if (meta) enrichment.set(g.id, meta);
      onProgress?.(++done, targets.length);
    }
  };

  const queue = [...targets];
  await Promise.all([worker(queue), worker(queue)]);
  return enrichment;
}

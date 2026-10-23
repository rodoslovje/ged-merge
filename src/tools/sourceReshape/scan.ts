import {
  type BookType,
  INLINE_VALUE_LINK_TAGS,
  type PageMediaStyle,
  type ReshapeShape,
  type ReshapeSite,
} from "./model";
import type { GedNode } from "../../gedcom/types";
import { childrenByTag, childText, firstChild } from "../../gedcom/node";
import { cleanUrl, recognize, type Recognized } from "./urls";
import { URL_RE } from "../../gedcom/builder";
import { linkKey } from "../../normalize/links";
import { buildObjeIndex, isPointer, looksLikeUrl, sourceTitle } from "../../gedcom/source";
import { FAM_EVENT_TAGS, INDI_EVENT_TAGS } from "../../gedcom/eventTags";
import { isPrivateNode } from "../../gedcom/private";

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
export const ACCEPTABLE_TAGS: Record<Exclude<BookType, "unknown">, ReadonlySet<string>> = {
  baptism: new Set(["BIRT", "BAPM", "CHR"]),
  marriage: new Set(["MARR"]),
  death: new Set(["DEAT", "BURI"]),
  burial: new Set(["BURI", "DEAT"]),
};

/** The event a non-marriage book's citation belongs on, or undefined when the
 *  occurrence already sits acceptably (or the book can't say). One doctrine for
 *  the apply's relocation and the report's post-enrichment refresh — the row
 *  must show the same move the apply will make. */
export function bookEventTarget(
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
export interface ScanHit {
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

/** Of the media a source keeps, the linked page images only — a scan stored
 *  as a local file under a source is an attachment, not a page link, so it
 *  says nothing about where the file keeps page links. */
function sourPageLinkXrefs(records: GedNode[]): Map<string, string> {
  const objeIndex = buildObjeIndex(records);
  const owners = sourReferencedObjeXrefs(records);
  for (const xref of [...owners.keys()]) if (!objeIndex.get(xref)?.url) owners.delete(xref);
  return owners;
}

/** Whether any source in the file keeps linked page images at all — without
 *  them the page-media style is moot (don't show/act on a trivial answer). */
export function hasSourcePageMedia(records: GedNode[]): boolean {
  return sourPageLinkXrefs(records).size > 0;
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
  const owners = sourPageLinkXrefs(records);
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

    if (INLINE_VALUE_LINK_TAGS.has(child.tag) && value) {
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
        const found = recognizedUrls(value, value, sites);
        // The citation's prose without ANY of its links — a second site's URL
        // is that site's own occurrence, not text to keep in a NOTE.
        const prose = found.reduce((text, f) => text.replace(f.url, ""), value);
        for (const { url, recognized } of found) {
          const prefix = prose
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
      if (INLINE_VALUE_LINK_TAGS.has(c.tag) && c.value) {
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

export function scanOccurrences(
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
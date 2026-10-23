import { DEFAULT_SITES, type ReshapeGroup, type ReshapeSite } from "./model";
import { stripTrailingPunct, URL_RE } from "../../gedcom/builder";
import { bookKeyOf, pageParamOf } from "../../gedcom/source";
import {
  type FamilySearchUrlParts,
  familySearchImageNumber as imageNumber,
  linkKey,
  parseFamilySearchUrl,
} from "../../normalize/links";
import { SITE_REPO } from "./apply";
import { withScheme } from "../../gedcom/uri";
import { parseSourceInput } from "../../gedcom/citationParse";
import { parsePastedFsCitation } from "./enrich";

// ---------------------------------------------------------------------------
// URL recognition (offline)

/** A recognized site URL, resolved to its group identity and source fields. */
export interface Recognized {
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
export function siteTitle(name: string | undefined, id: string | undefined, siteLabel: string): string {
  return [name, id, siteLabel].filter(Boolean).join(" - ");
}

/** Strip punctuation a URL picked up from surrounding prose — the builder's
 *  shared rule, so the scan and the note-link harvester see the same URL. */
export const cleanUrl = stripTrailingPunct;

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
const NEWSPAPERS_RE = /^https?:\/\/(?:www\.)?newspapers\.com\/(image|clip)\/(\d+)/i;

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
 * A FamilySearch page is the source's title over again, with two differences:
 * the film's own image number in front (`#16 - Ravna Gora - Births …`) and
 * the collection tail (`- Croatia, Church Books, 1516-1994`) dropped — the
 * page belongs to one book, and which collection published the film is the
 * source's business. The number is only ever the film's own count, read off
 * the link's `i=` or the lookup's "image N of M": the hand-editable page
 * field could hold the book's printed page instead, which the film does not
 * count, so a page without the film's number carries the name alone.
 *
 * A link no site recognized names a whole web page rather than a page of a
 * book, and its source's title is that page's own name — so it serves as the
 * media title too. Undefined only when there is no title to build on.
 */
export function pageObjeTitle(
  site: ReshapeSite | undefined,
  title: string | undefined,
  page: string | undefined,
  /** FamilySearch only: the film's own image number, when the link or the
   *  lookup said it — never a hand-edited field. */
  fsImage?: string,
  /** FamilySearch only: the collection the title ends with, dropped from the
   *  page's name. */
  collection?: string,
): string | undefined {
  if (!title) return undefined;
  if (site === "familysearch") {
    const name = collection && title.endsWith(` - ${collection}`) ? title.slice(0, -(collection.length + 3)) : title;
    return fsImage && /^\d+$/.test(fsImage) ? `#${fsImage} - ${name}` : name;
  }
  return page ? `#${page} - ${title}` : title;
}

/**
 * A media title that names where the page came from rather than what it is:
 * empty, the site's own name (what its save button writes on every image
 * alike), or one carrying the raw address. Only those are renamed when the
 * page's book gets a name — a title someone wrote is theirs.
 */
export function placeholderMediaTitle(title: string | undefined, site: ReshapeSite, url: string): boolean {
  const text = (title ?? "").trim();
  if (!text) return true;
  if (text === SITE_REPO[site]?.name) return true;
  if (/https?:\/\//i.test(text)) return true;
  return linkKey(text) === linkKey(url);
}

/** First quoted phrase in citation text — FamilySearch-style collection titles,
 *  e.g. `"Croatia, Church Books, 1516-1994," database with images, …`. */
export function quotedCollection(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = /["»“„]([^"«”‟]{6,120}?),?["«”‟]/.exec(text);
  return m?.[1].trim();
}

/** Recognize a URL for one of the reshapeable sites. `contextText` is the
 *  citation/note text around the URL (collection titles, type hints). */
export function recognize(rawUrl: string, contextText: string | undefined, sites: ReadonlySet<ReshapeSite>): Recognized | undefined {
  // A media FILE may hold a link without its scheme ("www.familysearch.org/…")
  // — every site below is read off the full address.
  const url = withScheme(rawUrl);
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
    // A clip id and a page-image id are different id spaces on the site — a
    // clip URL must never be rewritten into /image/{id}/ (a different or
    // nonexistent page), and a clip and an unrelated image sharing a number
    // must not merge into one source.
    const npKind = np[1].toLowerCase();
    const imageId = np[2];
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
      groupKey: npKind === "clip" ? `np:clip:${imageId}` : `np:${imageId}`,
      bookUrl: `https://www.newspapers.com/${npKind}/${imageId}/`,
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

/**
 * What kind of evidence a recognized site's page is, as the GEDCOM
 * data-quality value (`QUAY`) a citation of it starts from — `3` primary for a
 * photographed register page, `2` secondary for an index, a gravestone or a
 * published account of an event recorded later, `1` questionable for a tree
 * another researcher compiled, and nothing at all for the sites that publish
 * no evidence of their own. It is a proposal the reader changes or clears in
 * the source dialog before anything is written; a site the table leaves out
 * simply opens the dialog with an empty quality field.
 */
const SITE_QUAY: Partial<Record<ReshapeSite, string>> = {
  // A photograph of the parish register itself.
  matricula: "3",
  // The stone and the page that transcribes it: the burial was recorded after
  // the death, and by whoever raised the marker.
  findagrave: "2",
  billiongraves: "2",
  geneanet: "2",
  // A newspaper reports an event after it happened, as does a printed account.
  legacy: "2",
  newspapers: "2",
  sistory: "2",
  dlib: "2",
  googlebooks: "2",
  // A compiled tree states another researcher's conclusions, not evidence.
  geneanettree: "1",
};

/** The `QUAY` a fresh citation of `url` starts from — see {@link SITE_QUAY}.
 *  FamilySearch is the one site whose links differ in kind: an image of a film
 *  is the register page itself, a `1:1` ark is one indexed entry read off such
 *  a page, and a tree page is somebody's conclusions. */
export function siteQuay(site: ReshapeSite, url: string | undefined): string | undefined {
  if (site !== "familysearch") return SITE_QUAY[site];
  const kind = url ? parseFamilySearchUrl(url)?.kind : undefined;
  if (kind === "image") return "3";
  if (kind === "record") return "2";
  if (kind === "tree") return "1";
  return undefined;
}

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
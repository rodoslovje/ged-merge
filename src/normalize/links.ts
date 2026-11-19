import type { GedNode } from "../gedcom/types";
import { isRecordLinkLine, recordLinkHabit } from "../gedcom/edit/records";
import type { MainProfile } from "./types";
import { GEN_INDEX, genIndexOfHost, type GenIndex } from "../online/genIndexes";

/**
 * Recognize and rewrite genealogy-site links whose URL encodes a UI language
 * that varies by file (Matricula Online's `/sl/`-style path segment, Geneanet
 * cemetery's per-language section word) so the same record's link compares
 * equal across files and can be converted to the main's own language on
 * load.
 */

/** Matches the language-code path segment of a Matricula Online URL, e.g.
 *  ".../sl/slovenia/...". Case-insensitive: detection lowercases its input,
 *  but the rewrite runs on the URL as stored — an uppercase host must not
 *  turn `withMatriculaLang` into a silent no-op. */
const MATRICULA_LANG_RE = /^(https?:\/\/data\.matricula-online\.eu)\/([a-z]{2})\//i;

/**
 * One of Geneanet's UI languages for the cemetery section: its hostname and
 * the (language-specific) path word that replaces "cemetery", e.g.
 * "https://de.geneanet.org/friedhof/view/123" or, for French, the unprefixed
 * "https://www.geneanet.org/cimetieres/view/123" (no "fr." subdomain, plural
 * word). Verified against live Geneanet URLs rather than guessed, since the
 * translations don't follow a predictable pattern.
 */
interface GeneanetCemeteryLocale {
  lang: string;
  host: string;
  word: string;
}

const GENEANET_CEMETERY_LOCALES: GeneanetCemeteryLocale[] = [
  { lang: "en", host: "en.geneanet.org", word: "cemetery" },
  { lang: "de", host: "de.geneanet.org", word: "friedhof" },
  { lang: "es", host: "es.geneanet.org", word: "cementerio" },
  { lang: "fi", host: "fi.geneanet.org", word: "siviilihautausmaa" },
  { lang: "fr", host: "www.geneanet.org", word: "cimetieres" },
  { lang: "it", host: "it.geneanet.org", word: "cimitero" },
  { lang: "nl", host: "nl.geneanet.org", word: "kerkhof" },
  { lang: "no", host: "no.geneanet.org", word: "gravlund" },
  { lang: "pt", host: "pt.geneanet.org", word: "cemitério" },
  { lang: "sv", host: "sv.geneanet.org", word: "kyrkogård" },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const geneanetCemeteryRes = new Map<GeneanetCemeteryLocale, RegExp>();

/** Matches a Geneanet cemetery-entry URL for one locale, capturing the protocol
 *  and the "/view/..." tail. Built once per locale, not once per link read. */
function geneanetCemeteryRe(locale: GeneanetCemeteryLocale): RegExp {
  let re = geneanetCemeteryRes.get(locale);
  if (!re) {
    re = new RegExp(`^(https?://)${escapeRegExp(locale.host)}/${escapeRegExp(locale.word)}(/view/.*)$`, "i");
    geneanetCemeteryRes.set(locale, re);
  }
  return re;
}

/** Decode percent-escaped characters (e.g. a copied "cemit%C3%A9rio" link), falling back to the input if malformed. */
function decodeUrlSafe(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/** Find which Geneanet cemetery locale, if any, a URL belongs to, along with its "/view/..." tail. */
function matchGeneanetCemetery(url: string): { locale: GeneanetCemeteryLocale; tail: string } | undefined {
  const decoded = decodeUrlSafe(url.trim());
  for (const locale of GENEANET_CEMETERY_LOCALES) {
    const m = geneanetCemeteryRe(locale).exec(decoded);
    if (m) return { locale, tail: m[2] };
  }
  return undefined;
}

const FS_ARK_URL_RE = /^(https?:\/\/)(?:www\.)?familysearch\.org\/(?:[a-z]{2}\/)?ark:\/61903\/([^?#\s]+)/i;

/**
 * A FamilySearch ark stripped to what identifies the page: the ark itself.
 * Its viewer hangs a trail of state on the URL — `?view=explore&lang=en&
 * groupId=…`, or the older `?cc=…&wc=…&i=…` — which changes with how the
 * reader got there, not with what they are looking at. Two links to one image
 * therefore look different, and the same page ends up cited twice. The film
 * number (`cat=`) is the exception: it names which catalog film the image
 * belongs to, so it stays.
 */
export function canonicalFamilySearchUrl(url: string): string {
  const m = FS_ARK_URL_RE.exec(url.trim());
  if (!m) return url;
  const cat = /[?&]cat=(\d+)/i.exec(url)?.[1];
  return `${m[1]}www.familysearch.org/ark:/61903/${m[2]}${cat ? `?cat=${cat}` : ""}`;
}

/** A person page of the Slovenian Genealogical Index (indeks.rodoslovje.si),
 *  or of the Croatian one (indeks.rodoslovlje.hr) — the same software:
 *  `?t=tree&n={given}&sn={surname}&dob={date}&c={contributor}&id=@{xref}@`. The
 *  pair `c` + `id` names the record — the contributor's tree and the person's
 *  GEDCOM id in it; the rest is the view (`t`, `dir`, `gens`) and search
 *  hints that change with how the reader got there. */
export interface IndeksUrlParts {
  /** Which index the link is on. */
  index: GenIndex;
  contributor: string;
  /** The GEDCOM xref without its `@` delimiters ("60899836"). */
  id: string;
  given?: string;
  surname?: string;
  dob?: string;
  /** The page view the link opens: `tree` (default), `ancestors`, `descendants`. */
  view: string;
  dir?: string;
}

const INDEKS_RE = /^https?:\/\/(?:www\.)?(indeks\.rodoslovje\.si|indeks\.rodoslovlje\.hr)\/?\?(.*)$/i;

/** One query value as the reader means it: percent-decoded, `+` as a space. */
function queryValue(raw: string): string {
  return decodeUrlSafe(raw.replace(/\+/g, " ")).trim();
}

/** The query of an index URL, keys lowercased and values decoded, and the index it is on. */
function indeksParams(url: string): { index: GenIndex; params: Map<string, string> } | undefined {
  const m = INDEKS_RE.exec(url.trim());
  const index = m && genIndexOfHost(m[1]);
  if (!m || !index) return undefined;
  const params = new Map<string, string>();
  for (const pair of m[2].replace(/#.*$/, "").replace(/&amp;/gi, "&").split("&")) {
    const eq = pair.indexOf("=");
    if (eq > 0) params.set(pair.slice(0, eq).toLowerCase(), queryValue(pair.slice(eq + 1)));
  }
  return { index, params };
}

/** The name an index search link looks for (`?n=marija&sn=rakar`) — a query
 *  over every contributor, not one record; undefined when it names nobody. */
export function indeksSearchName(url: string): { index: GenIndex; given?: string; surname?: string } | undefined {
  const parsed = indeksParams(url);
  if (!parsed) return undefined;
  const given = parsed.params.get("n") || undefined;
  const surname = parsed.params.get("sn") || undefined;
  return given || surname ? { index: parsed.index, given, surname } : undefined;
}

/**
 * Read a Slovenian Genealogical Index person link. The site writes the id with
 * its GEDCOM delimiters unescaped (`id=@60899836@`); a copy taken out of a
 * GEDCOM 5.5.1 file doubles them (`@@60899836@@`), an encoder writes `%40` —
 * all name the same record. A search or contributors page (no `c` + `id`) is
 * not a person and reads as undefined.
 */
export function parseIndeksUrl(url: string): IndeksUrlParts | undefined {
  const parsed = indeksParams(url);
  if (!parsed) return undefined;
  const { index, params } = parsed;
  const contributor = params.get("c");
  const id = params.get("id")?.replace(/@/g, "").trim();
  if (!contributor || !id) return undefined;
  const view = params.get("t")?.toLowerCase();
  return {
    index,
    contributor,
    id,
    given: params.get("n") || undefined,
    surname: params.get("sn") || undefined,
    dob: params.get("dob") || undefined,
    view: view === "ancestors" || view === "descendants" ? view : "tree",
    dir: params.get("dir") || undefined,
  };
}

/** The canonical form of an index person link: the site's own parameter order
 *  and spelling (`@` and spaces left readable, as the site writes them). */
export function indeksPersonUrl(p: IndeksUrlParts): string {
  const enc = (s: string) => encodeURIComponent(s).replace(/%40/g, "@");
  const query = [
    `t=${p.view}`,
    p.given && `n=${enc(p.given)}`,
    p.surname && `sn=${enc(p.surname)}`,
    p.dob && `dob=${enc(p.dob)}`,
    `c=${enc(p.contributor)}`,
    `id=@${enc(p.id)}@`,
    p.dir && `dir=${enc(p.dir)}`,
  ]
    .filter(Boolean)
    .join("&");
  return `${GEN_INDEX[p.index].site}?${query}`;
}

/** An id that is case-sensitive on its own site — a YouTube video, a Google
 *  Books volume. Case-folding these would make two different resources
 *  compare equal, so the key carries the id as written. */
const CASE_SENSITIVE_ID_RE =
  /(?:youtube\.com\/watch\?(?:[^#]*&)?v=|youtu\.be\/|books\.google\.[a-z.]+\/books[^?#]*\?(?:[^#]*&)?id=|play\.google\.com\/store\/books\/details\?(?:[^#]*&)?id=|google\.[a-z.]+\/books\/edition\/[^/?#]+\/)([A-Za-z0-9_-]+)/;

/**
 * Normalize a URL for set comparison: case-fold, fold `http://` to `https://`
 * (an old export's plain-http copy of a page is the same page), drop a
 * trailing slash, ignore the language code in Matricula Online URLs (e.g.
 * /sl/ vs /de/) and Geneanet cemetery URLs (e.g. /cemetery/ vs /friedhof/)
 * since they link to the same record in different UI languages, and reduce a
 * FamilySearch ark to the page it names. A case-sensitive resource id
 * (YouTube, Google Books) survives the fold, so ids differing only by case
 * stay distinct. A Slovenian or Croatian Genealogical Index person link reduces to the
 * record it names (contributor + id), whatever view or search hints it carries.
 */
export function linkKey(url: string): string {
  const indeks = parseIndeksUrl(url);
  if (indeks) return `${GEN_INDEX[indeks.index].site}?c=${indeks.contributor.toLowerCase()}&id=${indeks.id.toLowerCase()}`;
  const caseId = CASE_SENSITIVE_ID_RE.exec(url.trim())?.[1];
  const key = canonicalFamilySearchUrl(url.trim().toLowerCase())
    .replace(/^http:\/\//, "https://")
    .replace(/\/+$/, "");
  const matriculaKey = key.replace(MATRICULA_LANG_RE, "$1/xx/");
  const geneanet = matchGeneanetCemetery(matriculaKey);
  const base = geneanet ? `https://xx.geneanet.org/cemetery${geneanet.tail}` : matriculaKey;
  return caseId ? `${base}#id=${caseId}` : base;
}

/** The language code a Matricula Online URL uses, if it is one. */
export function matriculaLangCode(url: string): string | undefined {
  return MATRICULA_LANG_RE.exec(url.trim().toLowerCase())?.[2];
}

/** Rewrite a Matricula Online URL to use the given language code. */
export function withMatriculaLang(url: string, lang: string): string {
  return url.replace(MATRICULA_LANG_RE, `$1/${lang}/`);
}

/** The language code a Geneanet cemetery URL uses, if it is one. */
export function geneanetLangCode(url: string): string | undefined {
  return matchGeneanetCemetery(url)?.locale.lang;
}

/** Rewrite a Geneanet cemetery URL to use the given language, if known. */
export function withGeneanetLang(url: string, lang: string): string {
  const target = GENEANET_CEMETERY_LOCALES.find((l) => l.lang === lang);
  const found = matchGeneanetCemetery(url);
  if (!target || !found) return url;
  return `https://${target.host}/${target.word}${found.tail}`;
}

/** The language code the main file's own links use, by site — Matricula Online and Geneanet cemetery. */
export interface LinkLangs {
  matricula: string | undefined;
  geneanet: string | undefined;
}

/** Rewrite a Matricula Online or Geneanet cemetery URL to the main's known language, if applicable. */
export function rewriteLinkLang(url: string, linkLangs: LinkLangs): string {
  if (linkLangs.matricula && matriculaLangCode(url)) return withMatriculaLang(url, linkLangs.matricula);
  if (linkLangs.geneanet && geneanetLangCode(url)) return withGeneanetLang(url, linkLangs.geneanet);
  return url;
}

/**
 * The language code the main file's existing links for a given site (e.g.
 * Matricula Online, Geneanet cemetery) use most often, so an incoming file's
 * links can be converted to match on load.
 */
function detectLinkLang(links: string[], langCode: (url: string) => string | undefined): string | undefined {
  const counts = new Map<string, number>();
  for (const url of links) {
    const lang = langCode(url);
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [lang, count] of counts) {
    if (count > bestCount) {
      best = lang;
      bestCount = count;
    }
  }
  return best;
}

/** The `LinkLangs` the main file's own links use most often, given every link found on it. */
export function detectLinkLangs(links: string[]): LinkLangs {
  return {
    matricula: detectLinkLang(links, matriculaLangCode),
    geneanet: detectLinkLang(links, geneanetLangCode),
  };
}

// ── FamilySearch links ──────────────────────────────────────────────────────
// A FamilySearch link carries two things a source must keep apart: which book
// (the film its images belong to) and which page (the image within that film).
// The ark in the path names the single image, so two pages of one film share
// no part of their URLs — which is why a source's identity is never read off
// the URL alone; see `FsSourceHint` in `gedcom/source`.

/** What a FamilySearch URL points at, in its own terms. */
export interface FamilySearchUrlParts {
  kind: "image" | "record" | "tree";
  ark?: string;
  /** `cat=` — the film/catalog the image belongs to: the *book* of the page. */
  cat?: string;
  /** `cc=` — the published collection the image belongs to ("Croatia, Church
   *  Books, 1516-1994"): many books, one collection, and the id a repository
   *  for it is found by. */
  cc?: string;
  /** `i=` — which image of that film, counting from zero. */
  image?: string;
}

// The optional `[a-z]{2}/` matches the UI-language path segment FamilySearch
// sometimes writes ahead of the ark (`/de/ark:/…`) — the same allowance
// `FS_ARK_URL_RE` above makes, so the parser and the key never disagree about
// whether a link is a FamilySearch page.
const FS_ARK_RE = /^https?:\/\/(?:www\.)?familysearch\.org\/(?:[a-z]{2}\/)?ark:\/61903\/(\d:\d):([^/?#]+)/i;

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
        cc: /[?&]cc=(\d+)/i.exec(trimmed)?.[1],
        image: /[?&]i=(\d+)/i.exec(trimmed)?.[1],
      };
    }
    return { kind: "record", ark: id };
  }
  return { kind: "tree" };
}

/** The image number FamilySearch itself would print for a link's `i=`, which
 *  counts from zero: `i=23` is the page its viewer and its citation both call
 *  image 24 (verified against both). Only the offline reading needs this — a
 *  lookup answers with the number already worded. */
export function familySearchImageNumber(i: string | undefined): string | undefined {
  const n = i && /^\d+$/.test(i) ? Number(i) : undefined;
  return n === undefined ? i : String(n + 1);
}

/** The `i=` that names the image a page number names — the reverse of
 *  {@link familySearchImageNumber}, for completing a link copied without one.
 *  Only a plain positive whole number answers: a printed folio, a grave plot
 *  or an entry in words says nothing about which image of the film it is. */
export function familySearchImageIndex(page: string | undefined): string | undefined {
  const n = page && /^\d+$/.test(page.trim()) ? Number(page.trim()) : undefined;
  return n && n > 0 ? String(n - 1) : undefined;
}

/**
 * The form of a FamilySearch link the file stores: the ark, the image the
 * reader was looking at (`i=`), and what that image belongs to — its film
 * (`cat=`) and its published collection (`cc=`). None of the viewer trail
 * around them survives. That is what {@link canonicalFamilySearchUrl} keeps
 * plus the page selector a browse link needs to reopen where it was copied,
 * and the two ids that say which book and which collection the page is from —
 * a link that keeps them can be filed without asking FamilySearch anything.
 * Any other URL is returned unchanged.
 *
 * `fill` completes what a copied link left out, from what the run has since
 * learned: the image its page number names, the collection its lookup
 * resolved. Only gaps are filled — what the link itself says always stands,
 * since that is what the reader copied from the page they were on.
 */
export function familySearchPageUrl(url: string, fill?: { image?: string; cc?: string }): string {
  const fs = parseFamilySearchUrl(url);
  if (!fs || fs.kind === "tree" || !fs.ark) return url;
  // A record page (`1:1`) is one indexed entry, not an image of a film: it has
  // no image to number and no page to select.
  const image = fs.image ?? (fs.kind === "image" ? fill?.image : undefined);
  const cc = fs.cc ?? (fs.kind === "image" ? fill?.cc : undefined);
  const query = [
    image ? `i=${image}` : undefined,
    fs.cat ? `cat=${fs.cat}` : undefined,
    cc ? `cc=${cc}` : undefined,
  ]
    .filter(Boolean)
    .join("&");
  const base = `https://www.familysearch.org/ark:/61903/${fs.ark}`;
  return query ? `${base}?${query}` : base;
}

/** How a file writes links on its person and family records — what
 *  {@link reshapeRecordLinks} brings an incoming record's links to. */
export function recordLinksOf(records: GedNode[]): NonNullable<MainProfile["recordLinks"]> {
  const { tag, tags } = recordLinkHabit(records);
  return { tag, keep: tags };
}

/**
 * Restate the bare `WWW`/`URL` link lines on person and family records in the
 * main's form. Neither GEDCOM version has a link there, so a strict main writes
 * the `_URL` extension; the file's own format writes the tag the file uses,
 * and keeps a bare tag the file itself writes. A new person copied into the
 * main carries its record as is, so this is what keeps a RootsMagic file's (or
 * a CSV import's) `1 WWW` out of a strict main. Calls `onChange` per rewrite.
 */
export function reshapeRecordLinks(
  records: GedNode[],
  target: NonNullable<MainProfile["recordLinks"]>,
  onChange: (before: string, after: string) => void,
): void {
  for (const rec of records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    for (const line of rec.children) {
      if (!isRecordLinkLine(line) || line.tag.startsWith("_")) continue;
      if (line.tag === target.tag || target.keep.includes(line.tag)) continue;
      onChange(`${rec.tag}.${line.tag}`, `${rec.tag}.${target.tag}`);
      line.tag = target.tag;
      line.spelling = undefined;
    }
  }
}

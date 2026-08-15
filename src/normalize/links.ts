/**
 * Recognize and rewrite genealogy-site links whose URL encodes a UI language
 * that varies by file (Matricula Online's `/sl/`-style path segment, Geneanet
 * cemetery's per-language section word) so the same record's link compares
 * equal across files and can be converted to the main's own language on
 * load.
 */

/** Matches the language-code path segment of a Matricula Online URL, e.g. ".../sl/slovenia/...". */
const MATRICULA_LANG_RE = /^(https?:\/\/data\.matricula-online\.eu)\/([a-z]{2})\//;

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

/** Matches a Geneanet cemetery-entry URL for one locale, capturing the protocol and the "/view/..." tail. */
function geneanetCemeteryRe(locale: GeneanetCemeteryLocale): RegExp {
  return new RegExp(`^(https?://)${escapeRegExp(locale.host)}/${escapeRegExp(locale.word)}(/view/.*)$`, "i");
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

/** An id that is case-sensitive on its own site — a YouTube video, a Google
 *  Books volume. Case-folding these would make two different resources
 *  compare equal, so the key carries the id as written. */
const CASE_SENSITIVE_ID_RE =
  /(?:youtube\.com\/watch\?(?:[^#]*&)?v=|youtu\.be\/|books\.google\.[a-z.]+\/books\?(?:[^#]*&)?id=|google\.[a-z.]+\/books\/edition\/[^/?#]+\/)([A-Za-z0-9_-]+)/;

/**
 * Normalize a URL for set comparison: case-fold, drop a trailing slash, ignore
 * the language code in Matricula Online URLs (e.g. /sl/ vs /de/) and Geneanet
 * cemetery URLs (e.g. /cemetery/ vs /friedhof/) since they link to the same
 * record in different UI languages, and reduce a FamilySearch ark to the page
 * it names. A case-sensitive resource id (YouTube, Google Books) survives the
 * fold, so ids differing only by case stay distinct.
 */
export function linkKey(url: string): string {
  const caseId = CASE_SENSITIVE_ID_RE.exec(url.trim())?.[1];
  const key = canonicalFamilySearchUrl(url.trim().toLowerCase()).replace(/\/+$/, "");
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

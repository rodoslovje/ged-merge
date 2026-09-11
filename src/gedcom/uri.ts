/**
 * Tiny value predicates shared by the parser (`builder.ts`) and the source
 * resolver (`source.ts`). They live in their own leaf module because those two
 * import each other, so neither can own a helper the other also needs without a
 * cycle. Re-exported from `source.ts` for the rest of the app.
 */

/** A GEDCOM pointer value, e.g. `@I1@`. */
export function isPointer(v: string): boolean {
  return /^@[^@]+@$/.test(v);
}

/** A `FILE`/link value that is an absolute URL rather than a bare local
 *  filename (`"12345.jpg"`) — only the former is a usable link. */
export function looksLikeUrl(v: string): boolean {
  return /^(https?:\/\/|www\.)/i.test(v);
}

/** File names a `FILE` line can hold, so a bare `krst.jpg` is never read as a
 *  host — `.jpg` is no top-level domain, but it has the shape of one. */
const FILE_NAME_RE =
  /\.(?:jpe?g|png|gif|tiff?|bmp|webp|heic|avif|pdf|docx?|xlsx?|pptx?|txt|rtf|odt|csv|mp[34]|m4[av]|mov|avi|mkv|wav|zip|gz|ged)$/i;

/**
 * Whether a value can be opened as a web address — the question an `↗` must
 * answer before it is drawn. Two shapes qualify: an absolute URL, and a bare
 * host the browser only needs a scheme for (`arhiv.si`, `gov.si/kje?id=3`).
 *
 * Nothing else does, and the difference is not cosmetic: a source's title
 * ("Illinois, Cook County Marriages, 1871-1969"), a filing number or a local
 * scan each turns into an `https://…` address that navigates nowhere once a
 * scheme is glued in front — a link that looks live and does nothing when
 * clicked. Stricter than {@link looksLikeUrl}, which answers a different
 * question (is this `FILE` value a URL or a filename).
 */
export function isWebAddress(v: string | undefined): boolean {
  const value = (v ?? "").trim();
  if (!value) return false;
  if (looksLikeUrl(value)) return true;
  // Whitespace is prose, a backslash is a Windows path, and a media/document
  // file name is a file however host-like its extension looks.
  if (/\s/.test(value) || value.includes("\\") || FILE_NAME_RE.test(value)) return false;
  // A dotted host, optionally with a port, then either nothing or the start of
  // a path/query/fragment.
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#]|$)/i.test(value);
}

/** Matches one or more http(s) URLs embedded anywhere in a line value —
 *  one spelling of "what counts as a URL", shared by the note-link harvester,
 *  `citationParse`, the source resolver and the reshape scan. */
export const URL_RE = /https?:\/\/[^\s<>"]+/gi;

/**
 * Drop trailing punctuation a URL regex may swallow from surrounding prose —
 * the one spelling of this rule, shared by the note-link harvester,
 * `citationParse` and the reshape scan, so every path sees the same URL in
 * the same note. Slovenian »…« quotes are prose too. A trailing `)` is only
 * prose when the URL doesn't open it: `…/wiki/Ljubljana_(city)` keeps its
 * paren, `(see https://example.com/a)` loses it.
 */
export function stripTrailingPunct(url: string): string {
  let out = url;
  for (;;) {
    if (/[.,;:!?»«"'\]}>]$/.test(out)) {
      out = out.slice(0, -1);
      continue;
    }
    if (out.endsWith(")") && (out.match(/\(/g)?.length ?? 0) < (out.match(/\)/g)?.length ?? 0)) {
      out = out.slice(0, -1);
      continue;
    }
    break;
  }
  return out;
}

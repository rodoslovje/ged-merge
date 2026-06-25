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

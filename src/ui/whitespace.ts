/**
 * Reveal otherwise-invisible leading/trailing whitespace by replacing each edge
 * whitespace character with a visible middot. Inner spaces are left alone (they
 * read fine), so a genuine reformat stays clean while a whitespace-only change —
 * e.g. a source line like `2 DATE    JUL 1900` parsed to `"   JUL 1900"` and
 * tidied to `"JUL 1900"` — becomes legible as `···JUL 1900 → JUL 1900` in the
 * normalization change previews instead of looking like an unchanged value.
 */
export function revealEdgeWhitespace(s: string): string {
  return s.replace(/^\s+|\s+$/g, (run) => "·".repeat(run.length));
}

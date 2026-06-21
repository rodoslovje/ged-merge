/**
 * Parse the text pasted into the "Add Source" dialog: either a bare URL, or
 * a full bibliographic citation that embeds one (e.g. a Chicago-footnote-ish
 * "Author, »Title«, Periodical (Place: Publisher, Year), retrieved date,
 * URL." citation, as Slovenian archives/institutes commonly format them).
 * Heuristic and best-effort — the dialog always shows the result in editable
 * fields before anything is saved, and nothing parsed is silently dropped:
 * whatever isn't claimed by a field ends up in `note`.
 */

export interface ParsedCitation {
  url?: string;
  title?: string;
  author?: string;
  periodical?: string;
  publisher?: string;
  note?: string;
}

const URL_RE = /https?:\/\/[^\s<>"]+/gi;

/** Drop trailing punctuation a URL regex may swallow from surrounding prose. */
function stripTrailingPunct(url: string): string {
  return url.replace(/[.,;:)\]}>"']+$/, "");
}

/** A quoted title: Slovenian/German-style »…«, curly “…”, straight "…", or '…'. */
const QUOTE_RE = /»([^»«]+)«|“([^“”]+)”|"([^"]+)"|'([^']+)'/;

/** The first parenthesized group, e.g. "(Ljubljana: Inštitut …, 2026)". */
const PAREN_RE = /\(([^()]+)\)/;

/** Pull the last URL out of `text`, returning it (trimmed of trailing punctuation) and the remaining text. */
export function extractUrl(text: string): { url?: string; rest: string } {
  const matches = [...text.matchAll(URL_RE)];
  if (matches.length === 0) return { rest: text.trim() };
  const last = matches[matches.length - 1];
  const start = last.index!;
  const url = stripTrailingPunct(last[0]);
  const rest = (text.slice(0, start) + text.slice(start + last[0].length)).trim();
  return { url, rest };
}

/** Parse pasted text into citation fields — see module doc for the heuristic. */
export function parseSourceInput(text: string): ParsedCitation {
  const { url, rest } = extractUrl(text);
  if (!rest) return url ? { url } : {};

  const quote = QUOTE_RE.exec(rest);
  const title = quote ? (quote[1] ?? quote[2] ?? quote[3] ?? quote[4])?.trim() : undefined;
  const paren = PAREN_RE.exec(rest);
  const publisher = paren ? paren[1].trim() : undefined;

  let author: string | undefined;
  let periodical: string | undefined;
  if (quote) {
    const beforeQuote = rest.slice(0, quote.index);
    const commaIdx = beforeQuote.indexOf(",");
    if (commaIdx !== -1 && commaIdx < 60) author = beforeQuote.slice(0, commaIdx).trim() || undefined;

    const afterQuote = quote.index + quote[0].length;
    if (paren && paren.index! > afterQuote) {
      periodical = rest.slice(afterQuote, paren.index).replace(/^[,\s]+/, "").trim() || undefined;
    }
  }

  // Whatever text isn't claimed by author/title/periodical/publisher isn't
  // dropped — it becomes a NOTE so no part of a pasted citation is lost.
  let remainder = rest;
  if (quote) remainder = remainder.replace(quote[0], "");
  if (paren) remainder = remainder.replace(paren[0], "");
  if (author) remainder = remainder.replace(author, "");
  if (periodical) remainder = remainder.replace(periodical, "");
  const note = remainder.split(",").map((s) => s.trim()).filter(Boolean).join(", ") || undefined;

  return { url, title, author, periodical, publisher, note };
}

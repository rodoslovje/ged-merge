/** How a spreadsheet of the reader's language expects its CSV: a language
 *  writing decimals with a comma (Slovenian) separates cells with a semicolon. */
export interface CsvStyle {
  separator: "," | ";";
}

/** A text that a spreadsheet would run as a formula — a cause of death or a
 *  place a file wrote as `=…`, `+…`, `-…` or `@…`. A plain number is no formula. */
const FORMULA = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[-+]?\d+([.,]\d+)?$/;

/** One CSV cell: a value with the separator, a quote or a line break is
 *  quoted, its quotes doubled; a text that reads as a formula is kept a text. */
function cell(value: string | number, style: CsvStyle): string {
  if (typeof value === "number") return style.separator === ";" ? String(value).replace(".", ",") : String(value);
  const s = FORMULA.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
  return s.includes(style.separator) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows as CSV text, CRLF-separated, behind a byte-order mark so a spreadsheet
 * reads č, š and ž as the letters they are rather than as UTF-8 debris.
 */
export function toCsv(rows: (string | number)[][], style: CsvStyle = { separator: "," }): string {
  return "﻿" + rows.map((row) => row.map((v) => cell(v, style)).join(style.separator)).join("\r\n") + "\r\n";
}

/** The CSV style for a UI language: the decimal comma's languages take `;`. */
export function csvStyleFor(language: string): CsvStyle {
  return { separator: (1.5).toLocaleString(language).includes(",") ? ";" : "," };
}

/** A share as a number of percent to one decimal, for a spreadsheet to compute with. */
export function percentOf(n: number, of: number): number | "" {
  return of ? Math.round((1000 * n) / of) / 10 : "";
}

/** One CSV cell: a value with a comma, a quote or a line break is quoted, its quotes doubled. */
function cell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Rows as CSV text, CRLF-separated, behind a byte-order mark so a spreadsheet
 * reads č, š and ž as the letters they are rather than as UTF-8 debris.
 */
export function toCsv(rows: (string | number)[][]): string {
  return "﻿" + rows.map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

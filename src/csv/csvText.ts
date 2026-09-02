/**
 * Reading CSV text, shared by every CSV import.
 *
 * The delimiter is the file's own, not a constant: the genealogical-index
 * exports are comma-separated, while a spreadsheet saved as CSV on a Slovenian
 * (or German, or French) machine separates with a semicolon — Excel follows the
 * locale's list separator, and the parish-index workbooks are all edited that
 * way. Guessing per file is what lets both arrive without asking the reader
 * which kind they have.
 */

/** The separators we recognise, in the order a tie is broken. */
const DELIMITERS = [",", ";", "\t"] as const;

/**
 * The separator a CSV uses, read off its header line — the one line every
 * export fills, and the one whose cells are plain labels rather than free text.
 * Counting stops at the first row break outside quotes so a semicolon inside a
 * later note cell has no vote. Falls back to a comma when nothing separates.
 */
export function detectDelimiter(text: string): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === "\n" || c === "\r") break;
    else if (counts.has(c)) counts.set(c, counts.get(c)! + 1);
  }
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMITERS) {
    const n = counts.get(d)!;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

/**
 * Parse RFC4180-ish CSV text (quoted fields, embedded separators/newlines/
 * quotes). The separator defaults to {@link detectDelimiter}'s reading of the
 * file's own header line.
 */
export function parseCsvText(text: string, delimiter?: string): string[][] {
  // Strip a leading UTF-8 BOM.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const sep = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  // Final field/row (files without a trailing newline).
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

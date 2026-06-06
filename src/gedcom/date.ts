import type { DateQualifier, GedDate } from "./types";

const MONTHS: Record<string, number> = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

interface SimpleDate {
  year?: number;
  month?: number;
  day?: number;
}

/**
 * Qualifier keyword variants. Genealogy software and hand entry use many
 * spellings/abbreviations for the same modifier ("ABT", "Abt.", "About",
 * "Circa"), so each group is matched case-insensitively with an optional
 * trailing period.
 */
const ABOUT = "ABT|ABOUT|CIRCA|CIR|CA|EST|ESTIMATED|CAL|CALCULATED";
const BEFORE = "BEF|BEFORE";
const AFTER = "AFT|AFTER";
const BETWEEN = "BET|BETWEEN";
const INTERPRETED = "INT|INTERPRETED";
const AND = "AND|&";

const kw = (alts: string) => `(?:${alts})\\.?`;

/** Parse a `DATE` value into a structured `GedDate`, preserving the raw text. */
export function parseDate(raw: string): GedDate {
  const upper = raw.trim().toUpperCase();

  // Range / period forms (two endpoints).
  let m = upper.match(new RegExp(`^${kw(BETWEEN)}\\s+(.+?)\\s+(?:${AND})\\s+(.+)$`));
  if (m) return withSecond("between", m[1], m[2], raw);

  m = upper.match(/^FROM\s+(.+?)\s+TO\s+(.+)$/);
  if (m) return withSecond("range", m[1], m[2], raw);

  m = upper.match(/^FROM\s+(.+)$/);
  if (m) return withFirst("from", m[1], raw);

  m = upper.match(/^TO\s+(.+)$/);
  if (m) return withFirst("to", m[1], raw);

  // Single-endpoint qualifiers. "~" (with or without a space) also means about.
  m = upper.match(/^~\s*(.+)$/);
  if (m) return withFirst("about", m[1], raw);

  m = upper.match(new RegExp(`^${kw(ABOUT)}\\s+(.+)$`));
  if (m) return withFirst("about", m[1], raw);

  m = upper.match(new RegExp(`^${kw(BEFORE)}\\s+(.+)$`));
  if (m) return withFirst("before", m[1], raw);

  m = upper.match(new RegExp(`^${kw(AFTER)}\\s+(.+)$`));
  if (m) return withFirst("after", m[1], raw);

  m = upper.match(new RegExp(`^${kw(INTERPRETED)}\\s+(.+?)(?:\\s+\\(.*\\))?$`));
  if (m) return withFirst("interpreted", m[1], raw);

  const simple = parseSimple(upper);
  if (simple) return { raw, qualifier: "exact", ...simple };

  return { raw, qualifier: "unknown" };
}

function withFirst(qualifier: DateQualifier, part: string, raw: string): GedDate {
  return { raw, qualifier, ...(parseSimple(part.toUpperCase()) ?? {}) };
}

function withSecond(qualifier: DateQualifier, a: string, b: string, raw: string): GedDate {
  const first = parseSimple(a.toUpperCase()) ?? {};
  const second = parseSimple(b.toUpperCase()) ?? {};
  return {
    raw,
    qualifier,
    year: first.year,
    month: first.month,
    day: first.day,
    year2: second.year,
    month2: second.month,
    day2: second.day,
  };
}

/** Parse `[[DD] MON] YYYY` (already upper-cased). */
function parseSimple(s: string): SimpleDate | undefined {
  const t = s.trim();
  // DD MON YYYY
  let m = t.match(/^(\d{1,2})\s+([A-Z]{3,})\s+(\d{3,4})$/);
  if (m && MONTHS[m[2]]) return { day: +m[1], month: MONTHS[m[2]], year: +m[3] };
  // MON YYYY
  m = t.match(/^([A-Z]{3,})\s+(\d{3,4})$/);
  if (m && MONTHS[m[1]]) return { month: MONTHS[m[1]], year: +m[2] };
  // YYYY
  m = t.match(/^(\d{3,4})$/);
  if (m) return { year: +m[1] };
  return undefined;
}

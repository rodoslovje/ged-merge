import type { DateOrder, DateQualifier, GedDate } from "./types";

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
const ABOUT = "ABT|ABOUT|CIRCA|CCA|CIR|CA|EST|ESTIMATED|CAL|CALCULATED";
const BEFORE = "BEF|BEFORE";
const AFTER = "AFT|AFTER";
const BETWEEN = "BET|BETWEEN";
const INTERPRETED = "INT|INTERPRETED";
const AND = "AND|&";

const kw = (alts: string) => `(?:${alts})\\.?`;

/**
 * Parse a `DATE` value into a structured `GedDate`, preserving the raw text.
 *
 * `order` disambiguates numeric dates (e.g. is `05/06/1989` D/M or M/D?). When
 * omitted, numeric dates are resolved heuristically: a component > 12 pins the
 * day, and otherwise we fall back by separator ("/" → MDY, else DMY).
 */
export function parseDate(raw: string, order?: DateOrder): GedDate {
  const upper = raw.trim().toUpperCase();

  // Range / period forms (two endpoints).
  let m = upper.match(new RegExp(`^${kw(BETWEEN)}\\s+(.+?)\\s+(?:${AND})\\s+(.+)$`));
  if (m) return withSecond("between", m[1], m[2], raw, order);

  m = upper.match(/^FROM\s+(.+?)\s+TO\s+(.+)$/);
  if (m) return withSecond("range", m[1], m[2], raw, order);

  m = upper.match(/^FROM\s+(.+)$/);
  if (m) return withFirst("from", m[1], raw, order);

  m = upper.match(/^TO\s+(.+)$/);
  if (m) return withFirst("to", m[1], raw, order);

  // Single-endpoint qualifiers. "~" (with or without a space) also means about.
  m = upper.match(/^~\s*(.+)$/);
  if (m) return withFirst("about", m[1], raw, order);

  m = upper.match(new RegExp(`^${kw(ABOUT)}\\s+(.+)$`));
  if (m) return withFirst("about", m[1], raw, order);

  m = upper.match(new RegExp(`^${kw(BEFORE)}\\s+(.+)$`));
  if (m) return withFirst("before", m[1], raw, order);

  m = upper.match(new RegExp(`^${kw(AFTER)}\\s+(.+)$`));
  if (m) return withFirst("after", m[1], raw, order);

  m = upper.match(new RegExp(`^${kw(INTERPRETED)}\\s+(.+?)(?:\\s+\\(.*\\))?$`));
  if (m) return withFirst("interpreted", m[1], raw, order);

  const simple = parseSimple(upper, order);
  if (simple) return { raw, qualifier: "exact", ...simple };

  return { raw, qualifier: "unknown" };
}

function withFirst(
  qualifier: DateQualifier,
  part: string,
  raw: string,
  order?: DateOrder,
): GedDate {
  return { raw, qualifier, ...(parseSimple(part.toUpperCase(), order) ?? {}) };
}

function withSecond(
  qualifier: DateQualifier,
  a: string,
  b: string,
  raw: string,
  order?: DateOrder,
): GedDate {
  const first = parseSimple(a.toUpperCase(), order) ?? {};
  const second = parseSimple(b.toUpperCase(), order) ?? {};
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

/** Parse `[[DD] MON] YYYY` (month word) or a numeric date (already upper-cased). */
function parseSimple(s: string, order?: DateOrder): SimpleDate | undefined {
  const t = s.trim();
  // DD MON YYYY (a month word makes a 2-digit year unambiguous, e.g. "5 JAN 89").
  let m = t.match(/^(\d{1,2})\s+([A-Z]{3,})\s+(\d{2,4})$/);
  if (m && MONTHS[m[2]]) return { day: +m[1], month: MONTHS[m[2]], year: toYear(m[3]) };
  // MON YYYY
  m = t.match(/^([A-Z]{3,})\s+(\d{2,4})$/);
  if (m && MONTHS[m[1]]) return { month: MONTHS[m[1]], year: toYear(m[2]) };
  // Numeric, three components: DD.MM.YYYY / MM/DD/YYYY / YYYY-MM-DD, etc.
  m = t.match(/^(\d{1,4})([./-])(\d{1,4})\2(\d{1,4})$/);
  if (m) {
    const triple = parseNumericTriple(m[1], m[3], m[4], m[2], order);
    if (triple) return triple;
  }
  // Numeric month + year: MM.YYYY (the lone non-year field is the month).
  m = t.match(/^(\d{1,2})[./-](\d{3,4})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return { month: +m[1], year: +m[2] };
  // YYYY
  m = t.match(/^(\d{3,4})$/);
  if (m) return { year: +m[1] };
  return undefined;
}

/** A 3+ digit run, or any value too large to be a day, is taken to be a year. */
function isYearField(g: string): boolean {
  return g.length >= 3 || +g > 31;
}

/** Numeric value of a year field, expanding 2-digit years to four digits. */
function toYear(g: string): number {
  const n = +g;
  return g.length <= 2 ? expandTwoDigitYear(n) : n;
}

/**
 * Expand a 2-digit year using a sliding window pivoted on the current year:
 * values at or below the current two-digit year are this century, the rest are
 * the previous one (so "89" → 1989, "05" → 2005). For numeric dates only values
 * 32–99 ever reach here — smaller numbers are read as a day or month — so those
 * resolve unambiguously into the 1900s.
 */
function expandTwoDigitYear(yy: number): number {
  const pivot = new Date().getFullYear() % 100;
  return yy <= pivot ? 2000 + yy : 1900 + yy;
}

/**
 * Resolve three numeric date components into day/month/year. Year position is
 * found first (4-digit run or a value > 31); the remaining two are assigned by
 * `order` or, lacking that, heuristically.
 */
function parseNumericTriple(
  g1: string,
  g2: string,
  g3: string,
  sep: string,
  order?: DateOrder,
): SimpleDate | undefined {
  if (isYearField(g1)) return resolveDayMonth(+g2, +g3, toYear(g1), sep, order, true);
  if (isYearField(g3)) return resolveDayMonth(+g1, +g2, toYear(g3), sep, order, false);
  return undefined; // No identifiable year — leave the value untouched.
}

function resolveDayMonth(
  a: number,
  b: number,
  year: number,
  sep: string,
  order: DateOrder | undefined,
  yearFirst: boolean,
): SimpleDate | undefined {
  // a/b are the two non-year fields in textual order. Decide which is the day.
  let dayFirst: boolean;
  if (yearFirst) {
    dayFirst = false; // year-first is YMD (month before day).
  } else if (order === "DMY") {
    dayFirst = true;
  } else if (order === "MDY") {
    dayFirst = false;
  } else if (a > 12) {
    dayFirst = true; // a can't be a month.
  } else if (b > 12) {
    dayFirst = false; // b can't be a month.
  } else {
    dayFirst = sep !== "/"; // ambiguous: "/" → US MDY, "." / "-" → DMY.
  }

  const day = dayFirst ? a : b;
  const month = dayFirst ? b : a;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { day, month, year };
}

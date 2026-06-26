import type { DateOrder, DateQualifier, GedDate } from "./types";

/**
 * Month name → number. Covers English (GEDCOM standard) plus the Slovenian and
 * German forms that appear in real Central-European exports — nominative,
 * genitive ("marca", "maja"), and common abbreviations ("avg", "okt").
 */
const MONTHS: Record<string, number> = {
  // English
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, JUNE: 6, JULY: 7,
  AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
  // Slovenian (nominative)
  JANUAR: 1, FEBRUAR: 2, MAREC: 3, MAJ: 5, JUNIJ: 6, JULIJ: 7,
  AVGUST: 8, OKTOBER: 10, AVG: 8, OKT: 10, SEPT: 9,
  // Slovenian (genitive, "21. marca 2011")
  JANUARJA: 1, FEBRUARJA: 2, MARCA: 3, APRILA: 4, MAJA: 5, JUNIJA: 6,
  JULIJA: 7, AVGUSTA: 8, SEPTEMBRA: 9, OKTOBRA: 10, NOVEMBRA: 11, DECEMBRA: 12,
  // German
  MÄRZ: 3, MAERZ: 3, MRZ: 3, MAI: 5, JUNI: 6, JULI: 7, DEZEMBER: 12, DEZ: 12,
};

/** Month-word token: a run of non-digit, non-separator characters (≥3). */
const MON = "[^\\d\\s.,/]{3,}";

interface SimpleDate {
  year?: number;
  month?: number;
  day?: number;
}

/**
 * Qualifier keyword variants. Genealogy software and hand entry use many
 * spellings/abbreviations for the same modifier ("ABT", "Abt.", "About",
 * "Circa", Slovenian "okoli"/"približno"), so each group is matched
 * case-insensitively with an optional trailing period.
 */
const ABOUT = "ABT|ABOUT|CIRCA|CCA|CIR|CA|EST|ESTIMATED|CAL|CALCULATED|OKOLI|OKO|PRIBLIŽNO|PRIBL";
const BEFORE = "BEF|BEFORE|PRED";
const AFTER = "AFT|AFTER|PO";
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
  const trimmed = raw.trim();

  // A whole date wrapped in parentheses, e.g. "(ABT 1810)", "(okt 7 2019)".
  const wrapped = trimmed.match(/^\((.+)\)$/);
  if (wrapped) return { ...parseDate(wrapped[1], order), raw };

  const upper = trimmed.toUpperCase();

  // Range / period forms (two endpoints).
  let m = upper.match(new RegExp(`^${kw(BETWEEN)}\\s+(.+?)\\s+(?:${AND})\\s+(.+)$`));
  if (m) return withSecond("between", m[1], m[2], raw, order);

  m = upper.match(/^FROM\s+(.+?)\s+TO\s+(.+)$/);
  if (m) return withSecond("range", m[1], m[2], raw, order);

  m = upper.match(/^FROM\s+(.+)$/);
  if (m) return withFirst("from", m[1], raw, order);

  m = upper.match(/^TO\s+(.+)$/);
  if (m) return withFirst("to", m[1], raw, order);

  // Single-endpoint qualifiers. "~" means about; "<"/">" mean before/after.
  m = upper.match(/^~\s*(.+)$/);
  if (m) return withFirst("about", m[1], raw, order);

  m = upper.match(/^<\s*(.+)$/);
  if (m) return withFirst("before", m[1], raw, order);

  m = upper.match(/^>\s*(.+)$/);
  if (m) return withFirst("after", m[1], raw, order);

  m = upper.match(new RegExp(`^${kw(ABOUT)}\\s+(.+)$`));
  if (m) return withFirst("about", m[1], raw, order);

  m = upper.match(new RegExp(`^${kw(BEFORE)}\\s+(.+)$`));
  if (m) return withFirst("before", m[1], raw, order);

  m = upper.match(new RegExp(`^${kw(AFTER)}\\s+(.+)$`));
  if (m) return withFirst("after", m[1], raw, order);

  m = upper.match(new RegExp(`^${kw(INTERPRETED)}\\s+(.+?)(?:\\s+\\(.*\\))?$`));
  if (m) return withFirst("interpreted", m[1], raw, order);

  // Year–year range/period: "1790-1803", "1770/1785".
  m = upper.match(/^(\d{3,4})\s*[-/]\s*(\d{3,4})$/);
  if (m) return { raw, qualifier: "between", year: +m[1], year2: +m[2] };

  const simple = parseSimple(upper, order);
  if (simple) return { raw, qualifier: "exact", ...simple };

  // A structured but entirely-unknown numeric date (".__.____", "__.__.____"):
  // no usable component, yet a deliberate placeholder, not garbage. Flag it so
  // reshaping can re-render it in the master's placeholder layout.
  if (isAllPlaceholderDate(upper)) return { raw, qualifier: "unknown", placeholder: true };

  return { raw, qualifier: "unknown" };
}

/**
 * True for a `.`/`/`-separated value whose every field is empty or a pure
 * placeholder run (`_`, `?`, `<>`, `-`, …) — i.e. a deliberate all-unknown date.
 * A field carrying any digit (e.g. the "19__" in ".__.19__") disqualifies it:
 * that's a partly-known value we'd rather leave as raw than treat as unknown.
 * A lone token ("____") is also excluded — it lacks the separators that mark it
 * out as a date rather than stray text.
 */
function isAllPlaceholderDate(s: string): boolean {
  const toks = s.split(/[./]/);
  if (toks.length < 2 || toks.length > 3) return false;
  let sawPlaceholder = false;
  for (const tok of toks) {
    const t = tok.trim();
    if (t === "") continue;
    if (/^[_?<>–—o-]+$/i.test(t)) sawPlaceholder = true;
    else return false;
  }
  return sawPlaceholder;
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

const mon = (tok: string): number | undefined => MONTHS[tok.toUpperCase()];

/** Parse a single date atom (already upper-cased): month-word or numeric. */
function parseSimple(s: string, order?: DateOrder): SimpleDate | undefined {
  const t = s.trim();
  let m: RegExpMatchArray | null;

  // [DD|placeholder] MON YYYY[/YY] — "5 JAN 1885", "21. marca 2011", "_.maj 2019"
  m = t.match(new RegExp(`^([\\d_?<>-]{1,2})[.\\s]\\s*(${MON})\\.?\\s+(\\d{2,4})(?:/\\d{1,4})?$`));
  if (m && mon(m[2])) {
    const day = /^\d{1,2}$/.test(m[1]) ? +m[1] : undefined;
    return { day, month: mon(m[2]), year: toYear(m[3]) };
  }
  // MON DD YYYY (month-first) — "AVG 31 1897", "okt 7 2019"
  m = t.match(new RegExp(`^(${MON})\\.?\\s+(\\d{1,2})\\s+(\\d{2,4})$`));
  if (m && mon(m[1])) return { day: +m[2], month: mon(m[1]), year: toYear(m[3]) };
  // DD-MON-YYYY (hyphenated) — "10-JUL-2016"
  m = t.match(new RegExp(`^(\\d{1,2})-(${MON})-(\\d{2,4})$`));
  if (m && mon(m[2])) return { day: +m[1], month: mon(m[2]), year: toYear(m[3]) };
  // MON YYYY[/YY]
  m = t.match(new RegExp(`^(${MON})\\.?\\s+(\\d{2,4})(?:/\\d{1,4})?$`));
  if (m && mon(m[1])) return { month: mon(m[1]), year: toYear(m[2]) };
  // Numeric, three components: DD.MM.YYYY / MM/DD/YYYY / YYYY-MM-DD, etc.
  m = t.match(/^(\d{1,4})([./-])(\d{1,4})\2(\d{1,4})$/);
  if (m) {
    const triple = parseNumericTriple(m[1], m[3], m[4], m[2], order);
    if (triple) return triple;
  }
  // Numeric month + year: MM.YYYY (the lone non-year field is the month).
  m = t.match(/^(\d{1,2})[./-](\d{3,4})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12) return { month: +m[1], year: +m[2] };
  // YYYY[/YY] (incl. old/new-style dual dating "1850/83").
  m = t.match(/^(\d{3,4})(?:\/\d{1,4})?$/);
  if (m) return { year: +m[1] };
  // Numeric with unknown (placeholder) components, e.g. ".__.1945", "_.9.1911".
  return parsePartialNumeric(t, order);
}

/**
 * Parse a `.`/`/`-separated numeric date where some components are placeholders
 * for unknown values ("_", "__", "?", "<>", "-"). Keeps the known components
 * (most importantly the year); unknown ones are left undefined.
 */
function parsePartialNumeric(s: string, order?: DateOrder): SimpleDate | undefined {
  const toks = s.split(/[./]/);
  if (toks.length < 2 || toks.length > 3) return undefined;

  const parsed = toks.map(parsePartialComponent);
  if (parsed.some((c) => c === null)) return undefined; // an uninterpretable token
  const comps = parsed as (number | undefined)[];
  // Only handle values that actually carry a placeholder (normal numeric dates
  // are parsed above); this avoids hijacking odd-but-complete inputs.
  if (!toks.some((tok) => tok.trim() === "" || /[_?<>-]/.test(tok) || /\d[_?o]/i.test(tok)))
    return undefined;

  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;
  if (toks.length === 3) {
    const ord = order ?? "DMY";
    const pos = ord === "YMD" ? [2, 1, 0] : ord === "MDY" ? [1, 0, 2] : [0, 1, 2]; // [dayIdx, monthIdx, yearIdx]
    day = comps[pos[0]];
    month = comps[pos[1]];
    year = comps[pos[2]];
  } else {
    const [a, b] = comps;
    if (b !== undefined && b > 31) {
      month = a;
      year = b;
    } else if (a !== undefined && a > 31) {
      year = a;
    } else return undefined;
  }

  if (year !== undefined && (year < 100 || year > 2200)) return undefined;
  if (month !== undefined && (month < 1 || month > 12)) return undefined;
  if (day !== undefined && (day < 1 || day > 31)) return undefined;
  if (year === undefined && month === undefined) return undefined; // nothing useful

  const out: SimpleDate = {};
  if (day !== undefined) out.day = day;
  if (month !== undefined) out.month = month;
  if (year !== undefined) out.year = year;
  return out;
}

/** A numeric value, `undefined` for a placeholder/unknown, `null` if unusable. */
function parsePartialComponent(tok: string): number | undefined | null {
  const t = tok.trim();
  if (t === "") return undefined;
  if (/^\d+$/.test(t)) return +t;
  if (/^[_?<>–—o\s-]+$/i.test(t)) return undefined; // pure placeholder
  if (/^\d+[_?o]+$/i.test(t) || /^[_?]+\d+$/.test(t)) return undefined; // partial digits "19__","1___"
  return null;
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

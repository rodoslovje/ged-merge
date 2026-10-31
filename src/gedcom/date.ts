import type { DateOrder, DateQualifier, GedCalendar, GedDate } from "./types";

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
  impossible?: boolean;
  shortYear?: boolean;
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Mark a date whose day its month does not have — see `GedDate.impossible`. */
function checkDay(d: SimpleDate): SimpleDate {
  if (d.day === undefined || d.month === undefined) return d;
  const leap = d.year === undefined || d.year % 4 === 0;
  const last = d.month === 2 && leap ? 29 : MONTH_DAYS[d.month - 1];
  return d.day >= 1 && d.day <= last ? d : { ...d, impossible: true };
}

/**
 * Qualifier keyword variants. Genealogy software and hand entry use many
 * spellings/abbreviations for the same modifier ("ABT", "Abt.", "About",
 * "Circa", Slovenian "okoli"/"približno", German "um"), so each group is
 * matched case-insensitively with an optional trailing period. The Slovenian
 * and German words are what a user types into a date field; writing the date
 * re-renders them as the standard keyword (see `normalize/date.ts`).
 */
const ABOUT = "ABT|ABOUT|CIRCA|CCA|CIR|CA|EST|ESTIMATED|CAL|CALCULATED|OKOLI|OKROG|OKO|PRIBLIŽNO|PRIBL|UM";
const BEFORE = "BEF|BEFORE|PRED|VOR";
const AFTER = "AFT|AFTER|PO|NACH";
const BETWEEN = "BET|BETWEEN|MED|ZWISCHEN";
const INTERPRETED = "INT|INTERPRETED";
const AND = "AND|&|IN|UND";
const FROM = "FROM|OD|VON";
const TO = "TO|DO|BIS";

const kw = (alts: string) => `(?:${alts})\\.?`;

/** The `about` keywords GEDCOM keeps apart from `ABT` — see `GedDate.approx`. */
const APPROX_KEYWORDS: Record<string, "CAL" | "EST"> = {
  CAL: "CAL", CALCULATED: "CAL", EST: "EST", ESTIMATED: "EST",
};

// Qualifier-prefix patterns, compiled once. They're built from the constant
// keyword strings above, so they never vary per call — and `parseDate` runs
// once per DATE line (~1M on a large file), where re-compiling these every
// time dominated build time.
const RE_BETWEEN = new RegExp(`^${kw(BETWEEN)}\\s+(.+?)\\s+(?:${AND})\\s+(.+)$`);
const RE_ABOUT = new RegExp(`^(${ABOUT})\\.?\\s+(.+)$`);
const RE_BEFORE = new RegExp(`^${kw(BEFORE)}\\s+(.+)$`);
const RE_AFTER = new RegExp(`^${kw(AFTER)}\\s+(.+)$`);
const RE_INTERPRETED = new RegExp(`^${kw(INTERPRETED)}\\s+(.+?)(?:\\s+\\(.*\\))?$`);
const RE_FROM_TO = new RegExp(`^${kw(FROM)}\\s+(.+?)\\s+${kw(TO)}\\s+(.+)$`);
const RE_FROM = new RegExp(`^${kw(FROM)}\\s+(.+)$`);
const RE_TO = new RegExp(`^${kw(TO)}\\s+(.+)$`);

/**
 * A calendar declaration, in either spelling: 5.5.1's escape `@#DJULIAN@` (and
 * `@#DFRENCH R@`, whose name carries a space) or GEDCOM 7's leading keyword
 * `JULIAN`. Both may sit either at the head of the value or after a qualifier
 * keyword — "ABT @#DJULIAN@ 1700" is as valid as "@#DJULIAN@ ABT 1700" — so
 * both are looked for in either position and the rest is left to the ordinary
 * grammar. The keyword form is a closed set of five words, none of which is a
 * month name or a qualifier, so matching it bare cannot swallow a real date.
 *
 * Neither runs on most values at all — see the shape guards in `parseDate` —
 * and the escape sits behind a substring test on top of that.
 */
const RE_CAL_ESCAPE = /@#D([A-Z_ ]+)@\s*/;
const RE_CAL_KEYWORD = /(?:^|\s)(GREGORIAN|JULIAN|HEBREW|FRENCH_R|ROMAN)\s+/;

/**
 * A date's text for display — the file's own spelling, except that a 5.5.1
 * calendar escape (`@#DJULIAN@ 14 JAN 1700`) is written the way GEDCOM 7
 * spells the same declaration (`JULIAN 14 JAN 1700`): the escape is syntax,
 * not something a report or a tooltip should print. Values without an escape
 * come back untouched, so this is safe on every date.
 *
 * A GEDCOM 7 date's own wording (`PHRASE`) follows the value in brackets, the
 * way 5.5.1 writes an interpreted date (`1850 (Easter Sunday)`), and stands
 * alone when the value is empty.
 */
export function dateText(d: GedDate): string {
  return withPhrase(valueText(d), d.phrase);
}

/** `text`, followed by the date's wording in brackets when it has one. */
export function withPhrase(text: string, phrase: string | undefined): string {
  if (!phrase) return text;
  return text.trim() ? `${text} (${phrase})` : phrase;
}

function valueText(d: GedDate): string {
  if (!d.calendar || !d.raw.includes("@#")) return d.raw;
  const m = d.raw.match(RE_CAL_ESCAPE);
  if (!m) return d.raw;
  const rest = d.raw.replace(RE_CAL_ESCAPE, " ").replace(/\s+/g, " ").trim();
  return rest ? `${d.calendar} ${rest}` : d.raw;
}

/** Calendar names as they appear inside an escape or as a keyword. */
const CALENDARS: Record<string, GedCalendar> = {
  GREGORIAN: "GREGORIAN",
  JULIAN: "JULIAN",
  HEBREW: "HEBREW",
  "FRENCH R": "FRENCH_R",
  FRENCH_R: "FRENCH_R",
  ROMAN: "ROMAN",
  UNKNOWN: "UNKNOWN",
};

/**
 * A "before the common era" suffix closing the value — `BC`, `BCE` (GEDCOM 7's
 * spelling), or their dotted forms. Required to follow whitespace so it can
 * never bite into a month or a word, and written as a bare suffix rather than
 * with a `(.*?)` prefix: a lazy prefix against a `$` anchor re-tries at every
 * offset in the string, which is real cost on a hot path that almost always
 * fails. The caller trims the matched suffix off itself.
 */
const RE_BCE = /\s(?:BCE?|B\.\s?C\.(?:\s?E\.)?)$/;

/** The year as the value literally writes it, for an era that counts backwards:
 *  "44" in "1 JAN 44" means the year 44, never the 1944 the two-digit sliding
 *  window would otherwise make of it. */
const RE_TRAILING_YEAR = /(\d{1,4})\s*$/;

// Month-word date atoms, compiled once from the constant MON token (see above).
const RE_DAY_MON_YEAR = new RegExp(`^([\\d_?<>-]{1,2})[.\\s]\\s*(${MON})\\.?\\s+(\\d{2,4})(?:/\\d{1,4})?$`);
const RE_MON_DAY_YEAR = new RegExp(`^(${MON})\\.?\\s+(\\d{1,2})\\s+(\\d{2,4})$`);
const RE_DAY_MON_YEAR_HYPHEN = new RegExp(`^(\\d{1,2})-(${MON})-(\\d{2,4})$`);
const RE_MON_YEAR = new RegExp(`^(${MON})\\.?\\s+(\\d{2,4})(?:/\\d{1,4})?$`);

/**
 * Parse a `DATE` value into a structured `GedDate`, preserving the raw text.
 *
 * `order` disambiguates numeric dates (e.g. is `05/06/1989` D/M or M/D?). When
 * omitted, numeric dates are resolved heuristically: a component > 12 pins the
 * day, and otherwise we fall back by separator ("/" → MDY, else DMY).
 */
export function parseDate(raw: string, order?: DateOrder): GedDate {
  const trimmed = raw.trim();

  // A whole date wrapped in parentheses, e.g. "(ABT 1810)", "(okt 7 2019)". In
  // GEDCOM that is a date phrase, free text: what it reads as is our reading,
  // so a date in it is never exact — it is interpreted, like `INT … (…)`.
  const wrapped = trimmed.match(/^\((.+)\)$/);
  if (wrapped) {
    const inner = parseDate(wrapped[1], order);
    return { ...inner, raw, qualifier: inner.qualifier === "exact" ? "interpreted" : inner.qualifier };
  }

  const upper = trimmed.toUpperCase();

  // The two declarations below are ruled out by the value's own shape far more
  // cheaply than by the patterns that read them, and `parseDate` runs once per
  // DATE line — ~2M of them on a large file, virtually none declaring anything.
  // Both guards follow from the grammar rather than from what files tend to
  // look like, so neither can miss a real declaration: a calendar leads the
  // date or follows a qualifier, and no qualifier begins with a digit; an era
  // suffix always closes on a letter or a period.
  const first = upper.charCodeAt(0);
  const last = upper.charCodeAt(upper.length - 1);
  const isDigit = (c: number) => c >= 48 && c <= 57;

  // A value that names its own calendar: lift the declaration out and parse
  // what remains by the ordinary grammar.
  if (!isDigit(first)) {
    const cal = extractCalendar(upper);
    if (cal) return withCalendar(cal.calendar, cal.rest, raw, order);
  }

  // A value that counts backwards from year 1 ("44 BCE", "1 JAN 44 B.C.").
  if (!isDigit(last)) {
    const era = upper.match(RE_BCE);
    const bce = era && withBce(upper.slice(0, era.index), raw, order);
    if (bce) return bce;
  }

  // Range / period forms (two endpoints).
  let m = upper.match(RE_BETWEEN);
  if (m) return withSecond("between", m[1], m[2], raw, order);

  m = upper.match(RE_FROM_TO);
  if (m) return withSecond("range", m[1], m[2], raw, order);

  m = upper.match(RE_FROM);
  if (m) return withFirst("from", m[1], raw, order);

  m = upper.match(RE_TO);
  if (m) return withFirst("to", m[1], raw, order);

  // Single-endpoint qualifiers. "~" means about; "<"/">" mean before/after.
  m = upper.match(/^~\s*(.+)$/);
  if (m) return withFirst("about", m[1], raw, order);

  m = upper.match(/^<\s*(.+)$/);
  if (m) return withFirst("before", m[1], raw, order);

  m = upper.match(/^>\s*(.+)$/);
  if (m) return withFirst("after", m[1], raw, order);

  m = upper.match(RE_ABOUT);
  if (m) {
    const date = withFirst("about", m[2], raw, order);
    const approx = APPROX_KEYWORDS[m[1]];
    return approx ? { ...date, approx } : date;
  }

  m = upper.match(RE_BEFORE);
  if (m) return withFirst("before", m[1], raw, order);

  m = upper.match(RE_AFTER);
  if (m) return withFirst("after", m[1], raw, order);

  m = upper.match(RE_INTERPRETED);
  if (m) return withFirst("interpreted", m[1], raw, order);

  // Year–year range/period: "1790-1803", "1770/1785".
  m = upper.match(/^(\d{3,4})\s*[-/]\s*(\d{3,4})$/);
  if (m) return { raw, qualifier: "between", year: +m[1], year2: +m[2] };

  const simple = parseSimple(upper, order);
  if (simple) return { raw, qualifier: "exact", ...simple };

  // A structured but entirely-unknown numeric date (".__.____", "__.__.____"):
  // no usable component, yet a deliberate placeholder, not garbage. Flag it so
  // reshaping can re-render it in the main's placeholder layout.
  if (isAllPlaceholderDate(upper)) return { raw, qualifier: "unknown", placeholder: true };

  return { raw, qualifier: "unknown" };
}

/**
 * Lift a calendar declaration out of an upper-cased date value, returning the
 * calendar it names and the value with the declaration removed. Undefined when
 * the value declares nothing, which is the common case and is why the escape
 * form is guarded by a substring test before its regex runs.
 */
function extractCalendar(upper: string): { calendar: GedCalendar; rest: string } | undefined {
  if (upper.includes("@#")) {
    const m = upper.match(RE_CAL_ESCAPE);
    const named = m && CALENDARS[m[1].trim()];
    // An escape naming something outside the standard's list is not ours to
    // interpret; leave the whole value to the ordinary grammar.
    if (named) return { calendar: named, rest: upper.replace(RE_CAL_ESCAPE, " ").trim() };
    return undefined;
  }
  const m = upper.match(RE_CAL_KEYWORD);
  if (!m) return undefined;
  return { calendar: CALENDARS[m[1]], rest: upper.replace(RE_CAL_KEYWORD, " ").trim() };
}

/**
 * Build the date for a value that named a calendar. Julian and Gregorian keep
 * every component — same month names, same year count — so they behave like any
 * other date downstream. The rest keep only the qualifier: their years belong to
 * another epoch, and lifting 5760 into `year` would put the person three
 * millennia in the future on every chart, in every age and in every sort. An
 * atom we cannot read at all is still an *exact* date under a calendar we don't
 * convert, not garbage, so it does not fall back to "unknown" — that is what
 * keeps the health check from reporting a valid Hebrew date as broken.
 */
function withCalendar(
  calendar: GedCalendar,
  rest: string,
  raw: string,
  order?: DateOrder,
): GedDate {
  const inner = parseDate(rest, order);
  if (calendar === "JULIAN" || calendar === "GREGORIAN") return { ...inner, raw, calendar };
  return { raw, qualifier: inner.qualifier === "unknown" ? "exact" : inner.qualifier, calendar };
}

/**
 * Build the date for a value whose era suffix counts backwards from year 1, or
 * undefined to let the ordinary grammar have it. The year is negated so it
 * orders and subtracts correctly against ordinary years, and is taken from the
 * text rather than from the parsed result: "44" is the year 44, not the 1944
 * that two-digit expansion would produce.
 *
 * Two-endpoint forms are declined ("BET 44 BC AND 30 BC" carries an era on each
 * side, and only the last one is in hand here) — they keep today's behaviour of
 * parsing as a range with no components rather than gaining a wrong one.
 */
function withBce(rest: string, raw: string, order?: DateOrder): GedDate | undefined {
  const inner = parseDate(rest, order);
  if (inner.qualifier === "between" || inner.qualifier === "range") return undefined;
  const written = rest.match(RE_TRAILING_YEAR);
  if (!written) return undefined;

  // What sits in front of the year has to be something we recognise, or the era
  // is just the last two letters of a sentence: "SOMETHING 1900 BC" stays the
  // unparseable value it is today rather than becoming the year -1900. Three
  // shapes qualify — a date whose components parsed ("1 JAN 44"), a qualifier
  // ("BEF 44"), and nothing at all ("44", which the atom grammar declines on
  // its own because two digits alone are far more often a fragment than a year).
  const yearOnly = written[0].trim() === rest.trim();
  if (inner.year === undefined && inner.qualifier === "unknown" && !yearOnly) return undefined;

  return {
    ...inner,
    raw,
    qualifier: inner.qualifier === "unknown" ? "exact" : inner.qualifier,
    year: -Number(written[1]),
    shortYear: undefined, // the year is the one written, not a widened one
  };
}

/**
 * How precise a single, plain date is (no range/placeholder):
 *   0 = nothing known · 1 = year · 2 = year+month · 3 = full date.
 * An `about`-style estimate counts as half a step less precise than the same
 * granularity asserted exactly, so "12 MAR 1949" beats "ABT 12 MAR 1949"; a
 * calculated date sits between the two, so "CAL 1949" beats "ABT 1949".
 */
function datePrecision(d: GedDate): number {
  if (d.year == null) return 0;
  let rank = d.month == null ? 1 : d.day == null ? 2 : 3;
  if (d.qualifier !== "exact") rank -= d.approx === "CAL" ? 0.25 : 0.5;
  return rank;
}

/** A date reckoned from something (an age at death, a stated age) rather
 *  than guessed: CAL beats ABT and EST even in another year. */
function calculatedOverEstimate(m: GedDate, i: GedDate): boolean {
  return m.qualifier === "about" && m.approx !== "CAL" && i.qualifier === "about" && i.approx === "CAL";
}

/** A stated date beats a mere bound it falls within: "27 OCT 1726" replaces
 *  "BEF 1727", "3 MAY 1801" "AFT 1800". One beyond the bound contradicts it
 *  and is left to the reader — so is a bare year against a bound pinned to
 *  the day, which would only lose what the main knows. */
function exactOverBound(m: GedDate, i: GedDate): boolean {
  if ((m.qualifier !== "before" && m.qualifier !== "after") || i.qualifier !== "exact") return false;
  if (m.year == null || i.year == null) return false;
  if (datePrecision(i) < datePrecision({ ...m, qualifier: "exact" })) return false;
  // The bound's own span — "1727" runs from its first day to its last — and
  // the stated date's first day; a date inside the bound's span is allowed,
  // as a "BEF 1727" often means "by 1727".
  const key = (y: number, mo: number, d: number) => y * 10000 + mo * 100 + d;
  const stated = key(i.year, i.month ?? 1, i.day ?? 1);
  return m.qualifier === "before"
    ? stated <= key(m.year, m.month ?? 12, m.day ?? 31)
    : stated >= key(m.year, m.month ?? 1, m.day ?? 1);
}

/**
 * Sort key for a single GedDate that is precision- and qualifier-aware:
 *  - BEF Y  → just before year start (Y*10000 - 1), so it sorts before any Y date
 *  - AFT Y  → after year end (Y*10000 + 9999)
 *  - Full date Y-M-D → Y*10000 + M*100 + D
 *  - Month-only Y-M  → mid-month (M*100 + 50), after same-month full dates
 *  - Year-only Y     → Y*10000 + 9000, after all specific dates in that year
 */
export function dateToSortKey(d: GedDate | undefined): number {
  if (!d || d.year == null) return 9_999_999;
  if (d.qualifier === "before") return d.year * 10000 - 1;
  if (d.qualifier === "after") return d.year * 10000 + 9999;
  // FROM..TO periods (e.g. an occupation held over several years) sort by their
  // end date, so they land next to whatever else was happening when they ended.
  const useEnd = d.qualifier === "range" && d.year2 != null;
  const year = useEnd ? d.year2! : d.year;
  const m = useEnd ? d.month2 : d.month;
  const day = useEnd ? d.day2 : d.day;
  const base = year * 10000;
  if (!m) return base + 9000;            // year-only → after any known date in year
  if (!day) return base + m * 100 + 50;  // month-only → mid-month
  return base + m * 100 + day;
}

/**
 * True when `incoming` is a strictly more precise version of `main` that
 * doesn't contradict it — e.g. main "1949" refined by incoming "12 MAR 1949".
 * Both must be single (non-range) dates sharing the same year, and every
 * component the main already pins (month, day) must agree. Used so a merge
 * defaults to the incoming side when it carries the more exact date. Two
 * exceptions to the shared year: a calculated date always replaces an
 * estimated one (ABT/EST), being reckoned rather than guessed, and an exact
 * date always replaces a BEF/AFT bound.
 */
export function dateRefines(mainRaw: string, incomingRaw: string, order?: DateOrder): boolean {
  const m = parseDate(mainRaw, order);
  const i = parseDate(incomingRaw, order);
  if (m.year == null || i.year == null) return false;
  // Ranges/periods aren't a simple precision ladder — leave them to the default.
  if (m.year2 != null || i.year2 != null) return false;
  if (calculatedOverEstimate(m, i) || exactOverBound(m, i)) return true;
  if (m.year !== i.year) return false;
  if (m.month != null && m.month !== i.month) return false;
  if (m.day != null && m.day !== i.day) return false;
  return datePrecision(i) > datePrecision(m);
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
    ...(first.impossible || second.impossible ? { impossible: true } : {}),
    ...(first.shortYear || second.shortYear ? { shortYear: true } : {}),
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
  const d = parseAtom(s, order);
  if (!d) return undefined;
  // A year the atom does not spell out was widened from two digits ("5.3.05"
  // → 2005) — see `GedDate.shortYear`.
  const short = d.year !== undefined && !s.includes(String(d.year));
  return checkDay(short ? { ...d, shortYear: true } : d);
}

function parseAtom(s: string, order?: DateOrder): SimpleDate | undefined {
  const t = s.trim();
  let m: RegExpMatchArray | null;

  // [DD|placeholder] MON YYYY[/YY] — "5 JAN 1885", "21. marca 2011", "_.maj 2019"
  m = t.match(RE_DAY_MON_YEAR);
  if (m && mon(m[2])) {
    const day = /^\d{1,2}$/.test(m[1]) ? +m[1] : undefined;
    return { day, month: mon(m[2]), year: toYear(m[3]) };
  }
  // MON DD YYYY (month-first) — "AVG 31 1897", "okt 7 2019"
  m = t.match(RE_MON_DAY_YEAR);
  if (m && mon(m[1])) return { day: +m[2], month: mon(m[1]), year: toYear(m[3]) };
  // DD-MON-YYYY (hyphenated) — "10-JUL-2016"
  m = t.match(RE_DAY_MON_YEAR_HYPHEN);
  if (m && mon(m[2])) return { day: +m[1], month: mon(m[2]), year: toYear(m[3]) };
  // MON YYYY[/YY]
  m = t.match(RE_MON_YEAR);
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
  // A number over 12 can only be the day, whatever order the file prefers: the
  // order settles the ambiguous dates, it does not make the plain ones unreadable.
  if (yearFirst) {
    dayFirst = false; // year-first is YMD (month before day).
  } else if (a > 12 && b <= 12) {
    dayFirst = true; // a can't be a month.
  } else if (b > 12 && a <= 12) {
    dayFirst = false; // b can't be a month.
  } else if (order === "DMY") {
    dayFirst = true;
  } else if (order === "MDY") {
    dayFirst = false;
  } else {
    dayFirst = sep !== "/"; // ambiguous: "/" → US MDY, "." / "-" → DMY.
  }

  const day = dayFirst ? a : b;
  const month = dayFirst ? b : a;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return { day, month, year };
}

import type { GedcomVersion } from "./types";

/**
 * The age a record *states* at an event — GEDCOM's `AGE` line, under an
 * individual event (`2 AGE 25y`) or under a family event's spouse
 * (`2 HUSB` / `3 AGE 32y`). Distinct from `age.ts`, which computes an age from
 * two dates: this one is evidence in its own right, often the only clue a
 * death register gives to when the person was born.
 *
 * The two dialects share the core grammar and differ at the edges:
 *  - 5.5.1 (`AGE_AT_EVENT`): an optional `<`/`>` bound, then `YYy MMm DDDd`
 *    (any subset, in that order) or one of the keywords `CHILD` (under 8),
 *    `INFANT` (under 1) and `STILLBORN`.
 *  - 7.0 (`Age`): the bound is followed by a space, weeks join the units
 *    (`nny nnm nnw nnd`), and the keywords are gone — what they said is a
 *    bound (`< 8y`) plus a free-text `PHRASE` beneath the AGE line.
 *
 * The reader is lenient in what files actually write: units in either case,
 * no space or several between the parts, a bare number taken as years.
 */

export type AgeKeyword = "CHILD" | "INFANT" | "STILLBORN";

/** A parsed AGE value. Every unit is optional; a keyword stands alone. */
export interface AgeValue {
  /** `<` the person was younger than this, `>` older. */
  bound?: "<" | ">";
  years?: number;
  months?: number;
  weeks?: number;
  days?: number;
  keyword?: AgeKeyword;
}

/** Ages beyond this are data errors, not people (as `age.ts` holds too). */
const MAX_AGE_YEARS = 125;

const KEYWORDS: readonly AgeKeyword[] = ["CHILD", "INFANT", "STILLBORN"];

/** What each 5.5.1 keyword means, as a 7.0 value — the bound it stands for. */
const KEYWORD_AS_BOUND: Record<AgeKeyword, AgeValue> = {
  CHILD: { bound: "<", years: 8 },
  INFANT: { bound: "<", years: 1 },
  STILLBORN: { years: 0 },
};

const UNIT_ORDER = ["y", "m", "w", "d"] as const;
type Unit = (typeof UNIT_ORDER)[number];
const UNIT_FIELD: Record<Unit, "years" | "months" | "weeks" | "days"> = {
  y: "years",
  m: "months",
  w: "weeks",
  d: "days",
};

/**
 * Read an AGE value, or undefined when the text is not one (empty, or words
 * the grammar has no place for — "about thirty"). Units must come in the
 * grammar's order and each at most once.
 */
export function parseAge(text: string | undefined): AgeValue | undefined {
  let s = text?.trim();
  if (!s) return undefined;
  const upper = s.toUpperCase();
  if ((KEYWORDS as readonly string[]).includes(upper)) return { keyword: upper as AgeKeyword };
  const out: AgeValue = {};
  if (s[0] === "<" || s[0] === ">") {
    out.bound = s[0];
    s = s.slice(1).trim();
    // A bound on a keyword (`< CHILD`) says nothing the keyword does not.
    if ((KEYWORDS as readonly string[]).includes(s.toUpperCase())) return undefined;
  }
  if (/^\d+$/.test(s)) {
    out.years = Number(s);
    return out;
  }
  const re = /(\d+)\s*([ymwd])\s*/giy;
  let at = 0;
  let lastUnit = -1;
  while (at < s.length) {
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) return undefined;
    const unit = m[2].toLowerCase() as Unit;
    const rank = UNIT_ORDER.indexOf(unit);
    if (rank <= lastUnit) return undefined;
    lastUnit = rank;
    out[UNIT_FIELD[unit]] = Number(m[1]);
    at = re.lastIndex;
  }
  return lastUnit >= 0 ? out : undefined;
}

/**
 * Write an age in a dialect's grammar. 7.0 has no keywords, so one becomes
 * the bound it stands for (its words are the caller's `PHRASE`, see
 * {@link writeAgeValue}); 5.5.1 has no weeks, so they fold into days.
 * `spaced` keeps a 5.5.1 bound apart from its number (`> 60y` rather than
 * `>60y`) — both are read everywhere, and the file's own habit is the one
 * to keep. 7.0 always spaces it: its grammar requires the delimiter.
 */
export function formatAge(age: AgeValue, version: GedcomVersion, spaced = false): string {
  if (age.keyword) {
    if (version !== "7.0") return age.keyword;
    return formatAge(KEYWORD_AS_BOUND[age.keyword], version);
  }
  let weeks = age.weeks;
  let days = age.days;
  if (version !== "7.0" && weeks !== undefined) {
    days = weeks * 7 + (days ?? 0);
    weeks = undefined;
  }
  const parts: string[] = [];
  if (age.years !== undefined) parts.push(`${age.years}y`);
  if (age.months !== undefined) parts.push(`${age.months}m`);
  if (weeks !== undefined) parts.push(`${weeks}w`);
  if (days !== undefined) parts.push(`${days}d`);
  const body = parts.join(" ");
  if (!age.bound) return body;
  return version === "7.0" || spaced ? `${age.bound} ${body}` : `${age.bound}${body}`;
}

/**
 * The AGE line to write for what the user typed, in the file's dialect: the
 * normalized value, and — for a 5.5.1 keyword typed into a 7.0 file — the
 * `PHRASE` that keeps its words ("Child"). Text the grammar cannot read is
 * written as typed, the way an unreadable date is: the user's words are not
 * the app's to throw away.
 */
export function writeAgeValue(text: string, version: GedcomVersion): { value: string; phrase?: string } {
  const typed = text.trim();
  const age = parseAge(typed);
  if (!age) return { value: typed };
  const value = formatAge(age, version, /^[<>]\s/.test(typed));
  if (age.keyword && version === "7.0") {
    return { value, phrase: age.keyword.charAt(0) + age.keyword.slice(1).toLowerCase() };
  }
  return { value };
}

/** The age's length in years — fractional, months as twelfths, weeks and
 *  days by the mean year. */
function lengthInYears(age: AgeValue): number {
  return (age.years ?? 0) + (age.months ?? 0) / 12 + ((age.weeks ?? 0) * 7 + (age.days ?? 0)) / 365.25;
}

/** One step of the age's finest unit — the precision `25y` claims (a whole
 *  year: 25 until the 26th birthday) versus `25y 3m` (a month). */
function finestStep(age: AgeValue): number {
  if (age.days !== undefined) return 1 / 365.25;
  if (age.weeks !== undefined) return 7 / 365.25;
  if (age.months !== undefined) return 1 / 12;
  return 1;
}

/**
 * The span of ages, in years, the value allows: `25y` is anything from the
 * 25th birthday to just before the 26th, `< 8y` anything under eight,
 * `> 60y` anything from sixty up to the limit of a human life. Undefined for
 * an age that says nothing ("0y" still says something: under a year).
 */
export function ageYearsRange(age: AgeValue): { min: number; max: number } | undefined {
  const exact = age.keyword ? KEYWORD_AS_BOUND[age.keyword] : age;
  const length = lengthInYears(exact);
  if (length > MAX_AGE_YEARS) return undefined;
  if (exact.bound === "<") return { min: 0, max: length };
  if (exact.bound === ">") return { min: length, max: MAX_AGE_YEARS };
  // STILLBORN: no age at all.
  if (age.keyword === "STILLBORN") return { min: 0, max: 0 };
  return { min: length, max: Math.min(MAX_AGE_YEARS, length + finestStep(exact)) };
}

/**
 * The whole years an exact age states, for prose ("age 25") — undefined for a
 * bound, a keyword, or an age given in months or days alone, where a number
 * of years would claim more than the record does.
 */
export function ageWholeYears(age: AgeValue | undefined): number | undefined {
  if (!age || age.bound || age.keyword || age.years === undefined) return undefined;
  return age.years <= MAX_AGE_YEARS ? age.years : undefined;
}

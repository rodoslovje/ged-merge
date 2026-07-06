import type { GedDate, Individual } from "./types";
import type { Translate } from "../locales/i18n";
import { birthDateOf, datesTooltipOf, deathDateOf, isDeceased, isPresumedLiving, lifespanOf } from "./lifespan";

/** Ages above this are data errors, not people — suppress rather than display. */
const MAX_AGE = 125;

/**
 * Whole years between a birth date and a later date. Uses whatever precision
 * both sides share: with months (and days) known the age is exact; with bare
 * years it is the year difference (may be off by one). Undefined when either
 * year is missing or the result is implausible (negative or > {@link MAX_AGE}).
 */
export function ageBetween(birth: GedDate | undefined, at: GedDate | undefined): number | undefined {
  if (birth?.year === undefined || at?.year === undefined) return undefined;
  let age = at.year - birth.year;
  if (
    birth.month !== undefined &&
    at.month !== undefined &&
    (at.month < birth.month ||
      (at.month === birth.month && birth.day !== undefined && at.day !== undefined && at.day < birth.day))
  )
    age -= 1;
  return age >= 0 && age <= MAX_AGE ? age : undefined;
}

/** The person's age when `at` happened, from their (proxy) birth date. */
export function ageAtDate(indi: Individual | undefined, at: GedDate | undefined): number | undefined {
  return ageBetween(birthDateOf(indi), at);
}

/** Calendar-component age: months/days present only when both dates pin them. */
export interface AgeParts {
  years: number;
  months?: number;
  days?: number;
}

/**
 * {@link ageBetween} broken into calendar components, at the precision both
 * dates share: bare years → `{years}` (may be off by one), months known →
 * `{years, months}`, full dates → `{years, months, days}`.
 */
export function agePartsBetween(birth: GedDate | undefined, at: GedDate | undefined): AgeParts | undefined {
  if (birth?.year === undefined || at?.year === undefined) return undefined;
  const cap = (p: AgeParts) => (p.years >= 0 && p.years <= MAX_AGE ? p : undefined);
  if (birth.month === undefined || at.month === undefined) return cap({ years: at.year - birth.year });
  const wholeMonths = (at.year - birth.year) * 12 + (at.month - birth.month);
  if (birth.day === undefined || at.day === undefined)
    return wholeMonths < 0 ? undefined : cap({ years: Math.floor(wholeMonths / 12), months: wholeMonths % 12 });
  let years = at.year - birth.year;
  let months = at.month - birth.month;
  let days = at.day - birth.day;
  if (days < 0) {
    months -= 1;
    // Count from the last monthly anniversary, which falls in the month before
    // `at` (JS Date day 0 = last day of the previous month) — clamped to that
    // month's end when it is shorter than the birth day (e.g. born the 30th,
    // anniversary month February).
    const prevMonthDays = new Date(at.year, at.month - 1, 0).getDate();
    days = at.day + Math.max(0, prevMonthDays - birth.day);
  }
  if (months < 0) {
    years -= 1;
    months += 12;
  }
  return cap({ years, months, days });
}

/** "62y 1m 5d" (unit letters localized), at the parts' available precision. */
export function formatAgeParts(parts: AgeParts, t: Translate): string {
  const out = [`${parts.years}${t("age.y")}`];
  if (parts.months !== undefined) out.push(`${parts.months}${t("age.m")}`);
  if (parts.days !== undefined) out.push(`${parts.days}${t("age.d")}`);
  return out.join(" ");
}

/** {@link agePartsBetween} formatted for tooltips, e.g. "62y 1m 5d". */
export function fullAgeBetween(
  birth: GedDate | undefined,
  at: GedDate | undefined,
  t: Translate,
): string | undefined {
  const parts = agePartsBetween(birth, at);
  return parts && formatAgeParts(parts, t);
}

/** Today as a `GedDate`, for current-age computations. */
export function todayDate(now: Date = new Date()): GedDate {
  return { raw: "", qualifier: "exact", year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * The endpoints of a person's displayable age: birth → death for the deceased
 * (needs a dated death), birth → today for the presumed living, undefined
 * otherwise — so a dateless-death ancient ancestor never shows a running age.
 */
function lifespanAgeEndpoints(
  indi: Individual | undefined,
  now: Date,
): [GedDate | undefined, GedDate | undefined] | undefined {
  if (!indi) return undefined;
  if (isDeceased(indi)) return [birthDateOf(indi), deathDateOf(indi)];
  if (isPresumedLiving(indi, now.getFullYear())) return [birthDateOf(indi), todayDate(now)];
  return undefined;
}

/**
 * The age to append to a lifespan label: age at death for the deceased,
 * current age for the presumed living (see {@link lifespanAgeEndpoints}).
 */
export function lifespanAge(indi: Individual | undefined, now: Date = new Date()): number | undefined {
  const ends = lifespanAgeEndpoints(indi, now);
  return ends && ageBetween(ends[0], ends[1]);
}

/**
 * Full-date tooltip for a person, with the full-precision age appended when
 * `showAge`, e.g. "26 Jan 1908 – 3 Mar 1970 (62y 1m 5d)".
 */
export function lifespanTooltipOf(
  indi: Individual | undefined,
  showAge: boolean,
  t: Translate,
  now: Date = new Date(),
): string {
  const base = datesTooltipOf(indi);
  if (!showAge) return base;
  const ends = lifespanAgeEndpoints(indi, now);
  const detail = ends && fullAgeBetween(ends[0], ends[1], t);
  return detail ? (base ? `${base} (${detail})` : detail) : base;
}

/** Lifespan label with the {@link lifespanAge} appended, e.g. "1850–1920 (70)". */
export function lifespanWithAge(indi: Individual | undefined, showAge: boolean): string {
  const span = lifespanOf(indi);
  if (!showAge || !span) return span;
  const age = lifespanAge(indi);
  return age === undefined ? span : `${span} (${age})`;
}

/** "♂32 ♀28" — whichever of a couple's ages are known, glyph-tagged; "" when neither. */
export function formatCoupleAges(husband: number | undefined, wife: number | undefined): string {
  const parts: string[] = [];
  if (husband !== undefined) parts.push(`♂${husband}`);
  if (wife !== undefined) parts.push(`♀${wife}`);
  return parts.join(" ");
}

/**
 * Badge + tooltip for a couple's ages at `at`: glyph-tagged whole years as the
 * text, `label` plus the glyph-tagged full-precision breakdown as the title
 * (e.g. "♂32y 4m 2d ♀28y 11m"). Undefined when neither age is known.
 */
export function coupleAgesDisplay(
  husband: Individual | undefined,
  wife: Individual | undefined,
  at: GedDate | undefined,
  label: string,
  t: Translate,
): { text: string; title: string } | undefined {
  const text = formatCoupleAges(ageAtDate(husband, at), ageAtDate(wife, at));
  if (!text) return undefined;
  const details: string[] = [];
  const h = fullAgeBetween(birthDateOf(husband), at, t);
  const w = fullAgeBetween(birthDateOf(wife), at, t);
  if (h) details.push(`♂${h}`);
  if (w) details.push(`♀${w}`);
  return { text, title: details.length ? `${label}: ${details.join(" ")}` : label };
}

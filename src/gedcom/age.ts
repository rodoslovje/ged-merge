import type { GedDate, Individual } from "./types";
import { birthDateOf, deathDateOf, isDeceased, isPresumedLiving, lifespanOf } from "./lifespan";

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

/** Today as a `GedDate`, for current-age computations. */
export function todayDate(now: Date = new Date()): GedDate {
  return { raw: "", qualifier: "exact", year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * The age to append to a lifespan label: age at death for the deceased (needs
 * a dated death), current age for the presumed living, undefined otherwise —
 * so a dateless-death ancient ancestor never shows a running age.
 */
export function lifespanAge(indi: Individual | undefined, now: Date = new Date()): number | undefined {
  if (!indi) return undefined;
  if (isDeceased(indi)) return ageBetween(birthDateOf(indi), deathDateOf(indi));
  if (isPresumedLiving(indi, now.getFullYear())) return ageBetween(birthDateOf(indi), todayDate(now));
  return undefined;
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

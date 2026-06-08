import { parseDate } from "../gedcom/date";
import type { DateOrder, GedDate } from "../gedcom/types";
import type { DateFormatProfile } from "./types";

/**
 * Render a structured date back into a GEDCOM date string using the master's
 * format. Falls back to the original raw text whenever we cannot faithfully
 * reconstruct the value (so normalization never loses information).
 */
export function formatGedDate(date: GedDate, profile: DateFormatProfile): string {
  const first = formatParts(date.year, date.month, date.day, profile);
  const second = formatParts(date.year2, date.month2, date.day2, profile);
  const q = profile.qualifierTokens;

  switch (date.qualifier) {
    case "exact":
      return first || date.raw;
    case "about":
    case "before":
    case "after":
    case "from":
    case "to":
      return first ? `${q[date.qualifier]} ${first}` : date.raw;
    case "between":
      return first && second ? `BET ${first} AND ${second}` : date.raw;
    case "range":
      return first && second ? `FROM ${first} TO ${second}` : date.raw;
    case "interpreted":
    case "unknown":
      return date.raw;
  }
}

/**
 * Re-render a raw DATE string into master format; raw is returned unchanged
 * when nothing about it differs. `sourceOrder` disambiguates numeric dates in
 * the source file (e.g. whether `05/06/1989` is D/M or M/D).
 */
export function normalizeDateString(
  raw: string,
  profile: DateFormatProfile,
  sourceOrder?: DateOrder,
): string {
  return formatGedDate(parseDate(raw, sourceOrder), profile);
}

function formatParts(
  year: number | undefined,
  month: number | undefined,
  day: number | undefined,
  profile: DateFormatProfile,
): string {
  if (year === undefined) return "";
  if (profile.numeric) return formatNumeric(year, month, day, profile.numeric);
  if (month === undefined) return String(year);
  const mon = profile.monthTokens[month] ?? String(month);
  if (day === undefined) return `${mon} ${year}`;
  const d = profile.padDay ? String(day).padStart(2, "0") : String(day);
  return `${d} ${mon} ${year}`;
}

function formatNumeric(
  year: number,
  month: number | undefined,
  day: number | undefined,
  fmt: NonNullable<DateFormatProfile["numeric"]>,
): string {
  const sep = fmt.separator;
  const y = String(year);
  if (month === undefined) return y; // year-only: numeric layout can't add more.
  const mm = fmt.padMonth ? String(month).padStart(2, "0") : String(month);
  if (day === undefined) {
    return fmt.order === "YMD" ? `${y}${sep}${mm}` : `${mm}${sep}${y}`;
  }
  const dd = fmt.padDay ? String(day).padStart(2, "0") : String(day);
  switch (fmt.order) {
    case "DMY": return `${dd}${sep}${mm}${sep}${y}`;
    case "MDY": return `${mm}${sep}${dd}${sep}${y}`;
    case "YMD": return `${y}${sep}${mm}${sep}${dd}`;
  }
}

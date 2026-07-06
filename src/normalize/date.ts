import { parseDate } from "../gedcom/date";
import type { DateOrder, GedDate, GedNode } from "../gedcom/types";
import type { DateFormatProfile } from "./types";

/** A bare year–year range, e.g. "1830-1850" or "1785 / 1810" — see parseDate. */
const DASH_YEAR_RANGE = /^\d{3,4}\s*[-/]\s*\d{3,4}$/;

/**
 * Render a structured date back into a GEDCOM date string using the main's
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
      // A loose dash/slash year range ("1830-1850", "1785 - 1810") is the
      // user's shorthand; keep it exactly as written rather than rewriting it
      // to the formal BET … AND … form.
      if (DASH_YEAR_RANGE.test(date.raw.trim())) return date.raw;
      return first && second ? `BET ${first} AND ${second}` : date.raw;
    case "range":
      return first && second ? `FROM ${first} TO ${second}` : date.raw;
    case "interpreted":
      return date.raw;
    case "unknown":
      // A flagged all-unknown placeholder date (".__.____") is re-rendered in the
      // main's placeholder layout when it has one; otherwise kept verbatim.
      return formatAllUnknown(date.placeholder === true, profile) ?? date.raw;
  }
}

/**
 * Render a fully-unknown placeholder date ("__.__.____") in the main's numeric
 * layout. Returns undefined when the value isn't a flagged placeholder or the
 * main has no placeholder convention — the caller then keeps the raw text.
 */
function formatAllUnknown(isPlaceholder: boolean, profile: DateFormatProfile): string | undefined {
  const fmt = profile.numeric;
  if (!isPlaceholder || !fmt?.placeholder) return undefined;
  const ph = fmt.placeholder;
  return joinNumeric(ph.repeat(2), ph.repeat(2), ph.repeat(4), fmt);
}

/**
 * Strip all-placeholder `DATE` nodes (".__.____", "__.__.____") from a record
 * tree, returning each removed raw value (for the report). Such a date carries
 * no information — a deliberate "date unknown" marker, not a real value — so
 * when the main has no placeholder-date convention of its own we drop it
 * entirely rather than carry a foreign "__.__.____" into the compare/merge
 * views and the merged file. This is the date analog of how
 * {@link reshapeUnknownNames} blanks placeholder names under the main's blank
 * convention; callers gate it on the main having no placeholder layout (when
 * it *does*, {@link formatGedDate} reshapes these to that layout and keeps them).
 */
export function dropPlaceholderDates(node: GedNode): string[] {
  const removed: string[] = [];
  const kept: GedNode[] = [];
  for (const child of node.children) {
    if (child.tag === "DATE" && child.value !== undefined && parseDate(child.value).placeholder) {
      removed.push(child.value.trim());
      continue; // drop this DATE node
    }
    removed.push(...dropPlaceholderDates(child));
    kept.push(child);
  }
  node.children = kept;
  return removed;
}

/**
 * Re-render a raw DATE string into main format; raw is returned unchanged
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
  if (profile.numeric) return formatNumeric(year, month, day, profile.numeric);
  if (year === undefined) return "";
  if (month === undefined) return String(year);
  const mon = profile.monthTokens[month] ?? String(month);
  if (day === undefined) return `${mon} ${year}`;
  const d = profile.padDay ? String(day).padStart(2, "0") : String(day);
  return `${d} ${mon} ${year}`;
}

function formatNumeric(
  year: number | undefined,
  month: number | undefined,
  day: number | undefined,
  fmt: NonNullable<DateFormatProfile["numeric"]>,
): string {
  const sep = fmt.separator;
  const ph = fmt.placeholder;

  // Year-only (or coarser): a numeric layout has no finer fields to add, so we
  // emit the bare year. We keep year-only dates bare even under a placeholder
  // convention — padding every approximate year to "__.__.1900" would rewrite a
  // huge share of dates for no real gain. Placeholders only fill a slot beneath
  // a *known* month (below) or a fully-unknown date (see formatAllUnknown).
  if (month === undefined) return year === undefined ? "" : String(year);

  const mm = fmt.padMonth ? String(month).padStart(2, "0") : String(month);
  // A known month needs a year slot; without a year and without a placeholder
  // we can't render it numerically, so signal "give up" (caller keeps raw).
  const y = year !== undefined ? String(year) : ph ? ph.repeat(4) : undefined;
  if (y === undefined) return "";

  if (day === undefined) {
    // Unknown day: fill it with a placeholder if the main uses one, otherwise
    // drop the slot ("MM.YYYY" / "YYYY.MM").
    if (!ph) return fmt.order === "YMD" ? `${y}${sep}${mm}` : `${mm}${sep}${y}`;
    return joinNumeric(ph.repeat(2), mm, y, fmt);
  }
  const dd = fmt.padDay ? String(day).padStart(2, "0") : String(day);
  return joinNumeric(dd, mm, y, fmt);
}

/** Join day/month/year field strings (already formatted) in the layout's order. */
function joinNumeric(
  dd: string,
  mm: string,
  y: string,
  fmt: NonNullable<DateFormatProfile["numeric"]>,
): string {
  const sep = fmt.separator;
  switch (fmt.order) {
    case "DMY": return `${dd}${sep}${mm}${sep}${y}`;
    case "MDY": return `${mm}${sep}${dd}${sep}${y}`;
    case "YMD": return `${y}${sep}${mm}${sep}${dd}`;
  }
}

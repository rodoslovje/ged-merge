import { parseDate } from "./date";
import { firstChild } from "./node";
import type { GedcomVersion, GedDate, GedNode } from "./types";

/**
 * GEDCOM 7's `SDATE`: "a date to be used as a sorting hint … when the actual
 * date is unknown, or when the actual date is not suitable for sorting" — an
 * undated residence that belongs between two dated ones, a baptism dated only
 * by a phrase ("Easter Sunday"). 5.5.1 has no such line; the version migration
 * keeps it as `_SDATE`, which reads alike.
 *
 * Wherever events are ordered — Edit, the merge comparison, the save's event
 * sort, the timeline and the reports — the sort date stands in for the date
 * when it has a year. It never stands in for the date anywhere else.
 */

/** The tags a sort date goes by. */
export const SORT_DATE_TAGS: readonly string[] = ["SDATE", "_SDATE"];

/** The tag a new sort date is written with in a file of `version`. */
export function sortDateTag(version: GedcomVersion): "SDATE" | "_SDATE" {
  return version === "7.0" ? "SDATE" : "_SDATE";
}

/** An event node's sort date, parsed. */
export function nodeSortDate(node: GedNode): GedDate | undefined {
  const v = firstChild(node, SORT_DATE_TAGS)?.value;
  return v?.trim() ? parseDate(v) : undefined;
}

/** The date to order an event by: its sort date when that has a year, else
 *  its own date. */
export function orderingDate(ev: { date?: GedDate; sortDate?: GedDate }): GedDate | undefined {
  return ev.sortDate?.year != null ? ev.sortDate : ev.date;
}

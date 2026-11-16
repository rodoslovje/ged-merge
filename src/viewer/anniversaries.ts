import type { Dataset, GedEvent } from "../gedcom/types";

/** One birth, marriage or death that falls on a day of the coming week. */
export interface Anniversary {
  /** The person, or the family for a marriage. */
  id: string;
  family: boolean;
  event: GedEvent;
  /** Days from today: 0 is today. */
  inDays: number;
}

/** The events a front page remembers on their day. */
const PERSON_TAGS = new Set(["BIRT", "CHR", "BAPM", "DEAT", "BURI"]);
const FAMILY_TAGS = new Set(["MARR"]);

/** At most this many; the nearest days and the oldest years first. */
export const WEEK_LIMIT = 8;

/**
 * Births, baptisms, marriages, deaths and burials whose day and month fall
 * today or in the six days after — "this week in years past". Only exact days
 * count: an "about" or a range is no anniversary.
 */
export function onThisWeek(ds: Dataset, today: Date, limit = WEEK_LIMIT): Anniversary[] {
  const days = new Map<string, number>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    days.set(`${d.getMonth() + 1}-${d.getDate()}`, i);
  }
  const out: Anniversary[] = [];
  const consider = (id: string, family: boolean, e: GedEvent) => {
    const d = e.date;
    if (!d || d.qualifier !== "exact" || !d.day || !d.month || d.year === undefined) return;
    const inDays = days.get(`${d.month}-${d.day}`);
    if (inDays !== undefined) out.push({ id, family, event: e, inDays });
  };
  for (const indi of ds.individuals.values()) for (const e of indi.events) if (PERSON_TAGS.has(e.tag)) consider(indi.id, false, e);
  for (const fam of ds.families.values()) for (const e of fam.events) if (FAMILY_TAGS.has(e.tag)) consider(fam.id, true, e);
  out.sort((a, b) => a.inDays - b.inDays || a.event.date!.year! - b.event.date!.year!);
  return out.slice(0, limit);
}

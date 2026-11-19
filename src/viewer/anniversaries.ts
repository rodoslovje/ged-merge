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

/** One day of the coming week and what happened on it in years past. */
export interface WeekDay {
  /** Days from today: 0 is today. */
  inDays: number;
  month: number;
  day: number;
  /** The oldest years first, at most the per-day limit. */
  items: Anniversary[];
  /** How many more the day has beyond `items`. */
  more: number;
}

/** The events a front page remembers on their day. */
const PERSON_TAGS = new Set(["BIRT", "CHR", "BAPM", "DEAT", "BURI"]);
const FAMILY_TAGS = new Set(["MARR"]);

/** At most this many a day; the oldest years first. */
export const WEEK_DAY_LIMIT = 12;

/**
 * Births, baptisms, marriages, deaths and burials whose day and month fall
 * today or in the six days after — "this week in years past" — one entry per
 * day that has any, nearest day first. Only exact days count: an "about" or a
 * range is no anniversary.
 */
export function onThisWeek(ds: Dataset, today: Date, perDay = WEEK_DAY_LIMIT): WeekDay[] {
  const days = new Map<string, number>();
  const week: { month: number; day: number; all: Anniversary[] }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
    days.set(`${d.getMonth() + 1}-${d.getDate()}`, i);
    week.push({ month: d.getMonth() + 1, day: d.getDate(), all: [] });
  }
  const consider = (id: string, family: boolean, e: GedEvent) => {
    const d = e.date;
    if (!d || d.qualifier !== "exact" || !d.day || !d.month || d.year === undefined) return;
    const inDays = days.get(`${d.month}-${d.day}`);
    if (inDays !== undefined) week[inDays].all.push({ id, family, event: e, inDays });
  };
  for (const indi of ds.individuals.values()) for (const e of indi.events) if (PERSON_TAGS.has(e.tag)) consider(indi.id, false, e);
  for (const fam of ds.families.values()) for (const e of fam.events) if (FAMILY_TAGS.has(e.tag)) consider(fam.id, true, e);
  const out: WeekDay[] = [];
  week.forEach(({ month, day, all }, inDays) => {
    if (!all.length) return;
    all.sort((a, b) => a.event.date!.year! - b.event.date!.year!);
    out.push({ inDays, month, day, items: all.slice(0, perDay), more: Math.max(0, all.length - perDay) });
  });
  return out;
}

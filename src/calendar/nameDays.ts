// Name days for the family calendar: the saints' names a day carries, and the
// day a person keeps by their given name. Two calendars — the Slovenian and
// the Croatian — read from one table (nameDayData.ts). Pure.

import { DAYS, VARIANTS } from "./nameDayData";

export type NameCalendar = "si" | "hr";
export const NAME_CALENDARS: NameCalendar[] = ["si", "hr"];

export interface MonthDay {
  month: number; // 1-12
  day: number;
}

interface Table {
  /** Per month and day (both from 0), the names in the table's order. */
  saints: string[][][];
  /** A name's key → the day its bearers keep. */
  days: Map<string, MonthDay>;
}

/** A name as the tables are keyed: case and diacritics aside, so a file that
 *  writes "Joze" still finds Jože. */
export function nameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase()
    .replace(/đ/g, "d")
    .trim();
}

/** One side of an entry: the name, and whether this is its bearers' day. */
function side(text: string): { name: string; main: boolean } {
  const main = text.endsWith("*");
  return { name: main ? text.slice(0, -1) : text, main };
}

/** A day's line, as the names of one calendar. */
export function parseDay(line: string, calendar: NameCalendar): { name: string; main: boolean }[] {
  const out: { name: string; main: boolean }[] = [];
  for (const entry of line.split(",")) {
    const [sl, hr = sl] = entry.trim().split("|");
    const s = side((calendar === "si" ? sl : hr).trim());
    if (s.name) out.push(s);
  }
  return out;
}

function build(calendar: NameCalendar): Table {
  const saints: string[][][] = [];
  const days = new Map<string, MonthDay>();
  const starred = new Set<string>();
  DAYS.forEach((month, m) => {
    saints.push(month.map((line, d) => {
      const names = parseDay(line, calendar);
      for (const { name, main } of names) {
        const key = nameKey(name);
        // The starred day wins; without one, the name's first day.
        if (main ? !starred.has(key) : !days.has(key)) days.set(key, { month: m + 1, day: d + 1 });
        if (main) starred.add(key);
      }
      return names.map((n) => n.name);
    }));
  });
  for (const line of VARIANTS[calendar]) {
    const [canonical, rest = ""] = line.split(":");
    const at = days.get(nameKey(canonical));
    if (!at) continue;
    for (const v of rest.trim().split(/\s+/)) {
      const key = nameKey(v);
      // A name with a day of its own keeps it.
      if (key && !days.has(key)) days.set(key, at);
    }
  }
  return { saints, days };
}

const tables = new Map<NameCalendar, Table>();
function table(calendar: NameCalendar): Table {
  let t = tables.get(calendar);
  if (!t) tables.set(calendar, (t = build(calendar)));
  return t;
}

/** The saints' names on a day, the best-known first. */
export function saintsOf(calendar: NameCalendar, month: number, day: number): string[] {
  return table(calendar).saints[month - 1]?.[day - 1] ?? [];
}

/**
 * The day kept by someone with this given name: the whole name first ("Ana
 * Marija" has none of its own), then its first word, then the first half of a
 * hyphenated one. Undefined for a name the calendar does not carry.
 */
export function nameDayOf(calendar: NameCalendar, given: string | undefined): MonthDay | undefined {
  const full = given?.trim();
  if (!full) return undefined;
  const { days } = table(calendar);
  const first = full.split(/\s+/)[0];
  for (const form of [full, first, first.split("-")[0]]) {
    const at = days.get(nameKey(form));
    if (at) return at;
  }
  return undefined;
}

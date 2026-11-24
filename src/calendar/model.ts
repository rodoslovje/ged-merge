// The family calendar's data, seen from one person (the one who gets it as a
// gift): which relatives' birthdays, wedding anniversaries and memorial days
// fall on which day of the year, and a few dated moments from the family's past
// for each month. Pure — the names, kinship words and layout are the view's.

import type { Dataset, GedDate, GedEvent, Individual } from "../gedcom/types";
import { isDeceased, isPresumedLiving } from "../gedcom/lifespan";
import { unionMark } from "../gedcom/union";

/** Whose birthdays the calendar shows: the recipient's descendants only, or
 *  every blood relative up to cousins of the given degree (0 — parents,
 *  siblings, aunts, nephews and the direct line, without cousins). */
export type CalendarScope = "descendants" | 0 | 1 | 2 | 3;

/** Memorial days: none; for those who died in the recipient's lifetime; or for
 *  the dead up to the 1st or 2nd degree of kinship (parents, siblings and
 *  children — then grandparents, aunts, uncles, first cousins, grandchildren). */
export type MemorialMode = "off" | "lifetime" | 1 | 2;

export interface CalendarOptions {
  year: number;
  scope: CalendarScope;
  /** Include the partners of the relatives shown (a son's wife, an aunt's husband). */
  partners: boolean;
  memorial: MemorialMode;
}

export type DayEntryKind = "birthday" | "anniversary" | "memorial";

export interface DayEntry {
  kind: DayEntryKind;
  day: number;
  /** One person; two for an anniversary (husband first). */
  ids: string[];
  /** The age turned or the years married — when the year is known. */
  years?: number;
  /** A memorial day's year of the death, when known — written on every
   *  memorial, as the dead are remembered by it. */
  deathYear?: number;
}

export type FactKind = "birth" | "marriage" | "death";

export interface Fact {
  kind: FactKind;
  date: GedDate;
  ids: string[];
  place?: string;
  /** Years between the event and the calendar year. */
  yearsAgo: number;
}

export interface CalendarMonth {
  month: number; // 1-12
  entries: DayEntry[];
  /** The moments from the family's past this month offers, best first. */
  candidates: Fact[];
  /** The ones picked by default (at most {@link FACTS_PER_MONTH}), in day order. */
  facts: Fact[];
}

export interface CalendarData {
  months: CalendarMonth[];
  /** Everyone named on the calendar (for the photo picker). */
  people: string[];
}

/** How many family-history moments a month carries by default. */
export const FACTS_PER_MONTH = 2;
/** How many a month offers to choose from. */
export const CANDIDATES_PER_MONTH = 8;

/** No living relative sits further up than this, so the walk stops there. */
const MAX_UP = 6;

interface Position {
  up: number;
  down: number;
}

/**
 * Blood relatives of `startId` within `scope`, each with its position: `up`
 * generations to the nearest common ancestor, `down` from there to them. One
 * walk down from each ancestor; a child who is themselves an ancestor is left
 * to their own (nearer) walk, so everyone keeps their nearest common ancestor.
 */
export function relativesInScope(ds: Dataset, startId: string, scope: CalendarScope): Map<string, Position> {
  const out = new Map<string, Position>();
  const offer = (id: string, up: number, down: number) => {
    const had = out.get(id);
    if (!had || up + down < had.up + had.down) out.set(id, { up, down });
  };
  const ancestors = scope === "descendants" ? new Map([[startId, 0]]) : ancestorGens(ds, startId, MAX_UP);
  for (const [anc, up] of ancestors) {
    offer(anc, up, 0);
    // Cousins of degree `scope` share an ancestor `scope + 1` up; further up only
    // the shallow lines stay in range (a grandparent's sibling, not their grandchildren).
    const maxDown = scope === "descendants" || up <= scope + 1 ? Infinity : scope + 1;
    const queue: [string, number][] = [[anc, 0]];
    for (let i = 0; i < queue.length; i++) {
      const [id, d] = queue[i];
      if (d >= maxDown) continue;
      for (const famId of ds.individuals.get(id)?.spouseOf ?? []) {
        for (const c of ds.families.get(famId)?.children ?? []) {
          const had = out.get(c);
          if (ancestors.has(c) || (had && had.up + had.down <= up + d + 1)) continue;
          offer(c, up, d + 1);
          queue.push([c, d + 1]);
        }
      }
    }
  }
  return out;
}

/** Generations up from `startId` (itself at 0), no further than `max`. */
function ancestorGens(ds: Dataset, startId: string, max: number): Map<string, number> {
  const map = new Map([[startId, 0]]);
  const queue = [startId];
  for (let i = 0; i < queue.length; i++) {
    const gen = map.get(queue[i])!;
    if (gen >= max) continue;
    for (const famId of ds.individuals.get(queue[i])?.childOf ?? []) {
      const fam = ds.families.get(famId);
      for (const p of [fam?.husband, fam?.wife]) {
        if (p && !map.has(p)) {
          map.set(p, gen + 1);
          queue.push(p);
        }
      }
    }
  }
  return map;
}

/** The partners `id` is still with: a couple the file records as divorced,
 *  annulled or living apart is left out. */
function spousesOf(ds: Dataset, id: string): string[] {
  const out: string[] = [];
  for (const famId of ds.individuals.get(id)?.spouseOf ?? []) {
    const fam = ds.families.get(famId);
    if (!fam || unionMark(fam).ended) continue;
    const other = fam.husband === id ? fam.wife : fam.husband;
    if (other) out.push(other);
  }
  return out;
}

/** A date that names its day and month exactly (no ABT, BEF, range…). */
function dayOf(date: GedDate | undefined): date is GedDate & { month: number; day: number } {
  return !!date && date.qualifier === "exact" && date.month !== undefined && date.day !== undefined && solar(date);
}

/** Gregorian or Julian — the calendars whose month and day mean ours. */
const solar = (date: GedDate) => !date.calendar || date.calendar === "GREGORIAN" || date.calendar === "JULIAN";

const eventDate = (indi: Individual | undefined, tag: string) => indi?.events.find((e) => e.tag === tag)?.date;

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 29 February in a common year is kept on the 28th. */
function clampDay(year: number, month: number, day: number): number {
  return Math.min(day, daysIn(year, month));
}

export function buildCalendar(ds: Dataset, startId: string, opts: CalendarOptions, nowYear: number): CalendarData {
  const { year } = opts;
  const months: CalendarMonth[] = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, entries: [], candidates: [], facts: [] }));
  const add = (month: number, entry: DayEntry) => months[month - 1].entries.push(entry);
  const living = (indi: Individual | undefined) => isPresumedLiving(indi, ds, nowYear);

  const blood = relativesInScope(ds, startId, opts.scope);
  // The recipient's own partner always belongs; the others' only when asked.
  const circle = new Set(blood.keys());
  for (const id of opts.partners ? [...blood.keys()] : [startId]) for (const s of spousesOf(ds, id)) circle.add(s);

  const people = new Set<string>();
  // The age turned or the years married; none in the year of the event itself.
  const since = (y: number | undefined) => (y !== undefined && year > y ? year - y : undefined);

  // Birthdays of the living.
  for (const id of circle) {
    const indi = ds.individuals.get(id);
    const birth = eventDate(indi, "BIRT");
    if (!dayOf(birth) || !living(indi) || indi?.private) continue;
    add(birth.month, { kind: "birthday", day: clampDay(year, birth.month, birth.day), ids: [id], years: since(birth.year) });
    people.add(id);
  }

  // Wedding anniversaries of living couples still together.
  const seenFam = new Set<string>();
  for (const id of circle) {
    for (const famId of ds.individuals.get(id)?.spouseOf ?? []) {
      if (seenFam.has(famId)) continue;
      seenFam.add(famId);
      const fam = ds.families.get(famId);
      if (!fam?.husband || !fam.wife || fam.private || unionMark(fam).ended) continue;
      const marr = fam.events.find((e) => e.tag === "MARR")?.date;
      const pair = [fam.husband, fam.wife];
      if (!dayOf(marr) || !pair.every((p) => { const ind = ds.individuals.get(p); return living(ind) && !ind?.private; })) continue;
      add(marr.month, { kind: "anniversary", day: clampDay(year, marr.month, marr.day), ids: pair, years: since(marr.year) });
      pair.forEach((p) => people.add(p));
    }
  }

  // Memorial days: the circle plus the whole direct line up, filtered by the mode.
  if (opts.memorial !== "off") {
    const near = new Map(blood);
    for (const [id, up] of ancestorGens(ds, startId, Infinity)) if (!near.has(id)) near.set(id, { up, down: 0 });
    const startBirth = eventDate(ds.individuals.get(startId), "BIRT")?.year;
    const candidates = new Set([...near.keys(), ...spousesOf(ds, startId)]);
    for (const id of candidates) {
      if (id === startId) continue;
      const indi = ds.individuals.get(id);
      const death = eventDate(indi, "DEAT");
      if (!dayOf(death) || !isDeceased(indi) || indi?.private) continue;
      if (opts.memorial === "lifetime") {
        if (startBirth === undefined || death.year === undefined || death.year < startBirth) continue;
      } else {
        const pos = near.get(id);
        // The recipient's partner counts as the nearest kin.
        const degree = pos ? Math.max(pos.up, pos.down) : 1;
        if (degree > opts.memorial) continue;
      }
      add(death.month, { kind: "memorial", day: clampDay(year, death.month, death.day), ids: [id], deathYear: death.year });
      people.add(id);
    }
  }

  for (const m of months) m.entries.sort((a, b) => a.day - b.day || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

  // Family history: births, weddings and deaths of the dead among the
  // recipient's ancestors and the circle, dated to the month.
  const ancestors = ancestorGens(ds, startId, Infinity);
  const historyPeople = new Set([...circle, ...ancestors.keys()]);
  const candidates: { fact: Fact; score: number; month: number }[] = [];
  const offerFact = (kind: FactKind, date: GedDate | undefined, ids: string[], place: string | undefined) => {
    if (!date || date.qualifier !== "exact" || date.month === undefined || date.year === undefined || date.year >= year) return;
    if (!solar(date)) return;
    const yearsAgo = year - date.year;
    const direct = ids.some((id) => ancestors.has(id) && id !== startId);
    const score = roundness(yearsAgo) * 10 + (direct ? 6 : 0) + (date.day !== undefined ? 2 : 0) + (place ? 1 : 0);
    candidates.push({ fact: { kind, date, ids, place, yearsAgo }, score, month: date.month });
  };
  const placeOf = (e: GedEvent | undefined) => e?.place?.parts[0] || e?.place?.raw || undefined;
  const famSeen = new Set<string>();
  for (const id of historyPeople) {
    const indi = ds.individuals.get(id);
    // A living person's birth is already a birthday; their life is not history
    // yet. An ancestor with no death on record is history all the same.
    if (!indi || indi.private || living(indi)) continue;
    const birt = indi.events.find((e) => e.tag === "BIRT");
    offerFact("birth", birt?.date, [id], placeOf(birt));
    const deat = indi.events.find((e) => e.tag === "DEAT");
    offerFact("death", deat?.date, [id], placeOf(deat));
    for (const famId of indi.spouseOf) {
      if (famSeen.has(famId)) continue;
      famSeen.add(famId);
      const fam = ds.families.get(famId);
      const h = fam?.husband ? ds.individuals.get(fam.husband) : undefined;
      const w = fam?.wife ? ds.individuals.get(fam.wife) : undefined;
      if (!fam?.husband || !fam.wife || fam.private || h?.private || w?.private || living(h) || living(w)) continue;
      const marr = fam.events.find((e) => e.tag === "MARR");
      offerFact("marriage", marr?.date, [fam.husband, fam.wife], placeOf(marr));
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.fact.date.year! - b.fact.date.year!);
  for (const c of candidates) {
    const m = months[c.month - 1];
    if (m.candidates.length < CANDIDATES_PER_MONTH) m.candidates.push(c.fact);
    if (m.facts.length >= FACTS_PER_MONTH) continue;
    // One moment per person per month: two facts about the same couple read as filler.
    if (m.facts.some((f) => f.ids.some((id) => c.fact.ids.includes(id)))) continue;
    m.facts.push(c.fact);
  }
  for (const m of months) {
    m.facts.sort(byDay);
    for (const f of m.candidates) f.ids.forEach((id) => people.add(id));
  }

  return { months, people: [...people] };
}

/** A fact's identity — what it is, about whom, on which date — stable when
 *  the year or the settings change and the scores move. */
export const factKey = (f: Fact) => `${f.kind}|${f.ids.join(",")}|${f.date.raw}`;

/** Day order within a month; an undated day first. */
export const byDay = (a: Fact, b: Fact) => (a.date.day ?? 0) - (b.date.day ?? 0);

const KIND_ORDER: Record<DayEntryKind, number> = { birthday: 0, anniversary: 1, memorial: 2 };

/** The wedding anniversaries a family marks: the 10th, every tenth after it,
 *  and the silver, sixty-fifth (iron) and seventy-fifth (crown) jubilees. */
const ROUND_WEDDINGS = new Set([10, 20, 25, 30, 40, 50, 60, 65, 70, 75, 80]);

/** A round birthday (every tenth from the 10th) or a jubilee wedding
 *  anniversary — the days a calendar should not let anyone miss. Memorial
 *  days never count. */
export function isRoundAnniversary(e: DayEntry): boolean {
  if (e.years === undefined) return false;
  if (e.kind === "birthday") return e.years >= 10 && e.years % 10 === 0;
  if (e.kind === "anniversary") return ROUND_WEDDINGS.has(e.years);
  return false;
}

/** How round an anniversary is: a centenary beats a jubilee beats a decade. */
function roundness(yearsAgo: number): number {
  if (yearsAgo % 100 === 0) return 5;
  if (yearsAgo % 50 === 0) return 4;
  if (yearsAgo % 25 === 0) return 3;
  if (yearsAgo % 10 === 0) return 2;
  if (yearsAgo % 5 === 0) return 1;
  return 0;
}

/** The weeks of a month, Monday first: each row seven day numbers, 0 for a blank. */
export function monthWeeks(year: number, month: number): number[][] {
  const first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const days = daysIn(year, month);
  const cells = [...Array(first).fill(0), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(0);
  const weeks: number[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

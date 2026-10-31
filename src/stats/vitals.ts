import { foldSearch } from "../ui/globalSearch";
import type { PersonFacts } from "./facts";
import type { ScopedFacts } from "./scope";
import {
  ageAtDeathOf,
  birthYearOf,
  rankText,
  centuryOf,
  byMonth,
  mean,
  share,
  type Bucket,
  type Mean,
  type Share,
} from "./aggregate";

/**
 * The Birth, Death and Occupation pages: the same group-bys as the other
 * pages, over the dates, places, causes and occupations the fact rows carry.
 */

/** The periods a span of years is cut into, finest first. */
const PERIODS = [10, 25, 50, 100];
/** At most this many columns: a file reaching back a thousand years counts by century. */
const MAX_PERIODS = 40;

/**
 * Rows per period, from the first period with any to the last, empty ones kept.
 * The period is the finest of decade, quarter-century, half-century and
 * century that fits the span in {@link MAX_PERIODS} columns.
 */
export function byPeriod<T>(rows: T[], yearOf: (r: T) => number | undefined, idOf: (r: T) => string): Bucket[] {
  const dated: [number, string][] = [];
  for (const r of rows) {
    const y = yearOf(r);
    if (y !== undefined) dated.push([y, idOf(r)]);
  }
  if (!dated.length) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const [y] of dated) { min = Math.min(min, y); max = Math.max(max, y); }
  const width = PERIODS.find((w) => Math.floor(max / w) - Math.floor(min / w) < MAX_PERIODS) ?? PERIODS[PERIODS.length - 1];
  const first = Math.floor(min / width) * width;
  const out: Bucket[] = [];
  for (let lo = first; lo <= max; lo += width) out.push({ key: String(lo), lo, hi: lo + width - 1, count: 0, ids: [] });
  for (const [y, id] of dated) {
    const b = out[Math.floor((y - first) / width)];
    b.count++;
    b.ids.push(id);
  }
  return out;
}

/** The few spans a baptism delay is read in: the same day, the next, the one
 *  after, within the week, the month, and later. */
function baptismBuckets(people: PersonFacts[]): Bucket[] {
  const spans: [string, number, number | undefined][] = [
    ["0", 0, 0], ["1", 1, 1], ["2", 2, 2], ["3", 3, 7], ["8", 8, 30], ["31", 31, undefined],
  ];
  const out: Bucket[] = spans.map(([key, lo, hi]) => ({ key, lo, hi, count: 0, ids: [] }));
  for (const p of people) {
    const days = p.baptismDays!;
    const b = out.find((x) => days >= x.lo! && (x.hi === undefined || days <= x.hi));
    if (!b) continue; // a baptism before the birth is the health check's to report
    b.count++;
    b.ids.push(p.id);
  }
  return out;
}

const deathYearOf = (s: ScopedFacts) => (p: PersonFacts) => (s.approx || !p.deathApprox ? p.deathYear : undefined);
const id = (p: PersonFacts) => p.id;

// ---------------------------------------------------------------------------
// Birth

export interface BirthStats {
  perPeriod: Bucket[];
  byMonth: Bucket[];
  /** Days from birth to baptism, for those whose both dates name the day. */
  baptism: Bucket[];
  baptismMean?: Mean;
  /** Children of one family born on the same day, in pairs (twins) and in sets
   *  of three or more: how many sets, and the families they were born into. */
  twins: MultipleBirths;
  multiples: MultipleBirths;
  places: Bucket[];
}

export interface MultipleBirths {
  sets: number;
  /** Each family once, however many sets it had. */
  families: string[];
}

function multipleBirths(sets: { family: string; children: string[] }[]): MultipleBirths {
  return { sets: sets.length, families: [...new Set(sets.map((set) => set.family))] };
}

export function birthStats(s: ScopedFacts): BirthStats {
  const year = birthYearOf(s);
  const withBaptism = s.people.filter((p) => p.baptismDays !== undefined && p.baptismDays >= 0);
  // Twins: siblings in scope sharing a family and an exact birth day.
  const sets = new Map<string, { family: string; children: string[] }>();
  for (const f of s.families) {
    for (const child of f.children) {
      const p = s.byId.get(child);
      if (!p?.birthDay || !s.ids.has(child)) continue;
      const key = `${f.id}|${p.birthDay}`;
      const set = sets.get(key);
      if (set) set.children.push(child);
      else sets.set(key, { family: f.id, children: [child] });
    }
  }
  const all = [...sets.values()];
  const pairs = all.filter((set) => set.children.length === 2);
  const larger = all.filter((set) => set.children.length > 2);
  return {
    perPeriod: byPeriod(s.people, year, id),
    byMonth: byMonth(s.people, (p) => (s.approx || !p.birthApprox ? p.birthMonth : undefined), id),
    baptism: baptismBuckets(withBaptism),
    baptismMean: mean(withBaptism.map((p) => p.baptismDays!)),
    twins: multipleBirths(pairs),
    multiples: multipleBirths(larger),
    places: rankText(s.people, (p) => [p.birthPlace], id),
  };
}

// ---------------------------------------------------------------------------
// Death

/** An average age per cause of death, with the people it was taken over. */
export interface CauseAge {
  key: string;
  label: string;
  value: number;
  ids: string[];
}

/** A cause needs this many dated deaths before its average age is shown. */
export const CAUSE_AGE_MIN = 3;

export interface DeathStats {
  causes: Bucket[];
  /** The deceased with a cause recorded, of all the deceased. */
  withCause: Share;
  ageByCause: CauseAge[];
  perPeriod: Bucket[];
  byMonth: Bucket[];
  places: Bucket[];
}

export function deathStats(s: ScopedFacts): DeathStats {
  const age = ageAtDeathOf(s);
  const deceased = s.people.filter((p) => p.deceased);
  const causes = rankText(deceased, (p) => [p.cause], id);
  const ageByCause: CauseAge[] = [];
  for (const c of causes) {
    const dated = c.ids.filter((pid) => age(s.byId.get(pid)!) !== undefined);
    if (dated.length < CAUSE_AGE_MIN) continue;
    const m = mean(dated.map((pid) => age(s.byId.get(pid)!)!))!;
    ageByCause.push({ key: c.key, label: c.label!, value: m.value, ids: dated });
  }
  return {
    causes,
    withCause: share(deceased, (p) => !!p.cause),
    ageByCause,
    perPeriod: byPeriod(s.people, deathYearOf(s), id),
    byMonth: byMonth(s.people, (p) => (s.approx || !p.deathApprox ? p.deathMonth : undefined), id),
    places: rankText(s.people, (p) => [p.deathPlace], id),
  };
}

// ---------------------------------------------------------------------------
// Occupation

export interface OccupationStats {
  occupations: Bucket[];
  /** The people with any occupation recorded, of everyone in scope. */
  withOccupation: Share;
  /** The most common occupations per century of birth. */
  byCentury: { century: number; top: Bucket[] }[];
  /** Sons whose occupations include one of their father's, of the sons where both have one. */
  sonFather: Share;
}

export function occupationStats(s: ScopedFacts): OccupationStats {
  const year = birthYearOf(s);
  const centuries = new Map<number, PersonFacts[]>();
  for (const p of s.people) {
    const y = year(p);
    if (y === undefined || !p.occupations.length) continue;
    const c = centuryOf(y);
    let list = centuries.get(c);
    if (!list) centuries.set(c, (list = []));
    list.push(p);
  }
  const keys = (p: PersonFacts | undefined) => new Set((p?.occupations ?? []).map((o) => foldSearch(o)));
  const sons = s.people.filter((p) => p.sex === "M" && p.occupations.length && p.father && s.byId.get(p.father)?.occupations.length);
  return {
    occupations: rankText(s.people, (p) => p.occupations, id),
    withOccupation: share(s.people, (p) => p.occupations.length > 0),
    byCentury: [...centuries]
      .sort((a, b) => a[0] - b[0])
      .map(([century, list]) => ({ century, top: rankText(list, (p) => p.occupations, id).slice(0, 5) })),
    sonFather: share(sons, (p) => {
      const father = keys(s.byId.get(p.father!));
      return [...keys(p)].some((k) => father.has(k));
    }),
  };
}

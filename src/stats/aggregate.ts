import { foldSearch } from "../ui/globalSearch";

import type { FamilyFacts, PersonFacts } from "./facts";
import type { ScopedFacts } from "./scope";

/**
 * The statistics themselves: group-bys over the scoped fact rows. Every number
 * keeps the ids it was counted from, so a click on a bar can list the people
 * behind it, and every measure says how many rows it rests on (`n`), so a chart
 * never hides how much of the scope it actually covers.
 */

/** One bar: what it counts and who it counted. */
export interface Bucket {
  key: string;
  /** The bar's label, where it is data (a name) rather than a range the UI words. */
  label?: string;
  /** The range a numeric bucket covers, inclusive; `hi` undefined = open-ended. */
  lo?: number;
  hi?: number;
  count: number;
  ids: string[];
}

/** An average and what it was taken over. */
export interface Mean {
  value: number;
  n: number;
}

/** A bucket of a series over time: an average or a share over its rows. */
export interface PeriodPoint {
  /** First and last year of the period (1800 and 1824 for 1800–1824). */
  from: number;
  to: number;
  value: number;
  n: number;
  /** The rows the value was taken over (a share's numerator, for shares). */
  ids: string[];
}

/** A share of a population: `ids` are those who *have* it, `missing` those who don't. */
export interface Share {
  n: number;
  of: number;
  ids: string[];
  missing: string[];
}

export function mean(values: number[]): Mean | undefined {
  if (!values.length) return undefined;
  return { value: values.reduce((a, b) => a + b, 0) / values.length, n: values.length };
}

export function share<T extends { id: string }>(rows: T[], test: (r: T) => boolean): Share {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const r of rows) (test(r) ? ids : missing).push(r.id);
  return { n: ids.length, of: rows.length, ids, missing };
}

export const centuryOf = (year: number) => Math.floor(year / 100) * 100;
/** Ties between equally common names fall back to alphabetical order. */
export const byLabel = new Intl.Collator();

/**
 * Rank text values by frequency, accent- and case-blind: "Novak", "NOVAK" and
 * "Nóvak" count as one, labelled by the spelling the file uses most.
 */
export function rankNames(rows: PersonFacts[], part: "given" | "surname"): Bucket[] {
  const groups = new Map<string, { ids: string[]; spellings: Map<string, number> }>();
  for (const p of rows) {
    const v = p[part];
    const key = part === "given" ? p.givenKey : p.surnameKey;
    if (!v || !key) continue;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { ids: [], spellings: new Map() }));
    g.ids.push(p.id);
    g.spellings.set(v, (g.spellings.get(v) ?? 0) + 1);
  }
  const out: Bucket[] = [];
  for (const [key, g] of groups) {
    let label = "";
    let best = -1;
    for (const [s, c] of g.spellings) if (c > best) { best = c; label = s; }
    out.push({ key, label, count: g.ids.length, ids: g.ids });
  }
  return out.sort((a, b) => b.count - a.count || byLabel.compare(a.label!, b.label!));
}

/**
 * Rank free text by frequency, accent- and case-blind, each row counted once
 * per distinct value — places, causes of death, occupations. Labelled by the
 * spelling the file uses most.
 */
/** Birth countries by frequency, over the people with a birth place: the key is the
 *  country facet, `""` for a place naming no country the file can tell. */
export function rankCountries(people: PersonFacts[]): Bucket[] {
  const groups = new Map<string, string[]>();
  for (const p of people) {
    if (!p.birthPlace) continue;
    const ids = groups.get(p.birthCountry);
    if (ids) ids.push(p.id);
    else groups.set(p.birthCountry, [p.id]);
  }
  return [...groups]
    .map(([key, ids]) => ({ key, count: ids.length, ids }))
    .sort((a, b) => b.count - a.count || byLabel.compare(a.key, b.key))
    .slice(0, OVERVIEW_TOP);
}

export function rankText<T>(rows: T[], valuesOf: (r: T) => (string | undefined)[], idOf: (r: T) => string): Bucket[] {
  const folded = new Map<string, string>();
  const groups = new Map<string, { ids: string[]; spellings: Map<string, number> }>();
  for (const r of rows) {
    const seen = new Set<string>();
    for (const raw of valuesOf(r)) {
      const v = raw?.trim();
      if (!v) continue;
      let key = folded.get(v);
      if (key === undefined) folded.set(v, (key = foldSearch(v)));
      if (seen.has(key)) continue;
      seen.add(key);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { ids: [], spellings: new Map() }));
      g.ids.push(idOf(r));
      g.spellings.set(v, (g.spellings.get(v) ?? 0) + 1);
    }
  }
  const out: Bucket[] = [];
  for (const [key, g] of groups) {
    let label = "";
    let best = -1;
    for (const [s, c] of g.spellings) if (c > best) { best = c; label = s; }
    out.push({ key, label, count: g.ids.length, ids: g.ids });
  }
  return out.sort((a, b) => b.count - a.count || byLabel.compare(a.label!, b.label!));
}
/**
 * Numeric values into fixed-width bins `[start, start+width)` up to `end`, with
 * an open bin for everything from `end` on and, when `under` is set, one for
 * everything below `start`. Empty bins are kept, so the axis has no gaps.
 */
export function histogram<T>(
  rows: T[],
  valueOf: (r: T) => number | undefined,
  idOf: (r: T) => string,
  { start, width, end, under = false }: { start: number; width: number; end: number; under?: boolean },
): Bucket[] {
  const bins: Bucket[] = [];
  if (under) bins.push({ key: `<${start}`, hi: start - 1, count: 0, ids: [] });
  for (let lo = start; lo < end; lo += width) bins.push({ key: `${lo}`, lo, hi: lo + width - 1, count: 0, ids: [] });
  bins.push({ key: `${end}+`, lo: end, count: 0, ids: [] });
  const offset = under ? 1 : 0;
  for (const r of rows) {
    const v = valueOf(r);
    if (v === undefined) continue;
    const i = v < start ? (under ? 0 : -1) : v >= end ? bins.length - 1 : offset + Math.floor((v - start) / width);
    if (i < 0) continue;
    bins[i].count++;
    bins[i].ids.push(idOf(r));
  }
  return bins;
}

/** Rows per calendar month, January to December. */
export function byMonth<T>(rows: T[], monthOf: (r: T) => number | undefined, idOf: (r: T) => string): Bucket[] {
  const months = histogram(rows, monthOf, idOf, { start: 1, width: 1, end: 13 });
  months.pop(); // no month 13
  return months;
}

/** The periods a span of years is cut into, finest first. */
const PERIODS = [10, 25, 50, 100];
/** At most this many columns: a file reaching back a thousand years counts by century. */
const MAX_PERIODS = 40;

/** The finest of `widths` that cuts `min`–`max` into fewer than `most` periods; the coarsest otherwise. */
function periodWidth(min: number, max: number, widths: number[], most: number): number {
  return widths.find((w) => Math.floor(max / w) - Math.floor(min / w) < most) ?? widths[widths.length - 1];
}

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
  const width = periodWidth(min, max, PERIODS, MAX_PERIODS);
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

/** The periods an average over time is cut into, finest first: a decade's
 *  average rests on too few lives to read. */
const MEAN_PERIODS = [25, 50, 100];
/** At most this many columns of averages. */
const MAX_MEAN_PERIODS = 20;
/** A period with fewer rows than this has no average: a life or two say nothing of their time. */
export const MIN_PERIOD_ROWS = 5;

/** The period width for averages over the years these rows have. */
export function meanPeriodWidth<T>(rows: T[], yearOf: (r: T) => number | undefined): number {
  let min = Infinity;
  let max = -Infinity;
  for (const r of rows) {
    const y = yearOf(r);
    if (y === undefined) continue;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return min > max ? MEAN_PERIODS[0] : periodWidth(min, max, MEAN_PERIODS, MAX_MEAN_PERIODS);
}

/** Rows grouped by the period of their year, earliest first; rows without a year are left out. */
export function groupByPeriod<T>(rows: T[], yearOf: (r: T) => number | undefined, width: number): { from: number; to: number; rows: T[] }[] {
  const groups = new Map<number, T[]>();
  for (const r of rows) {
    const y = yearOf(r);
    if (y === undefined) continue;
    const from = Math.floor(y / width) * width;
    let g = groups.get(from);
    if (!g) groups.set(from, (g = []));
    g.push(r);
  }
  return [...groups].sort((a, b) => a[0] - b[0]).map(([from, g]) => ({ from, to: from + width - 1, rows: g }));
}

/** An average per period of a year, over the rows that have both; periods
 *  with fewer than {@link MIN_PERIOD_ROWS} rows, or that `keep` refuses, are left out. */
export function meanByPeriod<T>(
  rows: T[],
  yearOf: (r: T) => number | undefined,
  valueOf: (r: T) => number | undefined,
  idOf: (r: T) => string,
  width: number,
  keep: (from: number, to: number) => boolean = () => true,
): PeriodPoint[] {
  const out: PeriodPoint[] = [];
  for (const { from, to, rows: g } of groupByPeriod(rows.filter((r) => valueOf(r) !== undefined), yearOf, width)) {
    if (g.length < MIN_PERIOD_ROWS || !keep(from, to)) continue;
    let sum = 0;
    for (const r of g) sum += valueOf(r)!;
    out.push({ from, to, value: sum / g.length, n: g.length, ids: g.map(idOf) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-row readings that honour the scope's "approximate dates" switch.

export const birthYearOf = (s: ScopedFacts) => (p: PersonFacts) => (s.approx || !p.birthApprox ? p.birthYear : undefined);
export const ageAtDeathOf = (s: ScopedFacts) => (p: PersonFacts) =>
  s.approx || !(p.birthApprox || p.deathApprox) ? p.ageAtDeath : undefined;

// ---------------------------------------------------------------------------
// Overview

/** How many names the overview ranks — as many rows as its completeness card has. */
export const OVERVIEW_TOP = 8;

export interface Overview {
  people: number;
  families: number;
  male: string[];
  female: string[];
  unknownSex: string[];
  living: string[];
  deceased: string[];
  firstBirth?: { year: number; id: string };
  lastBirth?: { year: number; id: string };
  surnames: number;
  givenNames: number;
  countries: number;
  /** Distinct places, cited sources and linked media of the scope's people and their families. */
  places: number;
  sources: number;
  media: number;
  completeness: {
    name: Share;
    birthDate: Share;
    birthPlace: Share;
    deathDate: Share;
    parents: Share;
    place: Share;
    mapped: Share;
    source: Share;
  };
  topSurnames: Bucket[];
  topGivenMale: Bucket[];
  topGivenFemale: Bucket[];
  topBirthPlaces: Bucket[];
  topBirthCountries: Bucket[];
  ageAtDeath?: Mean;
  /** The oldest man and woman at death. */
  oldestMale?: { id: string; age: number };
  oldestFemale?: { id: string; age: number };
  largestFamily?: { id: string; children: number };
  /** The man and the woman with the most children over all their unions. */
  mostChildrenMale?: { id: string; children: number };
  mostChildrenFemale?: { id: string; children: number };
  childrenPerFamily?: Mean;
}

/** How many distinct places, sources and media the scope's records name. */
function distinctRefs(s: ScopedFacts): { places: number; sources: number; media: number } {
  const places = new Set<string>();
  const sources = new Set<string>();
  const media = new Set<string>();
  for (const { refs } of [...s.people, ...s.families]) {
    for (const v of refs.places) places.add(v);
    for (const v of refs.sources) sources.add(v);
    for (const v of refs.media) media.add(v);
  }
  return { places: places.size, sources: sources.size, media: media.size };
}

export function overview(s: ScopedFacts): Overview {
  const male: string[] = [];
  const female: string[] = [];
  const unknownSex: string[] = [];
  const living: string[] = [];
  const deceased: string[] = [];
  let firstBirth: Overview["firstBirth"];
  let lastBirth: Overview["lastBirth"];
  let oldestMale: Overview["oldestMale"];
  let oldestFemale: Overview["oldestFemale"];
  const countries = new Set<string>();
  const ages: number[] = [];
  const by = birthYearOf(s);
  const age = ageAtDeathOf(s);
  for (const p of s.people) {
    (p.sex === "M" ? male : p.sex === "F" ? female : unknownSex).push(p.id);
    if (p.deceased) deceased.push(p.id);
    else if (p.living) living.push(p.id);
    const y = by(p);
    if (y !== undefined) {
      if (!firstBirth || y < firstBirth.year) firstBirth = { year: y, id: p.id };
      if (!lastBirth || y > lastBirth.year) lastBirth = { year: y, id: p.id };
    }
    if (p.country) countries.add(p.country);
    const a = age(p);
    if (a !== undefined) {
      ages.push(a);
      if (p.sex === "M" && (!oldestMale || a > oldestMale.age)) oldestMale = { id: p.id, age: a };
      if (p.sex === "F" && (!oldestFemale || a > oldestFemale.age)) oldestFemale = { id: p.id, age: a };
    }
  }
  let largestFamily: Overview["largestFamily"];
  // A parent's children over all their unions, each child once.
  const childrenOf = new Map<string, Set<string>>();
  for (const f of s.families) {
    if (!largestFamily || f.children.length > largestFamily.children) largestFamily = { id: f.id, children: f.children.length };
    for (const parent of [f.husband, f.wife]) {
      if (!parent || !s.ids.has(parent)) continue;
      let kids = childrenOf.get(parent);
      if (!kids) childrenOf.set(parent, (kids = new Set()));
      for (const child of f.children) kids.add(child);
    }
  }
  const mostChildren = (sex: "M" | "F") => {
    let best: { id: string; children: number } | undefined;
    for (const [id, kids] of childrenOf) {
      if (s.byId.get(id)?.sex !== sex || !kids.size) continue;
      if (!best || kids.size > best.children) best = { id, children: kids.size };
    }
    return best;
  };
  const surnames = rankNames(s.people, "surname");
  const givens = new Set(s.people.map((p) => p.givenKey).filter(Boolean));
  return {
    people: s.people.length,
    families: s.families.length,
    male,
    female,
    unknownSex,
    living,
    deceased,
    firstBirth,
    lastBirth,
    surnames: surnames.length,
    givenNames: givens.size,
    countries: countries.size,
    ...distinctRefs(s),
    completeness: {
      name: share(s.people, (p) => p.hasName),
      birthDate: share(s.people, (p) => p.hasBirthDate),
      birthPlace: share(s.people, (p) => p.hasBirthPlace),
      deathDate: share(s.people.filter((p) => p.deceased), (p) => p.hasDeathDate),
      parents: share(s.people, (p) => p.hasParents),
      place: share(s.people, (p) => p.hasPlace),
      mapped: share(s.people, (p) => p.mapped),
      source: share(s.people, (p) => p.hasSource),
    },
    topSurnames: surnames.slice(0, OVERVIEW_TOP),
    topGivenMale: rankNames(s.people.filter((p) => p.sex === "M"), "given").slice(0, OVERVIEW_TOP),
    topGivenFemale: rankNames(s.people.filter((p) => p.sex === "F"), "given").slice(0, OVERVIEW_TOP),
    topBirthPlaces: rankText(s.people, (p) => [p.birthPlace], (p) => p.id).slice(0, OVERVIEW_TOP),
    topBirthCountries: rankCountries(s.people),
    ageAtDeath: mean(ages),
    oldestMale,
    oldestFemale,
    largestFamily: largestFamily && largestFamily.children > 0 ? largestFamily : undefined,
    mostChildrenMale: mostChildren("M"),
    mostChildrenFemale: mostChildren("F"),
    childrenPerFamily: mean(s.families.map((f) => f.children.length)),
  };
}

// ---------------------------------------------------------------------------
// Names

export interface NamesStats {
  surnames: Bucket[];
  givenMale: Bucket[];
  givenFemale: Bucket[];
  /** The most-used given names per century of birth, by sex. */
  byCentury: { century: number; male: Bucket[]; female: Bucket[] }[];
  /** How many given names people carry: one, two, three or more. */
  givenCount: Bucket[];
  /** Children whose first given name repeats a parent's or a grandparent's. */
  namesakes: {
    sonFather: Share;
    sonGrandfather: Share;
    daughterMother: Share;
    daughterGrandmother: Share;
  };
}

/** People per kind of additional name, and those whose primary name lacks
 *  a given name or a surname (blank or a stand-in such as NN) — a Research card. */
export interface NameKinds {
  noGiven: string[];
  noSurname: string[];
  types: Bucket[];
}

export function nameKindsStats(s: ScopedFacts): NameKinds {
  return {
    noGiven: s.people.filter((p) => !p.given).map((p) => p.id),
    noSurname: s.people.filter((p) => !p.surname).map((p) => p.id),
    types: rankText(s.people, (p) => p.nameTypes, (p) => p.id),
  };
}

export function namesStats(s: ScopedFacts): NamesStats {
  const by = birthYearOf(s);
  const centuries = new Map<number, PersonFacts[]>();
  for (const p of s.people) {
    const y = by(p);
    if (y === undefined || !p.given) continue;
    const c = centuryOf(y);
    let list = centuries.get(c);
    if (!list) centuries.set(c, (list = []));
    list.push(p);
  }
  // Each test counts only the children for whom the comparison can be made at
  // all: a named child and at least one named parent (or grandparent) of the
  // side in question. One pass reads each child's kin once.
  const empty = (): Share => ({ n: 0, of: 0, ids: [], missing: [] });
  const namesakes = { sonFather: empty(), sonGrandfather: empty(), daughterMother: empty(), daughterGrandmother: empty() };
  const tally = (target: Share, child: PersonFacts, keys: (string | undefined)[]) => {
    if (!keys.some(Boolean)) return;
    target.of++;
    if (keys.includes(child.givenKey)) { target.n++; target.ids.push(child.id); } else target.missing.push(child.id);
  };
  for (const p of s.people) {
    if (!p.givenKey || (p.sex !== "M" && p.sex !== "F")) continue;
    const father = p.father ? s.byId.get(p.father) : undefined;
    const mother = p.mother ? s.byId.get(p.mother) : undefined;
    if (!father && !mother) continue;
    const side = p.sex === "M" ? "father" : "mother";
    const grand = [father?.[side], mother?.[side]].map((id) => (id ? s.byId.get(id)?.givenKey : undefined));
    if (p.sex === "M") {
      tally(namesakes.sonFather, p, [father?.givenKey]);
      tally(namesakes.sonGrandfather, p, grand);
    } else {
      tally(namesakes.daughterMother, p, [mother?.givenKey]);
      tally(namesakes.daughterGrandmother, p, grand);
    }
  }
  const withGiven = s.people.filter((p) => p.givenCount > 0);
  return {
    surnames: rankNames(s.people, "surname"),
    givenMale: rankNames(s.people.filter((p) => p.sex === "M"), "given"),
    givenFemale: rankNames(s.people.filter((p) => p.sex === "F"), "given"),
    byCentury: [...centuries]
      .sort((a, b) => a[0] - b[0])
      .map(([century, list]) => ({
        century,
        male: rankNames(list.filter((p) => p.sex === "M"), "given").slice(0, 5),
        female: rankNames(list.filter((p) => p.sex === "F"), "given").slice(0, 5),
      })),
    givenCount: histogram(withGiven, (p) => p.givenCount, (p) => p.id, { start: 1, width: 1, end: 3 }),
    namesakes,
  };
}

// ---------------------------------------------------------------------------
// Lifespan

/** Deaths before this age count as child mortality. */
export const CHILD_AGE = 5;
/** A child who reached this age grew up. */
export const ADULT_AGE = 18;

/** A period's families with children: how many of them grew up, how many died young, on average. */
export interface SurvivalPoint {
  from: number;
  to: number;
  /** Families counted. */
  n: number;
  grown: number;
  died: number;
  grownIds: string[];
  diedIds: string[];
}

/** A birth period whose living outnumber this share of its people is still
 *  dying young: its average age at death would read far too low. */
const LIVING_SHARE = 0.25;

export interface LifespanStats {
  /** Age at death in five-year bins. */
  ageAtDeath: Bucket[];
  /** The same, and the average per period of birth, for men and for women apart. */
  ageAtDeathMale: Bucket[];
  ageAtDeathFemale: Bucket[];
  byPeriodMale: PeriodPoint[];
  byPeriodFemale: PeriodPoint[];
  all?: Mean;
  male?: Mean;
  female?: Mean;
  /** Average age at death per period of birth (see {@link meanPeriodWidth}).
   *  Periods whose people mostly still live are left out. */
  byPeriod: PeriodPoint[];
  /** The same, over those who lived to {@link CHILD_AGE}. */
  byPeriodAdults: PeriodPoint[];
  /** The share (percent) of the dead who died before {@link CHILD_AGE}, per period of birth. */
  childDeaths: PeriodPoint[];
  /** Per period of the family: children who reached {@link ADULT_AGE} and
   *  children who died before it, per family with children. A child with no
   *  dated death counts as grown when married or living past that age, and
   *  is left out otherwise. A period whose children cannot all be grown yet is left out. */
  childSurvival: SurvivalPoint[];
  oldest: { id: string; age: number }[];
}

/** A family period whose last year lies within {@link ADULT_AGE} years of now
 *  still has children growing up: no reading. */
const grownBy = (thisYear: number) => (_from: number, to: number) => to <= thisYear - ADULT_AGE;

export function lifespanStats(s: ScopedFacts): LifespanStats {
  const age = ageAtDeathOf(s);
  const by = birthYearOf(s);
  const dated = s.people.filter((p) => age(p) !== undefined);
  const id = (p: PersonFacts) => p.id;
  const width = meanPeriodWidth(dated, by);
  // Birth periods still mostly alive: their dead are the ones who died young.
  const living = new Set<number>();
  for (const { from, rows } of groupByPeriod(s.people, by, width)) {
    if (rows.filter((p) => p.living).length > LIVING_SHARE * rows.length) living.add(from);
  }
  const keep = (from: number) => !living.has(from);
  const childDeaths: PeriodPoint[] = [];
  for (const { from, to, rows } of groupByPeriod(dated, by, width)) {
    if (rows.length < MIN_PERIOD_ROWS || !keep(from)) continue;
    const ids = rows.filter((p) => age(p)! < CHILD_AGE).map(id);
    childDeaths.push({ from, to, value: (100 * ids.length) / rows.length, n: rows.length, ids });
  }
  const thisYear = new Date().getFullYear();
  const famYear = (f: FamilyFacts) => (s.approx || !f.yearApprox ? f.year : undefined);
  const withChildren = s.families.filter((f) => f.children.length);
  const grown = grownBy(thisYear);
  const childSurvival: SurvivalPoint[] = [];
  for (const { from, to, rows } of groupByPeriod(withChildren, famYear, meanPeriodWidth(withChildren, famYear))) {
    if (rows.length < MIN_PERIOD_ROWS || !grown(from, to)) continue;
    const grownIds: string[] = [];
    const diedIds: string[] = [];
    for (const f of rows) {
      for (const childId of f.children) {
        const child = s.byId.get(childId);
        if (!child) continue;
        const a = age(child);
        const born = by(child);
        if (a !== undefined && a < ADULT_AGE) diedIds.push(childId);
        else if (a !== undefined || child.married || (child.living && born !== undefined && thisYear - born >= ADULT_AGE)) grownIds.push(childId);
      }
    }
    const n = rows.length;
    childSurvival.push({ from, to, n, grown: grownIds.length / n, died: diedIds.length / n, grownIds, diedIds });
  }
  const meanAge = (rows: PersonFacts[]) => meanByPeriod(rows, by, age, id, width, keep);
  return {
    ageAtDeath: histogram(dated, age, id, { start: 0, width: 5, end: 100 }),
    ageAtDeathMale: histogram(dated.filter((p) => p.sex === "M"), age, id, { start: 0, width: 5, end: 100 }),
    ageAtDeathFemale: histogram(dated.filter((p) => p.sex === "F"), age, id, { start: 0, width: 5, end: 100 }),
    all: mean(dated.map((p) => age(p)!)),
    male: mean(dated.filter((p) => p.sex === "M").map((p) => age(p)!)),
    female: mean(dated.filter((p) => p.sex === "F").map((p) => age(p)!)),
    byPeriod: meanAge(dated),
    byPeriodMale: meanAge(dated.filter((p) => p.sex === "M")),
    byPeriodFemale: meanAge(dated.filter((p) => p.sex === "F")),
    byPeriodAdults: meanAge(dated.filter((p) => age(p)! >= CHILD_AGE)),
    childDeaths,
    childSurvival,
    oldest: dated
      .map((p) => ({ id: p.id, age: age(p)! }))
      .sort((a, b) => b.age - a.age)
      .slice(0, 10),
  };
}

// ---------------------------------------------------------------------------
// Marriage & families

export interface FamilyStats {
  /** Age at first marriage, men and women, in five-year bins; ids are the spouses. */
  firstMarriageMale: Bucket[];
  firstMarriageFemale: Bucket[];
  firstMarriageMaleMean?: Mean;
  firstMarriageFemaleMean?: Mean;
  /** Husband's age minus wife's, at the marriage; ids are families. */
  ageGap: Bucket[];
  /** Children per family; ids are families. */
  children: Bucket[];
  /** Average children per family, per period of the family; a period whose families may still grow is left out. */
  childrenByPeriod: PeriodPoint[];
  /** Unions per person among the scoped people who have one; ids are people. */
  unionsPerPerson: Bucket[];
  /** The person in scope with the most unions; ties go to the first found. */
  mostUnions?: { id: string; count: number };
  childrenMean?: Mean;
  /** Marriages per period of years (see {@link byPeriod}); ids are families. */
  marriagesPerPeriod: Bucket[];
  /** Marriages per calendar month (1–12); ids are families. */
  marriageMonth: Bucket[];
  /** Marriage places, most frequent first; ids are families. */
  marriagePlaces: Bucket[];
  /** Months from marriage to the first child; ids are families. */
  firstChild: Bucket[];
  /** Mother's age at her first and last child in the family; ids are families. */
  motherFirst: Bucket[];
  motherLast: Bucket[];
}

export function familyStats(s: ScopedFacts): FamilyStats {
  const famId = (f: FamilyFacts) => f.id;
  const agesOk = (f: FamilyFacts) => s.approx || !f.agesApprox;
  const parentsOk = (f: FamilyFacts) => s.approx || !f.parentAgesApprox;
  // A first marriage counts for the spouse only when the spouse is in scope:
  // a "women only" scope says nothing about the husbands' ages.
  const firstMen = s.families.filter((f) => f.husbandFirst && f.husband && s.ids.has(f.husband) && agesOk(f));
  const firstWomen = s.families.filter((f) => f.wifeFirst && f.wife && s.ids.has(f.wife) && agesOk(f));
  const marriageBins = { start: 15, width: 5, end: 50, under: true };
  const unions = new Map<string, number>();
  for (const f of s.families) {
    for (const spouse of [f.husband, f.wife]) {
      if (spouse && s.ids.has(spouse)) unions.set(spouse, (unions.get(spouse) ?? 0) + 1);
    }
  }
  const gapFamilies = s.families.filter(
    (f) => f.husbandAge !== undefined && f.wifeAge !== undefined && agesOk(f),
  );
  const dated = s.families.filter((f) => f.marriageMonth !== undefined && (s.approx || !f.marriageApprox));
  const month = byMonth(dated, (f) => f.marriageMonth, famId);
  const famYear = (f: FamilyFacts) => (s.approx || !f.yearApprox ? f.year : undefined);
  return {
    firstMarriageMale: histogram(firstMen, (f) => f.husbandAge, (f) => f.husband!, marriageBins),
    firstMarriageFemale: histogram(firstWomen, (f) => f.wifeAge, (f) => f.wife!, marriageBins),
    firstMarriageMaleMean: mean(firstMen.flatMap((f) => (f.husbandAge !== undefined ? [f.husbandAge] : []))),
    firstMarriageFemaleMean: mean(firstWomen.flatMap((f) => (f.wifeAge !== undefined ? [f.wifeAge] : []))),
    ageGap: histogram(gapFamilies, (f) => f.husbandAge! - f.wifeAge!, famId, { start: -10, width: 5, end: 20, under: true }),
    children: histogram(s.families, (f) => f.children.length, famId, { start: 0, width: 1, end: 13 }),
    childrenByPeriod: meanByPeriod(s.families, famYear, (f) => f.children.length, famId, meanPeriodWidth(s.families, famYear), grownBy(new Date().getFullYear())),
    unionsPerPerson: histogram([...unions], ([, n]) => n, ([id]) => id, { start: 1, width: 1, end: 3 }),
    mostUnions: [...unions].reduce<{ id: string; count: number } | undefined>((best, [id, count]) => (!best || count > best.count ? { id, count } : best), undefined),
    childrenMean: mean(s.families.map((f) => f.children.length)),
    marriageMonth: month,
    marriagesPerPeriod: byPeriod(s.families, (f) => (s.approx || !f.marriageApprox ? f.marriageYear : undefined), famId),
    marriagePlaces: rankText(s.families, (f) => [f.marriagePlace], famId),
    firstChild: firstChildBuckets(s.families.filter((f) => f.firstChildMonths !== undefined && (s.approx || !(f.marriageApprox || f.firstChildApprox)))),
    motherFirst: histogram(s.families.filter(parentsOk), (f) => f.motherAgeFirst, famId, marriageBins),
    motherLast: histogram(s.families.filter(parentsOk), (f) => f.motherAgeLast, famId, marriageBins),
  };
}

/** Months from marriage to the first birth, in the spans the question turns on:
 *  born before the wedding, within eight months of it, within the first year,
 *  the second, and later. */
function firstChildBuckets(families: FamilyFacts[]): Bucket[] {
  const spans: [string, number | undefined, number | undefined][] = [
    ["before", undefined, -1],
    ["0", 0, 7],
    ["8", 8, 11],
    ["12", 12, 23],
    ["24", 24, undefined],
  ];
  const out: Bucket[] = spans.map(([key, lo, hi]) => ({ key, lo, hi, count: 0, ids: [] }));
  for (const f of families) {
    const m = f.firstChildMonths!;
    const b = out.find((x) => (x.lo === undefined || m >= x.lo) && (x.hi === undefined || m <= x.hi))!;
    b.count++;
    b.ids.push(f.id);
  }
  return out;
}

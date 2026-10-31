import type { Dataset, GedDate, GedEvent, GedNode, Individual } from "../gedcom/types";
import { BIRTH_TAGS, DEATH_TAGS, isApproximate, isDeceased, isPresumedLiving } from "../gedcom/lifespan";
import { ageBetween } from "../gedcom/age";
import { countryOf } from "../tools/geocode";
import { foldSearch } from "../ui/globalSearch";
import { isUnknownNameToken } from "../gedcom/name";
import { placeKeysOf } from "../tools/places";
import { isPointer } from "../gedcom/uri";

/**
 * Statistics read the file once: one flat row per person and one per family,
 * holding exactly the values the statistics group by. Every page and every
 * scope is then a filter and a group-by over these rows, so changing the scope
 * never walks the records again.
 */

export interface PersonFacts {
  id: string;
  sex: "M" | "F" | "U";
  /** The first given name, as written. */
  given?: string;
  /** How many given names the primary name carries. */
  givenCount: number;
  surname?: string;
  /** `given` and `surname` folded accent- and case-blind — what names are counted by. */
  givenKey?: string;
  surnameKey?: string;
  birthYear?: number;
  birthMonth?: number;
  /** The birth (or baptism) date names a neighbourhood, not a day or a year. */
  birthApprox: boolean;
  deathYear?: number;
  deathMonth?: number;
  deathApprox: boolean;
  /** The record carries a death, burial or cremation. */
  deceased: boolean;
  /** Not deceased and born (or estimated born) within the living window. */
  living: boolean;
  /** Whole years from birth to death, when both are dated. */
  ageAtDeath?: number;
  /** The birth or death place, whichever the file gives first; `""` for none. */
  place: string;
  /** The place's country facet (see `placeCountryFacet`); `""` for none. */
  country: string;
  /** The birth (or baptism) place's country facet; `""` when there is no birth place. */
  birthCountry: string;
  /** The death's cause (CAUS), as written. */
  cause?: string;
  /** The birth (or baptism) place and the death (or burial) place, `""` for none. */
  birthPlace: string;
  deathPlace: string;
  /** The birth date as `year-month-day`, when it names the day exactly — what twins share. */
  birthDay?: string;
  /** Days from the birth to the baptism (or christening), when both name the day. */
  baptismDays?: number;
  /** The occupations (OCCU) the person carries, as written, each once. */
  occupations: string[];
  /** Both a given name and a surname, neither of them a stand-in for an unknown one (NN, ?). */
  hasName: boolean;
  hasBirthDate: boolean;
  hasBirthPlace: boolean;
  hasDeathDate: boolean;
  hasParents: boolean;
  hasSource: boolean;
  /** Any of the person's own events names a place. */
  hasPlace: boolean;
  /** One of those places has coordinates somewhere in the file — the person can be put on a map. */
  mapped: boolean;
  father?: string;
  mother?: string;
  /** What the record names: its distinct places, cited sources and linked media. */
  refs: RecordRefs;
}

export interface FamilyFacts {
  id: string;
  husband?: string;
  wife?: string;
  marriageYear?: number;
  marriageMonth?: number;
  marriageApprox: boolean;
  /** The year the family is dated by: its marriage, else its first child's birth. */
  year?: number;
  /** Ages at the marriage, when both dates are known. */
  husbandAge?: number;
  wifeAge?: number;
  /** Either age above rests on an approximate date. */
  agesApprox: boolean;
  /** This union is the earliest-dated one of that spouse (their first marriage). */
  husbandFirst: boolean;
  wifeFirst: boolean;
  children: string[];
  /** Months from the marriage to the first child's birth, when both name the month. */
  firstChildMonths?: number;
  /** The mother's and father's ages at their first and last child in this family. */
  motherAgeFirst?: number;
  motherAgeLast?: number;
  fatherAgeFirst?: number;
  /** One of the dates the parents' ages rest on is approximate. */
  parentAgesApprox: boolean;
  refs: RecordRefs;
}

export interface StatsFacts {
  people: PersonFacts[];
  families: FamilyFacts[];
  /** Index into `people` by id. */
  byId: Map<string, PersonFacts>;
}

/** What one record names, so a scope can count the places, sources and media
 *  of its own people rather than of the whole file. */
export interface RecordRefs {
  /** Distinct-place keys, as the Places tool counts them. */
  places: string[];
  /** Source records cited anywhere in the record. */
  sources: string[];
  /** Media linked anywhere in the record: the shared record's xref, or an inline one's file. */
  media: string[];
}

function refsOf(raw: GedNode): RecordRefs {
  const sources: string[] = [];
  const media: string[] = [];
  const walk = (node: GedNode) => {
    for (const child of node.children) {
      const v = child.value?.trim();
      if (child.tag === "SOUR" && v && isPointer(v)) sources.push(v);
      else if (child.tag === "OBJE") {
        if (v && isPointer(v)) media.push(v);
        else {
          const file = child.children.find((c) => c.tag === "FILE")?.value?.trim();
          if (file) media.push(`file:${file}`);
        }
      }
      walk(child);
    }
  };
  walk(raw);
  return { places: placeKeysOf(raw), sources, media };
}

function firstDated(indi: Individual, tags: readonly string[]): GedEvent | undefined {
  for (const tag of tags) {
    const e = indi.events.find((ev) => ev.tag === tag && ev.date?.year !== undefined);
    if (e) return e;
  }
  return undefined;
}

function firstPlace(indi: Individual, tags: readonly string[]): string {
  for (const tag of tags) {
    const raw = indi.events.find((ev) => ev.tag === tag && ev.place?.raw.trim())?.place?.raw.trim();
    if (raw) return raw;
  }
  return "";
}

/** A date that names its day exactly, as a comparable key. */
function dayKey(d: GedDate | undefined): string | undefined {
  if (d?.year === undefined || d.month === undefined || d.day === undefined || isApproximate(d)) return undefined;
  return `${d.year}-${d.month}-${d.day}`;
}

/** Days from the birth to the baptism (or christening), both stated to the day. */
function baptismDays(indi: Individual): number | undefined {
  const exact = (tag: string) => indi.events.find((e) => e.tag === tag && dayKey(e.date))?.date;
  const birth = exact("BIRT");
  const baptism = exact("BAPM") ?? exact("CHR");
  if (!birth || !baptism) return undefined;
  return Math.round((Date.UTC(baptism.year!, baptism.month! - 1, baptism.day!) - Date.UTC(birth.year!, birth.month! - 1, birth.day!)) / 86_400_000);
}

/** Whole months from one dated event to another, when both name the month. */
function monthsBetween(from: GedDate | undefined, to: GedDate | undefined): number | undefined {
  if (from?.year === undefined || from.month === undefined || to?.year === undefined || to.month === undefined) return undefined;
  let months = (to.year - from.year) * 12 + (to.month - from.month);
  if (from.day !== undefined && to.day !== undefined && to.day < from.day) months--;
  return months;
}

/**
 * The fact rows for a whole file. `home` is the home country, which a place
 * naming no country of its own is counted under (as the place lists do).
 */
export function buildStatsFacts(ds: Dataset, home = "", now: number = new Date().getFullYear()): StatsFacts {
  const people: PersonFacts[] = [];
  const byId = new Map<string, PersonFacts>();
  const birthDates = new Map<string, GedDate | undefined>();
  // A file repeats a few hundred names over its whole population, and folding
  // is the dearest step per person — so each spelling is folded once.
  const folded = new Map<string, string>();
  const fold = (s: string | undefined) => {
    if (!s) return undefined;
    let key = folded.get(s);
    if (key === undefined) folded.set(s, (key = foldSearch(s)));
    return key;
  };
  for (const indi of ds.individuals.values()) {
    const name = indi.names[0];
    // A stand-in for an unknown name (NN, ???, neznano) is no name: it is
    // neither ranked nor counted as known.
    const givenText = isUnknownNameToken(name?.given) ? "" : (name?.given ?? "").trim();
    const givens = givenText.split(/\s+/).filter(Boolean);
    const birth = firstDated(indi, BIRTH_TAGS);
    const death = firstDated(indi, DEATH_TAGS);
    const birthPlace = firstPlace(indi, BIRTH_TAGS);
    const deathPlace = firstPlace(indi, DEATH_TAGS);
    const place = birthPlace || deathPlace;
    let father: string | undefined;
    let mother: string | undefined;
    for (const famId of indi.childOf) {
      const fam = ds.families.get(famId);
      father ??= fam?.husband;
      mother ??= fam?.wife;
    }
    const deceased = isDeceased(indi);
    const surname = (isUnknownNameToken(name?.surname) ? "" : name?.surname?.trim()) || undefined;
    const f: PersonFacts = {
      id: indi.id,
      sex: indi.sex === "M" || indi.sex === "F" ? indi.sex : "U",
      given: givens[0],
      givenCount: givens.length,
      surname,
      givenKey: fold(givens[0]),
      surnameKey: fold(surname),
      birthYear: birth?.date?.year,
      birthMonth: birth?.date?.month,
      birthApprox: isApproximate(birth?.date),
      deathYear: death?.date?.year,
      deathMonth: death?.date?.month,
      deathApprox: isApproximate(death?.date),
      deceased,
      living: !deceased && isPresumedLiving(indi, ds, now),
      ageAtDeath: death ? ageBetween(birth?.date, death.date) : undefined,
      place,
      country: place ? countryOf(place, home) : "",
      birthCountry: birthPlace ? countryOf(birthPlace, home) : "",
      cause: indi.events.find((e) => e.tag === "DEAT")?.cause?.trim() || undefined,
      birthPlace,
      deathPlace,
      birthDay: dayKey(birth?.date),
      baptismDays: baptismDays(indi),
      occupations: [...new Set(indi.events.filter((e) => e.tag === "OCCU").map((e) => e.value?.trim()).filter((v): v is string => !!v))],
      hasName: givens.length > 0 && !!surname,
      hasBirthDate: !!birth,
      hasBirthPlace: !!birthPlace,
      hasDeathDate: !!death,
      hasParents: !!(father || mother),
      hasSource: !!indi.sources?.length || indi.events.some((e) => !!e.sources?.length),
      hasPlace: indi.events.some((e) => !!e.place?.raw.trim()),
      mapped: false,
      father,
      mother,
      refs: refsOf(indi.raw),
    };
    people.push(f);
    byId.set(f.id, f);
    birthDates.set(indi.id, birth?.date);
  }

  const families: FamilyFacts[] = [];
  for (const fam of ds.families.values()) {
    const marr = fam.events.find((e) => e.tag === "MARR" && e.date?.year !== undefined)?.date;
    const kids = fam.children
      .map((id) => ({ id, date: birthDates.get(id) }))
      .filter((k): k is { id: string; date: GedDate } => k.date?.year !== undefined)
      .sort((a, b) => a.date.year! - b.date.year! || (a.date.month ?? 0) - (b.date.month ?? 0) || (a.date.day ?? 0) - (b.date.day ?? 0));
    const first = kids[0]?.date;
    const last = kids[kids.length - 1]?.date;
    const hb = fam.husband ? birthDates.get(fam.husband) : undefined;
    const wb = fam.wife ? birthDates.get(fam.wife) : undefined;
    const marrApprox = isApproximate(marr);
    families.push({
      id: fam.id,
      husband: fam.husband,
      wife: fam.wife,
      marriageYear: marr?.year,
      marriageMonth: marr?.month,
      marriageApprox: marrApprox,
      year: marr?.year ?? first?.year,
      husbandAge: marr ? ageBetween(hb, marr) : undefined,
      wifeAge: marr ? ageBetween(wb, marr) : undefined,
      agesApprox: marrApprox || isApproximate(hb) || isApproximate(wb),
      husbandFirst: false,
      wifeFirst: false,
      children: fam.children,
      firstChildMonths: marr && first ? monthsBetween(marr, first) : undefined,
      motherAgeFirst: first ? ageBetween(wb, first) : undefined,
      motherAgeLast: last ? ageBetween(wb, last) : undefined,
      fatherAgeFirst: first ? ageBetween(hb, first) : undefined,
      parentAgesApprox: isApproximate(hb) || isApproximate(wb) || isApproximate(first) || isApproximate(last),
      refs: refsOf(fam.raw),
    });
  }

  // A spouse's first marriage is their earliest-dated union; an undated union
  // is nobody's first, since it cannot be placed among the others.
  const earliest = new Map<string, { fam: FamilyFacts; year: number }>();
  for (const fam of families) {
    if (fam.marriageYear === undefined) continue;
    for (const spouse of [fam.husband, fam.wife]) {
      if (!spouse) continue;
      const seen = earliest.get(spouse);
      if (!seen || fam.marriageYear < seen.year) earliest.set(spouse, { fam, year: fam.marriageYear });
    }
  }
  for (const [spouse, { fam }] of earliest) {
    if (fam.husband === spouse) fam.husbandFirst = true;
    if (fam.wife === spouse) fam.wifeFirst = true;
  }
  // A place value has coordinates when any event writing it carries them,
  // as the Places tool reads it; a person is on the map through any of theirs.
  const placed = new Set<string>();
  const notePlaced = (events: GedEvent[]) => {
    for (const e of events) if (e.place?.coord) placed.add(e.place.raw.trim());
  };
  for (const indi of ds.individuals.values()) notePlaced(indi.events);
  for (const fam of ds.families.values()) notePlaced(fam.events);
  if (placed.size) {
    for (const indi of ds.individuals.values()) {
      byId.get(indi.id)!.mapped = indi.events.some((e) => !!e.place && placed.has(e.place.raw.trim()));
    }
  }
  return { people, families, byId };
}

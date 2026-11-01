import type { Dataset, GedDate, GedEvent, GedNode, GeoCoord, Individual } from "../gedcom/types";
import { distanceKm } from "../geo/points";
import { BIRTH_TAGS, birthDateOf, DEATH_TAGS, deathDateOf, isApproximate, isDeceased, isPresumedLiving } from "../gedcom/lifespan";
import { ageBetween, daysBetween } from "../gedcom/age";
import { birthParentFamilies } from "../gedcom/couple";
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
  /** The death (or burial) place's country facet; `""` when there is no death place. */
  deathCountry: string;
  /** Kilometres from the birth place to the death place, when both are on the map. */
  movedKm?: number;
  /** The death's cause (CAUS), as written. */
  cause?: string;
  /** The birth (or baptism) place and the death (or burial) place, `""` for none. */
  birthPlace: string;
  deathPlace: string;
  /** `place` and `birthPlace` folded for search (see `foldSearch`), `""` for none —
   *  folded once here, not per person on every keystroke of the place filter. */
  placeKey: string;
  birthPlaceKey: string;
  /** The birth date as `year-month-day`, when it names the day exactly — what twins share. */
  birthDay?: string;
  /** Days from the birth to the baptism (or christening), when both name the day. */
  baptismDays?: number;
  /** The occupations (OCCU) and the education (EDUC) the person carries, as
   *  written, each once; a value listing several (`¼ zemljak, ½ zemljak`)
   *  gives each of them. */
  occupations: string[];
  education: string[];
  /** Both a given name and a surname, neither of them a stand-in for an unknown one (NN, ?). */
  hasName: boolean;
  hasBirthDate: boolean;
  hasBirthPlace: boolean;
  hasDeathDate: boolean;
  hasParents: boolean;
  hasSource: boolean;
  /** The tags of the person's own events, and of those among them that cite a source. */
  eventTags: string[];
  sourcedTags: string[];
  /** Source citations on the person and on their events. */
  citations: number;
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
  /** The first marriage event's place as written, `""` for none. */
  marriagePlace: string;
  /** The year the family is dated by: its marriage, else its first child's birth. */
  year?: number;
  /** That year rests on an approximate date. */
  yearApprox: boolean;
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
  /** The first child's birth date is approximate. */
  firstChildApprox: boolean;
  /** The mother's and father's ages at their first and last child in this family. */
  motherAgeFirst?: number;
  motherAgeLast?: number;
  fatherAgeFirst?: number;
  /** One of the dates the parents' ages rest on is approximate. */
  parentAgesApprox: boolean;
  /** The family's own events (MARR, DIV, …), and those among them that cite a source. */
  eventTags: string[];
  sourcedTags: string[];
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

/** What `raw` names, and how many source citations it holds at any depth —
 *  a name's, a birth family link's or an association's as well as the
 *  record's and its events', pointer or inline: the citations a reader counts. */
function refsOf(raw: GedNode): { refs: RecordRefs; citations: number } {
  const sources: string[] = [];
  const media: string[] = [];
  let citations = 0;
  const walk = (node: GedNode) => {
    for (const child of node.children) {
      const v = child.value?.trim();
      if (child.tag === "SOUR" && v) {
        citations++;
        if (isPointer(v)) sources.push(v);
      } else if (child.tag === "OBJE") {
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
  return { refs: { places: placeKeysOf(raw), sources, media }, citations };
}

function firstPlace(indi: Individual, tags: readonly string[]): string {
  for (const tag of tags) {
    const raw = indi.events.find((ev) => ev.tag === tag && ev.place?.raw.trim())?.place?.raw.trim();
    if (raw) return raw;
  }
  return "";
}

/** The values of one attribute, split where a value lists several, each once. */
function listedValues(indi: Individual, tag: string): string[] {
  const out = new Set<string>();
  for (const e of indi.events) {
    if (e.tag !== tag) continue;
    for (const part of (e.value ?? "").split(/[,;]/)) {
      const v = part.trim();
      if (v) out.add(v);
    }
  }
  return [...out];
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
  return daysBetween(birth, baptism);
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
  // A place value has coordinates when any event writing it carries them,
  // as the Places tool reads it; a person is on the map through any of theirs.
  // Gathered first, so each person's row is finished in the one pass below.
  const placed = new Map<string, GeoCoord>();
  const notePlaced = (events: GedEvent[]) => {
    for (const e of events) {
      const raw = e.place?.raw.trim();
      if (raw && e.place?.coord && !placed.has(raw)) placed.set(raw, e.place.coord);
    }
  };
  for (const indi of ds.individuals.values()) notePlaced(indi.events);
  for (const fam of ds.families.values()) notePlaced(fam.events);
  for (const indi of ds.individuals.values()) {
    const name = indi.names[0];
    // A stand-in for an unknown name (NN, ???, neznano) is no name: it is
    // neither ranked nor counted as known.
    const givenText = isUnknownNameToken(name?.given) ? "" : (name?.given ?? "").trim();
    const givens = givenText.split(/\s+/).filter(Boolean);
    // The dates every list and card of the app reads (see `birthDateOf`), so
    // a bar and the people it lists agree on the year.
    const birth = birthDateOf(indi);
    const death = deathDateOf(indi);
    const birthPlace = firstPlace(indi, BIRTH_TAGS);
    const deathPlace = firstPlace(indi, DEATH_TAGS);
    const place = birthPlace || deathPlace;
    // The birth parents, as the Ancestors and Blood scopes follow them: an
    // adoptive family listed first must not stand in the pedigree.
    let father: string | undefined;
    let mother: string | undefined;
    for (const fam of birthParentFamilies(indi, ds)) {
      father ??= fam.husband;
      mother ??= fam.wife;
    }
    const deceased = isDeceased(indi);
    const { refs, citations } = refsOf(indi.raw);
    const surname = (isUnknownNameToken(name?.surname) ? "" : name?.surname?.trim()) || undefined;
    const f: PersonFacts = {
      id: indi.id,
      sex: indi.sex === "M" || indi.sex === "F" ? indi.sex : "U",
      given: givens[0],
      givenCount: givens.length,
      surname,
      givenKey: fold(givens[0]),
      surnameKey: fold(surname),
      birthYear: birth?.year,
      birthMonth: birth?.month,
      birthApprox: isApproximate(birth),
      deathYear: death?.year,
      deathMonth: death?.month,
      deathApprox: isApproximate(death),
      deceased,
      living: !deceased && isPresumedLiving(indi, ds, now),
      ageAtDeath: death ? ageBetween(birth, death) : undefined,
      place,
      country: place ? countryOf(place, home) : "",
      birthCountry: birthPlace ? countryOf(birthPlace, home) : "",
      deathCountry: deathPlace ? countryOf(deathPlace, home) : "",
      cause: indi.events.find((e) => e.tag === "DEAT")?.cause?.trim() || undefined,
      birthPlace,
      deathPlace,
      placeKey: fold(place) ?? "",
      birthPlaceKey: fold(birthPlace) ?? "",
      birthDay: dayKey(birth),
      baptismDays: baptismDays(indi),
      occupations: listedValues(indi, "OCCU"),
      education: listedValues(indi, "EDUC"),
      hasName: givens.length > 0 && !!surname,
      hasBirthDate: !!birth,
      hasBirthPlace: !!birthPlace,
      hasDeathDate: !!death,
      hasParents: !!(father || mother),
      hasSource: citations > 0,
      eventTags: indi.events.map((e) => e.tag),
      sourcedTags: indi.events.filter((e) => !!e.sources?.length).map((e) => e.tag),
      citations,
      hasPlace: indi.events.some((e) => !!e.place?.raw.trim()),
      mapped: placed.size > 0 && indi.events.some((e) => !!e.place && placed.has(e.place.raw.trim())),
      father,
      mother,
      refs,
    };
    // How far a life moved: from the birth place to the death place, when both are on the map.
    const from = birthPlace ? placed.get(birthPlace) : undefined;
    const to = deathPlace ? placed.get(deathPlace) : undefined;
    if (from && to) f.movedKm = distanceKm(from, to);
    people.push(f);
    byId.set(f.id, f);
    birthDates.set(indi.id, birth);
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
      marriagePlace: fam.events.find((e) => e.tag === "MARR" && e.place?.raw.trim())?.place?.raw.trim() ?? "",
      year: marr?.year ?? first?.year,
      yearApprox: marr ? marrApprox : isApproximate(first),
      husbandAge: marr ? ageBetween(hb, marr) : undefined,
      wifeAge: marr ? ageBetween(wb, marr) : undefined,
      agesApprox: marrApprox || isApproximate(hb) || isApproximate(wb),
      husbandFirst: false,
      wifeFirst: false,
      children: fam.children,
      firstChildMonths: marr && first ? monthsBetween(marr, first) : undefined,
      firstChildApprox: isApproximate(first),
      motherAgeFirst: first ? ageBetween(wb, first) : undefined,
      motherAgeLast: last ? ageBetween(wb, last) : undefined,
      fatherAgeFirst: first ? ageBetween(hb, first) : undefined,
      parentAgesApprox: isApproximate(hb) || isApproximate(wb) || isApproximate(first) || isApproximate(last),
      eventTags: fam.events.map((e) => e.tag),
      sourcedTags: fam.events.filter((e) => !!e.sources?.length).map((e) => e.tag),
      refs: refsOf(fam.raw).refs,
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
  return { people, families, byId };
}

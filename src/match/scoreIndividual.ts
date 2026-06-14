import type { Dataset, GedEvent, Individual, PersonName } from "../gedcom/types";
import { birthDateText, deathDateText, isDeceased } from "../gedcom/lifespan";
import { childrenNames, displayName, fatherName, motherName, pairTitle, parentNames, partnerNames, primaryName, findEvent } from "./relatives";
import {
  dateSimilarity,
  givenSimilarity,
  nameSetSimilarity,
  nameSimilarity,
  placeSimilarity,
} from "./similarity";
import { foldToken, jaroWinkler } from "./text";
import {
  categorize,
  combineComponents,
  type IndividualCandidate,
  type MatchConfig,
  type ScoreComponent,
} from "./types";

/**
 * Score a master/compare individual pair. Components that can't be compared
 * (data missing on either side) are omitted so they neither help nor hurt.
 */
export function scoreIndividualPair(
  master: Individual,
  compare: Individual,
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): IndividualCandidate {
  const w = config.individualWeights;
  const components: ScoreComponent[] = [];
  const mn = primaryName(master);
  const cn = primaryName(compare);

  // Surname, given name and birth year form the identity key: each is always
  // scored, and a side that's missing the field is charged `missingKeyScore`
  // (penalized rather than ignored) so an incomplete record can't reach 100%.
  const surnameSim =
    mn?.surname && cn?.surname
      ? jaroWinkler(foldToken(mn.surname), foldToken(cn.surname))
      : undefined;
  addKey(components, "surname", w.surname, surnameSim, config.missingKeyScore, `${mn?.surname ?? "—"} ~ ${cn?.surname ?? "—"}`);

  const givenSim = mn?.given && cn?.given ? givenSimilarity(mn.given, cn.given) : undefined;
  addKey(components, "given", w.given, givenSim, config.missingKeyScore, `${mn?.given ?? "—"} ~ ${cn?.given ?? "—"}`);

  const mb = findEvent(master, "BIRT");
  const cb = findEvent(compare, "BIRT");
  addKey(components, "birthDate", w.birthDate, dateSimilarity(mb?.date, cb?.date), config.missingKeyScore, `${mb?.date?.raw ?? "—"} ~ ${cb?.date?.raw ?? "—"}`);
  add(components, "birthPlace", w.birthPlace, placeSimilarity(mb?.place, cb?.place), `${mb?.place?.raw ?? "?"} ~ ${cb?.place?.raw ?? "?"}`);
  add(components, "birthAddress", w.birthAddress, placeSimilarity(mb?.address, cb?.address), `${mb?.address?.raw ?? "?"} ~ ${cb?.address?.raw ?? "?"}`);

  // Death date/place: corroborating evidence, not part of the identity key —
  // absence (e.g. living people) is skipped rather than penalized.
  const md = findEvent(master, "DEAT");
  const cd = findEvent(compare, "DEAT");
  add(components, "deathDate", w.deathDate, dateSimilarity(md?.date, cd?.date), `${md?.date?.raw ?? "—"} ~ ${cd?.date?.raw ?? "—"}`);
  add(components, "deathPlace", w.deathPlace, placeSimilarity(md?.place, cd?.place), `${md?.place?.raw ?? "?"} ~ ${cd?.place?.raw ?? "?"}`);

  if (master.sex !== "U" && compare.sex !== "U") {
    add(components, "sex", w.sex, master.sex === compare.sex ? 1 : 0, `${master.sex} ~ ${compare.sex}`);
  }

  add(components, "parents", w.parents, nameSetSimilarity(parentNames(master, masterDs), parentNames(compare, compareDs)), "parents");
  add(components, "partners", w.partners, nameSetSimilarity(partnerNames(master, masterDs), partnerNames(compare, compareDs)), "partners");
  add(components, "children", w.children, nameSetSimilarity(childrenNames(master, masterDs), childrenNames(compare, compareDs)), "children");

  // Marriage corroboration, folded in from the person's spouse family: a matching
  // marriage date/place is strong evidence (and disambiguates same-named people).
  const mar = bestMarriageSimilarity(master, compare, masterDs, compareDs);
  add(components, "marriageDate", w.marriageDate, mar.date, "marriage date");
  add(components, "marriagePlace", w.marriagePlace, mar.place, "marriage place");

  let score01 = combineComponents(components);

  // The identity key — surname, given name and birth date — is conclusive: when
  // all three are present and an exact match the pair is the same person and
  // scores a flat 100. Conversely 100 is reserved for that case, so secondary
  // fields can never round an imperfect-key pair up to it.
  const keyPerfect = KEY_FIELDS.every((k) => {
    const c = components.find((x) => x.key === k);
    return c !== undefined && !c.missing && c.score === 1;
  });
  if (keyPerfect) score01 = 1;

  let score = Math.round(score01 * 1000) / 10;
  if (!keyPerfect && score >= 100) score = 99.9;

  // A fully-matching relative is strong corroboration: nudge the score up a
  // little for each of father/mother/partner that matches exactly. The bonus is
  // capped just below 100 so it never reaches a perfect score on its own — 100
  // stays reserved for a perfect identity key.
  if (!keyPerfect) {
    const bonus = relativeMatchBonus(master, compare, masterDs, compareDs, config);
    if (bonus > 0) score = Math.min(99.9, Math.round((score + bonus) * 10) / 10);
  }

  return {
    masterId: master.id,
    compareId: compare.id,
    score,
    category: categorize(score01, config),
    components,
    title: pairTitle(master, compare),
    name: displayName(primaryName(master)),
    birthYear: birthYear(master),
    deathYear: deathYear(master),
    birthDate: birthDateText(master),
    deathDate: deathDateText(master),
    deceased: isDeceased(master),
    sex: master.sex !== "U" ? master.sex : compare.sex,
  };
}

/** The identity key: a perfect match on all three earns a 100 score. */
const KEY_FIELDS = ["surname", "given", "birthDate"] as const;

/** MARR events across all families where the person is a spouse. */
function marriageEvents(indi: Individual, ds: Dataset): GedEvent[] {
  const out: GedEvent[] = [];
  for (const famId of indi.spouseOf) {
    const m = ds.families.get(famId)?.events.find((e) => e.tag === "MARR");
    if (m) out.push(m);
  }
  return out;
}

/** Best marriage date/place similarity over the cross-product of both people's
 *  marriages (handles re-marriages; undefined when a side lacks the data). */
function bestMarriageSimilarity(
  master: Individual,
  compare: Individual,
  masterDs: Dataset,
  compareDs: Dataset,
): { date: number | undefined; place: number | undefined } {
  const me = marriageEvents(master, masterDs);
  const ce = marriageEvents(compare, compareDs);
  let date: number | undefined;
  let place: number | undefined;
  for (const a of me) {
    for (const b of ce) {
      const d = dateSimilarity(a.date, b.date);
      if (d !== undefined) date = Math.max(date ?? 0, d);
      const p = placeSimilarity(a.place, b.place);
      if (p !== undefined) place = Math.max(place ?? 0, p);
    }
  }
  return { date, place };
}

/**
 * Total bonus for corroborating relatives: father, mother and any partner that
 * is a confident full name match.
 */
function relativeMatchBonus(
  master: Individual,
  compare: Individual,
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): number {
  let bonus = 0;
  if (fullNameMatch(fatherName(master, masterDs), fatherName(compare, compareDs))) {
    bonus += config.parentMatchBonus;
  }
  if (fullNameMatch(motherName(master, masterDs), motherName(compare, compareDs))) {
    bonus += config.parentMatchBonus;
  }
  if (anyFullNameMatch(partnerNames(master, masterDs), partnerNames(compare, compareDs))) {
    bonus += config.partnerMatchBonus;
  }
  return bonus;
}

/** True when some name on each side is a confident full match with the other. */
function anyFullNameMatch(as: PersonName[], bs: PersonName[]): boolean {
  return as.some((a) => bs.some((b) => fullNameMatch(a, b)));
}

/**
 * A confident full match: both sides have a given name *and* a surname, and the
 * two names are identical. Requiring both parts avoids treating a shared family
 * surname (with no given name) as corroboration.
 */
function fullNameMatch(a: PersonName | undefined, b: PersonName | undefined): boolean {
  if (!a?.given || !b?.given || !a?.surname || !b?.surname) return false;
  return nameSimilarity(a, b) === 1;
}

function add(
  into: ScoreComponent[],
  key: string,
  weight: number,
  score: number | undefined,
  detail: string,
): void {
  if (score === undefined) return;
  into.push({ key, weight, score, detail });
}

/**
 * Add a key (identity) field. Unlike `add`, a missing similarity is not skipped
 * but recorded with the `missingKeyScore` penalty, so absent key data drags the
 * overall score down instead of being silently excluded from the average.
 */
function addKey(
  into: ScoreComponent[],
  key: string,
  weight: number,
  similarity: number | undefined,
  missingScore: number,
  detail: string,
): void {
  const missing = similarity === undefined;
  into.push({ key, weight, score: missing ? missingScore : similarity, detail, missing });
}

/**
 * True when both individuals have a recorded sex and they differ. Such pairs are
 * never the same person, so the engine drops them before scoring.
 */
export function sexConflicts(a: Individual, b: Individual): boolean {
  return a.sex !== "U" && b.sex !== "U" && a.sex !== b.sex;
}

/**
 * Hard plausibility gate applied before scoring. Rejects pairs that cannot
 * reasonably be the same person:
 *  - names too dissimilar (surname and/or given below threshold),
 *  - representative years more than ~a century apart,
 *  - lifespans that don't overlap (one died before the other was born).
 */
export function plausibleIndividualMatch(
  a: Individual,
  b: Individual,
  gates: MatchConfig["gates"],
): boolean {
  return nameGate(a, b, gates) && temporalGate(a, b, gates);
}

function nameGate(a: Individual, b: Individual, gates: MatchConfig["gates"]): boolean {
  const an = primaryName(a);
  const bn = primaryName(b);
  const surname =
    an?.surname && bn?.surname
      ? jaroWinkler(foldToken(an.surname), foldToken(bn.surname))
      : undefined;
  const given =
    an?.given && bn?.given ? givenSimilarity(an.given, bn.given) : undefined;

  if (surname !== undefined && surname < gates.minSurname) return false;
  if (given !== undefined && given < gates.minGiven) return false;

  // No structured name parts on either side: fall back to the full name.
  if (surname === undefined && given === undefined) {
    if (an?.full && bn?.full) {
      return jaroWinkler(foldToken(an.full), foldToken(bn.full)) >= gates.minSurname;
    }
    return false; // nothing to match a name on
  }
  return true;
}

function temporalGate(a: Individual, b: Individual, gates: MatchConfig["gates"]): boolean {
  // Coarse "same era" check using each person's best available year.
  const ea = eraYear(a);
  const eb = eraYear(b);
  if (ea !== undefined && eb !== undefined && Math.abs(ea - eb) > gates.maxYearGap) {
    return false;
  }

  // Lifespan impossibility: one died before the other was born.
  const da = deathYear(a);
  const bb = birthYear(b);
  if (da !== undefined && bb !== undefined && da < bb) return false;
  const db = deathYear(b);
  const ba = birthYear(a);
  if (db !== undefined && ba !== undefined && db < ba) return false;

  return true;
}

function yearOfAny(indi: Individual, tags: string[]): number | undefined {
  for (const tag of tags) {
    const year = findEvent(indi, tag)?.date?.year;
    if (year !== undefined) return year;
  }
  return undefined;
}

/** Birth year, or baptism/christening as a close proxy. */
export function birthYear(indi: Individual): number | undefined {
  return yearOfAny(indi, ["BIRT", "BAPM", "CHR"]);
}
function deathYear(indi: Individual): number | undefined {
  return yearOfAny(indi, ["DEAT", "BURI", "CREM"]);
}
/** A representative year placing the person in time, from any dated event. */
function eraYear(indi: Individual): number | undefined {
  return (
    birthYear(indi) ??
    deathYear(indi) ??
    yearOfAny(indi, ["MARR", "RESI"])
  );
}

/** Stable blocking keys for an individual (recall-oriented, cheap). */
export function individualBlockKeys(indi: Individual, soundex: (s: string) => string): string[] {
  const n = primaryName(indi);
  const surname = n?.surname;
  const given = n?.given;
  const sdx = soundex(surname ?? given ?? "");
  if (!sdx) return [];

  const keys = [`S:${sdx}`];
  const birthYear = indi.events.find((e) => e.tag === "BIRT")?.date?.year;
  if (birthYear) keys.push(`SB:${sdx}:${Math.floor(birthYear / 10)}`);
  if (given) keys.push(`SG:${sdx}:${foldToken(given)[0] ?? ""}`);
  return keys;
}

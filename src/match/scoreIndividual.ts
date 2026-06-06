import type { Dataset, Individual } from "../gedcom/types";
import { label, parentNames, partnerNames, primaryName, findEvent } from "./relatives";
import {
  dateSimilarity,
  givenSimilarity,
  nameSetSimilarity,
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

  if (master.sex !== "U" && compare.sex !== "U") {
    add(components, "sex", w.sex, master.sex === compare.sex ? 1 : 0, `${master.sex} ~ ${compare.sex}`);
  }

  add(components, "parents", w.parents, nameSetSimilarity(parentNames(master, masterDs), parentNames(compare, compareDs)), "parents");
  add(components, "partners", w.partners, nameSetSimilarity(partnerNames(master, masterDs), partnerNames(compare, compareDs)), "partners");

  const score01 = combineComponents(components);
  return {
    masterId: master.id,
    compareId: compare.id,
    score: Math.round(score01 * 1000) / 10,
    category: categorize(score01, config),
    components,
    masterLabel: label(master),
    compareLabel: label(compare),
  };
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
function birthYear(indi: Individual): number | undefined {
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

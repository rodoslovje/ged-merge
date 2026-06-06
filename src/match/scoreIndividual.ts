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

  if (mn?.surname && cn?.surname) {
    add(components, "surname", w.surname, jaroWinkler(foldToken(mn.surname), foldToken(cn.surname)), `${mn.surname} ~ ${cn.surname}`);
  }
  if (mn?.given && cn?.given) {
    add(components, "given", w.given, givenSimilarity(mn.given, cn.given), `${mn.given} ~ ${cn.given}`);
  }

  const mb = findEvent(master, "BIRT");
  const cb = findEvent(compare, "BIRT");
  add(components, "birthDate", w.birthDate, dateSimilarity(mb?.date, cb?.date), `${mb?.date?.raw ?? "?"} ~ ${cb?.date?.raw ?? "?"}`);
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
 * True when both individuals have a recorded sex and they differ. Such pairs are
 * never the same person, so the engine drops them before scoring.
 */
export function sexConflicts(a: Individual, b: Individual): boolean {
  return a.sex !== "U" && b.sex !== "U" && a.sex !== b.sex;
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

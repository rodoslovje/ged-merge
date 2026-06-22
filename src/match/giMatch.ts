import type { Dataset, Individual } from "../gedcom/types";
import type { GiMasterKey, GiPair } from "../csv/giMatches";
import { birthYear } from "../gedcom/lifespan";
import { primaryName } from "./relatives";
import { scoreIndividualPair } from "./scoreIndividual";
import { foldToken } from "./text";
import { DEFAULT_CONFIG, type IndividualCandidate, type MatchConfig, type MatchResult } from "./types";

/**
 * Resolve a genealogical index matches CSV against the master dataset: each
 * pair's master key (given + surname + birth year, from the CSV's first row)
 * is matched exactly against a master individual, and the pair's synthetic
 * compare individual (second row) is then scored against it as usual. Pairs
 * whose key doesn't resolve to exactly one master individual are skipped.
 */
export function matchGiPairs(
  masterDs: Dataset,
  compareDs: Dataset,
  pairs: GiPair[],
  config: MatchConfig = DEFAULT_CONFIG,
): MatchResult {
  const index = buildMasterKeyIndex(masterDs);
  const individuals: IndividualCandidate[] = [];
  for (const pair of pairs) {
    const master = index.get(keyStr(pair.masterKey));
    if (!master) continue;
    const compare = compareDs.individuals.get(pair.compareId);
    if (!compare) continue;
    individuals.push(scoreIndividualPair(master, compare, masterDs, compareDs, config));
  }
  return { individuals };
}

/** Folded "given|surname|birthYear" key, shared by index-building and lookup. */
function keyStr(key: GiMasterKey): string {
  return `${foldToken(key.given)}|${foldToken(key.surname)}|${key.birthYear ?? ""}`;
}

/** Index master individuals by their folded name+birth-year key, built once so
 *  resolving every CSV pair is an O(1) lookup instead of an O(masterSize) scan.
 *  Keeps the first individual seen per key (dataset iteration order), matching
 *  the original linear scan's "first match wins" for an ambiguous key. */
function buildMasterKeyIndex(masterDs: Dataset): Map<string, Individual> {
  const index = new Map<string, Individual>();
  for (const indi of masterDs.individuals.values()) {
    const n = primaryName(indi);
    if (!n?.given || !n?.surname) continue;
    const key = keyStr({ given: n.given, surname: n.surname, birthYear: birthYear(indi) });
    if (!index.has(key)) index.set(key, indi);
  }
  return index;
}

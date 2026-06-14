import type { Dataset, Individual } from "../gedcom/types";
import type { GiMasterKey, GiPair } from "../csv/giMatches";
import { primaryName } from "./relatives";
import { birthYear, scoreIndividualPair } from "./scoreIndividual";
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
  const individuals: IndividualCandidate[] = [];
  for (const pair of pairs) {
    const master = findMasterByKey(masterDs, pair.masterKey);
    if (!master) continue;
    const compare = compareDs.individuals.get(pair.compareId);
    if (!compare) continue;
    individuals.push(scoreIndividualPair(master, compare, masterDs, compareDs, config));
  }
  return { individuals };
}

function findMasterByKey(masterDs: Dataset, key: GiMasterKey): Individual | undefined {
  const given = foldToken(key.given);
  const surname = foldToken(key.surname);
  for (const indi of masterDs.individuals.values()) {
    const n = primaryName(indi);
    if (!n?.given || !n?.surname) continue;
    if (foldToken(n.given) !== given || foldToken(n.surname) !== surname) continue;
    if (birthYear(indi) !== key.birthYear) continue;
    return indi;
  }
  return undefined;
}

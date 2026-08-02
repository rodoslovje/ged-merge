import type { Dataset, Individual } from "../gedcom/types";
import type { GiMainKey, GiPair } from "../csv/giMatches";
import { birthYear } from "../gedcom/lifespan";
import { primaryName } from "./relatives";
import { scoreIndividualPair } from "./scoreIndividual";
import { foldToken } from "./text";
import { DEFAULT_CONFIG, type IndividualCandidate, type MatchConfig, type MatchResult } from "./types";

/**
 * Resolve a genealogical index matches CSV against the main dataset: each
 * pair's main key (given + surname + birth year, from the CSV's first row)
 * is matched exactly against a main individual, and the pair's synthetic
 * compare individual (second row) is then scored against it as usual. Pairs
 * whose key doesn't resolve to exactly one main individual are skipped.
 */
export function matchGiPairs(
  mainDs: Dataset,
  compareDs: Dataset,
  pairs: GiPair[],
  config: MatchConfig = DEFAULT_CONFIG,
): MatchResult {
  const index = buildMainKeyIndex(mainDs);
  const individuals: IndividualCandidate[] = [];
  // One candidate per person on each side: the pairs list leads with the CSV's
  // own match rows and follows with the relatives named inside them, so a
  // relative who resolves to a person the index already matched is dropped
  // rather than shown as a second, competing candidate.
  const usedMain = new Set<string>();
  const usedCompare = new Set<string>();
  for (const pair of pairs) {
    const main = index.get(keyStr(pair.mainKey));
    if (!main) continue;
    const compare = compareDs.individuals.get(pair.compareId);
    if (!compare) continue;
    if (usedMain.has(main.id) || usedCompare.has(compare.id)) continue;
    usedMain.add(main.id);
    usedCompare.add(compare.id);
    individuals.push(scoreIndividualPair(main, compare, mainDs, compareDs, config));
  }
  return { individuals };
}

/** Folded "given|surname|birthYear" key, shared by index-building and lookup. */
function keyStr(key: GiMainKey): string {
  return `${foldToken(key.given)}|${foldToken(key.surname)}|${key.birthYear ?? ""}`;
}

/** Index main individuals by their folded name+birth-year key, built once so
 *  resolving every CSV pair is an O(1) lookup instead of an O(mainSize) scan.
 *  Keeps the first individual seen per key (dataset iteration order), matching
 *  the original linear scan's "first match wins" for an ambiguous key. */
function buildMainKeyIndex(mainDs: Dataset): Map<string, Individual> {
  const index = new Map<string, Individual>();
  for (const indi of mainDs.individuals.values()) {
    const n = primaryName(indi);
    if (!n?.given || !n?.surname) continue;
    const key = keyStr({ given: n.given, surname: n.surname, birthYear: birthYear(indi) });
    if (!index.has(key)) index.set(key, indi);
  }
  return index;
}

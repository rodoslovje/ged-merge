import type { Dataset, Individual } from "../gedcom/types";
import { giPersonKey, type GiPair } from "../csv/giMatches";
import { birthYear } from "../gedcom/lifespan";
import { primaryName } from "./relatives";
import { scoreIndividualPair } from "./scoreIndividual";
import { DEFAULT_CONFIG, type IndividualCandidate, type MatchConfig, type ScoredMatchResult } from "./types";

/**
 * Resolve a genealogical index matches CSV against the main dataset: each
 * pair's main key (given + surname + birth year, from the CSV's first row)
 * is matched exactly against a main individual, and the pair's synthetic
 * compare individual (second row) is then scored against it as usual. A pair
 * whose key no main individual carries is skipped.
 *
 * A key is a name and a birth year, and a file can hold two people under one —
 * two Janez Novaks born in 1850. The pair then goes to whichever of them the
 * incoming row scores best against, since that row describes the person the
 * index matched: taking the first in file order attached a Bled baptism to the
 * namesake from Kranj.
 */
export function matchGiPairs(
  mainDs: Dataset,
  compareDs: Dataset,
  pairs: GiPair[],
  config: MatchConfig = DEFAULT_CONFIG,
): ScoredMatchResult {
  const index = buildMainKeyIndex(mainDs);
  const individuals: IndividualCandidate[] = [];
  // One candidate per person on each side: the pairs list leads with the CSV's
  // own match rows and follows with the relatives named inside them, so a
  // relative who resolves to a person the index already matched is dropped
  // rather than shown as a second, competing candidate.
  const usedMain = new Set<string>();
  const usedCompare = new Set<string>();
  for (const pair of pairs) {
    const compare = compareDs.individuals.get(pair.compareId);
    if (!compare || usedCompare.has(compare.id)) continue;
    const free = (index.get(keyStr(pair.mainKey)) ?? []).filter((m) => !usedMain.has(m.id));
    if (free.length === 0) continue;
    let best = scoreIndividualPair(free[0], compare, mainDs, compareDs, config);
    for (const main of free.slice(1)) {
      const scored = scoreIndividualPair(main, compare, mainDs, compareDs, config);
      if (scored.score > best.score) best = scored;
    }
    usedMain.add(best.mainId);
    usedCompare.add(compare.id);
    individuals.push(best);
  }
  return { individuals };
}

/** Folded "given|surname|birthYear" key, shared by index-building and lookup —
 *  the same spelling the CSV import dedupes rows with. */
const keyStr = giPersonKey;

/** Index main individuals by their folded name+birth-year key, built once so
 *  resolving every CSV pair is an O(1) lookup instead of an O(mainSize) scan.
 *  Everyone under a key is kept, in file order. */
function buildMainKeyIndex(mainDs: Dataset): Map<string, Individual[]> {
  const index = new Map<string, Individual[]>();
  for (const indi of mainDs.individuals.values()) {
    const n = primaryName(indi);
    if (!n?.given || !n?.surname) continue;
    const key = keyStr({ given: n.given, surname: n.surname, birthYear: birthYear(indi) });
    const under = index.get(key);
    if (under) under.push(indi);
    else index.set(key, [indi]);
  }
  return index;
}

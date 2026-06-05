import type { Dataset } from "../gedcom/types";
import { familyBlockKeys, scoreFamilyPair } from "./scoreFamily";
import { individualBlockKeys, scoreIndividualPair } from "./scoreIndividual";
import { soundex } from "./text";
import {
  DEFAULT_CONFIG,
  type FamilyCandidate,
  type IndividualCandidate,
  type MatchConfig,
  type MatchResult,
} from "./types";

/**
 * Match a compare dataset against the master.
 *
 * Two stages keep this from being O(n²): a cheap **blocking** pass groups
 * records by phonetic/decade keys so only plausible pairs get the (more
 * expensive) weighted **scoring** pass. Results are filtered to `minScore`,
 * capped per compare record, and returned sorted by score descending.
 */
export function matchDatasets(
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig = DEFAULT_CONFIG,
): MatchResult {
  return {
    individuals: matchIndividuals(masterDs, compareDs, config),
    families: matchFamilies(masterDs, compareDs, config),
  };
}

function matchIndividuals(
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): IndividualCandidate[] {
  const index = buildBlockIndex(masterDs.individuals.values(), (i) =>
    individualBlockKeys(i, soundex),
  );

  const out: IndividualCandidate[] = [];
  for (const compare of compareDs.individuals.values()) {
    const keys = individualBlockKeys(compare, soundex);
    const masterIds = collectCandidates(index, keys);

    const scored: IndividualCandidate[] = [];
    for (const mid of masterIds) {
      const master = masterDs.individuals.get(mid)!;
      const cand = scoreIndividualPair(master, compare, masterDs, compareDs, config);
      if (cand.score / 100 >= config.minScore) scored.push(cand);
    }
    pushTop(out, scored, config.maxPerRecord);
  }
  return out.sort(byScoreDesc);
}

function matchFamilies(
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): FamilyCandidate[] {
  const index = buildBlockIndex(masterDs.families.values(), (f) =>
    familyBlockKeys(f, masterDs),
  );

  const out: FamilyCandidate[] = [];
  for (const compare of compareDs.families.values()) {
    const keys = familyBlockKeys(compare, compareDs);
    const masterIds = collectCandidates(index, keys);

    const scored: FamilyCandidate[] = [];
    for (const mid of masterIds) {
      const master = masterDs.families.get(mid)!;
      const cand = scoreFamilyPair(master, compare, masterDs, compareDs, config);
      if (cand.score / 100 >= config.minScore) scored.push(cand);
    }
    pushTop(out, scored, config.maxPerRecord);
  }
  return out.sort(byScoreDesc);
}

// --- blocking helpers ------------------------------------------------------

function buildBlockIndex<T>(
  records: IterableIterator<T>,
  keysOf: (record: T) => string[],
): Map<string, Set<T>> {
  const index = new Map<string, Set<T>>();
  for (const rec of records) {
    for (const key of keysOf(rec)) {
      let bucket = index.get(key);
      if (!bucket) {
        bucket = new Set<T>();
        index.set(key, bucket);
      }
      bucket.add(rec);
    }
  }
  return index;
}

function collectCandidates<T extends { id: string }>(
  index: Map<string, Set<T>>,
  keys: string[],
): Set<string> {
  const ids = new Set<string>();
  for (const key of keys) {
    const bucket = index.get(key);
    if (bucket) for (const rec of bucket) ids.add(rec.id);
  }
  return ids;
}

function pushTop<T extends { score: number }>(out: T[], scored: T[], cap: number): void {
  scored.sort(byScoreDesc);
  for (const c of scored.slice(0, cap)) out.push(c);
}

function byScoreDesc(a: { score: number }, b: { score: number }): number {
  return b.score - a.score;
}

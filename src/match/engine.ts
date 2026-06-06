import type { Dataset } from "../gedcom/types";
import { familyBlockKeys, scoreFamilyPair } from "./scoreFamily";
import {
  individualBlockKeys,
  plausibleIndividualMatch,
  scoreIndividualPair,
  sexConflicts,
} from "./scoreIndividual";
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

  const scored: IndividualCandidate[] = [];
  for (const compare of compareDs.individuals.values()) {
    const masterIds = collectCandidates(index, individualBlockKeys(compare, soundex));
    for (const mid of masterIds) {
      const master = masterDs.individuals.get(mid)!;
      // Hard plausibility gates: different sex, dissimilar names, or
      // incompatible lifespans => never the same person; skip before scoring.
      if (sexConflicts(master, compare)) continue;
      if (!plausibleIndividualMatch(master, compare, config.gates)) continue;
      const cand = scoreIndividualPair(master, compare, masterDs, compareDs, config);
      if (cand.score / 100 >= config.minScore) scored.push(cand);
    }
  }
  return assignOneToOne(scored);
}

function matchFamilies(
  masterDs: Dataset,
  compareDs: Dataset,
  config: MatchConfig,
): FamilyCandidate[] {
  const index = buildBlockIndex(masterDs.families.values(), (f) =>
    familyBlockKeys(f, masterDs),
  );

  const scored: FamilyCandidate[] = [];
  for (const compare of compareDs.families.values()) {
    const masterIds = collectCandidates(index, familyBlockKeys(compare, compareDs));
    for (const mid of masterIds) {
      const master = masterDs.families.get(mid)!;
      const cand = scoreFamilyPair(master, compare, masterDs, compareDs, config);
      if (cand.score / 100 >= config.minScore) scored.push(cand);
    }
  }
  return assignOneToOne(scored);
}

/**
 * Greedy one-to-one assignment: take pairs in descending score order, keeping a
 * pair only if neither its master nor its compare record is already spoken for.
 * This is the right model for a merge (a record maps to at most one counterpart)
 * and removes the many-to-one noise of similarly-named people.
 */
function assignOneToOne<T extends { masterId: string; compareId: string; score: number }>(
  candidates: T[],
): T[] {
  const sorted = [...candidates].sort(byScoreDesc);
  const usedMaster = new Set<string>();
  const usedCompare = new Set<string>();
  const out: T[] = [];
  for (const c of sorted) {
    if (usedMaster.has(c.masterId) || usedCompare.has(c.compareId)) continue;
    usedMaster.add(c.masterId);
    usedCompare.add(c.compareId);
    out.push(c);
  }
  return out;
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

function byScoreDesc(a: { score: number }, b: { score: number }): number {
  return b.score - a.score;
}

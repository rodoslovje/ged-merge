import type { Dataset, Individual } from "../gedcom/types";
import {
  individualBlockKeys,
  plausibleIndividualMatch,
  scoreIndividualPair,
  sexConflicts,
} from "../match/scoreIndividual";
import { soundex } from "../match/text";
import { DEFAULT_CONFIG, type MatchCategory, type MatchConfig } from "../match/types";
import { label } from "../match/relatives";

/**
 * Within-file duplicate detection.
 *
 * Unlike `matchDatasets` — which compares two distinct files and resolves to a
 * one-to-one mapping — finding duplicates inside a single file must NOT do
 * one-to-one assignment (every person's best match would be themselves) and
 * must skip identity pairs. So this reuses the same blocking + gating + scoring
 * primitives but compares the master against itself, emitting every plausible
 * unordered pair above a (higher than merge-default) threshold.
 */

export interface DuplicatePair {
  aId: string;
  bId: string;
  aLabel: string;
  bLabel: string;
  /** 0..100 similarity score. */
  score: number;
  category: MatchCategory;
}

/** Default acceptance for duplicates — stricter than the merge default (0.45)
 *  because here both records come from the same curated file. */
const DEFAULT_MIN_SCORE = 0.7;

export function findDuplicates(
  ds: Dataset,
  minScore: number = DEFAULT_MIN_SCORE,
  config: MatchConfig = DEFAULT_CONFIG,
): DuplicatePair[] {
  // Blocking: bucket individuals by phonetic/decade keys so only plausible
  // pairs reach the expensive scoring pass.
  const index = new Map<string, Individual[]>();
  for (const indi of ds.individuals.values()) {
    for (const key of individualBlockKeys(indi, soundex, ds)) {
      let bucket = index.get(key);
      if (!bucket) index.set(key, (bucket = []));
      bucket.push(indi);
    }
  }

  const seen = new Set<string>();
  const out: DuplicatePair[] = [];

  for (const a of ds.individuals.values()) {
    const candidates = new Set<string>();
    for (const key of individualBlockKeys(a, soundex, ds)) {
      const bucket = index.get(key);
      if (bucket) for (const b of bucket) candidates.add(b.id);
    }

    for (const bId of candidates) {
      if (bId === a.id) continue;
      // Each unordered pair scored once.
      const pairKey = a.id < bId ? `${a.id}|${bId}` : `${bId}|${a.id}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      const b = ds.individuals.get(bId)!;
      if (sexConflicts(a, b)) continue;
      if (!plausibleIndividualMatch(a, b, config.gates, ds, ds)) continue;
      const cand = scoreIndividualPair(a, b, ds, ds, config);
      if (cand.score / 100 < minScore) continue;

      out.push({
        aId: a.id,
        bId,
        aLabel: label(a),
        bLabel: label(b),
        score: cand.score,
        category: cand.category,
      });
    }
  }

  out.sort((x, y) => y.score - x.score);
  return out;
}

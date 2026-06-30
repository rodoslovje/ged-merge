import type { Sex } from "../gedcom/types";

/** A single weighted contribution to a match score. */
export interface ScoreComponent {
  /** Stable key, e.g. "surname", "birthDate". */
  key: string;
  /** Relative importance. */
  weight: number;
  /** Similarity for this field, 0..1. */
  score: number;
  /** Optional human-readable detail (the compared values). */
  detail?: string;
  /**
   * True for a key field (name/surname/birth year) that couldn't be compared
   * because data was missing on a side: it carries the `missingKeyScore`
   * penalty rather than a real similarity.
   */
  missing?: boolean;
}

export type MatchCategory = "strong" | "probable" | "weak";

export interface IndividualCandidate {
  masterId: string;
  compareId: string;
  /** 0..100, weighted over the components that were comparable. */
  score: number;
  category: MatchCategory;
  components: ScoreComponent[];
  /** Combined master-centric title: master label plus only the differing compare fields. */
  title: string;
  /** Master display name on its own (no birth date), for the redesigned UI. */
  name: string;
  /** Master birth year, when known — rendered in mono beside the name. */
  birthYear?: number;
  /** Master death year, when known — completes the "1817–1921" lifespan range. */
  deathYear?: number;
  /** Original birth/death date text, for the full-date hover tooltip. */
  birthDate?: string;
  deathDate?: string;
  /** True when the master has a death/burial event (even undated) — drives the
   *  "1817–" vs living "1817" distinction in the lifespan label. */
  deceased: boolean;
  /** Sex of the matched person, used to colour the name label. */
  sex: Sex;
  /** Hops from the start person to the master individual (set during ranking). */
  distance?: number;
  /** Fields the compare record has that the master lacks (data to add). */
  newCount?: number;
  /** Fields both records have but that differ (to reconcile). */
  diffCount?: number;
  /** Attached-link rows the compare adds or that differ. */
  linkCount?: number;
  /** Incoming-only ancestors this match would bring in (importable, see countImportable). */
  ancestorCount?: number;
  /** Incoming-only descendants this match would bring in. */
  descendantCount?: number;
  /**
   * Set when this pair was connected by the relationship pass (the two records
   * are each a parent of the same matched children) rather than by name/date
   * score — so the UI can flag it, since such a pair may legitimately differ in
   * name (maiden vs married) or birth year.
   */
  relationshipLinked?: boolean;
}

/**
 * A set of incoming (compare) records that are the same person split across
 * duplicates — detected because they all match the *same* master person. The
 * worker consolidates each cluster (merging the extras into `keepId`) before the
 * compare dataset is used for the tree/merge, so the master matches one clean
 * record carrying all the data instead of stranding the other copies.
 */
export interface IncomingDuplicateCluster {
  /** The matched incoming record kept as the merge survivor. */
  keepId: string;
  /** Other incoming records (the same person) to merge into `keepId`. */
  mergeIds: string[];
}

export interface MatchResult {
  individuals: IndividualCandidate[];
  /** Incoming duplicate clusters for the worker to consolidate (see the type). */
  incomingDuplicates?: IncomingDuplicateCluster[];
}

/** Per-field weights and acceptance thresholds. All tunable. */
export interface MatchConfig {
  individualWeights: {
    surname: number;
    given: number;
    birthDate: number;
    birthPlace: number;
    birthAddress: number;
    /** Death date/place, when known — disambiguates same-named individuals
     *  across generations but isn't part of the identity key (many records
     *  lack it for the living or the unrecorded). */
    deathDate: number;
    deathPlace: number;
    sex: number;
    parents: number;
    partners: number;
    children: number;
    /** Marriage corroboration, folded in from the person's spouse family. */
    marriageDate: number;
    marriagePlace: number;
  };
  /**
   * Hard plausibility gates: a pair failing any of these is never offered as a
   * match, no matter how other fields score.
   */
  gates: {
    /** Minimum surname similarity (0..1) when both have a surname. */
    minSurname: number;
    /** Minimum given-name similarity (0..1) when both have a given name. */
    minGiven: number;
    /** Max years between the two people's representative ("era") years. */
    maxYearGap: number;
  };
  /**
   * Similarity (0..1) charged for a *key* field — surname, given name, or birth
   * year — that is missing on either side. These three are treated as the
   * identity key: a confident match needs all of them, so a gap is penalized
   * (counted at this score) rather than ignored. Lower = harsher.
   */
  missingKeyScore: number;
  /**
   * Extra score points (0..100 scale) added for each parent — father and
   * mother — that is a full name match. Corroborating parents nudge confidence
   * up a little, but the bonus never lifts a pair to 100 unless its identity
   * key is itself perfect.
   */
  parentMatchBonus: number;
  /**
   * Extra score points (0..100 scale) added when a partner (spouse) is a full
   * name match — the same idea as `parentMatchBonus` for a corroborating spouse.
   */
  partnerMatchBonus: number;
  /** Below this 0..1 score a pair is discarded. */
  minScore: number;
  /** Category cut-offs on the 0..1 scale. */
  strongThreshold: number;
  probableThreshold: number;
  /** Cap candidates kept per compare record. */
  maxPerRecord: number;
}

export const DEFAULT_CONFIG: MatchConfig = {
  individualWeights: {
    surname: 3,
    given: 2,
    birthDate: 3,
    birthPlace: 1.5,
    birthAddress: 1.5,
    deathDate: 1.5,
    deathPlace: 0.75,
    sex: 0.5,
    parents: 2,
    partners: 1.5,
    children: 1.5,
    marriageDate: 1.5,
    marriagePlace: 0.75,
  },
  gates: {
    minSurname: 0.8,
    minGiven: 0.5,
    // A century-wide gap is no real filter at all — no plausible same-person
    // pair (even via a remarriage or residence-event fallback year) spans
    // this much, so tightening it rejects implausible pairs before the
    // expensive scoring pass instead of after.
    maxYearGap: 30,
  },
  missingKeyScore: 0.3,
  parentMatchBonus: 1.5,
  partnerMatchBonus: 1.5,
  minScore: 0.45,
  strongThreshold: 0.85,
  probableThreshold: 0.65,
  maxPerRecord: 5,
};

export function categorize(score01: number, config: MatchConfig): MatchCategory {
  if (score01 >= config.strongThreshold) return "strong";
  if (score01 >= config.probableThreshold) return "probable";
  return "weak";
}

/** Combine present components into a 0..1 weighted average. */
export function combineComponents(components: ScoreComponent[]): number {
  if (components.length === 0) return 0;
  const wsum = components.reduce((s, c) => s + c.weight, 0);
  if (wsum === 0) return 0;
  return components.reduce((s, c) => s + c.weight * c.score, 0) / wsum;
}

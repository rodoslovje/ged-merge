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
}

export type MatchCategory = "strong" | "probable" | "weak";

export interface IndividualCandidate {
  masterId: string;
  compareId: string;
  /** 0..100, weighted over the components that were comparable. */
  score: number;
  category: MatchCategory;
  components: ScoreComponent[];
  /** Display labels resolved at scoring time. */
  masterLabel: string;
  compareLabel: string;
  /** Hops from the home person to the master individual (set during ranking). */
  distance?: number;
}

export interface FamilyCandidate {
  masterId: string;
  compareId: string;
  score: number;
  category: MatchCategory;
  components: ScoreComponent[];
  masterLabel: string;
  compareLabel: string;
  /** Minimum distance of either spouse to the home person. */
  distance?: number;
}

export interface MatchResult {
  individuals: IndividualCandidate[];
  families: FamilyCandidate[];
}

/** Per-field weights and acceptance thresholds. All tunable. */
export interface MatchConfig {
  individualWeights: {
    surname: number;
    given: number;
    birthDate: number;
    birthPlace: number;
    sex: number;
    parents: number;
    partners: number;
  };
  familyWeights: {
    husband: number;
    wife: number;
    marriageDate: number;
    marriagePlace: number;
    children: number;
  };
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
    sex: 0.5,
    parents: 2,
    partners: 1.5,
  },
  familyWeights: {
    husband: 2.5,
    wife: 2.5,
    marriageDate: 2,
    marriagePlace: 1,
    children: 2,
  },
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

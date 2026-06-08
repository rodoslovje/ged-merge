/** Whether a candidate match has been acted on. */
export type MatchDecisionStatus = "undecided" | "confirmed" | "rejected" | "deferred";

/** For a single field, which side wins when the match is merged. */
export type FieldChoice = "master" | "incoming" | "both";

export type MatchKind = "individual" | "family";

/** How a field compares between the two records. */
export type FieldState =
  | "agree" // both present and equal
  | "conflict" // both present and different
  | "master-only" // only the master has it
  | "incoming-only"; // only the compare file has it

/** One comparable field, shown as a row in the review panel. */
export interface FieldRow {
  key: string; // stable id, e.g. "surname", "BIRT.date"
  label: string; // display label, e.g. "Birth date"
  master: string; // "" when absent
  incoming: string; // "" when absent
  state: FieldState;
  /** When set, the row holds attached links rendered as icons (not text). */
  masterLinks?: string[];
  incomingLinks?: string[];
  /** Hover tooltip for the value cell (e.g. relatives' full dates behind the
   *  abbreviated "Name yyyy–yyyy" lines). */
  masterTitle?: string;
  incomingTitle?: string;
  /**
   * For relative rows (father, mother, partners, children): the referenced
   * person's id per line, aligned with the lines of `master` / `incoming`.
   * `masterRefs` holds master individual ids, `incomingRefs` compare ids; an
   * entry is undefined for a blank or non-navigable line. Lets the UI turn each
   * name into a link that jumps to that person.
   */
  masterRefs?: (string | undefined)[];
  incomingRefs?: (string | undefined)[];
}

/** The user's decision for one master/compare candidate pair. */
export interface CandidateDecision {
  status: MatchDecisionStatus;
  /** Per-field overrides; absent keys fall back to the row's default choice. */
  fields: Record<string, FieldChoice>;
}

/** Stable key for storing a decision against a candidate pair. */
export function decisionKey(kind: MatchKind, masterId: string, compareId: string): string {
  return `${kind}:${masterId}:${compareId}`;
}

/** Sensible default merge choice: keep the master's value, else take incoming. */
export function defaultChoice(row: FieldRow): FieldChoice {
  return row.master ? "master" : "incoming";
}

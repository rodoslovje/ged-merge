import type { Sex } from "../gedcom/types";

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
  label: string; // full label used in change reports, e.g. "Birth date"
  /** Short label for UI display when an event group header provides context (e.g. "Date"). Falls back to `label`. */
  displayLabel?: string;
  master: string; // "" when absent
  incoming: string; // "" when absent
  state: FieldState;
  /** When set, the row holds attached links rendered as icons (not text). */
  masterLinks?: string[];
  incomingLinks?: string[];
  /** Inline link icons shown alongside the field's text value (used for event-attached links). */
  masterLinkIcons?: string[];
  incomingLinkIcons?: string[];
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
  /**
   * For aligned relative lists (partners, children): one entry per aligned
   * relative, so the UI can render each as its own row that spans both columns —
   * keeping the same person lined up across master and incoming even when a name
   * wraps. When set, the row is rendered from this instead of `master`/`incoming`.
   */
  relatives?: RelativePair[];
  /** When true, this row is a visual separator/header for a group of fields. */
  isGroupHeader?: boolean;
  /** When true, styled as a small-caps event sub-header rather than a bold group header. */
  isEventHeader?: boolean;
}

/** One side of an aligned relative row. */
export interface RelativeCell {
  /** Display text ("Name 1817–1921"), or "" when this side has no counterpart. */
  text: string;
  /** The relative's individual id, when navigable. */
  id?: string;
  /** Full-date tooltip; absent when it adds nothing beyond `text`. */
  title?: string;
  /** The relative's name without dates. */
  name?: string;
  /** The relative's abbreviated lifespan (e.g. "1817–1921"). */
  years?: string;
  /** The relative's sex ("M", "F", "U"). */
  sex?: Sex;
}

/** A relative paired across the two files; either side may be absent. */
export interface RelativePair {
  master?: RelativeCell;
  incoming?: RelativeCell;
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

import type { SourceCitation, Sex } from "../gedcom/types";

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
  /** Event-attached links, rendered as icons alongside the event's source citations. */
  masterLinkIcons?: string[];
  incomingLinkIcons?: string[];
  /** Source citations attached to the event, rendered as badges in this row's value cells. */
  masterSources?: SourceCitation[];
  incomingSources?: SourceCitation[];
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
  /**
   * When true, this relatives row (children) is selected per item: every
   * incoming-only child carries its own take/skip toggle instead of one choice
   * for the whole list, and children are opt-in (skipped unless explicitly
   * taken). See `CandidateDecision.takenChildren`. Partners stay a single
   * row-level choice and don't set this.
   */
  perChildChoice?: boolean;
  /** When true, this row is a visual separator/header for a group of fields. */
  isGroupHeader?: boolean;
  /** When true, styled as a small-caps event sub-header rather than a bold group header. */
  isEventHeader?: boolean;
  /**
   * For individual event sub-rows (date/place/addr/note/agency/value/sources):
   * the row's underlying event's true position in `master.events`/`compare.events`
   * filtered to this tag (-1 if absent on that side). The merge engine uses
   * these — not a position parsed back out of `key` — to find the exact event
   * node to edit, since `key`'s numeric suffix (e.g. "RESI.2") is an output-order
   * index from date/place pairing that doesn't generally equal either side's
   * real array position once a tag has more than one instance.
   */
  eventMasterIdx?: number;
  eventCompareIdx?: number;
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
  /**
   * Incoming events the user has fully rejected — by editing them into a new
   * master event, or by deleting/dismissing an event that was already paired
   * with (or created from) them — as `"<tag>:<compareIdx>"`, where `compareIdx`
   * is that event's position in `compare.events.filter(e => e.tag === tag)`.
   * That index is stable for the whole session (the incoming dataset is never
   * mutated), unlike a row's display key, whose numeric suffix is re-derived
   * from date/place pairing and can point at a different event after any
   * structural edit (an event added, removed, or re-dated). Listed here, the
   * incoming event is treated as absent everywhere — both in the live merge
   * preview and when actually applying the merge on save — so it can never
   * resurface as a duplicate or get silently re-added after its master
   * counterpart is deleted.
   */
  rejectedEvents?: string[];
  /**
   * Incoming children the user has chosen to stitch into the matched master
   * family, by incoming individual id. Children are opt-in: an incoming child
   * the master family doesn't already list is only added when its id appears
   * here. Like `rejectedEvents`, these are stable incoming ids (the compare
   * dataset is never mutated), so the selection survives any structural edit.
   * A child already present in the master family is shown as agreeing and isn't
   * listed here — it needs no decision.
   */
  takenChildren?: string[];
}

/** Stable key for storing a decision against a candidate pair. */
export function decisionKey(kind: MatchKind, masterId: string, compareId: string): string {
  return `${kind}:${masterId}:${compareId}`;
}

/**
 * Collapses individual-decision keys down to one status per master id, so
 * callers showing a single person (a relative card, a tree node) can do a
 * plain id lookup instead of scanning every candidate pair. A "confirmed"
 * decision wins over any other stale decision recorded against the same id.
 */
export function decisionStatusByMasterId(
  decisions: Map<string, CandidateDecision> | undefined,
): Map<string, Exclude<MatchDecisionStatus, "undecided">> {
  const map = new Map<string, Exclude<MatchDecisionStatus, "undecided">>();
  if (!decisions) return map;
  for (const [key, dec] of decisions) {
    if (dec.status === "undecided") continue;
    const parts = key.split(":");
    if (parts.length !== 3 || parts[0] !== "individual") continue;
    if (map.get(parts[1]) !== "confirmed") map.set(parts[1], dec.status);
  }
  return map;
}

/** Sensible default merge choice: keep the master's value, else take incoming. */
export function defaultChoice(row: FieldRow): FieldChoice {
  return row.master ? "master" : "incoming";
}

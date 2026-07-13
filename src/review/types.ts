import type { SourceCitation, Sex } from "../gedcom/types";
import type { AgeBadge } from "../gedcom/age";
import { dateRefines } from "../gedcom/date";

/** Whether a candidate match has been acted on. */
export type MatchDecisionStatus = "undecided" | "confirmed" | "rejected" | "deferred";

/** For a single field, which side wins when the match is merged. */
export type FieldChoice = "main" | "incoming" | "both";

export type MatchKind = "individual" | "family";

/** How a field compares between the two records. */
export type FieldState =
  | "agree" // both present and equal
  | "conflict" // both present and different
  | "main-only" // only the main has it
  | "incoming-only"; // only the compare file has it

/** One comparable field, shown as a row in the review panel. */
export interface FieldRow {
  key: string; // stable id, e.g. "surname", "BIRT.date"
  label: string; // full label used in change reports, e.g. "Birth date"
  /** Short label for UI display when an event group header provides context (e.g. "Date"). Falls back to `label`. */
  displayLabel?: string;
  main: string; // "" when absent
  incoming: string; // "" when absent
  state: FieldState;
  /** When set, the row holds attached links rendered as icons (not text). */
  mainLinks?: string[];
  incomingLinks?: string[];
  /** Event-attached links, rendered as icons alongside the event's source citations. */
  mainLinkIcons?: string[];
  incomingLinkIcons?: string[];
  /** Source citations attached to the event, rendered as badges in this row's value cells. */
  mainSources?: SourceCitation[];
  incomingSources?: SourceCitation[];
  /** Hover tooltip for the value cell (e.g. relatives' full dates behind the
   *  abbreviated "Name yyyy–yyyy" lines). */
  mainTitle?: string;
  incomingTitle?: string;
  /**
   * For an event's date sub-row: the age(s) at that date, shown after the date
   * when "Show ages" is on — the person's own age for individual events, the
   * father's/mother's ages ("♂/♀") on a birth, the couple's ages on a family
   * event. Same badges Edit mode renders; only populated when `showAge` is set.
   */
  mainAges?: AgeBadge[];
  incomingAges?: AgeBadge[];
  /**
   * For relative rows (father, mother, partners, children): the referenced
   * person's id per line, aligned with the lines of `main` / `incoming`.
   * `mainRefs` holds main individual ids, `incomingRefs` compare ids; an
   * entry is undefined for a blank or non-navigable line. Lets the UI turn each
   * name into a link that jumps to that person.
   */
  mainRefs?: (string | undefined)[];
  incomingRefs?: (string | undefined)[];
  /**
   * For aligned relative lists (partners, children): one entry per aligned
   * relative, so the UI can render each as its own row that spans both columns —
   * keeping the same person lined up across main and incoming even when a name
   * wraps. When set, the row is rendered from this instead of `main`/`incoming`.
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
   * the row's underlying event's true position in `main.events`/`compare.events`
   * filtered to this tag (-1 if absent on that side). The merge engine uses
   * these — not a position parsed back out of `key` — to find the exact event
   * node to edit, since `key`'s numeric suffix (e.g. "RESI.2") is an output-order
   * index from date/place pairing that doesn't generally equal either side's
   * real array position once a tag has more than one instance.
   */
  eventMainIdx?: number;
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
  main?: RelativeCell;
  incoming?: RelativeCell;
}

/** The user's decision for one main/compare candidate pair. */
export interface CandidateDecision {
  status: MatchDecisionStatus;
  /** Per-field overrides; absent keys fall back to the row's default choice. */
  fields: Record<string, FieldChoice>;
  /** Fingerprint of the main person's raw record when the decision was (last)
   * set to confirmed. The save preview compares it against the live record and
   * warns when Edit-mode changes landed after the confirmation — the field
   * choices were made against values that no longer exist. */
  mainFp?: string;
  /**
   * Incoming events the user has fully rejected — by editing them into a new
   * main event, or by deleting/dismissing an event that was already paired
   * with (or created from) them — as `"<tag>:<compareIdx>"`, where `compareIdx`
   * is that event's position in `compare.events.filter(e => e.tag === tag)`.
   * That index is stable for the whole session (the incoming dataset is never
   * mutated), unlike a row's display key, whose numeric suffix is re-derived
   * from date/place pairing and can point at a different event after any
   * structural edit (an event added, removed, or re-dated). Listed here, the
   * incoming event is treated as absent everywhere — both in the live merge
   * preview and when actually applying the merge on save — so it can never
   * resurface as a duplicate or get silently re-added after its main
   * counterpart is deleted.
   */
  rejectedEvents?: string[];
  /**
   * Incoming children the user has chosen to stitch into the matched main
   * family, by incoming individual id. Children are opt-in: an incoming child
   * the main family doesn't already list is only added when its id appears
   * here. Like `rejectedEvents`, these are stable incoming ids (the compare
   * dataset is never mutated), so the selection survives any structural edit.
   * A child already present in the main family is shown as agreeing and isn't
   * listed here — it needs no decision.
   */
  takenChildren?: string[];
}

/** Stable key for storing a decision against a candidate pair. */
export function decisionKey(kind: MatchKind, mainId: string, compareId: string): string {
  return `${kind}:${mainId}:${compareId}`;
}

/** Which way a "bring in this branch" request fans out from its anchor person. */
export type ImportDirection = "ancestors" | "descendants";

/**
 * Stable key for a requested subtree import, by direction + the anchor's
 * incoming individual id. The set of these keys (an opt-in "graft this branch
 * on save" selection) is held in app state and threaded into the merge engine.
 */
export function importKey(direction: ImportDirection, incomingId: string): string {
  return `${direction}:${incomingId}`;
}

/** Inverse of {@link importKey}; undefined for a malformed key. */
export function parseImportKey(
  key: string,
): { direction: ImportDirection; incomingId: string } | undefined {
  const i = key.indexOf(":");
  if (i < 0) return undefined;
  return { direction: key.slice(0, i) as ImportDirection, incomingId: key.slice(i + 1) };
}

/**
 * Collapses individual-decision keys down to one status per main id, so
 * callers showing a single person (a relative card, a tree node) can do a
 * plain id lookup instead of scanning every candidate pair. A "confirmed"
 * decision wins over any other stale decision recorded against the same id.
 */
export function decisionStatusByMainId(
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

/** Sensible default merge choice: keep the main's value, else take incoming.
 *  Exception: for a date field, when the incoming date is a strictly more exact
 *  version of the main's (e.g. main "1949" vs incoming "12 MAR 1949"), take
 *  the incoming side — the finer date is almost always what the user wants. */
export function defaultChoice(row: FieldRow): FieldChoice {
  if (!row.main) return "incoming";
  if (row.key.endsWith(".date") && dateRefines(row.main, row.incoming)) return "incoming";
  return "main";
}

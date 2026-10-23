import type { EventFieldUpdate } from "../../gedcom/edit";

/** One text field of an event row, as `useField` holds it. */
export interface RowField {
  value: string;
  /** The value the field mounted with. */
  initial: string;
  /** Still showing an unapplied merge-incoming value. */
  isMerge: boolean;
}

export type RowFields = Record<"date" | "value" | "place" | "address" | "note" | "agency" | "type" | "cause", RowField>;

/**
 * The update an event row commits: every field's current value, with
 * `override` on top — or `null` when nothing in the row differs from what it
 * mounted with (for a still-empty new event, committing would prune it as
 * empty before the user gets a chance to fill in the field they clicked into).
 *
 * Fields still showing an unapplied merge suggestion are sent even untouched:
 * none of it is written yet, and committing only the touched field would drop
 * the other still-shown values the moment the event node first comes into
 * existence. Every other untouched field is left out, so the edit leaves its
 * lines alone:
 *  - a note's displayed text is a stripped projection (URLs pulled into links,
 *    shared-note text resolved from the record), and rewriting it would flatten
 *    a shared-note pointer or drop the note's URLs;
 *  - re-sending a place runs reconcilePlaceForm, which deletes a PLAC.FORM
 *    whose labels don't match the place's comma count;
 *  - the rest are written as one line per tag, so re-sending them collapsed a
 *    second `2 DATE` or `2 ADDR` into the first and trimmed the value's spaces.
 *
 * `flagOnly`: the event's line value is a flag (`Y`) the row doesn't show, so
 * an empty value field keeps `flagValue`.
 */
export function eventRowUpdate(
  fields: RowFields,
  override: Partial<EventFieldUpdate>,
  flagOnly: boolean,
  flagValue: string | undefined,
): EventFieldUpdate | null {
  const merged: EventFieldUpdate = {};
  for (const key of Object.keys(fields) as (keyof RowFields)[]) {
    const field = fields[key];
    if (override[key] !== undefined || field.isMerge || field.value !== field.initial) merged[key] = field.value;
  }
  if (merged.value !== undefined && flagOnly && !merged.value.trim()) merged.value = flagValue;
  Object.assign(merged, override);
  // Fields with no text input behind them have no `initial` to compare against,
  // so an override carrying one is a change by definition. Without this, picking
  // a coordinate while every text field stays as it was reads as "unchanged" and
  // is silently dropped. The note list is its own control with its own state,
  // so like a picked coordinate it only ever commits because something moved.
  const nonTextChange = override.coord !== undefined || override.links !== undefined || override.addSource !== undefined
    || override.noteRefs !== undefined;
  const unchanged = !nonTextChange && (Object.keys(fields) as (keyof RowFields)[]).every((key) => {
    const v = merged[key];
    return v === undefined || v === fields[key].initial || (key === "value" && flagOnly && v === flagValue);
  });
  return unchanged ? null : merged;
}

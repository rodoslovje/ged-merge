import { cloneNode } from "../gedcom/node";
import type { GedNode } from "../gedcom/types";
import { sortEventsByDate } from "./applyFields";

/**
 * The record forest an **edit-only** save writes: a deep clone of the live main
 * records, with every edited individual's events put back into canonical order.
 *
 * Cloning is the point. The save pipeline mutates these records in place — the
 * event sort here, then `stampChanCrea` / `ensureUtf8Charset` when the user
 * confirms — and the preview dialog is built before the user has agreed to
 * anything. Handing over the live `Dataset.records` would apply those edits the
 * moment the *preview opens*, and cancelling the dialog would not undo them,
 * because they are recorded in no `RecordPatch` and so are invisible to
 * undo/redo and to the dirty-tracking snapshots. The clone becomes the live
 * dataset only on confirm, where `buildDataset` rebuilds from it.
 *
 * The merge path gets this for free: `mergeDecisions` already clones.
 *
 * @param records       the live main record forest — never mutated
 * @param sortEligible  true for an individual xref that went through a
 *   *structural* edit in the edit UI — one that added, removed, retagged or
 *   re-dated an event (`App.isSortEligible` decides it by comparing the
 *   person's `eventOrderSignature` against their pre-edit snapshot). Bulk
 *   operations like a place rename, and hand edits that only change values,
 *   must not silently reorder events that were already in a non-canonical
 *   position, so they answer false.
 */
export function buildEditSaveRecords(
  records: readonly GedNode[],
  sortEligible: (xref: string) => boolean,
): GedNode[] {
  const clone = records.map(cloneNode);
  for (const r of clone) {
    if (r.tag === "INDI" && r.xref && sortEligible(r.xref)) sortEventsByDate(r);
  }
  return clone;
}

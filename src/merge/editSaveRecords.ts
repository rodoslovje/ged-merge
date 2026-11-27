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
 * With `touched`, only the records the save can write to are cloned — those it
 * names (the edited ones, whose stamps the save refreshes), the ones whose
 * events it sorts, and the records without an id or about the file itself
 * (header, trailer, submitter). Every other record is the live one, shared: a
 * second copy of a whole large tree is hundreds of megabytes the save does not
 * have, for records it only reads. A caller that goes on to write to more of
 * them takes those over first with {@link ownRecords}.
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
  touched?: (xref: string) => boolean,
): GedNode[] {
  return records.map((r) => {
    const sorts = r.tag === "INDI" && !!r.xref && sortEligible(r.xref);
    if (touched && r.xref && !FILE_RECORDS.has(r.tag) && !sorts && !touched(r.xref)) return r;
    const clone = cloneNode(r);
    if (sorts) sortEventsByDate(clone);
    return clone;
  });
}

/** Records the save rewrites whatever was edited: the header it stamps, the
 *  submitter it may complete, the trailer. */
const FILE_RECORDS = new Set(["HEAD", "SUBM", "TRLR"]);

/**
 * Replace, in place, every record of `records` that is still the live one
 * with its own clone — all of them, or those named by `only` — so that what
 * is about to write to them cannot reach the live file. See
 * {@link buildEditSaveRecords}.
 */
export function ownRecords(records: GedNode[], live: readonly GedNode[], only?: ReadonlySet<string>): void {
  const shared = new Set(live);
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (only && !(r.xref && only.has(r.xref))) continue;
    if (shared.has(r)) records[i] = cloneNode(r);
  }
}

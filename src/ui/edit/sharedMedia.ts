import type { GedNode } from "../../gedcom/types";
import { attachMediaPointer, createMediaRecord, findSharedMediaByFile } from "../../gedcom/edit";
import { cloneRaw, type RecordPatch } from "../historyTypes";

/**
 * The mutation that links a photo to a record in a file of shared top-level
 * `OBJE` records: reuse `existingXref` (or a record with the same file), else
 * create one — recorded in `extraPatches` for undo. The record is created
 * only when the mutation runs, inside the commit: created any earlier, a
 * commit that bails out (no person on screen) would leave it orphaned, with no
 * undo step and no unsaved mark.
 */
export function sharedMediaMutation(
  records: GedNode[],
  file: string,
  existingXref: string | undefined,
  extraPatches: RecordPatch[],
): (raw: GedNode) => void {
  return (raw) => {
    let objeXref = existingXref ?? findSharedMediaByFile(records, file)?.xref;
    if (!objeXref) {
      const rec = createMediaRecord(records, file);
      objeXref = rec.xref!;
      extraPatches.push({ type: "record", id: objeXref, before: null, after: cloneRaw(rec) });
    }
    attachMediaPointer(raw, objeXref);
  };
}

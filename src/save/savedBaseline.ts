import { buildDataset, type BuiltRecords } from "../gedcom/builder";
import type { Dataset, GedcomVersion, GedNode } from "../gedcom/types";

/**
 * The live main as a confirmed save leaves it: rebuilt from the very records
 * the download was serialized from, so the app reflects exactly what was saved
 * rather than leaving merged-in fields stuck on stale pre-merge data
 * (`mergeDecisions` only ever wrote them into a clone for serialization). App
 * assigns the result onto the live dataset in place.
 *
 * `version` is the one the download was written in, which is the file's own
 * unless the reader converted it in the save dialog.
 *
 * Meant to equal a fresh parse of the saved text; the save tests hold it to
 * that.
 */
export function savedBaseline(
  main: Dataset,
  records: GedNode[],
  version: GedcomVersion = main.version,
  reuse?: BuiltRecords,
): Dataset {
  return buildDataset({
    // A save in the other GEDCOM version leaves the open file in that version.
    version,
    // The saved text declares (and is) UTF-8 — the save runs ensureUtf8Charset
    // over these records first — so the new baseline's charset must agree.
    charset: "UTF-8",
    records,
    warnings: main.warnings,
    eol: main.eol,
    finalNewline: main.finalNewline,
    // The file's byte-order mark is a property of the file, not of this save:
    // without it the second download of the session would lose it.
    bom: main.bom,
  }, reuse);
}

/**
 * Make `main` the saved file, in place (see {@link savedBaseline}), and let go
 * of what it held before.
 *
 * A record the save wrote as the very node the file already held keeps the
 * person or family built from it (see `BuiltRecords`): an edit-only save
 * copies only the records it changes, so nearly all of them do, and no second
 * projection is ever built beside the first. A merge, or a save in the other
 * GEDCOM version, writes copies throughout and builds everything anew.
 *
 * The previous collections are emptied rather than merely replaced, because
 * the dataset keeps its identity across a save: whatever still points at them
 * (a closure from the render before, a lookup built over the people map) would
 * otherwise keep the whole pre-save file alive beside the saved one, where no
 * garbage collection could return it.
 */
export function adoptSavedBaseline(main: Dataset, records: GedNode[], version: GedcomVersion = main.version): void {
  const before = { individuals: main.individuals, families: main.families, records: main.records };
  Object.assign(main, savedBaseline(main, records, version, before));
  before.individuals.clear();
  before.families.clear();
  if (before.records !== main.records) before.records.length = 0;
}

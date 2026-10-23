import { buildDataset } from "../gedcom/builder";
import type { Dataset, GedNode } from "../gedcom/types";

/**
 * The live main as a confirmed save leaves it: rebuilt from the very records
 * the download was serialized from, so the app reflects exactly what was saved
 * rather than leaving merged-in fields stuck on stale pre-merge data
 * (`mergeDecisions` only ever wrote them into a clone for serialization). App
 * assigns the result onto the live dataset in place.
 *
 * Meant to equal a fresh parse of the saved text; the save tests hold it to
 * that.
 */
export function savedBaseline(main: Dataset, records: GedNode[]): Dataset {
  return buildDataset({
    version: main.version,
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
  });
}

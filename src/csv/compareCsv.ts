/**
 * The table shapes that can be loaded into the incoming slot, and which one a
 * given file is.
 *
 * They are read differently on purpose. A genealogical-index *matches* export
 * already says which of the reader's people each row concerns, so it is matched
 * pair by pair; a parish-register *index* is a whole book and says nothing about
 * the reader's tree, so it goes through the ordinary matching engine exactly as
 * a GEDCOM compare file does — which is what `pairs` being absent means to the
 * worker.
 */
import type { Dataset } from "../gedcom/types";
import { parseGiMatchesCsv, type GiPair } from "./giMatches";
import { parseParishIndexCsv, parseParishIndexRows } from "./parishIndex";
import { looksLikeWorkbook, readWorkbook } from "./xlsx";

/**
 * Whether an incoming file is a table rather than a GEDCOM — a CSV, or a
 * spreadsheet workbook. The one place the answer is decided, so the loader, the
 * cache and the reload cannot come to different conclusions about one file.
 */
export function isTableFile(fileName: string): boolean {
  return /\.(csv|xlsx|xlsm)$/i.test(fileName);
}

export interface CompareCsvImport {
  dataset: Dataset;
  /** Present only for the matches CSV, whose rows name their main-side person. */
  pairs?: GiPair[];
}

/**
 * Parse an incoming CSV into a compare dataset. The parish index is tried first
 * because it recognises itself and declines quietly; the matches import throws
 * on a header it doesn't know, and that message is what the reader should see
 * when a CSV is neither.
 */
export function parseCompareCsv(text: string): CompareCsvImport {
  const parish = parseParishIndexCsv(text);
  if (parish) return { dataset: parish.dataset };
  return parseGiMatchesCsv(text);
}

/**
 * Parse an incoming table file, whichever form it arrives in: a spreadsheet
 * workbook, or CSV text. Which it is comes from the bytes rather than the name,
 * so a workbook saved with the wrong extension still opens.
 */
export async function parseCompareTable(buffer: ArrayBuffer): Promise<CompareCsvImport> {
  if (looksLikeWorkbook(buffer)) return { dataset: await workbookDataset(buffer) };
  const text = new TextDecoder("utf-8").decode(buffer);
  return parseCompareCsv(text);
}

/**
 * The index inside a workbook. Every sheet is offered to the importer and the
 * first one it recognises wins: the published templates carry an instructions
 * tab and a list of given names beside the index, in no fixed order.
 */
async function workbookDataset(buffer: ArrayBuffer): Promise<Dataset> {
  const sheets = await readWorkbook(buffer);
  if (!sheets.length) throw new Error("Unreadable spreadsheet: no sheets found");
  for (const sheet of sheets) {
    const parish = parseParishIndexRows(sheet.rows);
    if (parish) return parish.dataset;
  }
  throw new Error(
    `Unrecognized spreadsheet: no sheet holds a parish-register index (looked in ${sheets
      .map((s) => s.name)
      .join(", ")})`,
  );
}

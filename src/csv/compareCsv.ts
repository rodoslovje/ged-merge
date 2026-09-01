/**
 * The CSV shapes that can be loaded into the incoming slot, and which one a
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
import { parseParishIndexCsv } from "./parishIndex";

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

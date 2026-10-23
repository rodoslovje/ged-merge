import type { Dataset } from "../gedcom/types";
import { extractBranch } from "../gedcom/branchExport";
import { downloadOptions, serializeGedcom } from "../gedcom/serialize";
import { prepareDownload } from "../save/outputFile";
import { downloadText } from "./download";

/**
 * The Export-menu "GEDCOM" action shared by every chart: cut the chart's
 * people out of the main file as a standalone, valid GEDCOM (see
 * {@link extractBranch}) and download it as `{slug}.ged`. The recipient loads
 * it in GED Merge as a compare file and merges it into their own tree.
 */
export function exportChartGedcom(ds: Dataset, personIds: Iterable<string>, slug: string, authorName?: string): void {
  const { records } = extractBranch(ds, personIds);
  // Records are clones; downloads are UTF-8 bytes, stamped, complete — a 5.5.1
  // branch without a submitter gets one named after the reader (Settings).
  prepareDownload(records, ds, undefined, undefined, authorName);
  downloadText(`${slug}.ged`, serializeGedcom(records, downloadOptions(ds)));
}

import type { Dataset } from "../gedcom/types";
import { extractBranch } from "../gedcom/branchExport";
import { downloadOptions, ensureUtf8Charset, serializeGedcom } from "../gedcom/serialize";
import { downloadText } from "./download";

/**
 * The Export-menu "GEDCOM" action shared by every chart: cut the chart's
 * people out of the master file as a standalone, valid GEDCOM (see
 * {@link extractBranch}) and download it as `{slug}.ged`. The recipient loads
 * it in GED Merge as a compare file and merges it into their own tree.
 */
export function exportChartGedcom(ds: Dataset, personIds: Iterable<string>, slug: string): void {
  const { records } = extractBranch(ds, personIds);
  ensureUtf8Charset(records, ds); // records are clones; downloads are UTF-8 bytes
  downloadText(`${slug}.ged`, serializeGedcom(records, downloadOptions(ds)));
}

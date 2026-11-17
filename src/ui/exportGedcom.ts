import type { Dataset } from "../gedcom/types";
import type { Submitter } from "../gedcom/newFile";
import type { WriteTarget } from "../normalize/target";
import { extractBranch } from "../gedcom/branchExport";
import { serializeGedcom } from "../gedcom/serialize";
import { downloadVersion, outputOptions, prepareDownload } from "../save/outputFile";
import { downloadText } from "./download";
import { afterPendingAdds } from "./source/pendingAdds";

/**
 * The branch file a chart exports: its people cut out of the main file (see
 * {@link extractBranch}), written in the version the main file's target
 * format saves in — a strict target converts, as Save does.
 */
export function branchGedcomText(
  ds: Dataset,
  personIds: Iterable<string>,
  target: Pick<WriteTarget, "strict" | "version">,
  author?: Submitter,
  redactLiving = false,
): string {
  const version = downloadVersion(ds, target);
  const { records } = extractBranch(ds, personIds, { redactLiving, version });
  // Records are clones; downloads are UTF-8 bytes, stamped, complete — a 5.5.1
  // branch without a submitter gets one named after the reader (Settings).
  prepareDownload(records, ds, version, undefined, author);
  return serializeGedcom(records, outputOptions(ds, version));
}

/**
 * The Export-menu "GEDCOM" action shared by every chart: download
 * {@link branchGedcomText} as `{slug}.ged`. The recipient loads it in GED
 * Merge as a compare file and merges it into their own tree.
 */
export function exportChartGedcom(
  ds: Dataset,
  personIds: Iterable<string>,
  slug: string,
  target: Pick<WriteTarget, "strict" | "version">,
  author?: Submitter,
  redactLiving = false,
): void {
  const ids = [...personIds];
  afterPendingAdds(() => {
    downloadText(`${slug}.ged`, branchGedcomText(ds, ids, target, author, redactLiving));
  });
}

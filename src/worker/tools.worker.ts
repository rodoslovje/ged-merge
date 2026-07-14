/// <reference lib="webworker" />
import type { Dataset } from "../gedcom/types";
import { findDuplicates } from "../tools/duplicates";
import { validateDataset } from "../tools/validate";
import { validateStructure } from "../tools/structure";
import { findSourceDuplicates } from "../tools/sourceDuplicates";
import { findReshapableLinks } from "../tools/sourceReshape";
import { bulkNormalize } from "../tools/bulkNormalize";
import { downloadOptions, ensureUtf8Charset, serializeGedcom } from "../gedcom/serialize";
import type { ToolsRequest, ToolsResponse, ToolsResultMap } from "./toolsMessages";

/**
 * Off-main-thread whole-file Tools scans, so a long pass (the duplicate scan
 * takes minutes on an index-scale file) never freezes the tab. Deliberately
 * separate from the gedcom worker: a running scan must not delay a parse or
 * match. The dataset arrives once via `setDataset` and stays cached — the
 * price of one resident copy buys scans that start without re-cloning a
 * possibly huge file. The main thread may terminate this worker at any time
 * to cancel (a synchronous scan can't be interrupted any other way); it is
 * respawned and re-fed lazily on the next run.
 */
let dataset: Dataset | undefined;

self.onmessage = (e: MessageEvent<ToolsRequest>) => {
  const req = e.data;
  if (req.type === "setDataset") {
    dataset = req.dataset;
    return;
  }
  try {
    post({ type: "result", requestId: req.requestId, data: run(req) });
  } catch (err) {
    post({
      type: "error",
      requestId: req.requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

function run(req: Exclude<ToolsRequest, { type: "setDataset" }>): ToolsResultMap[keyof ToolsResultMap] {
  if (!dataset) throw new Error("no dataset loaded");
  switch (req.type) {
    case "findDuplicates": {
      const id = req.requestId;
      const pairs = findDuplicates(dataset, undefined, undefined, (done, total) =>
        post({ type: "progress", requestId: id, done, total }),
      );
      return { pairs };
    }
    case "validate":
      return { report: validateDataset(dataset), structure: validateStructure(dataset) };
    case "sourceDuplicates":
      return { report: findSourceDuplicates(dataset) };
    case "sourceReshape":
      // Scan every category (incl. "other"); the panel filters by selection.
      return {
        report: findReshapableLinks(
          dataset,
          new Set(["matricula", "geneanet", "findagrave", "legacy", "sistory", "familysearch", "other"]),
        ),
      };
    case "normalizePreview":
      return { report: bulkNormalize(dataset).report };
    case "normalizeText": {
      const { dataset: out } = bulkNormalize(dataset, req.options);
      ensureUtf8Charset(out.records, out); // downloads are UTF-8 bytes
      return { text: serializeGedcom(out.records, downloadOptions(dataset)) };
    }
  }
}

function post(res: ToolsResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(res);
}

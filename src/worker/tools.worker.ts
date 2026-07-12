/// <reference lib="webworker" />
import { findDuplicates } from "../tools/duplicates";
import { validateDataset } from "../tools/validate";
import { validateStructure } from "../tools/structure";
import { findSourceDuplicates } from "../tools/sourceDuplicates";
import { bulkNormalize } from "../tools/bulkNormalize";
import { downloadOptions, ensureUtf8Charset, serializeGedcom } from "../gedcom/serialize";
import type { ToolsRequest, ToolsResponse, ToolsResultMap } from "./toolsMessages";

/**
 * Off-main-thread whole-file Tools scans, so a long pass (the duplicate scan
 * takes minutes on an index-scale file) never freezes the tab. Deliberately
 * separate from the gedcom worker: a running scan must not delay a parse or
 * match, and being stateless — every request ships the dataset it scans —
 * this worker can be terminated to cancel without leaving stale state behind.
 */
self.onmessage = (e: MessageEvent<ToolsRequest>) => {
  const req = e.data;
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

function run(req: ToolsRequest): ToolsResultMap[ToolsRequest["type"]] {
  switch (req.type) {
    case "findDuplicates": {
      const pairs = findDuplicates(req.dataset, undefined, undefined, (done, total) =>
        post({ type: "progress", requestId: req.requestId, done, total }),
      );
      return { pairs };
    }
    case "validate":
      return { report: validateDataset(req.dataset), structure: validateStructure(req.dataset) };
    case "sourceDuplicates":
      return { report: findSourceDuplicates(req.dataset) };
    case "normalizePreview":
      return { report: bulkNormalize(req.dataset).report };
    case "normalizeText": {
      const { dataset: out } = bulkNormalize(req.dataset, req.options);
      ensureUtf8Charset(out.records, out); // downloads are UTF-8 bytes
      return { text: serializeGedcom(out.records, downloadOptions(req.dataset)) };
    }
  }
}

function post(res: ToolsResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(res);
}

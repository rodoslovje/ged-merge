/// <reference lib="webworker" />
import type { Dataset } from "../gedcom/types";
import { findDuplicates } from "../tools/duplicates";
import { validateDataset } from "../tools/validate";
import { validateStructure } from "../tools/structure";
import { findSourceDuplicates } from "../tools/sourceDuplicates";
import { ALL_SITES, findReshapableLinks, reshapeOptionsFromOverrides } from "../tools/sourceReshape";
import { bulkNormalize } from "../tools/bulkNormalize";
import { applyRecordsPatch, datasetFromSnapshot } from "../state/mainSync";
import type { ToolsRequest, ToolsResponse, ToolsResultMap } from "./toolsMessages";

/**
 * Off-main-thread whole-file Tools scans, so a long pass (the duplicate scan
 * takes minutes on an index-scale file) never freezes the tab. Deliberately
 * separate from the gedcom worker: a running scan must not delay a parse or
 * match. The main arrives once via `setMain` and stays cached, kept up to
 * date by the edited records (`patchMain`) — the price of one resident copy
 * buys scans that start without re-sending a possibly huge file. The main thread may terminate this worker at any time
 * to cancel (a synchronous scan can't be interrupted any other way); it is
 * respawned and re-fed lazily on the next run.
 */
let dataset: Dataset | undefined;
/** Set while a `patchMain` that did not fit waits for the `setMain` it asked
 *  for: the scans posted meanwhile run once the whole file is here. */
let held: ToolsRequest[] | undefined;

self.onmessage = (e: MessageEvent<ToolsRequest>) => {
  const req = e.data;
  if (held && req.type !== "setMain") {
    held.push(req);
    return;
  }
  const waiting = req.type === "setMain" ? held : undefined;
  held = undefined;
  handle(req);
  // A patch that waited was made against a copy older than the whole main
  // just taken, which already holds its records as they are now.
  for (const r of waiting ?? []) if (r.type !== "patchMain") handle(r);
};

function handle(req: ToolsRequest): void {
  if (req.type === "setMain") {
    dataset = datasetFromSnapshot(req.snapshot);
    return;
  }
  if (req.type === "patchMain") {
    const next = dataset && applyRecordsPatch(dataset, req.patch);
    if (next) dataset = next;
    else {
      dataset = undefined;
      held = [];
      post({ type: "resync" });
    }
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
}

function run(req: Exclude<ToolsRequest, { type: "setMain" | "patchMain" }>): ToolsResultMap[keyof ToolsResultMap] {
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
      return { report: validateDataset(dataset), structure: validateStructure(dataset, req.formatOverrides) };
    case "sourceDuplicates":
      return { report: findSourceDuplicates(dataset) };
    case "sourceReshape":
      // Scan every category (incl. "other"); the panel filters by selection.
      // The user's format overrides ride along so the report matches what the
      // apply will actually write.
      return { report: findReshapableLinks(dataset, new Set(ALL_SITES), reshapeOptionsFromOverrides(req.formatOverrides)) };
    case "normalizePreview":
      // The reader's format overrides ride along, so the preview counts what
      // the apply will actually write.
      return { report: bulkNormalize(dataset, undefined, req.formatOverrides).report };
  }
}

function post(res: ToolsResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(res);
}

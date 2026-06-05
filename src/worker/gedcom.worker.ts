/// <reference lib="webworker" />
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset } from "../gedcom/types";
import { inferMasterProfile } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import type { MasterProfile } from "../normalize/types";
import { matchDatasets } from "../match/engine";
import type { WorkerRequest, WorkerResponse } from "./messages";

/**
 * Off-main-thread GEDCOM parsing and normalization.
 *
 * The worker keeps a little state so the compare file can be normalized to the
 * master regardless of load order:
 *  - load master  -> infer profile; if a compare is already loaded, re-normalize
 *    it and emit an updated result.
 *  - load compare -> normalize against the profile if the master is loaded.
 */
let profile: MasterProfile | undefined;
let masterDataset: Dataset | undefined;
let compareRaw: { fileName: string; dataset: Dataset } | undefined;
let compareNormalized: Dataset | undefined;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type !== "parse") return;

  try {
    const dataset = buildDataset(parseGedcom(req.buffer));

    if (req.role === "master") {
      masterDataset = dataset;
      profile = inferMasterProfile(dataset);
      post({ type: "parsed", role: "master", fileName: req.fileName, dataset });
      // A compare loaded earlier can now be normalized against this master.
      if (compareRaw) emitCompare(compareRaw.fileName, compareRaw.dataset);
    } else {
      // Keep the raw parse so we can re-normalize if the master changes later.
      compareRaw = { fileName: req.fileName, dataset };
      emitCompare(req.fileName, dataset);
    }

    maybeMatch();
  } catch (err) {
    post({
      type: "error",
      role: req.role,
      fileName: req.fileName,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};

/** Emit the compare slot, normalized to the master profile when available. */
function emitCompare(fileName: string, rawDataset: Dataset): void {
  if (!profile) {
    compareNormalized = rawDataset;
    post({ type: "parsed", role: "compare", fileName, dataset: rawDataset });
    return;
  }
  const { dataset, report } = normalizeDataset(rawDataset, profile);
  compareNormalized = dataset;
  post({ type: "parsed", role: "compare", fileName, dataset, report });
}

/** Run matching once both sides are available. */
function maybeMatch(): void {
  if (!masterDataset || !compareNormalized) return;
  const result = matchDatasets(masterDataset, compareNormalized);
  post({ type: "matched", result });
}

function post(res: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(res);
}

/// <reference lib="webworker" />
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { Dataset } from "../gedcom/types";
import { inferMasterProfile } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import type { MasterProfile } from "../normalize/types";
import { matchDatasets } from "../match/engine";
import { applyDistanceRanking } from "../match/distance";
import type { MatchResult } from "../match/types";
import { familyFieldRows, fieldDiffCounts, individualFieldRows } from "../review/fields";
import type { WorkerRequest, WorkerResponse } from "./messages";

/**
 * Off-main-thread GEDCOM parsing, normalization, and matching.
 *
 * The worker keeps state so the compare file normalizes to the master and the
 * results re-rank against the home person, regardless of action order:
 *  - load master  -> infer profile + suggest a home person; re-normalize any
 *    compare already loaded.
 *  - load compare -> normalize against the profile if the master is loaded.
 *  - setHome       -> re-rank the last match result by distance to that person.
 */
let profile: MasterProfile | undefined;
let masterDataset: Dataset | undefined;
let compareRaw: { fileName: string; dataset: Dataset } | undefined;
let compareNormalized: Dataset | undefined;
let homeId: string | undefined;
let lastResult: MatchResult | undefined;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type === "setHome") {
    homeId = req.id;
    if (lastResult && masterDataset) {
      post({ type: "matching" });
      lastResult = applyDistanceRanking(lastResult, masterDataset, homeId);
      post({ type: "matched", result: lastResult });
    }
    return;
  }
  if (req.type !== "parse") return;

  try {
    const dataset = buildDataset(parseGedcom(req.buffer));

    if (req.role === "master") {
      masterDataset = dataset;
      profile = inferMasterProfile(dataset);
      homeId = suggestHome(dataset);
      post({
        type: "parsed",
        role: "master",
        fileName: req.fileName,
        dataset,
        ...(homeId ? { suggestedHomeId: homeId } : {}),
      });
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

/** Run matching once both sides are available, ranked if a home person is set. */
function maybeMatch(): void {
  if (!masterDataset || !compareNormalized) return;
  post({ type: "matching" });
  let result = matchDatasets(masterDataset, compareNormalized);
  result = annotateCounts(result, masterDataset, compareNormalized);
  if (homeId) result = applyDistanceRanking(result, masterDataset, homeId);
  lastResult = result;
  post({ type: "matched", result });
}

/** Attach per-candidate "new" and "differing" field counts for the results table. */
function annotateCounts(result: MatchResult, master: Dataset, compare: Dataset): MatchResult {
  return {
    individuals: result.individuals.map((c) => ({
      ...c,
      ...fieldDiffCounts(
        individualFieldRows(master.individuals.get(c.masterId), compare.individuals.get(c.compareId)),
      ),
    })),
    families: result.families.map((c) => ({
      ...c,
      ...fieldDiffCounts(
        familyFieldRows(master.families.get(c.masterId), compare.families.get(c.compareId), master, compare),
      ),
    })),
  };
}

/** Default home person: HEAD._ROOT pointer if present, else the first INDI. */
function suggestHome(ds: Dataset): string | undefined {
  const head = ds.records.find((r) => r.tag === "HEAD");
  const root = head?.children.find((c) => c.tag === "_ROOT")?.value?.trim();
  if (root && ds.individuals.has(root)) return root;
  const first = ds.individuals.keys().next();
  return first.done ? undefined : first.value;
}

function post(res: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(res);
}

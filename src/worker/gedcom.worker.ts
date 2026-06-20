/// <reference lib="webworker" />
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { inferSourceFormat } from "../gedcom/source";
import type { Dataset } from "../gedcom/types";
import { inferDateLayout, inferMasterProfile, inferPlaceLayout } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import type { MasterProfile } from "../normalize/types";
import { matchDatasets } from "../match/engine";
import { matchGiPairs } from "../match/giMatch";
import { applyDistanceRanking, clearDistanceRanking } from "../match/distance";
import type { MatchResult } from "../match/types";
import { parseGiMatchesCsv, type GiPair } from "../csv/giMatches";
import { fieldDiffCounts, individualFieldRows } from "../review/fields";
import { inferPlaceExportFormat } from "../normalize/profile";
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
/** Set when the compare slot was loaded from a genealogical index matches CSV rather than a GEDCOM. */
let compareCsvPairs: GiPair[] | undefined;
let homeId: string | undefined;
let lastResult: MatchResult | undefined;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type === "setHome") {
    homeId = req.id || undefined; // empty id clears the home person
    if (lastResult && masterDataset) {
      post({ type: "matching" });
      lastResult = homeId
        ? applyDistanceRanking(lastResult, masterDataset, homeId)
        : clearDistanceRanking(lastResult);
      post({ type: "matched", result: lastResult });
    }
    return;
  }
  if (req.type === "parseCsv") {
    try {
      const text = decodeCsv(req.buffer);
      const { dataset, pairs } = parseGiMatchesCsv(text);
      compareCsvPairs = pairs;
      compareRaw = { fileName: req.fileName, dataset };
      emitCompare(req.fileName, dataset);
      maybeMatch();
    } catch (err) {
      post({
        type: "error",
        role: "compare",
        fileName: req.fileName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }
  if (req.type !== "parse") return;

  try {
    const dataset = buildDataset(parseGedcom(req.buffer));

    if (req.role === "master") {
      masterDataset = dataset;
      profile = inferMasterProfile(dataset);
      post({
        type: "parsed",
        role: "master",
        fileName: req.fileName,
        dataset,
        placeLayout: profile.place.layout,
        dateFormat: inferDateLayout(dataset),
        sourceLayout: inferSourceFormat(dataset.records).layout,
      });
      // A compare loaded earlier can now be normalized against this master.
      if (compareRaw) emitCompare(compareRaw.fileName, compareRaw.dataset);
    } else {
      // Keep the raw parse so we can re-normalize if the master changes later.
      compareRaw = { fileName: req.fileName, dataset };
      compareCsvPairs = undefined;
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

/** Decode an ArrayBuffer as UTF-8 text, stripping a leading BOM if present. */
function decodeCsv(buffer: ArrayBuffer): string {
  const text = new TextDecoder("utf-8").decode(buffer);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Emit the compare slot, normalized to the master profile when available. */
function emitCompare(fileName: string, rawDataset: Dataset): void {
  const placeLayout = inferPlaceLayout(rawDataset);
  // Report the format we detected in the incoming file itself (before it is
  // normalized to the master's conventions).
  const dateFormat = inferDateLayout(rawDataset);
  const sourceLayout = inferSourceFormat(rawDataset.records).layout;
  if (!profile) {
    compareNormalized = rawDataset;
    post({ type: "parsed", role: "compare", fileName, dataset: rawDataset, placeLayout, dateFormat, sourceLayout });
    return;
  }
  const { dataset, report } = normalizeDataset(rawDataset, profile);
  compareNormalized = dataset;
  post({ type: "parsed", role: "compare", fileName, dataset, report, placeLayout, dateFormat, sourceLayout });
}

/** Run matching once both sides are available, ranked if a home person is set. */
function maybeMatch(): void {
  if (!masterDataset || !compareNormalized) return;
  post({ type: "matching" });
  let result = compareCsvPairs
    ? matchGiPairs(masterDataset, compareNormalized, compareCsvPairs)
    : matchDatasets(masterDataset, compareNormalized);
  result = annotateCounts(result, masterDataset, compareNormalized);
  if (homeId) result = applyDistanceRanking(result, masterDataset, homeId);
  lastResult = result;
  post({ type: "matched", result });
}

/** Field labels are irrelevant to the counts computed here, so use a no-op
 * translator (the worker has no i18n context). */
const rawLabel = (key: string) => key;

/** Attach per-candidate "new" and "differing" field counts for the results table. */
function annotateCounts(result: MatchResult, master: Dataset, compare: Dataset): MatchResult {
  const placeFmt = inferPlaceExportFormat(master);
  return {
    individuals: result.individuals.map((c) => ({
      ...c,
      ...fieldDiffCounts(
        individualFieldRows(
          rawLabel,
          master.individuals.get(c.masterId),
          compare.individuals.get(c.compareId),
          master,
          compare,
          placeFmt,
        ),
      ),
    })),
  };
}

function post(res: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(res);
}

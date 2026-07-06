/// <reference lib="webworker" />
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { inferSourceFormat } from "../gedcom/source";
import type { Dataset, Individual } from "../gedcom/types";
import { buildPersonTree, buildMatchMaps, countImportable, type TreeMode } from "../chart/personTree";
import { collectLayoutValues, dateLayoutFromValues, detectDatePlaceholder, detectPlaceLayout, detectUnknownNameToken, inferDateLayout, inferDatePlaceholder, inferMainProfile, inferNameLayout } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import type { MainProfile } from "../normalize/types";
import { matchDatasets } from "../match/engine";
import { matchGiPairs } from "../match/giMatch";
import { mergeDuplicate } from "../tools/mergeDuplicate";
import { applyDistanceRanking, clearDistanceRanking } from "../match/distance";
import type { MatchResult } from "../match/types";
import { parseGiMatchesCsv, type GiPair } from "../csv/giMatches";
import { fieldDiffCounts, individualFieldRows } from "../review/fields";
import { inferPlaceExportFormat } from "../normalize/profile";
import type { WorkerRequest, WorkerResponse } from "./messages";

/**
 * Off-main-thread GEDCOM parsing, normalization, and matching.
 *
 * The worker keeps state so the compare file normalizes to the main and the
 * results re-rank against the start person, regardless of action order:
 *  - load main  -> infer profile + suggest a start person; re-normalize any
 *    compare already loaded.
 *  - load compare -> normalize against the profile if the main is loaded.
 *  - setStart       -> re-rank the last match result by distance to that person.
 */
let profile: MainProfile | undefined;
let mainDataset: Dataset | undefined;
let compareRaw: { fileName: string; dataset: Dataset } | undefined;
let compareNormalized: Dataset | undefined;
/** Set when the compare slot was loaded from a genealogical index matches CSV rather than a GEDCOM. */
let compareCsvPairs: GiPair[] | undefined;
let startId: string | undefined;
let lastResult: MatchResult | undefined;
/** The last compare `parsed` payload (minus the dataset), so the consolidated
 *  compare can be re-emitted with the same format reports after duplicates are
 *  merged in. */
let lastCompareMeta:
  | Omit<Extract<WorkerResponse, { type: "parsed" }>, "type" | "role" | "dataset">
  | undefined;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type === "setStart") {
    startId = req.id || undefined; // empty id clears the start person
    if (lastResult && mainDataset) {
      post({ type: "matching" });
      lastResult = startId
        ? applyDistanceRanking(lastResult, mainDataset, startId)
        : clearDistanceRanking(lastResult);
      post({ type: "matched", result: lastResult });
    }
    return;
  }
  if (req.type === "clearCompare") {
    // Forget the incoming file so a later main reload/re-match doesn't resurrect
    // it. The start person stays set for a subsequent compare.
    compareRaw = undefined;
    compareNormalized = undefined;
    compareCsvPairs = undefined;
    lastResult = undefined;
    lastCompareMeta = undefined;
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

    if (req.role === "main") {
      mainDataset = dataset;
      profile = inferMainProfile(dataset);
      // A silent re-feed only rebuilds internal state (see ParseRequest.silent);
      // the main thread keeps its existing main file + edit tracking.
      if (!req.silent) {
        post({
          type: "parsed",
          role: "main",
          fileName: req.fileName,
          dataset,
          placeLayout: profile.place.layout,
          dateFormat: inferDateLayout(dataset),
          datePlaceholder: inferDatePlaceholder(dataset),
          sourceLayout: inferSourceFormat(dataset.records).layout,
          nameLayout: inferNameLayout(dataset),
          unknownNameStyle: detectUnknownNameToken(dataset),
          marriedNameTag: profile.nameVariants.married.form === "tag",
        });
      }
      // A compare loaded earlier can now be normalized against this main.
      if (compareRaw) emitCompare(compareRaw.fileName, compareRaw.dataset);
    } else {
      // Keep the raw parse so we can re-normalize if the main changes later.
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

/** Emit the compare slot, normalized to the main profile when available. */
function emitCompare(fileName: string, rawDataset: Dataset): void {
  // One walk collects DATE and PLAC/ADDR values together, shared below by the
  // place/date layout reports and (when normalizing) the source date order —
  // instead of each walking the record tree on its own.
  const { dateValues, placeValues, addrCount } = collectLayoutValues(rawDataset);
  const placeLayout = detectPlaceLayout(placeValues, addrCount);
  // Report the format we detected in the incoming file itself (before it is
  // normalized to the main's conventions).
  const dateFormat = dateLayoutFromValues(dateValues);
  const datePlaceholder = detectDatePlaceholder(dateValues);
  const sourceLayout = inferSourceFormat(rawDataset.records).layout;
  const nameLayout = inferNameLayout(rawDataset);
  // Detected on the raw file, so the summary reports the placeholder the incoming
  // file actually used (before it's reshaped to the main's convention).
  const unknownNameStyle = detectUnknownNameToken(rawDataset);
  if (!profile) {
    compareNormalized = rawDataset;
    lastCompareMeta = { fileName, placeLayout, dateFormat, datePlaceholder, sourceLayout, nameLayout, unknownNameStyle };
    post({ type: "parsed", role: "compare", dataset: rawDataset, ...lastCompareMeta });
    return;
  }
  const { dataset, report } = normalizeDataset(rawDataset, profile, dateValues);
  compareNormalized = dataset;
  lastCompareMeta = { fileName, report, placeLayout, dateFormat, datePlaceholder, sourceLayout, nameLayout, unknownNameStyle };
  post({ type: "parsed", role: "compare", dataset, ...lastCompareMeta });
}

/** Run matching once both sides are available, ranked if a start person is set. */
function maybeMatch(): void {
  if (!mainDataset || !compareNormalized) return;
  post({ type: "matching" });
  let result = compareCsvPairs
    ? matchGiPairs(mainDataset, compareNormalized, compareCsvPairs)
    : matchDatasets(mainDataset, compareNormalized);
  // Consolidate incoming records that are the same person split across duplicates
  // (detected by matching the same main) into one, then re-emit the cleaned
  // compare so the merge and tree see a single record carrying all the data.
  if (result.incomingDuplicates?.length) {
    for (const { keepId, mergeIds } of result.incomingDuplicates) {
      for (const id of mergeIds) {
        mergeDuplicate(compareNormalized, keepId, id, { status: "confirmed", fields: {} }, rawLabel);
      }
    }
    const consolidated = result.incomingDuplicates.reduce((n, c) => n + c.mergeIds.length, 0);
    result = { individuals: result.individuals };
    if (lastCompareMeta?.report) lastCompareMeta.report.consolidatedDuplicates = consolidated;
    if (lastCompareMeta) post({ type: "parsed", role: "compare", dataset: compareNormalized, ...lastCompareMeta });
  }
  result = annotateCounts(result, mainDataset, compareNormalized);
  if (startId) result = applyDistanceRanking(result, mainDataset, startId);
  lastResult = result;
  post({ type: "matched", result });
}

/** Field labels are irrelevant to the counts computed here, so use a no-op
 * translator (the worker has no i18n context). */
const rawLabel = (key: string) => key;

/** Attach per-candidate "new" and "differing" field counts plus the importable
 *  ancestor/descendant counts for the results table. */
function annotateCounts(result: MatchResult, main: Dataset, compare: Dataset): MatchResult {
  const placeFmt = inferPlaceExportFormat(main);
  const maps = buildMatchMaps(result);
  const importable = (mainInd: Individual | undefined, compareInd: Individual | undefined, mode: TreeMode) => {
    const tree = buildPersonTree(rawLabel, mainInd, compareInd, main, compare, maps, mode);
    return tree ? countImportable(tree) : 0;
  };
  return {
    individuals: result.individuals.map((c) => {
      const mainInd = main.individuals.get(c.mainId);
      const compareInd = compare.individuals.get(c.compareId);
      return {
        ...c,
        ...fieldDiffCounts(
          individualFieldRows(rawLabel, mainInd, compareInd, main, compare, placeFmt),
        ),
        ancestorCount: importable(mainInd, compareInd, "ancestors"),
        descendantCount: importable(mainInd, compareInd, "descendants"),
      };
    }),
  };
}

function post(res: WorkerResponse): void {
  (self as DedicatedWorkerGlobalScope).postMessage(res);
}

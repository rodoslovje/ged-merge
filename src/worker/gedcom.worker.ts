/// <reference lib="webworker" />
import { detectDialect, proposeTarget, targetFormatOverrides, writeTarget } from "../normalize/target";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { detectCitationPageStyle, inferSourceFormat, type CitationPageStyle } from "../gedcom/source";
import { applyFormatOverrides, type FormatOverrides } from "../normalize/formatOverrides";
import { detectPageMediaStyle, hasSourcePageMedia } from "../tools/sourceReshape";
import { detectFormatDefaults } from "../normalize/formatDefaults";
import type { NameLayout, PlaceLayout, SourceLayout } from "../normalize/types";
import type { Dataset } from "../gedcom/types";
import { annotateCounts } from "./annotateCounts";
import { collectLayoutValues, dateLayoutFromValues, detectCoordUsage, detectDatePlaceholder, detectPlaceLayout, detectUnknownNameToken, inferMainProfile, inferNameLayout } from "../normalize/profile";
import { normalizeDataset } from "../normalize/normalize";
import { diffNormalized } from "../normalize/normPatch";
import { applyRecordsPatch } from "../state/mainSync";
import type { MainProfile } from "../normalize/types";
import { matchDatasetsExplained, pairExplainer, type PairExplainer } from "../match/engine";
import { matchGiPairs } from "../match/giMatch";
import { consolidateDuplicates } from "../tools/mergeDuplicate";
import { kinshipRanking } from "../match/distance";
import type { MatchResult, ScoredMatchResult } from "../match/types";
import { parseCompareTable } from "../csv/compareCsv";
import type { GiPair } from "../csv/giMatches";
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
/** The Settings › GEDCOM overrides the main was parsed with — annotateCounts
 *  must count with the same place format the review panel shows and the merge
 *  applies, not with the file's bare habit. */
let mainOverrides: FormatOverrides | undefined;
let mainDataset: Dataset | undefined;
let compareRaw: { fileName: string; dataset: Dataset } | undefined;
let compareNormalized: Dataset | undefined;
/** Set when the compare slot was loaded from a genealogical index matches CSV rather than a GEDCOM. */
let compareCsvPairs: GiPair[] | undefined;
/**
 * Bumped by everything that claims the compare slot, so a table still being read
 * can tell it has been superseded.
 *
 * A spreadsheet is inflated asynchronously, and the app only tears the worker
 * down when a *match* is in flight — so two incoming files chosen in quick
 * succession both reach this worker, and without a generation the first to
 * finish reading would be the one that lands, whichever the reader picked last.
 */
let compareGeneration = 0;
let startId: string | undefined;
/** The last match list as posted — score order, no score breakdowns, no
 *  distances; a start-person ranking is sent as positions into it. */
let lastResult: MatchResult | undefined;
/** Re-derives a pair's score breakdown for the score tooltip. */
let explain: PairExplainer | undefined;
/** The last compare `parsed` payload (minus the dataset), so the consolidated
 *  compare can be re-emitted with the same format reports after duplicates are
 *  merged in. */
let lastCompareMeta:
  | Omit<Extract<WorkerResponse, { type: "parsed" }>, "type" | "role" | "dataset">
  | undefined;

/** Set when a `patchMain` did not fit this worker's main: every request
 *  after it waits here until the whole main the app sends in answer has been
 *  parsed, so nothing is matched against a main that missed edits. */
let held: WorkerRequest[] | undefined;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (held) {
    if (req.type !== "parse" || req.role !== "main") {
      held.push(req);
      return;
    }
    const waiting = held;
    held = undefined;
    handle(req);
    // A patch that waited was made against a copy older than the whole main
    // just parsed, which already holds its records as they are now.
    for (const r of waiting) if (r.type !== "patchMain") handle(r);
    return;
  }
  handle(req);
};

function handle(req: WorkerRequest): void {
  if (req.type === "patchMain") {
    const next = mainDataset && applyRecordsPatch(mainDataset, req.patch);
    if (!next) {
      held = [];
      post({ type: "mainOutOfStep" });
      return;
    }
    // As a silent re-feed would, minus re-announcing and re-matching the
    // compare: the app sends this only on its way to loading a new one, and
    // the old result, matched against the old main, is not kept to re-rank.
    mainDataset = next;
    lastResult = undefined;
    mainOverrides = req.formatOverrides;
    profile = applyFormatOverrides(inferMainProfile(next), req.formatOverrides);
    return;
  }
  if (req.type === "setStart") {
    startId = req.id || undefined; // empty id clears the start person
    if (lastResult && mainDataset) {
      try {
        post({ type: "matching" });
        // Only the new order travels: the main thread holds the list.
        postMatched(undefined, mainDataset, lastResult);
      } catch (err) {
        post({ type: "matchFailed", message: errorMessage(err) });
      }
    }
    return;
  }
  if (req.type === "scoreDetail") {
    post({
      type: "scoreDetail",
      mainId: req.mainId,
      compareId: req.compareId,
      generation: req.generation,
      components: explain?.(req.mainId, req.compareId),
    });
    return;
  }
  if (req.type === "clearCompare") {
    // Forget the incoming file so a later main reload/re-match doesn't resurrect
    // it. The start person stays set for a subsequent compare.
    compareGeneration++;
    compareRaw = undefined;
    compareNormalized = undefined;
    compareCsvPairs = undefined;
    lastResult = undefined;
    explain = undefined;
    lastCompareMeta = undefined;
    return;
  }
  if (req.type === "parseCsv") {
    // Awaited rather than run inline: a spreadsheet workbook is a zip, and
    // inflating it is asynchronous. Nothing else in the message loop depends on
    // this finishing first — the slot announces itself when it is ready, as it
    // already does for a compare that arrives before the main.
    void loadCompareTable(req.fileName, req.buffer, ++compareGeneration);
    return;
  }
  if (req.type !== "parse") return;

  try {
    const dataset = buildDataset(parseGedcom(req.buffer));

    if (req.role === "main") {
      mainDataset = dataset;
      // The detections the target is proposed from, computed once here (off
      // the main thread) and stored with the file — the loader card and the
      // Settings GEDCOM tab both read from it. The map reports what the file
      // *itself* does; `profile` below additionally carries the user's
      // overrides and the target format's.
      const detectedFormats = req.silent ? undefined : detectFormatDefaults(dataset);
      const dialect = req.silent ? undefined : detectDialect(dataset);
      mainOverrides = req.target
        ? targetFormatOverrides(
            req.formatOverrides ?? {},
            writeTarget(
              req.target === "propose"
                ? proposeTarget(dataset, dialect ?? detectDialect(dataset), detectedFormats ?? detectFormatDefaults(dataset)).mode
                : req.target,
              dataset,
            ),
          )
        : req.formatOverrides;
      profile = applyFormatOverrides(inferMainProfile(dataset), mainOverrides);
      // A silent re-feed only rebuilds internal state (see ParseRequest.silent);
      // the main thread keeps its existing main file + edit tracking.
      if (detectedFormats) {
        post({
          type: "parsed",
          role: "main",
          fileName: req.fileName,
          // No dataset: the main thread builds its own from the same bytes
          // (see ParseSuccess.dataset). The profile travels so it can
          // normalize an incoming file the same way this worker does.
          profile,
          placeFmt: inferPlaceExportFormat(dataset), // cached from the profile inference above
          detectedFormats,
          dialect,
          placeLayout: (detectedFormats.place as PlaceLayout | undefined) ?? "unknown",
          dateFormat: detectedFormats.date,
          datePlaceholder: detectedFormats.datePlaceholder === "none" ? undefined : detectedFormats.datePlaceholder,
          sourceLayout: (detectedFormats.sourceLayout as SourceLayout | undefined) ?? "unknown",
          pageMediaStyle: detectedFormats.pageMedia as "event" | "source" | undefined,
          citationPageStyle: detectedFormats.citationPage as CitationPageStyle | undefined,
          nameLayout: (detectedFormats.names as NameLayout | undefined) ?? "none",
          unknownNameStyle: detectedFormats.unknownName === "blank" ? undefined : detectedFormats.unknownName,
          marriedNameTag: profile.nameVariants.married.form === "tag",
          coordUsage: detectCoordUsage(dataset),
        });
      }
    } else {
      // Keep the raw parse so we can re-normalize if the main changes later.
      compareGeneration++;
      compareRaw = { fileName: req.fileName, dataset };
      compareCsvPairs = undefined;
      emitCompare(req.fileName, dataset, false);
    }
  } catch (err) {
    post({
      type: "error",
      role: req.role,
      fileName: req.fileName,
      message: errorMessage(err),
    });
    return;
  }
  // A compare loaded earlier can now be normalized against this main. Outside
  // the parse try/catch, and reported against the *compare* slot: the main's
  // `parsed` has already been posted and that slot is genuinely loaded, so a
  // throw while reshaping the compare file must not flip a healthy main to
  // error and evict its cached file.
  if (req.role === "main" && compareRaw) {
    const { fileName } = compareRaw;
    try {
      emitCompare(fileName, compareRaw.dataset, compareCsvPairs !== undefined);
    } catch (err) {
      compareRaw = undefined;
      post({ type: "error", role: "compare", fileName, message: errorMessage(err) });
      return;
    }
  }
  // Outside the parse try/catch on purpose: by now `parsed` has been posted
  // and the slot is genuinely loaded, so a throw in the match pipeline must
  // not be reported as a parse error — that would flip a healthy slot to
  // error, evict its cached file, and leave the matching spinner up forever.
  tryMatch();
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run {@link maybeMatch}, converting a match-pipeline throw into a
 *  `matchFailed` message instead of letting it fall out of the handler. */
function tryMatch(): void {
  try {
    maybeMatch();
  } catch (err) {
    post({ type: "matchFailed", message: errorMessage(err) });
  }
}

/**
 * Load a CSV or spreadsheet into the compare slot, then match.
 *
 * The parse is guarded but the match is not, for the same reason the GEDCOM
 * path splits them: once the slot has announced itself the file is genuinely
 * loaded, and a throw in the match pipeline must not flip a healthy slot to
 * error and leave the spinner up for ever.
 */
async function loadCompareTable(fileName: string, buffer: ArrayBuffer, generation: number): Promise<void> {
  try {
    const { dataset, pairs } = await parseCompareTable(buffer);
    if (generation !== compareGeneration) return; // another file claimed the slot
    compareCsvPairs = pairs;
    compareRaw = { fileName, dataset };
    emitCompare(fileName, dataset, true);
  } catch (err) {
    // A superseded file's failure is not this slot's problem: erroring here
    // would fail the file the reader actually chose.
    if (generation === compareGeneration) {
      post({ type: "error", role: "compare", fileName, message: errorMessage(err) });
    }
    return;
  }
  tryMatch();
}

/** Emit the compare slot, normalized to the main profile when available.
 *  `withDataset` sends the dataset itself — only for a table-built compare,
 *  which the main thread cannot build; a GEDCOM compare is rebuilt there
 *  from the file's bytes (see ParseSuccess.dataset). */
function emitCompare(fileName: string, rawDataset: Dataset, withDataset: boolean): void {
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
  const citationPageStyle = detectCitationPageStyle(rawDataset.records);
  // Same rule as `detectFormatDefaults`: a file that cites pages by their
  // link has no page-image habit to report.
  const pageMediaStyle =
    citationPageStyle !== "url" && hasSourcePageMedia(rawDataset.records) ? detectPageMediaStyle(rawDataset.records) : undefined;
  const nameLayout = inferNameLayout(rawDataset);
  // Detected on the raw file, so the summary reports the placeholder the incoming
  // file actually used (before it's reshaped to the main's convention).
  const unknownNameStyle = detectUnknownNameToken(rawDataset);
  // Counted on the raw file: whether the *incoming* side brings coordinates is
  // what matters when deciding a merge, and normalizing does not add any.
  const coordUsage = detectCoordUsage(rawDataset);
  if (!profile) {
    compareNormalized = rawDataset;
    lastCompareMeta = { fileName, placeLayout, dateFormat, datePlaceholder, sourceLayout, pageMediaStyle, citationPageStyle, nameLayout, unknownNameStyle, coordUsage };
    post({ type: "parsed", role: "compare", ...(withDataset ? { dataset: rawDataset } : {}), ...lastCompareMeta });
    return;
  }
  const { dataset, report } = normalizeDataset(rawDataset, profile, dateValues);
  compareNormalized = dataset;
  // The profile travels with the compare: a silent main re-feed changes it
  // without announcing the main, and should the edits below be missing, the
  // main thread normalizes its copy against the same one.
  lastCompareMeta = { fileName, profile, report, placeLayout, dateFormat, datePlaceholder, sourceLayout, pageMediaStyle, citationPageStyle, nameLayout, unknownNameStyle, coordUsage };
  if (withDataset) {
    post({ type: "parsed", role: "compare", dataset, ...lastCompareMeta });
    return;
  }
  // What normalizing changed, for the main thread to replay on its own parse
  // of the bytes instead of normalizing them a second time. Kept out of
  // `lastCompareMeta`: its buffers are transferred, and the re-announcement
  // after consolidation has nothing to replay.
  const normalized = diffNormalized(rawDataset.records, dataset.records);
  post(
    { type: "parsed", role: "compare", ...lastCompareMeta, ...(normalized ? { normalized } : {}) },
    normalized ? [normalized.ops.buffer, normalized.lens.buffer] : undefined,
  );
}

/** Run matching once both sides are available, ranked if a start person is set. */
function maybeMatch(): void {
  if (!mainDataset || !compareNormalized) return;
  post({ type: "matching" });
  let result: ScoredMatchResult;
  if (compareCsvPairs) {
    result = matchGiPairs(mainDataset, compareNormalized, compareCsvPairs);
    explain = pairExplainer(mainDataset, compareNormalized);
  } else {
    ({ result, explain } = matchDatasetsExplained(mainDataset, compareNormalized));
  }
  // Consolidate incoming records that are the same person split across duplicates
  // (detected by matching the same main) into one, then re-emit the cleaned
  // compare so the merge and tree see a single record carrying all the data.
  if (result.incomingDuplicates?.length) {
    const clusters = result.incomingDuplicates;
    consolidateDuplicates(compareNormalized, clusters);
    const consolidated = clusters.reduce((n, c) => n + c.mergeIds.length, 0);
    result = { individuals: result.individuals };
    if (lastCompareMeta?.report) lastCompareMeta.report.consolidatedDuplicates = consolidated;
    // The clusters travel, not the dataset: the main thread replays the same
    // merges on its own copy (see ParseSuccess.consolidated).
    if (lastCompareMeta) post({ type: "parsed", role: "compare", consolidated: clusters, ...lastCompareMeta });
  }
  lastResult = annotateCounts(result, mainDataset, compareNormalized, mainOverrides);
  postMatched(lastResult, mainDataset, lastResult);
}

/**
 * Post a match list (`result`, when it is new) and its ranking by kinship to
 * the start person, if one is set. The ranking is two Int32Arrays of
 * positions into `list`, moved rather than copied.
 */
function postMatched(result: MatchResult | undefined, main: Dataset, list: MatchResult): void {
  const ranking = startId ? kinshipRanking(list.individuals, main, startId) : undefined;
  post(
    { type: "matched", ...(result ? { result } : {}), ...(ranking ? { ranking } : {}) },
    ranking ? [ranking.order.buffer, ranking.distance.buffer] : [],
  );
}


function post(res: WorkerResponse, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(res, transfer);
}

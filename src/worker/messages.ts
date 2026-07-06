import type { Dataset } from "../gedcom/types";
import type { NameLayout, NormalizationReport, PlaceLayout, SourceLayout } from "../normalize/types";
import type { MatchResult } from "../match/types";

/** Which slot a loaded file occupies. */
export type DatasetRole = "main" | "compare";

export interface ParseRequest {
  type: "parse";
  role: DatasetRole;
  fileName: string;
  buffer: ArrayBuffer;
  /** Rebuild the worker's internal dataset/profile without emitting `parsed`.
   *  Used to re-feed a kept slot into a freshly-recreated worker (after a
   *  hard-abort) so a match can run again, while leaving the main thread's
   *  loaded-file state — and any edit tracking bound to it — untouched. */
  silent?: boolean;
}

/** Load a matches CSV from indeks.rodoslovje.si into the compare slot. */
export interface ParseCsvRequest {
  type: "parseCsv";
  fileName: string;
  buffer: ArrayBuffer;
}

/** Choose the start person in the main; triggers a re-ranked match result. */
export interface SetStartRequest {
  type: "setStart";
  id: string;
}

/** Drop the compare slot so the worker holds only the main again. Emits no
 *  response — the app clears its own match/decision state when it unloads. */
export interface ClearCompareRequest {
  type: "clearCompare";
}

export type WorkerRequest = ParseRequest | ParseCsvRequest | SetStartRequest | ClearCompareRequest;

export interface ParseSuccess {
  type: "parsed";
  role: DatasetRole;
  fileName: string;
  dataset: Dataset;
  /** Present for the compare slot once it has been normalized to the main. */
  report?: NormalizationReport;
  /** Detected place-formatting convention of this file. */
  placeLayout?: PlaceLayout;
  /** Detected date format pattern of this file, e.g. "DD.MM.YYYY". */
  dateFormat?: string;
  /** Marker this file uses for an unknown date component (e.g. "_"); absent when
   * it has no placeholder-date convention. */
  datePlaceholder?: string;
  /** Detected source-citation convention of this file. */
  sourceLayout?: SourceLayout;
  /** Detected name-storage style of this file. */
  nameLayout?: NameLayout;
  /** Placeholder token this file uses for unknown names (e.g. "NN"); absent when
   * it leaves unknown name parts blank. */
  unknownNameStyle?: string;
  /** Main only: true when married surnames are stored inline as `_MARNM`, so
   * the name editor folds an added "married" name into that tag. */
  marriedNameTag?: boolean;
}

export interface ParseFailure {
  type: "error";
  role: DatasetRole;
  fileName: string;
  message: string;
}

/** Emitted right before a (re-)match begins, so the UI can show progress. */
export interface MatchProgress {
  type: "matching";
}

/** Emitted once both main and compare are loaded. */
export interface MatchSuccess {
  type: "matched";
  result: MatchResult;
}

export type WorkerResponse = ParseSuccess | ParseFailure | MatchProgress | MatchSuccess;

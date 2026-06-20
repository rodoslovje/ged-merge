import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, PlaceLayout, SourceLayout } from "../normalize/types";
import type { MatchResult } from "../match/types";

/** Which slot a loaded file occupies. */
export type DatasetRole = "master" | "compare";

export interface ParseRequest {
  type: "parse";
  role: DatasetRole;
  fileName: string;
  buffer: ArrayBuffer;
}

/** Load a matches CSV from indeks.rodoslovje.si into the compare slot. */
export interface ParseCsvRequest {
  type: "parseCsv";
  fileName: string;
  buffer: ArrayBuffer;
}

/** Choose the home person in the master; triggers a re-ranked match result. */
export interface SetHomeRequest {
  type: "setHome";
  id: string;
}

export type WorkerRequest = ParseRequest | ParseCsvRequest | SetHomeRequest;

export interface ParseSuccess {
  type: "parsed";
  role: DatasetRole;
  fileName: string;
  dataset: Dataset;
  /** Present for the compare slot once it has been normalized to the master. */
  report?: NormalizationReport;
  /** Detected place-formatting convention of this file. */
  placeLayout?: PlaceLayout;
  /** Detected date format pattern of this file, e.g. "DD.MM.YYYY". */
  dateFormat?: string;
  /** Detected source-citation convention of this file. */
  sourceLayout?: SourceLayout;
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

/** Emitted once both master and compare are loaded. */
export interface MatchSuccess {
  type: "matched";
  result: MatchResult;
}

export type WorkerResponse = ParseSuccess | ParseFailure | MatchProgress | MatchSuccess;

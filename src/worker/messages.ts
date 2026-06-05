import type { Dataset } from "../gedcom/types";
import type { NormalizationReport } from "../normalize/types";

/** Which slot a loaded file occupies. */
export type DatasetRole = "master" | "compare";

export interface ParseRequest {
  type: "parse";
  role: DatasetRole;
  fileName: string;
  buffer: ArrayBuffer;
}

export type WorkerRequest = ParseRequest;

export interface ParseSuccess {
  type: "parsed";
  role: DatasetRole;
  fileName: string;
  dataset: Dataset;
  /** Present for the compare slot once it has been normalized to the master. */
  report?: NormalizationReport;
}

export interface ParseFailure {
  type: "error";
  role: DatasetRole;
  fileName: string;
  message: string;
}

export type WorkerResponse = ParseSuccess | ParseFailure;

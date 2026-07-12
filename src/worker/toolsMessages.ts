import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import type { DuplicatePair } from "../tools/duplicates";
import type { ValidationReport } from "../tools/validate";
import type { StructureReport } from "../tools/structure";
import type { DuplicateReport } from "../tools/sourceDuplicates";

/**
 * Requests for the tools worker (whole-file Tools-tab scans).
 *
 * Every request carries the live dataset (structured-cloned into the worker),
 * so a scan always sees the current main-thread state — including in-place
 * edits the gedcom worker's own copy never learns about. The tools worker
 * keeps no state of its own, which is what makes terminate-based cancellation
 * (see `useToolsWorker`) safe.
 */
export type ToolsRequest =
  | { type: "findDuplicates"; requestId: number; dataset: Dataset }
  | { type: "validate"; requestId: number; dataset: Dataset }
  | { type: "sourceDuplicates"; requestId: number; dataset: Dataset }
  | { type: "normalizePreview"; requestId: number; dataset: Dataset }
  | { type: "normalizeText"; requestId: number; dataset: Dataset; options: NormalizeOptions };

/** Result payload for each request type. */
export interface ToolsResultMap {
  findDuplicates: { pairs: DuplicatePair[] };
  validate: { report: ValidationReport; structure: StructureReport };
  sourceDuplicates: { report: DuplicateReport };
  normalizePreview: { report: NormalizationReport };
  /** The normalized file already serialized, so only a string crosses back. */
  normalizeText: { text: string };
}

export type ToolsResponse =
  | { type: "progress"; requestId: number; done: number; total: number }
  | { type: "result"; requestId: number; data: ToolsResultMap[keyof ToolsResultMap] }
  | { type: "error"; requestId: number; message: string };

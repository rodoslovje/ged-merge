import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import type { DuplicatePair } from "../tools/duplicates";
import type { ValidationReport } from "../tools/validate";
import type { StructureReport } from "../tools/structure";
import type { DuplicateReport } from "../tools/sourceDuplicates";
import type { ReshapeReport } from "../tools/sourceReshape";
import type { FormatOverrides } from "../normalize/formatOverrides";

/**
 * Requests for the tools worker (whole-file Tools-tab scans).
 *
 * The dataset is uploaded once with `setDataset` and cached in the worker;
 * scan requests then reference that cached copy. Structured-cloning an
 * index-scale file blocks the main thread for seconds, so the clone must
 * happen once per content version — not once per scan (see `useToolsScans`,
 * which re-uploads only when the file or its edit version changes). Messages
 * are processed in order, so a scan always sees the upload that preceded it.
 */
export type ToolsRequest =
  | { type: "setDataset"; dataset: Dataset }
  | { type: "findDuplicates"; requestId: number }
  | { type: "validate"; requestId: number }
  | { type: "sourceDuplicates"; requestId: number }
  | { type: "sourceReshape"; requestId: number; formatOverrides?: FormatOverrides }
  | { type: "normalizePreview"; requestId: number; formatOverrides?: FormatOverrides }
  | { type: "normalizeText"; requestId: number; options: NormalizeOptions; formatOverrides?: FormatOverrides };

/** Result payload for each scan request type. */
export interface ToolsResultMap {
  findDuplicates: { pairs: DuplicatePair[] };
  validate: { report: ValidationReport; structure: StructureReport };
  sourceDuplicates: { report: DuplicateReport };
  sourceReshape: { report: ReshapeReport };
  normalizePreview: { report: NormalizationReport };
  /** The normalized file already serialized, so only a string crosses back. */
  normalizeText: { text: string };
}

export type ToolsResponse =
  | { type: "progress"; requestId: number; done: number; total: number }
  | { type: "result"; requestId: number; data: ToolsResultMap[keyof ToolsResultMap] }
  | { type: "error"; requestId: number; message: string };

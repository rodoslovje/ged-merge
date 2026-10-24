import type { OutputVersion } from "../save/outputFile";
import type { MainSnapshot, RecordsPatch } from "../state/mainSync";
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
 * The main is uploaded whole once with `setMain` and cached in the worker;
 * scan requests then reference that cached copy. After edits only the edited
 * records travel (`patchMain`): structured-cloning the typed dataset cost
 * ~11 s of blocked main thread on a 500k-person file, the snapshot ~1.9 s and
 * a patch a fraction of a second (see `useToolsScans`, which uploads only
 * when the file or its edit version changes). Messages are processed in
 * order, so a scan always sees the upload that preceded it.
 */
export type ToolsRequest =
  | { type: "setMain"; snapshot: MainSnapshot }
  | { type: "patchMain"; patch: RecordsPatch }
  | { type: "findDuplicates"; requestId: number }
  | { type: "validate"; requestId: number; formatOverrides?: FormatOverrides }
  | { type: "sourceDuplicates"; requestId: number }
  | { type: "sourceReshape"; requestId: number; formatOverrides?: FormatOverrides }
  | { type: "normalizePreview"; requestId: number; formatOverrides?: FormatOverrides }
  | {
      type: "normalizeText"; requestId: number; options: NormalizeOptions; formatOverrides?: FormatOverrides;
      /** The version the download is written in (the target format's). */
      version: OutputVersion;
      /** Names a submitter record the file needs and lacks (see `prepareDownload`). */
      authorName?: string;
    };

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
  /** The worker's copy did not take a `patchMain`: send `setMain`. Requests
   *  posted meanwhile wait in the worker until it arrives. */
  | { type: "resync" }
  | { type: "progress"; requestId: number; done: number; total: number }
  | { type: "result"; requestId: number; data: ToolsResultMap[keyof ToolsResultMap] }
  | { type: "error"; requestId: number; message: string };

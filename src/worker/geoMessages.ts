// Message contract for the gazetteer-import worker (geo.worker.ts). Separate
// from the tools worker: the import doesn't touch the dataset, receives its
// file as a transferred ArrayBuffer (zero-copy, like the parse requests in
// messages.ts), and writes straight into the gedmerge-geo IndexedDB from the
// worker. Cancel = terminate, matching the duplicate-scan precedent.

export interface GeoImportRequest {
  type: "importGazetteer";
  requestId: number;
  /** The picked file's bytes — a GeoNames country extract, .txt or .zip. */
  buffer: ArrayBuffer;
  fileName: string;
}

export type GeoWorkerRequest = GeoImportRequest;

export type GeoWorkerResponse =
  | { type: "progress"; requestId: number; done: number; total: number }
  | { type: "result"; requestId: number; countries: { code: string; count: number }[] }
  | { type: "error"; requestId: number; message: string };

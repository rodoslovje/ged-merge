// Message contract for the gazetteer-import worker (geo.worker.ts). Separate
// from the tools worker: the import doesn't touch the dataset, receives its
// file as a transferred ArrayBuffer (zero-copy, like the parse requests in
// messages.ts), and writes straight into the gedmerge-geo IndexedDB from the
// worker. Cancel = terminate, matching the duplicate-scan precedent.

export interface GeoImportRequest {
  type: "importGazetteer";
  requestId: number;
  /** The payload bytes — a GeoNames extract (.txt/.zip), Overpass JSON, or
   *  the GURS RPE settlements GeoJSON. */
  buffer: ArrayBuffer;
  fileName: string;
  /** Payload shape; "geonames" when omitted. */
  format?: "geonames" | "overpass" | "rpe";
  /** Overpass only: the country code the entries are stored under.
   *  ("rpe" is Slovenia by definition and always stores under "SI".) */
  country?: string;
  /** "rpe" only: the RPE municipalities collection, the id→name table the
   *  settlements join to so each one can name its občina. Optional — a settled
   *  gazetteer without it simply carries no municipality. */
  obcine?: ArrayBuffer;
}

export type GeoWorkerRequest = GeoImportRequest;

export type GeoWorkerResponse =
  | { type: "progress"; requestId: number; done: number; total: number }
  | { type: "result"; requestId: number; countries: { code: string; count: number }[] }
  | { type: "error"; requestId: number; message: string };

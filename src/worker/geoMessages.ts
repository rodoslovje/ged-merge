// Message contract for the gazetteer-import worker (geo.worker.ts). Separate
// from the tools worker: the import doesn't touch the dataset, receives its
// file as a transferred ArrayBuffer (zero-copy, like the parse requests in
// messages.ts), and writes straight into the gedmerge-geo IndexedDB from the
// worker. Cancel = terminate, matching the duplicate-scan precedent.

export interface GeoImportRequest {
  type: "importGazetteer";
  requestId: number;
  /** The payload bytes — a GeoNames extract (.txt/.zip), Overpass JSON, the
   *  GURS RPE settlements GeoJSON, or the DGU register of geographical names. */
  buffer: ArrayBuffer;
  fileName: string;
  /** Payload shape; "geonames" when omitted. "hr-ad" is the Croatian INSPIRE
   *  address download — a zip whose 2.6 GB of GML the worker streams rather
   *  than decodes, and which lands in the address stores, not the country
   *  ones. */
  format?: "geonames" | "overpass" | "rpe" | "rgi" | "hr-ad";
  /** Overpass only: the country code the entries are stored under. ("rpe" and
   *  "rgi" are Slovenia and Croatia by definition and store under their own
   *  register keys.) */
  country?: string;
  /** Overpass only: the ISO 3166-2 subdivision this payload covers ("US-CA"),
   *  when the country was too large to fetch whole. The entries still go into
   *  the country's directory — they merge into it, replacing whatever an
   *  earlier download of the *same* region left there. */
  region?: string;
  /** "rpe" only: the RPE municipalities collection, the id→name table the
   *  settlements join to so each one can name its občina. Optional — a settled
   *  gazetteer without it simply carries no municipality. */
  obcine?: ArrayBuffer;
  /** "rgi" only: the RPJ municipalities and counties tables, which together say
   *  which county each place sits in. Optional in the same way — without them
   *  the places still import, they just cannot corroborate a county named in
   *  the file. */
  opcine?: ArrayBuffer;
  zupanije?: ArrayBuffer;
}

export type GeoWorkerRequest = GeoImportRequest;

export type GeoWorkerResponse =
  | {
      type: "progress";
      requestId: number;
      done: number;
      total: number;
      /** What the numbers are counting, when it is not the default reading of
       *  the payload. The address register spends its last stretch writing
       *  thousands of records, which is long enough that a bar sitting at
       *  100 % would read as hung. */
      stage?: "storing";
    }
  | { type: "result"; requestId: number; countries: { code: string; count: number }[] }
  /** An address register was stored — a different store, and a different line
   *  in the manager, from the place directories a "result" reports. */
  | { type: "addressRegister"; requestId: number; country: string; count: number }
  | { type: "error"; requestId: number; message: string };

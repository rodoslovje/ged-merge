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
  /** Payload shape; "geonames" when omitted. */
  format?: "geonames" | "overpass" | "rpe" | "rgi";
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

/**
 * Fetch and store a national address register, fetching included.
 *
 * The worker does the downloading as well as the parsing for both countries:
 * Croatia's is an 85 MB file and Slovenia's 116 requests, neither of which
 * belongs on the main thread — and, more to the point, an import that owns its
 * whole job can outlive the dialog that started it (see addressDownload.ts).
 */
export interface AddressDownloadRequest {
  type: "downloadAddresses";
  requestId: number;
  country: "SI" | "HR";
}

export type GeoWorkerRequest = GeoImportRequest | AddressDownloadRequest;

export type GeoWorkerResponse =
  | {
      type: "progress";
      requestId: number;
      done: number;
      total: number;
      /** What the numbers are counting, when it is not the default reading of
       *  the payload — an address import passes through all three, and each is
       *  long enough on its own that a bar left saying the wrong thing (or
       *  sitting at 100 %) would read as hung. */
      stage?: "downloading" | "parsing" | "storing";
    }
  | { type: "result"; requestId: number; countries: { code: string; count: number }[] }
  /** An address register was stored — a different store, and a different line
   *  in the manager, from the place directories a "result" reports. */
  | { type: "addressRegister"; requestId: number; country: string; count: number }
  | { type: "error"; requestId: number; message: string };

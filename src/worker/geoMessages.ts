// Message contract for the geo-import worker (geo.worker.ts). Separate from the
// tools worker: an import doesn't touch the dataset, and it writes straight
// into the gedmerge-geo IndexedDB from the worker. Cancel = terminate, matching
// the duplicate-scan precedent.
//
// One request shape for every source. A download is a download whichever
// register it comes from: the same fetching, the same progress, the same list
// of ways it can fail — so what the caller sends is *which* source, and
// everything after that is one path through the worker. The alternative, and
// what this replaced, was the registers and OpenStreetMap fetching on the main
// thread while the address registers fetched in the worker: two sets of
// progress reporting, two ways of reporting a failure, and only one of them
// able to outlive the dialog that started it.

import type { Subdivision } from "../geo/gazetteer";

/**
 * What to import. Every job ends the same way — entries written into the
 * gedmerge-geo database — and differs only in where the bytes come from.
 */
export type GeoJob =
  /** The GURS register of Slovenian settlements, with its municipalities. */
  | { kind: "gurs" }
  /** The DGU register of Croatian geographical names, with its counties. */
  | { kind: "dgu" }
  /**
   * OpenStreetMap places, through Overpass. Without `region` this is the whole
   * country, which for a large one is more than the service will do in a single
   * query — that comes back as a `tooLarge` failure carrying the country's
   * subdivisions, and each of those is then its own job.
   */
  | { kind: "osm"; country: string; region?: string }
  /** A GeoNames extract off the reader's own disk (.txt or .zip). The one job
   *  that downloads nothing, and it goes through the worker all the same: what
   *  follows the bytes — parse, store, report — is the same work. */
  | { kind: "file"; file: File }
  /** A national address register: the houses, not the places. */
  | { kind: "addresses"; country: "SI" | "HR" };

export interface GeoImportRequest {
  type: "import";
  requestId: number;
  job: GeoJob;
}

export type GeoWorkerRequest = GeoImportRequest;

/**
 * Why an import produced nothing, in the shapes the manager can say something
 * useful about. Every one of them is a sentence in the reader's own language,
 * chosen by `code` — the worker names the failure and the UI words it, so a
 * download failing in the worker and a file failing to parse are reported the
 * same way.
 */
export type GeoFailure =
  /** The request did not go through, or answered with an HTTP status. */
  | { code: "download" }
  /** Overpass is loaded and refused this query; worth trying again shortly. */
  | { code: "busy" }
  /** The area is more than one Overpass query will do. For a country that is
   *  not shown as an error at all: `regions` carries the subdivisions to fetch
   *  it in instead and the manager offers them. Empty regions is the genuine
   *  dead end — a country with none mapped, or, with `region` naming it, one
   *  subdivision that is too large on its own. */
  | { code: "tooLarge"; regions: Subdivision[]; region?: string }
  /** The source answered, and there was nothing importable in the answer. */
  | { code: "empty" }
  /** The bytes were not what this source is supposed to send (a zip with no
   *  .txt in it, JSON that is not the collection it should be). */
  | { code: "unreadable"; detail: string }
  /** The download went through and the browser would not keep it: its place
   *  database is open in another window, or it refused the write outright.
   *  `detail` is the browser's own error name, which names the refusal. */
  | { code: "storeBlocked" }
  | { code: "storeRefused"; detail: string }
  /** Nothing was heard from the import for long enough that nothing is coming.
   *  A worker the browser kills for want of memory — which a register of half a
   *  million addresses can provoke — goes without an error event of any kind,
   *  and left to itself that is a progress bar that never moves again. */
  | { code: "stalled" }
  /** The worker itself never got going, or died outside its own reporting.
   *  Not posted by the worker, for obvious reasons — the runner raises it. The
   *  usual cause is a stale app shell asking for a chunk a deploy has since
   *  replaced, which is a thing the reader can act on. */
  | { code: "workerFailed" };

/** What the numbers in a progress message count. Each stage is long enough on
 *  its own that a bar left saying the wrong thing — or sitting full — would
 *  read as hung: Overpass computes a country's extract before it sends a byte,
 *  and writing 6759 settlements into the browser's database takes its own
 *  while. */
export type GeoStage = "waiting" | "regions" | "downloading" | "parsing" | "storing";

export type GeoWorkerResponse =
  | { type: "progress"; requestId: number; stage: GeoStage; done: number; total: number }
  /** Place directories were written — one per country for a GeoNames dump,
   *  otherwise the single register the job named. */
  | { type: "result"; requestId: number; countries: { code: string; count: number }[] }
  /** An address register was written — a different store, and a different line
   *  in the manager, from the place directories a "result" reports. */
  | { type: "addressRegister"; requestId: number; country: string; count: number }
  | { type: "error"; requestId: number; failure: GeoFailure };

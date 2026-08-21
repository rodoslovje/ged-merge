import type { Subdivision } from "../../geo/gazetteer";
import { invalidateAddressRegisters } from "../../geo/addressLookup";
import { invalidateGazetteerIndex } from "../edit/PlaceLookupContext";
import type { GeoFailure, GeoJob, GeoStage, GeoWorkerRequest, GeoWorkerResponse } from "../../worker/geoMessages";

// Every download the app offers, run by the module rather than by whatever
// happens to be on screen.
//
// This exists because of a bug worth remembering: an import used to belong to
// the gazetteer manager's own worker ref, which its unmount cleanup terminates.
// The manager lives in Settings › Map, behind `{tab === "map" && …}` — so
// switching tabs or closing the dialog killed a running import. For Croatia's
// one-shot file that was a narrow window; for Slovenia's addresses, whose 116
// pages take five minutes or more, closing the dialog and going to do something
// else is the *expected* behaviour, and it ended as a spinner that simply
// stopped, with nothing downloaded and nothing said. A 45 MB register is only a
// shorter version of the same wait, and a run of fifty OpenStreetMap regions is
// a far longer one.
//
// An import needs no UI: the worker fetches, parses and writes to IndexedDB by
// itself, and the only thing the screen contributes is a progress bar. So it
// runs here, for as long as it takes, and any manager that mounts meanwhile
// picks up where it has got to. Cancel is the one thing that stops it.

export type { GeoJob } from "../../worker/geoMessages";

/** What an import is doing, so the bar can say it. */
export interface GeoRunning {
  phase: "running";
  job: GeoJob;
  stage: GeoStage;
  done: number;
  total: number;
  /** What this particular download is, when one click starts many: the region
   *  being fetched and its place in the run. */
  note?: string;
}

export type GeoImportState =
  | { phase: "idle" }
  | GeoRunning
  | { phase: "error"; failure: GeoFailure }
  /** Several downloads were asked for and some did not land — the run carried
   *  on past them, and the names are what the reader needs. */
  | { phase: "partial"; failed: string[] };

/**
 * Everything an import can put on screen, in one snapshot: what is running, and
 * the offer of a country's regions when it turned out to be too large for one
 * query. The offer outlives the run that produced it — it is a question waiting
 * to be answered, and closing the dialog is not an answer.
 */
export interface GeoImportSnapshot {
  state: GeoImportState;
  regions: { country: string; list: Subdivision[] } | null;
}

// Carried across Vite's hot updates in development. An import takes minutes,
// and every save reloads this module — which without this would drop the worker
// on the floor, reset the bar to idle and leave the download running invisibly
// until the tab closed. In a production build `import.meta.hot` is undefined and
// this is a plain module-level pair.
const kept = (import.meta.hot?.data ?? {}) as { snapshot?: GeoImportSnapshot; worker?: Worker | null };

let snapshot: GeoImportSnapshot = kept.snapshot ?? { state: { phase: "idle" }, regions: null };
let worker: Worker | null = kept.worker ?? null;
/** Set while a click's work is still going — a region batch outlives the single
 *  worker run it is on, so "is something running" is not "is there a worker". */
let running = false;
const watchers = new Set<() => void>();

/** Told whenever the stored directories change, so every mounted manager
 *  reloads — including the one that was not on screen when the import landed. */
const changeWatchers = new Set<() => void>();

import.meta.hot?.dispose((data: { snapshot?: GeoImportSnapshot; worker?: Worker | null }) => {
  data.snapshot = snapshot;
  data.worker = worker;
});

/** The current snapshot. A stable reference between changes, so it can back a
 *  `useSyncExternalStore`. */
export function geoImportSnapshot(): GeoImportSnapshot {
  return snapshot;
}

export function watchGeoImport(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

/** Watch the stored directories, not the run: fires when an import has written
 *  something, or when one was deleted. */
export function watchGeoData(fn: () => void): () => void {
  changeWatchers.add(fn);
  return () => changeWatchers.delete(fn);
}

/** Say that what is stored has changed. Exported because deleting a directory
 *  is the same event as importing one, and the manager does that itself. */
export function geoDataChanged(): void {
  // The Edit view's lookup keeps its own index for the whole session, so an
  // import or removal has to drop it — otherwise the place fields answer from
  // the gazetteer that has just been replaced. The address register caches its
  // own index and buckets for the same reason and needs the same clearing.
  invalidateGazetteerIndex();
  invalidateAddressRegisters();
  for (const fn of changeWatchers) fn();
}

function set(state: GeoImportState, regions = snapshot.regions): void {
  snapshot = { state, regions };
  for (const fn of watchers) fn();
}

/** What one worker run produced: nothing, or the reason there is nothing. */
type Outcome = { ok: true } | { ok: false; failure: GeoFailure };

/**
 * How long an import may say nothing at all before it is taken for dead.
 *
 * Every stage reports as it goes, and the one legitimate silence is an Overpass
 * query computing its extract, which the query itself caps at 180 seconds. Five
 * minutes is therefore well clear of anything that is still working, and short
 * enough that a worker killed for want of memory — which sends no error event
 * whatsoever — stops being a bar that never moves again.
 */
const STALL_MS = 300_000;

/**
 * Run one job to its end.
 *
 * The single place a geo worker is created, watched and disposed of — so a
 * download's progress, a download's failure and a worker that dies without
 * saying why are handled once for the registers, OpenStreetMap, a GeoNames
 * file and the address registers alike.
 */
function runJob(job: GeoJob, note?: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const w = new Worker(new URL("../../worker/geo.worker.ts", import.meta.url), { type: "module" });
    worker = w;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => finish({ ok: false, failure: { code: "stalled" } }), STALL_MS);
    };
    const finish = (outcome: Outcome) => {
      clearTimeout(watchdog);
      stopCurrent = null;
      w.terminate();
      if (worker === w) worker = null;
      // Whatever happened, what is stored may have changed — a failed address
      // import clears the old register before it writes — so the caches are
      // dropped either way.
      geoDataChanged();
      resolve(outcome);
    };
    w.onmessage = (e: MessageEvent<GeoWorkerResponse>) => {
      const msg = e.data;
      heard();
      if (msg.type === "progress") {
        set({ phase: "running", job, stage: msg.stage, done: msg.done, total: msg.total, note });
      } else if (msg.type === "error") {
        finish({ ok: false, failure: msg.failure });
      } else {
        finish({ ok: true });
      }
    };
    // A worker that fails to load, or throws outside its own handler, would
    // otherwise leave the bar running for ever. The usual cause is a stale app
    // shell asking for a worker chunk a deploy has since replaced (the host
    // answers missing assets with index.html), which is what `workerFailed`
    // tells the reader to do something about.
    w.onerror = () => finish({ ok: false, failure: { code: "workerFailed" } });
    w.onmessageerror = () => finish({ ok: false, failure: { code: "workerFailed" } });
    // Cancel terminates the worker from outside, and a terminated worker sends
    // no last message — without this the run's promise would stay pending for
    // the life of the tab, and the batch awaiting it would stop mid-list with
    // no way to be woken. The outcome itself goes nowhere: Cancel has moved the
    // generation on, so every caller drops what it gets back.
    stopCurrent = () => finish({ ok: false, failure: { code: "workerFailed" } });
    heard();
    set({ phase: "running", job, stage: "waiting", done: 0, total: 0, note });
    const req: GeoWorkerRequest = { type: "import", requestId: 1, job };
    w.postMessage(req);
  });
}

/** Ends the run in hand, when something other than the worker decides it is
 *  over. Null whenever no job is on the wire. */
let stopCurrent: (() => void) | null = null;

/** Countries already known to need splitting, with the subdivisions found for
 *  them — so the discovery (three minutes of a query timing out) happens once
 *  per browser and not once per visit. */
const REGIONS_KEY = "gedmerge.osmRegions";

function knownRegions(): Record<string, Subdivision[]> {
  try {
    const raw = localStorage.getItem(REGIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Subdivision[]>) : {};
  } catch {
    return {};
  }
}

function rememberRegions(country: string, list: Subdivision[]): void {
  try {
    localStorage.setItem(REGIONS_KEY, JSON.stringify({ ...knownRegions(), [country]: list }));
  } catch {
    // A full or blocked storage costs the shortcut, nothing else.
  }
}

/** Report one job's outcome, and turn the one failure that is not a failure —
 *  a country too large for a single query — into the offer of its regions. */
function report(outcome: Outcome, country?: string): void {
  // Nothing to say about a download that worked: what it produced is in the
  // list of directories, which `geoDataChanged` has already refreshed.
  if (outcome.ok) {
    set({ phase: "idle" });
    return;
  }
  if (outcome.failure.code === "tooLarge" && outcome.failure.regions.length && country) {
    rememberRegions(country, outcome.failure.regions);
    set({ phase: "idle" }, { country, list: outcome.failure.regions });
    return;
  }
  set({ phase: "error", failure: outcome.failure });
}

/**
 * The run a click started, counted rather than flagged.
 *
 * A batch of regions is a run that spans many worker lifetimes, with gaps
 * between them where nothing is on the wire — and Cancel lands in one of those
 * gaps as readily as in the middle of a download. A generation says which run
 * the code that wakes up belongs to, where a boolean cleared by the next click
 * would let a cancelled batch walk on through it.
 */
let generation = 0;

/** Whether the caller is still the current run — false once Cancel or another
 *  click has moved on. */
function isCurrent(mine: number): boolean {
  return generation === mine;
}

/** Guard every entry point: one import at a time, and each one knows whether
 *  it is still the one running. */
async function start(fn: (mine: number) => Promise<void>): Promise<void> {
  if (running) return;
  running = true;
  const mine = ++generation;
  try {
    await fn(mine);
  } finally {
    if (isCurrent(mine)) running = false;
  }
}

/** One source, start to finish: the two national registers, a GeoNames file
 *  from the reader's disk, one country's addresses, one OpenStreetMap region. */
export function startImport(job: GeoJob): void {
  void start(async (mine) => {
    const outcome = await runJob(job);
    if (isCurrent(mine)) report(outcome);
  });
}

/**
 * A whole country from OpenStreetMap.
 *
 * The one flow with a decision in it: a country already known to be too large
 * goes straight to its regions rather than spending another three minutes
 * proving it again, and one that turns out to be too large offers the
 * subdivisions the worker found on the way.
 */
export function startOsmCountry(country: string): void {
  const code = country.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return;
  void start(async (mine) => {
    const known = knownRegions()[code];
    if (known?.length) {
      set({ phase: "idle" }, { country: code, list: known });
      return;
    }
    set({ phase: "idle" }, null);
    const outcome = await runJob({ kind: "osm", country: code });
    if (isCurrent(mine)) report(outcome, code);
  });
}

/** Milliseconds between two region downloads. The public endpoints meter
 *  concurrent queries per address, and fifty heavy ones fired off together get
 *  the whole run refused rather than served faster. */
const REGION_GAP = 2000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Every offered region, one after another, unhurried on purpose.
 *
 * Each region is stored as it arrives, so a cancelled or half-failed run still
 * leaves everything it did fetch — and the names of the ones that did not land
 * are what the reader is told at the end.
 */
export function startAllRegions(label: (name: string, index: number, total: number) => string): void {
  const offer = snapshot.regions;
  if (!offer) return;
  void start(async (mine) => {
    const failed: string[] = [];
    for (const [i, region] of offer.list.entries()) {
      const outcome = await runJob(
        { kind: "osm", country: offer.country, region: region.code },
        label(region.name, i + 1, offer.list.length),
      );
      if (!isCurrent(mine)) return;
      if (!outcome.ok) failed.push(region.name);
      if (i < offer.list.length - 1) await wait(REGION_GAP);
      if (!isCurrent(mine)) return;
    }
    if (failed.length) set({ phase: "partial", failed });
    else set({ phase: "idle" }, null);
  });
}

/** Stop an import, and clear whatever it last said. The generation moves on, so
 *  a batch waiting out its gap between regions finds it is no longer the run in
 *  hand and stops there. */
export function cancelGeoImport(): void {
  generation++;
  running = false;
  stopCurrent?.();
  worker?.terminate();
  worker = null;
  set({ phase: "idle" });
}

/** Put the region offer away. The whole-country control stays where it is: what
 *  fails for one country works for the next. */
export function dismissRegions(): void {
  set(snapshot.state, null);
}

// An import carried across a hot update is still running, but its worker's
// message handler belongs to the old copy of this module. There is nothing to
// rebind it to — the promise that owned it is gone — so it is stopped rather
// than left driving a bar nothing renders.
if (import.meta.hot && worker && snapshot.state.phase === "running") {
  worker.terminate();
  worker = null;
  snapshot = { state: { phase: "idle" }, regions: snapshot.regions };
}

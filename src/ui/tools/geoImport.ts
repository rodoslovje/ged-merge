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
//
// Different sources run side by side, each in its own worker: they store under
// different keys (a country's directory, a country's address register), so
// GURS places and DGU addresses have nothing to wait for from each other. One
// source runs once at a time — a second click on it would only race the first
// to write the same key.

export type { GeoJob } from "../../worker/geoMessages";

/** One source that downloads on its own: each national register's places and
 *  addresses, OpenStreetMap (a country, or a run of its regions), a GeoNames
 *  file. Each runs at most once at a time, and all of them side by side. */
export type GeoSlot = "gurs" | "dgu" | "addresses-SI" | "addresses-HR" | "osm" | "file";

export function slotOf(job: GeoJob): GeoSlot {
  return job.kind === "addresses" ? `addresses-${job.country}` : job.kind;
}

/** The i18n key naming a job by what it fetches and from whom — "GURS places",
 *  "DGU addresses" — for every place that shows one running. */
export function importLabelKey(job: GeoJob): string {
  switch (job.kind) {
    case "gurs":
      return "activity.import.gurs";
    case "dgu":
      return "activity.import.dgu";
    case "addresses":
      return job.country === "SI" ? "activity.import.gursAddresses" : "activity.import.dguAddresses";
    case "osm":
      return "activity.import.osm";
    case "file":
      return "activity.import.file";
  }
}

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
 * Everything an import can put on screen, in one snapshot: what each source is
 * doing (an idle source is absent), and the offer of a country's regions when
 * it turned out to be too large for one query. The offer outlives the run that
 * produced it — it is a question waiting to be answered, and closing the dialog
 * is not an answer.
 */
export interface GeoImportSnapshot {
  jobs: Partial<Record<GeoSlot, Exclude<GeoImportState, { phase: "idle" }>>>;
  regions: { country: string; list: Subdivision[] } | null;
}

/** One source's run in hand: its worker, and how to end it from outside. */
interface Slot {
  worker: Worker | null;
  stop: (() => void) | null;
  /** Counted rather than flagged — see {@link start}. */
  generation: number;
  running: boolean;
}

// Carried across Vite's hot updates in development. An import takes minutes,
// and every save reloads this module — which without this would drop the
// workers on the floor, reset the bars to idle and leave the downloads running
// invisibly until the tab closed. In a production build `import.meta.hot` is
// undefined and this is a plain module-level pair.
const kept = (import.meta.hot?.data ?? {}) as { snapshot?: GeoImportSnapshot; slots?: Map<GeoSlot, Slot> };

let snapshot: GeoImportSnapshot = kept.snapshot?.jobs ? kept.snapshot : { jobs: {}, regions: null };
const slots: Map<GeoSlot, Slot> = kept.slots ?? new Map();
const watchers = new Set<() => void>();

function slot(id: GeoSlot): Slot {
  let s = slots.get(id);
  if (!s) {
    s = { worker: null, stop: null, generation: 0, running: false };
    slots.set(id, s);
  }
  return s;
}

/** Told whenever the stored directories change, so every mounted manager
 *  reloads — including the one that was not on screen when the import landed. */
const changeWatchers = new Set<() => void>();

import.meta.hot?.dispose((data: { snapshot?: GeoImportSnapshot; slots?: Map<GeoSlot, Slot> }) => {
  data.snapshot = snapshot;
  data.slots = slots;
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

function set(id: GeoSlot, state: GeoImportState, regions = snapshot.regions): void {
  const jobs = { ...snapshot.jobs };
  if (state.phase === "idle") delete jobs[id];
  else jobs[id] = state;
  snapshot = { jobs, regions };
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
  const id = slotOf(job);
  const s = slot(id);
  return new Promise((resolve) => {
    const w = new Worker(new URL("../../worker/geo.worker.ts", import.meta.url), { type: "module" });
    s.worker = w;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => finish({ ok: false, failure: { code: "stalled" } }), STALL_MS);
    };
    const finish = (outcome: Outcome) => {
      clearTimeout(watchdog);
      if (s.worker === w) {
        s.worker = null;
        s.stop = null;
      }
      w.terminate();
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
        set(id, { phase: "running", job, stage: msg.stage, done: msg.done, total: msg.total, note });
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
    s.stop = () => finish({ ok: false, failure: { code: "workerFailed" } });
    heard();
    set(id, { phase: "running", job, stage: "waiting", done: 0, total: 0, note });
    const req: GeoWorkerRequest = { type: "import", requestId: 1, job };
    w.postMessage(req);
  });
}

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
function report(id: GeoSlot, outcome: Outcome, country?: string): void {
  // Nothing to say about a download that worked: what it produced is in the
  // list of directories, which `geoDataChanged` has already refreshed.
  if (outcome.ok) {
    set(id, { phase: "idle" });
    return;
  }
  if (outcome.failure.code === "tooLarge" && outcome.failure.regions.length && country) {
    rememberRegions(country, outcome.failure.regions);
    set(id, { phase: "idle" }, { country, list: outcome.failure.regions });
    return;
  }
  set(id, { phase: "error", failure: outcome.failure });
}

/**
 * Guard every entry point: one run per source at a time, and each one knows
 * whether it is still the one running.
 *
 * The run is counted rather than flagged. A batch of regions spans many worker
 * lifetimes, with gaps between them where nothing is on the wire — and Cancel
 * lands in one of those gaps as readily as in the middle of a download. A
 * generation says which run the code that wakes up belongs to, where a boolean
 * cleared by the next click would let a cancelled batch walk on through it.
 */
async function start(id: GeoSlot, fn: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
  const s = slot(id);
  if (s.running) return;
  s.running = true;
  const mine = ++s.generation;
  const isCurrent = () => s.generation === mine;
  try {
    await fn(isCurrent);
  } finally {
    if (isCurrent()) s.running = false;
  }
}

/** One source, start to finish: the two national registers, a GeoNames file
 *  from the reader's disk, one country's addresses, one OpenStreetMap region. */
export function startImport(job: GeoJob): void {
  const id = slotOf(job);
  void start(id, async (isCurrent) => {
    const outcome = await runJob(job);
    if (isCurrent()) report(id, outcome);
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
  void start("osm", async (isCurrent) => {
    const known = knownRegions()[code];
    if (known?.length) {
      set("osm", { phase: "idle" }, { country: code, list: known });
      return;
    }
    set("osm", { phase: "idle" }, null);
    const outcome = await runJob({ kind: "osm", country: code });
    if (isCurrent()) report("osm", outcome, code);
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
  void start("osm", async (isCurrent) => {
    const failed: string[] = [];
    for (const [i, region] of offer.list.entries()) {
      const outcome = await runJob(
        { kind: "osm", country: offer.country, region: region.code },
        label(region.name, i + 1, offer.list.length),
      );
      if (!isCurrent()) return;
      if (!outcome.ok) failed.push(region.name);
      if (i < offer.list.length - 1) await wait(REGION_GAP);
      if (!isCurrent()) return;
    }
    if (failed.length) set("osm", { phase: "partial", failed });
    else set("osm", { phase: "idle" }, null);
  });
}

/** Stop one source's import, and clear whatever it last said. The generation
 *  moves on, so a batch waiting out its gap between regions finds it is no
 *  longer the run in hand and stops there. */
export function cancelGeoImport(id: GeoSlot): void {
  const s = slot(id);
  s.generation++;
  s.running = false;
  s.stop?.();
  s.worker?.terminate();
  s.worker = null;
  s.stop = null;
  set(id, { phase: "idle" });
}

/** Put the region offer away. The whole-country control stays where it is: what
 *  fails for one country works for the next. */
export function dismissRegions(): void {
  snapshot = { ...snapshot, regions: null };
  for (const fn of watchers) fn();
}

// Imports carried across a hot update are still running, but their workers'
// message handlers belong to the old copy of this module. There is nothing to
// rebind them to — the promises that owned them are gone — so they are stopped
// rather than left driving bars nothing renders.
if (import.meta.hot) {
  for (const [id, s] of slots) {
    if (!s.worker) continue;
    s.worker.terminate();
    s.worker = null;
    s.stop = null;
    s.running = false;
    s.generation++;
    const jobs = { ...snapshot.jobs };
    delete jobs[id];
    snapshot = { ...snapshot, jobs };
  }
}

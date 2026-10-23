import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeoWorkerRequest, GeoWorkerResponse } from "../../worker/geoMessages";

vi.mock("../edit/PlaceLookupContext", () => ({ invalidateGazetteerIndex: vi.fn() }));
vi.mock("../../geo/addressLookup", () => ({ invalidateAddressRegisters: vi.fn() }));

/**
 * The geo-import runner: the one place a geo worker is created, watched and
 * disposed of, for every download the app offers. Run against a fake Worker
 * the test answers for, so success, failure, a dead or silent worker and
 * Cancel can each be staged exactly.
 */

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<GeoWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  sent: GeoWorkerRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(msg: GeoWorkerRequest) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  /** Answer as the worker would. */
  say(msg: GeoWorkerResponse) {
    this.onmessage?.({ data: msg } as MessageEvent<GeoWorkerResponse>);
  }
}

type Runner = typeof import("./geoImport");
let runner: Runner;
let storage: Map<string, string>;
const latest = () => FakeWorker.all.at(-1)!;
const state = () => runner.geoImportSnapshot().state;
/** Let the runner's awaits catch up. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(async () => {
  vi.resetModules();
  FakeWorker.all = [];
  vi.stubGlobal("Worker", FakeWorker);
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  runner = await import("./geoImport");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("geo import runner: one job", () => {
  it("runs the job in a worker, shows its progress, and ends idle with the caches refreshed", async () => {
    const { invalidateGazetteerIndex } = await import("../edit/PlaceLookupContext");
    const seen = vi.fn();
    const data = vi.fn();
    runner.watchGeoImport(seen);
    runner.watchGeoData(data);
    runner.startImport({ kind: "gurs" });
    expect(FakeWorker.all).toHaveLength(1);
    expect(latest().sent).toEqual([{ type: "import", requestId: 1, job: { kind: "gurs" } }]);
    expect(state()).toMatchObject({ phase: "running", stage: "waiting", done: 0, total: 0 });
    latest().say({ type: "progress", requestId: 1, stage: "downloading", done: 512, total: 0 });
    expect(state()).toMatchObject({ phase: "running", stage: "downloading", done: 512 });
    latest().say({ type: "result", requestId: 1, countries: [{ code: "SI-GURS", count: 6000 }] });
    await settle();
    expect(state()).toEqual({ phase: "idle" });
    expect(latest().terminated).toBe(true);
    expect(data).toHaveBeenCalledTimes(1);
    expect(invalidateGazetteerIndex).toHaveBeenCalled();
    expect(seen).toHaveBeenCalled();
  });

  it("an address register landing is a success too", async () => {
    runner.startImport({ kind: "addresses", country: "SI" });
    latest().say({ type: "addressRegister", requestId: 1, country: "SI", count: 5 });
    await settle();
    expect(state()).toEqual({ phase: "idle" });
  });

  it("a failure the worker reports is shown as it was named", async () => {
    runner.startImport({ kind: "dgu" });
    latest().say({ type: "error", requestId: 1, failure: { code: "download" } });
    await settle();
    expect(state()).toEqual({ phase: "error", failure: { code: "download" } });
    expect(latest().terminated).toBe(true);
  });

  it("a worker that never loads, or whose message cannot be read, is workerFailed", async () => {
    runner.startImport({ kind: "gurs" });
    latest().onerror!();
    await settle();
    expect(state()).toEqual({ phase: "error", failure: { code: "workerFailed" } });
    runner.startImport({ kind: "gurs" });
    latest().onmessageerror!();
    await settle();
    expect(state()).toEqual({ phase: "error", failure: { code: "workerFailed" } });
  });

  it("a worker silent for five minutes is taken for dead", async () => {
    vi.useFakeTimers();
    runner.startImport({ kind: "addresses", country: "HR" });
    vi.advanceTimersByTime(299_000);
    latest().say({ type: "progress", requestId: 1, stage: "parsing", done: 1, total: 2 });
    vi.advanceTimersByTime(299_000);
    expect(state()).toMatchObject({ phase: "running" });
    vi.advanceTimersByTime(2_000);
    await settle();
    expect(state()).toEqual({ phase: "error", failure: { code: "stalled" } });
    expect(latest().terminated).toBe(true);
  });

  it("runs one import at a time", async () => {
    runner.startImport({ kind: "gurs" });
    runner.startImport({ kind: "dgu" });
    expect(FakeWorker.all).toHaveLength(1);
    latest().say({ type: "result", requestId: 1, countries: [] });
    await settle();
    runner.startImport({ kind: "dgu" });
    expect(FakeWorker.all).toHaveLength(2);
  });

  it("Cancel stops the worker, clears the bar, and what it says afterwards goes nowhere", async () => {
    runner.startImport({ kind: "osm", country: "SI" });
    const w = latest();
    runner.cancelGeoImport();
    await settle();
    expect(w.terminated).toBe(true);
    expect(state()).toEqual({ phase: "idle" });
    w.say({ type: "error", requestId: 1, failure: { code: "busy" } });
    await settle();
    expect(state()).toEqual({ phase: "idle" });
    // Free for the next import straight away.
    runner.startImport({ kind: "gurs" });
    expect(FakeWorker.all).toHaveLength(2);
  });
});

describe("geo import runner: OpenStreetMap countries and regions", () => {
  const REGIONS = [{ code: "FR-BRE", name: "Bretagne" }, { code: "FR-NOR", name: "Normandie" }];

  it("ignores a code that is not a country", () => {
    runner.startOsmCountry("France");
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("a country too large offers its regions, and remembers them for next time", async () => {
    runner.startOsmCountry(" fr ");
    expect(latest().sent[0].job).toEqual({ kind: "osm", country: "FR" });
    latest().say({ type: "error", requestId: 1, failure: { code: "tooLarge", regions: REGIONS } });
    await settle();
    expect(runner.geoImportSnapshot()).toEqual({ state: { phase: "idle" }, regions: { country: "FR", list: REGIONS } });
    expect(JSON.parse(storage.get("gedmerge.osmRegions")!)).toEqual({ FR: REGIONS });
    runner.dismissRegions();
    expect(runner.geoImportSnapshot().regions).toBeNull();
    // The next click goes straight to the offer, without a three-minute query.
    runner.startOsmCountry("FR");
    await settle();
    expect(FakeWorker.all).toHaveLength(1);
    expect(runner.geoImportSnapshot().regions).toEqual({ country: "FR", list: REGIONS });
  });

  it("a too-large failure with no regions is an error like any other", async () => {
    runner.startOsmCountry("XX");
    latest().say({ type: "error", requestId: 1, failure: { code: "tooLarge", regions: [] } });
    await settle();
    expect(state()).toEqual({ phase: "error", failure: { code: "tooLarge", regions: [] } });
  });

  it("fetches every offered region in turn, and names the ones that did not land", async () => {
    vi.useFakeTimers();
    storage.set("gedmerge.osmRegions", JSON.stringify({ FR: REGIONS }));
    runner.startOsmCountry("FR");
    await settle();
    runner.startAllRegions((name, i, n) => `${name} ${i}/${n}`);
    expect(latest().sent[0].job).toEqual({ kind: "osm", country: "FR", region: "FR-BRE" });
    expect(state()).toMatchObject({ phase: "running", note: "Bretagne 1/2" });
    latest().say({ type: "error", requestId: 1, failure: { code: "busy" } });
    await settle();
    // Unhurried on purpose: the next region waits out the gap.
    expect(FakeWorker.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(latest().sent[0].job).toEqual({ kind: "osm", country: "FR", region: "FR-NOR" });
    latest().say({ type: "result", requestId: 1, countries: [{ code: "FR-OSM", count: 9 }] });
    await settle();
    expect(runner.geoImportSnapshot()).toEqual({ state: { phase: "partial", failed: ["Bretagne"] }, regions: { country: "FR", list: REGIONS } });
  });

  it("a run where every region lands puts the offer away", async () => {
    vi.useFakeTimers();
    storage.set("gedmerge.osmRegions", JSON.stringify({ FR: REGIONS.slice(0, 1) }));
    runner.startOsmCountry("FR");
    await settle();
    runner.startAllRegions((name) => name);
    latest().say({ type: "result", requestId: 1, countries: [] });
    await settle();
    expect(runner.geoImportSnapshot()).toEqual({ state: { phase: "idle" }, regions: null });
  });

  it("Cancel between two regions stops the batch there", async () => {
    vi.useFakeTimers();
    storage.set("gedmerge.osmRegions", JSON.stringify({ FR: REGIONS }));
    runner.startOsmCountry("FR");
    await settle();
    runner.startAllRegions((name) => name);
    latest().say({ type: "result", requestId: 1, countries: [] });
    await settle();
    runner.cancelGeoImport();
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeWorker.all).toHaveLength(1);
    expect(state()).toEqual({ phase: "idle" });
  });

  it("with no offer, fetching all regions does nothing", () => {
    runner.startAllRegions((name) => name);
    expect(FakeWorker.all).toHaveLength(0);
  });

  it("unreadable or blocked storage costs the shortcut, nothing else", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    runner.startOsmCountry("FR");
    await settle();
    latest().say({ type: "error", requestId: 1, failure: { code: "tooLarge", regions: REGIONS } });
    await settle();
    expect(runner.geoImportSnapshot().regions).toEqual({ country: "FR", list: REGIONS });
  });
});

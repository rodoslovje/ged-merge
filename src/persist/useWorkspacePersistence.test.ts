import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { downloadOptions, serializeGedcom } from "../gedcom/serialize";
import type { Dataset } from "../gedcom/types";
import { ChangeJournal } from "../state/mainSync";
import { initialWorkspace, type LoadedFile, type WorkspaceAction, type WorkspaceState } from "../state/workspace";
import type { WorkerRequest } from "../worker/messages";
import type { WorkspacePersistenceOptions } from "./useWorkspacePersistence";

vi.mock("react", () => import("../testing/fakeReact"));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../ui/SettingsContext", () => ({ useSettingsSlice: () => ({ persistWorkspace: true, formatOverrides: {} }) }));
vi.mock("./geoDb", () => ({ clearDecisions: vi.fn(async () => {}) }));

/**
 * The opt-in workspace cache as App runs it: the startup restore re-feeding
 * cached files to the worker (and its crash-loop guard), the debounced writer
 * that is the sole writer of the main blob, and the toggle and clear paths.
 * Against fake-indexeddb, a fake localStorage, and a hand-cranked
 * `window.setTimeout` so the 800 ms debounce runs when the test says.
 */

type Mod = typeof import("./useWorkspacePersistence");
type Idb = typeof import("./idb");
type Harness = typeof import("../testing/fakeReact");

let mod: Mod;
let idb: Idb;
let harness: Harness;
let storage: Map<string, string>;
let timers: Map<number, () => void>;

beforeEach(async () => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  timers = new Map();
  let nextId = 1;
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  // The mocked "react" — the very instance the hooks import, which outlives
  // the module reset (vi.resetModules keeps the mock registry).
  harness = (await import("react")) as unknown as Harness;
  idb = await import("./idb");
  mod = await import("./useWorkspacePersistence");
});

const TEXT = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8", "0 @I1@ INDI", "1 NAME Janez /Novak/", "0 TRLR", ""].join("\n");
const load = (text = TEXT): Dataset => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));
const textOf = (ds: Dataset) => serializeGedcom(ds.records, downloadOptions(ds));

/** Run the debounced writer: every pending timer, then its async write. */
async function tick() {
  const pending = [...timers.values()];
  timers.clear();
  for (const fn of pending) await fn();
}

interface Rig {
  opts: WorkspacePersistenceOptions;
  posted: WorkerRequest[];
  actions: WorkspaceAction[];
  toasts: (string | null)[];
  h: ReturnType<Harness["renderHook"]>;
  /** Re-render with these options changed. */
  update: (over: Partial<WorkspacePersistenceOptions>) => void;
  readonly api: ReturnType<Mod["useWorkspacePersistence"]>;
}

function loadedWorkspace(ds: Dataset, over: Partial<WorkspaceState> = {}): WorkspaceState {
  const file: LoadedFile = { fileName: "tree.ged", dataset: ds };
  return { ...initialWorkspace, main: { status: "loaded", file }, lastMainFile: file, mainLoadGen: 1, ...over };
}

async function mount(over: Partial<WorkspacePersistenceOptions> = {}): Promise<Rig> {
  const { useDirtyTracking } = await import("../edit-state/useDirtyTracking");
  const { useUndoRedo } = await import("../edit-state/useUndoRedo");
  const dirty = harness.renderHook(() => useDirtyTracking()).result.current;
  const undoRedo = harness.renderHook(() => useUndoRedo()).result.current;
  const rig = { posted: [], actions: [], toasts: [] } as unknown as Rig;
  rig.opts = {
    persistEnabled: true,
    workspace: initialWorkspace,
    mainDataset: undefined,
    editVersion: 0,
    cleanEditVersionRef: { current: 0 },
    changeJournal: new ChangeJournal(),
    dirty,
    undoRedo,
    sortEligiblePersonIdsRef: { current: new Set() },
    post: (msg) => rig.posted.push(msg),
    dispatch: (a) => rig.actions.push(a),
    autoStartRef: { current: false },
    loadFile: vi.fn(async () => {}),
    confirmDialog: vi.fn(async () => true),
    setSaveToast: (msg) => rig.toasts.push(msg),
    clearMediaFolder: vi.fn(),
    ...over,
  };
  rig.h = harness.renderHook((p: WorkspacePersistenceOptions) => mod.useWorkspacePersistence(p), rig.opts) as Rig["h"];
  rig.update = (o) => {
    rig.opts = { ...rig.opts, ...o };
    rig.h.rerender(rig.opts);
  };
  Object.defineProperty(rig, "api", { get: () => rig.h.result.current });
  return rig;
}

/** Plant a cached workspace, as an earlier session's writer left it. */
async function plant(session: Partial<import("./idb").StoredSession> = {}, compare = false) {
  await idb.saveFile("main", { fileName: "tree.ged", blob: new Blob([TEXT]), savedAt: 1, originalHash: "abc" });
  if (compare) await idb.saveFile("compare", { fileName: "in.ged", blob: new Blob([TEXT]), savedAt: 1 });
  await idb.saveSession({ mainFileName: "tree.ged", decisions: [], importBranches: [], savedAt: 1, ...session });
}

describe("useWorkspacePersistence: startup restore", () => {
  it("with nothing cached, persists freely from the first tick", async () => {
    const rig = await mount();
    await vi.waitFor(() => expect(rig.api.hydratedRef.current).toBe(true));
    expect(rig.posted).toEqual([]);
  });

  it("re-feeds the cached main through the worker and stashes its session", async () => {
    await plant({ startId: "@I1@", editState: { undo: [], redo: [] } as never }, true);
    const rig = await mount();
    await vi.waitFor(() => expect(rig.posted).toHaveLength(2));
    expect(rig.actions).toEqual([
      { type: "slotLoading", role: "main", fileName: "tree.ged" },
      { type: "slotLoading", role: "compare", fileName: "in.ged" },
    ]);
    const first = rig.posted[0];
    expect(first.type === "parse" && first.role).toBe("main");
    expect(first.type === "parse" && new TextDecoder().decode(first.buffer)).toBe(TEXT);
    expect(rig.api.pendingSessionRef.current?.startId).toBe("@I1@");
    expect(rig.api.pendingEditStateRef.current).toEqual({ undo: [], redo: [] });
    expect(rig.api.expectCompareRef.current).toBe(true);
    expect(rig.api.mainCachedRef.current).toBe(true);
    expect(rig.api.mainOriginalHashRef.current).toBe("abc");
    expect(rig.opts.autoStartRef.current).toBe(true);
    // The session is written only once the restore has settled.
    expect(rig.api.hydratedRef.current).toBe(false);
  });

  it("marks a restore in progress, and the mark comes off when the main settles", async () => {
    await plant();
    const rig = await mount();
    await vi.waitFor(() => expect(rig.posted).toHaveLength(1));
    expect(storage.get("gedmerge.restoreInProgress")).toBe("1");
    rig.update({ workspace: { ...initialWorkspace, main: { status: "error", fileName: "tree.ged", message: "x" } } });
    expect(storage.has("gedmerge.restoreInProgress")).toBe(false);
  });

  it("a restore that never finished is skipped once, and says so", async () => {
    await plant();
    storage.set("gedmerge.restoreInProgress", "1");
    const rig = await mount();
    await vi.waitFor(() => expect(rig.api.hydratedRef.current).toBe(true));
    expect(rig.posted).toEqual([]);
    expect(rig.toasts).toEqual(["persist.restoreSkipped"]);
    expect(storage.has("gedmerge.restoreInProgress")).toBe(false);
  });

  it("a cached blob that cannot be read fails the slot and drops the cache entry", async () => {
    await plant();
    const spy = vi.spyOn(Blob.prototype, "arrayBuffer").mockRejectedValue(new Error("evicted"));
    try {
      const rig = await mount();
      await vi.waitFor(() => expect(rig.api.hydratedRef.current).toBe(true));
      expect(rig.actions).toContainEqual({ type: "slotError", role: "main", fileName: "tree.ged", message: "load.unreadable" });
      expect(rig.posted).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    await vi.waitFor(async () => expect((await idb.loadWorkspace()).main).toBeUndefined());
  });

  it("a logo-click fresh start skips the restore and clears the cache", async () => {
    await plant();
    idb.markFreshStart();
    const rig = await mount();
    expect(rig.api.hydratedRef.current).toBe(true);
    await vi.waitFor(async () => expect((await idb.loadWorkspace()).main).toBeUndefined());
    expect(rig.posted).toEqual([]);
  });

  it("a file the user loads while the cache is read wins", async () => {
    await plant();
    const rig = await mount();
    rig.api.userLoadedRef.current = true;
    await new Promise((r) => setTimeout(r, 20));
    expect(rig.posted).toEqual([]);
    expect(rig.actions).toEqual([]);
  });

  it("with persistence off, reads nothing", async () => {
    await plant();
    const rig = await mount({ persistEnabled: false });
    await vi.waitFor(() => expect(rig.api.hydratedRef.current).toBe(true));
    expect(rig.posted).toEqual([]);
  });
});

describe("useWorkspacePersistence: the debounced writer", () => {
  it("caches the loaded main and its session; an unedited file carries no edit state", async () => {
    const ds = load();
    const rig = await mount();
    await vi.waitFor(() => expect(rig.api.hydratedRef.current).toBe(true));
    rig.update({ workspace: loadedWorkspace(ds, { decisions: new Map([["k", { status: "accepted" } as never]]), startId: "@I1@" }), mainDataset: ds });
    await tick();
    const ws = await idb.loadWorkspace();
    expect(await ws.main!.blob.text()).toBe(textOf(ds));
    expect(ws.session).toMatchObject({ mainFileName: "tree.ged", decisions: [["k", { status: "accepted" }]], startId: "@I1@" });
    expect(ws.session!.editState).toBeUndefined();
    expect(rig.api.mainCachedRef.current).toBe(true);
  });

  it("writes nothing while a main (re)load is still parsing", async () => {
    const ds = load();
    const rig = await mount();
    await vi.waitFor(() => expect(rig.api.hydratedRef.current).toBe(true));
    rig.update({ workspace: { ...loadedWorkspace(ds), main: { status: "loading", fileName: "next.ged" } }, mainDataset: ds });
    expect(timers.size).toBe(0);
  });

  it("an edit rewrites the blob with the edit state; a decision click alone does not re-serialize", async () => {
    const { SerializedMain } = await import("./serializedMain");
    const blob = vi.spyOn(SerializedMain.prototype, "blob");
    const ds = load();
    const rig = await mount();
    await vi.waitFor(() => expect(rig.api.hydratedRef.current).toBe(true));
    rig.update({ workspace: loadedWorkspace(ds), mainDataset: ds });
    await tick();
    expect(blob).toHaveBeenCalledTimes(1);

    ds.individuals.get("@I1@")!.raw.children[0].value = "Janez /Kranjc/";
    rig.opts.changeJournal.record(1, ["@I1@"]);
    rig.opts.undoRedo.push({ mode: "edit", patches: [], navigateTo: "@I1@" });
    rig.update({ editVersion: 1 });
    await tick();
    expect(blob).toHaveBeenCalledTimes(2);
    let ws = await idb.loadWorkspace();
    expect(await ws.main!.blob.text()).toContain("Janez /Kranjc/");
    expect(ws.session!.editState?.undo).toEqual([{ mode: "edit", patches: [], navigateTo: "@I1@" }]);

    rig.update({ workspace: { ...rig.opts.workspace, decisions: new Map([["k", { status: "rejected" } as never]]) } });
    await tick();
    expect(blob).toHaveBeenCalledTimes(2);
    ws = await idb.loadWorkspace();
    expect(ws.session!.decisions).toEqual([["k", { status: "rejected" }]]);
    blob.mockRestore();
  });

  it("after a save the cached session is clean again; a fresh main is cached anew", async () => {
    const ds = load();
    const rig = await mount();
    await vi.waitFor(() => expect(rig.api.hydratedRef.current).toBe(true));
    rig.update({ workspace: loadedWorkspace(ds), mainDataset: ds, editVersion: 2 });
    await tick();
    expect((await idb.loadWorkspace()).session!.editState).toBeDefined();
    // The save advanced App's clean mark to the saved version.
    (rig.opts.cleanEditVersionRef as { current: number }).current = 2;
    rig.update({ editVersion: 3 });
    (rig.opts.cleanEditVersionRef as { current: number }).current = 3;
    await tick();
    expect((await idb.loadWorkspace()).session!.editState).toBeUndefined();

    // Another main loads: App resets the flag, versions start over.
    const next = load(TEXT.replace("Janez /Novak/", "Ana /Kos/"));
    rig.api.mainCachedRef.current = false;
    (rig.opts.cleanEditVersionRef as { current: number }).current = 0;
    rig.update({ workspace: loadedWorkspace(next, { mainLoadGen: 2 }), mainDataset: next, editVersion: 0 });
    await tick();
    const ws = await idb.loadWorkspace();
    expect(await ws.main!.blob.text()).toContain("Ana /Kos/");
    expect(ws.session!.editState).toBeUndefined();
  });

  it("a failing cache write is reported once per failure streak", async () => {
    const ds = load();
    const rig = await mount();
    await vi.waitFor(() => expect(rig.api.hydratedRef.current).toBe(true));
    const real = globalThis.indexedDB;
    // A transaction that throws makes saveMainAndSession answer false.
    const db = await new Promise<IDBDatabase>((resolve) => {
      const r = real.open("gedmerge-session", 1);
      r.onsuccess = () => resolve(r.result);
    });
    const tx = vi.spyOn(Object.getPrototypeOf(db), "transaction").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      rig.update({ workspace: loadedWorkspace(ds), mainDataset: ds });
      await tick();
      rig.update({ workspace: loadedWorkspace(ds, { startId: "@I1@" }) });
      await tick();
      expect(rig.toasts).toEqual(["persist.writeFailed"]);
    } finally {
      tx.mockRestore();
    }
    rig.update({ workspace: loadedWorkspace(ds, { startId: undefined }) });
    await tick();
    expect(rig.api.mainCachedRef.current).toBe(true);
    db.close();
  });
});

describe("useWorkspacePersistence: toggle, clear and verify", () => {
  it("turning caching on writes the open files; turning it off wipes them", async () => {
    const ds = load();
    const compareBlob = new Blob(["a;b\n1;2\n"]);
    const rig = await mount({ persistEnabled: false });
    rig.api.compareBlobRef.current = compareBlob;
    rig.update({
      workspace: loadedWorkspace(ds, { compare: { status: "loaded", file: { fileName: "in.csv", dataset: load() } } }),
      mainDataset: ds,
    });
    rig.update({ persistEnabled: true });
    await vi.waitFor(async () => expect((await idb.loadWorkspace()).compare).toBeDefined());
    const ws = await idb.loadWorkspace();
    expect(await ws.main!.blob.text()).toBe(textOf(ds));
    expect(ws.compare).toMatchObject({ fileName: "in.csv", isCsv: true });
    rig.update({ persistEnabled: false });
    await vi.waitFor(async () => expect((await idb.loadWorkspace()).main).toBeUndefined());
  });

  it("Clear cached data wipes the workspace, the place decisions and the media folder", async () => {
    await plant();
    const geo = await import("./geoDb");
    const rig = await mount({ persistEnabled: false });
    await rig.api.handleClearCache();
    expect((await idb.loadWorkspace()).main).toBeUndefined();
    expect(geo.clearDecisions).toHaveBeenCalled();
    expect(rig.opts.clearMediaFolder).toHaveBeenCalled();
    expect(rig.toasts).toEqual(["settings.data.cleared"]);
  });

  it("Clear cached data asks first", async () => {
    await plant();
    const rig = await mount({ persistEnabled: false, confirmDialog: vi.fn(async () => false) });
    await rig.api.handleClearCache();
    expect((await idb.loadWorkspace()).main).toBeDefined();
  });

  it("Verify compares the file on disk with the one loaded", async () => {
    const { hashFile } = await import("./fingerprint");
    const disk = { current: new File([TEXT], "tree.ged") };
    const perm = { current: "granted" as PermissionState };
    const handle = {
      getFile: vi.fn(async () => disk.current),
      queryPermission: vi.fn(async () => perm.current),
      requestPermission: vi.fn(async () => "denied" as PermissionState),
    } as unknown as FileSystemFileHandle;
    const rig = await mount({ persistEnabled: false });
    rig.api.setMainHandle(handle);
    rig.api.mainOriginalHashRef.current = await hashFile(disk.current);

    await rig.api.verifyNow("main");
    expect(rig.toasts.at(-1)).toBe("load.verify.unchanged");

    disk.current = new File([TEXT + "0 @I2@ INDI\n"], "tree.ged");
    await rig.api.verifyNow("main");
    expect(rig.opts.loadFile).toHaveBeenCalledWith("main", disk.current, handle);

    perm.current = "prompt";
    await rig.api.verifyNow("main");
    expect(rig.toasts.at(-1)).toBe("load.verify.denied");

    perm.current = "granted";
    (handle.getFile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("gone"));
    await rig.api.verifyNow("main");
    expect(rig.toasts.at(-1)).toBe("load.unreadable");

    // Nothing to verify against: no compare handle.
    const before = rig.toasts.length;
    await rig.api.verifyNow("compare");
    expect(rig.toasts).toHaveLength(before);
  });
});

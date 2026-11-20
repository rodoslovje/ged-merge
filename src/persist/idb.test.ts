import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";

/**
 * The IndexedDB workspace cache, run against fake-indexeddb. Losing unsaved
 * work to a persistence bug is the worst failure this app has, and none of
 * this had a test: the module caches its DB connection at module level, so
 * each test gets a fresh factory AND a fresh module import.
 */

type Idb = typeof import("./idb");

let idb: Idb;

beforeEach(async () => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  idb = await import("./idb");
});

const mainFile = (name = "tree.ged") => ({
  fileName: name,
  blob: new Blob(["0 HEAD\n0 TRLR\n"]),
  savedAt: 1,
});

const session = (over: Partial<import("./idb").StoredSession> = {}): import("./idb").StoredSession => ({
  mainFileName: "tree.ged",
  decisions: [],
  importBranches: [],
  savedAt: 1,
  ...over,
});

/** Raw write bypassing the module, for planting legacy/foreign shapes. */
function rawPut(store: "files" | "session", key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("gedmerge-session", 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files");
      if (!db.objectStoreNames.contains("session")) db.createObjectStore("session");
    };
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    open.onerror = () => reject(open.error);
  });
}

describe("workspace cache round-trips", () => {
  it("saveMainAndSession commits blob and session together and reports success", async () => {
    const ok = await idb.saveMainAndSession(mainFile(), session({ startId: "@I1@" }));
    expect(ok).toBe(true);
    const ws = await idb.loadWorkspace();
    expect(ws.main?.fileName).toBe("tree.ged");
    expect(await ws.main!.blob.text()).toBe("0 HEAD\n0 TRLR\n");
    expect(ws.session?.startId).toBe("@I1@");
  });

  it("a session-only tick keeps the previously cached main blob", async () => {
    await idb.saveMainAndSession(mainFile(), session());
    const ok = await idb.saveMainAndSession(undefined, session({ startId: "@I2@" }));
    expect(ok).toBe(true);
    const ws = await idb.loadWorkspace();
    expect(ws.main?.fileName).toBe("tree.ged");
    expect(ws.session?.startId).toBe("@I2@");
  });

  it("saveFile/loadWorkspace round-trips the compare slot beside the main", async () => {
    await idb.saveMainAndSession(mainFile(), session());
    await idb.saveFile("compare", { fileName: "other.ged", blob: new Blob(["x"]), savedAt: 2, isCsv: false });
    const ws = await idb.loadWorkspace();
    expect(ws.compare?.fileName).toBe("other.ged");
  });

  it("discards a session written with an incompatible schema, keeping the files", async () => {
    await idb.saveMainAndSession(mainFile(), session());
    // A deploy bumped the shapes since this session was written.
    await rawPut("session", "current", { ...session({ startId: "@OLD@" }), schema: 1 });
    const ws = await idb.loadWorkspace();
    expect(ws.session).toBeUndefined();
    expect(ws.main?.fileName).toBe("tree.ged");
  });

  it("reads a main cached under the pre-rename legacy key", async () => {
    await rawPut("files", "master", mainFile("legacy.ged"));
    const ws = await idb.loadWorkspace();
    expect(ws.main?.fileName).toBe("legacy.ged");
  });

  it("deleteFile('main') clears the legacy key too", async () => {
    await rawPut("files", "master", mainFile("legacy.ged"));
    await idb.saveFile("main", mainFile("new.ged"));
    await idb.deleteFile("main");
    const ws = await idb.loadWorkspace();
    expect(ws.main).toBeUndefined();
  });

  it("clearWorkspace wipes files (legacy key included) and the session", async () => {
    await rawPut("files", "master", mainFile("legacy.ged"));
    await idb.saveMainAndSession(mainFile(), session());
    await idb.saveFile("compare", { fileName: "other.ged", blob: new Blob(["x"]), savedAt: 2 });
    await idb.clearWorkspace();
    const ws = await idb.loadWorkspace();
    expect(ws).toEqual({ main: undefined, compare: undefined, session: undefined });
  });

  it("settles when the transaction aborts instead of completing", async () => {
    // A write refused at commit (quota) fires `abort`, not `error`.
    const { IDBDatabase } = await import("fake-indexeddb");
    const transaction = IDBDatabase.prototype.transaction;
    const spy = vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const tx = transaction.apply(this, args as Parameters<typeof transaction>);
      if (args[1] === "readwrite") queueMicrotask(() => tx.abort());
      return tx;
    });
    const settled = (p: Promise<unknown>) =>
      Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("hung"), 200))]);
    try {
      expect(await settled(idb.saveFile("main", mainFile()))).toBe("settled");
      expect(await settled(idb.clearWorkspace())).toBe("settled");
      expect(await idb.saveMainAndSession(mainFile(), session())).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect((await idb.loadWorkspace()).main).toBeUndefined();
  });

  it("operations resolve harmlessly when IndexedDB is unavailable", async () => {
    // The app must keep working with persistence silently off.
    // @ts-expect-error — simulating an environment without IndexedDB
    delete globalThis.indexedDB;
    vi.resetModules();
    idb = await import("./idb");
    expect(await idb.loadWorkspace()).toEqual({});
    expect(await idb.saveMainAndSession(mainFile(), session())).toBe(false);
    await expect(idb.saveFile("main", mainFile())).resolves.toBeUndefined();
  });

  it("opens a new connection after the browser closed the one it had", async () => {
    const open = vi.spyOn(globalThis.indexedDB, "open");
    const connection = (n: number) => (open.mock.results[n].value as IDBOpenDBRequest).result;
    await idb.saveFile("main", mainFile());
    expect(open).toHaveBeenCalledTimes(1);
    connection(0).onclose?.(new Event("close"));
    await idb.saveFile("main", mainFile("second.ged"));
    expect(open).toHaveBeenCalledTimes(2);
    // Another tab's upgrade: this connection gets out of its way.
    const close = vi.spyOn(connection(1), "close");
    connection(1).onversionchange?.(new Event("versionchange") as IDBVersionChangeEvent);
    expect(close).toHaveBeenCalled();
    await idb.saveFile("main", mainFile("again.ged"));
    expect(open).toHaveBeenCalledTimes(3);
    expect((await idb.loadWorkspace()).main?.fileName).toBe("again.ged");
  });
});

describe("claimCache: one tab owns the cache", () => {
  const withLocks = (request: (name: string, o: { signal: AbortSignal }, cb: () => Promise<void>) => Promise<unknown>) =>
    vi.stubGlobal("navigator", { locks: { request } });
  const held = (_name: string, o: { signal: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      o.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });

  it("is ours where the browser has no Web Locks", async () => {
    vi.stubGlobal("navigator", {});
    expect(await idb.claimCache()).toBe(true);
    expect(await idb.saveMainAndSession(mainFile(), session())).toBe(true);
  });

  it("is ours once the lock is granted, and is asked for only once", async () => {
    const request = vi.fn(async (_name: string, _o: unknown, cb: () => Promise<void>) => { void cb(); });
    withLocks(request);
    expect(await idb.claimCache()).toBe(true);
    expect(await idb.claimCache()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await idb.saveMainAndSession(mainFile(), session())).toBe(true);
  });

  it("held by another tab: every write is a no-op, clearing still works", async () => {
    await idb.saveMainAndSession(mainFile(), session());
    await idb.saveFile("compare", mainFile("in.ged"));
    withLocks(held);
    expect(await idb.claimCache()).toBe(false);
    expect(await idb.saveMainAndSession(mainFile("mine.ged"), session())).toBe(false);
    await idb.saveFile("main", mainFile("mine.ged"));
    await idb.saveSession(session({ mainFileName: "mine.ged" }));
    await idb.deleteFile("compare");
    const ws = await idb.loadWorkspace();
    expect(ws.main?.fileName).toBe("tree.ged");
    expect(ws.session?.mainFileName).toBe("tree.ged");
    expect(ws.compare?.fileName).toBe("in.ged");
    await idb.clearWorkspace();
    expect(await idb.loadWorkspace()).toEqual({ main: undefined, compare: undefined, session: undefined });
  });

  it("a browser that refuses the lock outright leaves the cache as it was", async () => {
    withLocks(() => Promise.reject(Object.assign(new Error("no"), { name: "SecurityError" })));
    expect(await idb.claimCache()).toBe(true);
    expect(await idb.saveMainAndSession(mainFile(), session())).toBe(true);
  });
});

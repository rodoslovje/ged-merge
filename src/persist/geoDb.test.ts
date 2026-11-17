import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { AddressBucket, AddressIndex } from "../geo/addressRegister";
import type { GazEntry } from "../geo/gazetteer";

/**
 * The gazetteer / geocode-decision store, run against fake-indexeddb. Each test
 * gets a fresh factory and a fresh module import, as in idb.test.ts.
 */

type GeoDb = typeof import("./geoDb");

let geoDb: GeoDb;

beforeEach(async () => {
  vi.resetModules();
  globalThis.indexedDB = new IDBFactory();
  globalThis.IDBKeyRange = IDBKeyRange;
  geoDb = await import("./geoDb");
});

const country = (code: string, over: Partial<import("./geoDb").StoredCountry> = {}) => ({
  code,
  count: 1,
  importedAt: 1,
  entries: [{ name: `${code} town` } as unknown as GazEntry],
  ...over,
});

const index = (country: "SI" | "HR", ids: string[]): AddressIndex => ({
  country,
  count: ids.length,
  importedAt: 1,
  settlements: ids.map((id) => ({ id, name: id, count: 1 })),
  parentNames: [],
});

const bucket = (country: string, id: string): AddressBucket =>
  ({ key: `${country}:${id}`, name: id, streets: [], posts: [], st: new Int32Array([1]) }) as unknown as AddressBucket;

describe("countries", () => {
  it("round-trips put / get / load / delete", async () => {
    await geoDb.putCountry(country("SI"));
    await geoDb.putCountry(country("HR", { count: 2 }));
    expect((await geoDb.getCountry("SI"))?.entries[0]).toEqual({ name: "SI town" });
    expect((await geoDb.loadCountries()).map((c) => c.code).sort()).toEqual(["HR", "SI"]);

    await geoDb.putCountry(country("HR", { count: 5 }));
    expect((await geoDb.getCountry("HR"))?.count).toBe(5);

    await geoDb.deleteCountry("SI");
    expect(await geoDb.getCountry("SI")).toBeUndefined();
    expect((await geoDb.loadCountries()).map((c) => c.code)).toEqual(["HR"]);
  });
});

describe("decisions", () => {
  it("loads only nomatch / historic, ignoring legacy accepted records", async () => {
    await geoDb.putDecisions([
      { key: "Ljubljana", status: "nomatch", ts: 1 },
      { key: "register:Kranj", status: "historic", ts: 1 },
      { key: "Celje", status: "accepted", lat: 46, lon: 15, ts: 1 },
    ]);
    const loaded = await geoDb.loadDecisions();
    expect([...loaded.keys()].sort()).toEqual(["Ljubljana", "register:Kranj"]);
  });

  it("deletes one, several, and saves marks plus forgets in one call", async () => {
    await geoDb.putDecisions([
      { key: "a", status: "nomatch", ts: 1 },
      { key: "b", status: "nomatch", ts: 1 },
      { key: "c", status: "nomatch", ts: 1 },
    ]);
    await geoDb.deleteDecision("a");
    await geoDb.deleteDecisions(["b", "never-stored"]);
    expect([...(await geoDb.loadDecisions()).keys()]).toEqual(["c"]);

    await geoDb.saveDecisions([{ key: "d", status: "historic", ts: 2 }], ["c"]);
    expect([...(await geoDb.loadDecisions()).keys()]).toEqual(["d"]);
  });

  it("empty batches are no-ops", async () => {
    await geoDb.putDecisions([]);
    await geoDb.deleteDecisions([]);
    expect((await geoDb.loadDecisions()).size).toBe(0);
  });

  it("setDismissed stores and removes a dismissal", async () => {
    await geoDb.setDismissed("register:Kranj", true, "historic");
    expect((await geoDb.loadDecisions()).get("register:Kranj")?.status).toBe("historic");
    await geoDb.setDismissed("register:Kranj", false, "historic");
    expect((await geoDb.loadDecisions()).has("register:Kranj")).toBe(false);
  });

  it("clearDecisions forgets decisions but keeps imported countries", async () => {
    await geoDb.putCountry(country("SI"));
    await geoDb.putDecisions([{ key: "x", status: "nomatch", ts: 1 }]);
    await geoDb.clearDecisions();
    expect((await geoDb.loadDecisions()).size).toBe(0);
    expect(await geoDb.getCountry("SI")).toBeDefined();
  });
});

describe("address registers", () => {
  it("writes buckets in chunks, then the index, reporting progress", async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `s${i}`);
    const progress: [number, number][] = [];
    await geoDb.putAddressRegister(index("HR", ids), ids.map((id) => bucket("HR", id)), (d, t) =>
      progress.push([d, t]),
    );
    expect(progress).toEqual([[250, 300], [300, 300]]);
    expect((await geoDb.getAddressIndex("HR"))?.count).toBe(300);
    const b = await geoDb.getAddressBucket("HR:s299");
    expect(b?.name).toBe("s299");
    expect(Array.from(b?.st ?? [])).toEqual([1]);
  });

  it("a re-import replaces only that country's buckets", async () => {
    await geoDb.putAddressRegister(index("HR", ["a", "b"]), [bucket("HR", "a"), bucket("HR", "b")]);
    await geoDb.putAddressRegister(index("SI", ["a"]), [bucket("SI", "a")]);
    await geoDb.putAddressRegister(index("HR", ["c"]), [bucket("HR", "c")]);

    expect(await geoDb.getAddressBucket("HR:a")).toBeUndefined();
    expect(await geoDb.getAddressBucket("HR:c")).toBeDefined();
    expect(await geoDb.getAddressBucket("SI:a")).toBeDefined();
    expect((await geoDb.getAddressIndex("HR"))?.count).toBe(1);
  });

  it("deleteAddressRegister drops the index and every bucket of that country", async () => {
    await geoDb.putAddressRegister(index("HR", ["a"]), [bucket("HR", "a")]);
    await geoDb.putAddressRegister(index("SI", ["a"]), [bucket("SI", "a")]);
    await geoDb.deleteAddressRegister("HR");
    expect(await geoDb.getAddressIndex("HR")).toBeUndefined();
    expect(await geoDb.getAddressBucket("HR:a")).toBeUndefined();
    expect(await geoDb.getAddressIndex("SI")).toBeDefined();
  });
});

describe("failures", () => {
  it("reads degrade to empty without IndexedDB, while imports reject with GeoStoreError", async () => {
    // @ts-expect-error — simulating an environment without IndexedDB
    globalThis.indexedDB = undefined;
    expect(await geoDb.loadCountries()).toEqual([]);
    expect((await geoDb.loadDecisions()).size).toBe(0);
    expect(await geoDb.getCountry("SI")).toBeUndefined();
    await expect(geoDb.setDismissed("k", true, "historic")).resolves.toBeUndefined();

    // The imports deliberately do not swallow it.
    await expect(geoDb.putCountry(country("SI"))).rejects.toThrow();
    await expect(geoDb.putAddressRegister(index("HR", []), [])).rejects.toThrow();
  });

  it("a refused register write rejects as a 'failed' GeoStoreError naming the cause", async () => {
    const keyless = { name: "no key" } as unknown as AddressBucket;
    const err = await geoDb.putAddressRegister(index("HR", ["x"]), [keyless]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(geoDb.GeoStoreError);
    expect((err as InstanceType<GeoDb["GeoStoreError"]>).kind).toBe("failed");
    expect((err as InstanceType<GeoDb["GeoStoreError"]>).detail).toMatch(/DataError/);
    // The index was never written, so the half-import reads as "nothing imported".
    expect(await geoDb.getAddressIndex("HR")).toBeUndefined();
  });

  it("an upgrade blocked by an older connection rejects as 'blocked'", async () => {
    // A second window on the version-1 database that never closes.
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("gedmerge-geo", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const err = await geoDb.putCountry(country("SI")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(geoDb.GeoStoreError);
    expect((err as InstanceType<GeoDb["GeoStoreError"]>).kind).toBe("blocked");
    expect(String((err as Error).message)).toContain("another window");
    // The window closes: the upgrade that was waiting now goes through, and
    // its late connection is closed rather than left to block the next open.
    old.close();
    await geoDb.putCountry(country("SI"));
    expect(await geoDb.getCountry("SI")).toBeDefined();
  });

  it("a database from a newer version of the app rejects as 'failed'", async () => {
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("gedmerge-geo", 99);
      req.onsuccess = () => {
        req.result.close();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
    const err = await geoDb.putCountry(country("SI")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(geoDb.GeoStoreError);
    expect((err as InstanceType<GeoDb["GeoStoreError"]>).kind).toBe("failed");
    expect((err as InstanceType<GeoDb["GeoStoreError"]>).detail).toMatch(/VersionError/);
    expect(await geoDb.loadCountries()).toEqual([]);
  });

  it("GeoStoreError words a refused write with the browser's detail", () => {
    const e = new geoDb.GeoStoreError("failed", "QuotaExceededError: full");
    expect(e.message).toContain("QuotaExceededError: full");
    expect(e.name).toBe("GeoStoreError");
  });
});

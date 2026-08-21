// IndexedDB-backed gazetteer + geocode-decision storage.
//
// Its own DB (like MediaFolderContext's handle store and the workspace DB),
// deliberately separate from "gedmerge-session": the imported gazetteer and
// the user's geocode decisions outlive any one workspace and are not gated by
// the persist-workspace opt-in (importing a gazetteer file is itself the
// deliberate action). Imported countries survive "clear locally stored data"
// (public reference data, expensive to re-download); the decisions do not —
// they are keyed by the file's own place strings (see clearDecisions).
// Best-effort:
// every operation swallows errors — storage failure degrades the Geocode
// tool to "no gazetteer", never breaks the app.
//
// Stores:
//  - "countries": one record per imported GeoNames country extract, keyed by
//    ISO country code, holding its parsed entries wholesale (one get loads a
//    country; no per-row cursor traffic).
//  - "decisions": one record per reviewed place string, keyed by the exact
//    raw PLAC value — explicit "no match" marks — plus the register check's
//    dismissals, under the same value behind a "register:" prefix so the two
//    judgements never overwrite each other. This cache is their ONLY
//    home; they are never written into the file. Accepted coordinates are NOT
//    remembered here: writing them into the GEDCOM is the user's act, and a
//    fresh run should ask again rather than arrive pre-decided (the "accepted"
//    status below survives only to read and ignore records from before this).
//  - "addrIndex" / "addrBuckets": the downloaded national *address*
//    registers — every house number of a country, with its own coordinate.
//    The index is one record per country; the buckets are one record per
//    settlement, so a lookup reads exactly the village it is about. Public
//    reference data like the countries above, and kept on the same terms.

import type { DivisionNames, GazEntry } from "../geo/gazetteer";
import type { AddressBucket, AddressIndex } from "../geo/addressRegister";

const DB_NAME = "gedmerge-geo";
const DB_VERSION = 2;
const COUNTRIES_STORE = "countries";
const DECISIONS_STORE = "decisions";
const ADDR_INDEX_STORE = "addrIndex";
const ADDR_BUCKETS_STORE = "addrBuckets";

export interface StoredCountry {
  /** ISO-3166 alpha-2 code, e.g. "SI". */
  code: string;
  count: number;
  importedAt: number;
  entries: GazEntry[];
  /** admin1 code → the division's known names, when the source provided them.
   *  Absent on imports made before divisions were recorded. */
  divisions?: DivisionNames;
}

export interface CountryMeta {
  code: string;
  count: number;
  importedAt: number;
}

export interface GeocodeDecision {
  /** Exact raw PLAC value this decision applies to. */
  key: string;
  /** "nomatch" — the geocode review found the place in no gazetteer;
   *  "historic" — the register check was told this wording is right as it
   *  stands (a historical name the register no longer knows, most often).
   *  "accepted" still parses so a store from an earlier version loads
   *  cleanly, but it is filtered out. */
  status: "accepted" | "nomatch" | "historic";
  lat?: number;
  lon?: number;
  /** Display label of the accepted match (gazetteer name or "manual"). */
  label?: string;
  /** GOV id, when the accepted match came from GOV (re-written as `_GOV`). */
  govId?: string;
  ts: number;
}

/**
 * Why a store failed, in the two shapes a caller can say something useful
 * about: the database is held open by another window of the app, or the
 * browser refused the write. `detail` is the browser's own wording, which
 * names the refusal — `QuotaExceededError` most often — and is the only thing
 * that tells a full disk apart from a browser storing nothing for this site.
 */
export class GeoStoreError extends Error {
  constructor(
    readonly kind: "blocked" | "failed",
    readonly detail: string,
  ) {
    super(
      kind === "blocked"
        ? "the place database is open in another window"
        : `the place database refused the write (${detail})`,
    );
    this.name = "GeoStoreError";
  }
}

function storeFailure(e: unknown): GeoStoreError {
  if (e instanceof GeoStoreError) return e;
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e ?? "unknown error");
  return new GeoStoreError("failed", detail);
}

function openGeoDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    let settled = false;
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(COUNTRIES_STORE)) db.createObjectStore(COUNTRIES_STORE, { keyPath: "code" });
      if (!db.objectStoreNames.contains(DECISIONS_STORE)) db.createObjectStore(DECISIONS_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(ADDR_INDEX_STORE)) db.createObjectStore(ADDR_INDEX_STORE, { keyPath: "country" });
      if (!db.objectStoreNames.contains(ADDR_BUCKETS_STORE)) db.createObjectStore(ADDR_BUCKETS_STORE, { keyPath: "key" });
    };
    req.onsuccess = () => {
      // A connection that arrives after the blocked rejection below belongs to
      // nobody: close it, or it becomes the connection that blocks the next
      // attempt in its turn.
      if (settled) req.result.close();
      else {
        settled = true;
        resolve(req.result);
      }
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(storeFailure(req.error));
    };
    // An upgrade waits for every other connection to this database to close,
    // and a second window of the app sitting on an older version of it never
    // does. Without this the open request simply never settles, so the import
    // awaiting it ends as a progress bar that stops — nothing stored, nothing
    // said, which is exactly how the failure was reported.
    req.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(new GeoStoreError("blocked", "upgrade blocked by another connection"));
    };
  });
}

async function withGeoDb<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T | undefined> {
  try {
    const db = await openGeoDb();
    try {
      return await fn(db);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function requestDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Store (replace) one imported country. Callable from the import worker too.
 *
 * Deliberately NOT withGeoDb, on the same grounds as putAddressRegister below:
 * a download of minutes whose one product is this write must not end by
 * swallowing the reason it failed and reporting the directory as imported.
 * It waits for the transaction rather than for the request, because a write
 * refused for want of room succeeds as a request and aborts on commit.
 */
export async function putCountry(country: StoredCountry): Promise<void> {
  const db = await openGeoDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(COUNTRIES_STORE, "readwrite");
      tx.objectStore(COUNTRIES_STORE).put(country);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(storeFailure(tx.error));
      tx.onabort = () => reject(storeFailure(tx.error));
    });
  } finally {
    db.close();
  }
}

/** One imported directory with its entries, or undefined when nothing is stored
 *  under that key — what a per-region download reads before merging into it. */
export async function getCountry(code: string): Promise<StoredCountry | undefined> {
  return await withGeoDb((db) =>
    requestDone(db.transaction(COUNTRIES_STORE).objectStore(COUNTRIES_STORE).get(code) as IDBRequest<StoredCountry | undefined>),
  );
}

export async function deleteCountry(code: string): Promise<void> {
  await withGeoDb((db) => requestDone(db.transaction(COUNTRIES_STORE, "readwrite").objectStore(COUNTRIES_STORE).delete(code)));
}

/** Every imported country with its entries — the Geocode tool loads all of
 *  them into one in-memory index anyway, so one getAll is the cheapest shape. */
export async function loadCountries(): Promise<StoredCountry[]> {
  const all = await withGeoDb((db) =>
    requestDone(db.transaction(COUNTRIES_STORE).objectStore(COUNTRIES_STORE).getAll() as IDBRequest<StoredCountry[]>),
  );
  return all ?? [];
}

/** Buckets written per transaction. One transaction for all 6759 settlements
 *  holds the whole 35 MB register open at once and blocks anything else the
 *  browser wanted to do with the database; a few hundred at a time streams. */
const BUCKET_CHUNK = 250;

/**
 * Replace a country's stored address register: its buckets first, then the
 * index that describes them.
 *
 * That order is the point. The index is what every lookup reads to decide
 * whether there is a register at all, so writing it last means an import
 * interrupted halfway — a closed tab, a full disk — leaves a store with no
 * index, which reads as "nothing imported" rather than as a register whose
 * villages are mostly missing. `onProgress` is called with buckets written.
 */
export async function putAddressRegister(
  index: AddressIndex,
  buckets: readonly AddressBucket[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Deliberately NOT withGeoDb: every other call here is best-effort, because
  // losing a cached decision degrades a tool rather than breaking it. A register
  // import is the opposite — minutes of downloading whose only product is this
  // write, so a failure (a full disk, a browser refusing the quota) has to reach
  // the user as a failure instead of ending as a spinner that simply stops.
  const db = await openGeoDb();
  try {
    await putRegister(db, index, buckets, onProgress);
  } catch (e) {
    // The same two shapes as every other write here, so the manager can say
    // which of them happened in the reader's own language.
    throw storeFailure(e);
  } finally {
    db.close();
  }
}

async function putRegister(
  db: IDBDatabase,
  index: AddressIndex,
  buckets: readonly AddressBucket[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  await clearAddressRegister(db, index.country);
  for (let at = 0; at < buckets.length; at += BUCKET_CHUNK) {
    const chunk = buckets.slice(at, at + BUCKET_CHUNK);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ADDR_BUCKETS_STORE, "readwrite");
      const store = tx.objectStore(ADDR_BUCKETS_STORE);
      for (const bucket of chunk) store.put(bucket);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    onProgress?.(Math.min(at + BUCKET_CHUNK, buckets.length), buckets.length);
  }
  // The transaction, not the request: a write refused for want of room
  // succeeds as a request and aborts on commit, and this one is what every
  // later lookup reads to decide the register is there at all.
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ADDR_INDEX_STORE, "readwrite");
    tx.objectStore(ADDR_INDEX_STORE).put(index);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Drop every bucket of one country, plus its index. */
async function clearAddressRegister(db: IDBDatabase, country: string): Promise<void> {
  await requestDone(db.transaction(ADDR_INDEX_STORE, "readwrite").objectStore(ADDR_INDEX_STORE).delete(country));
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ADDR_BUCKETS_STORE, "readwrite");
    // Keyed `HR:<id>`, so one country's buckets are a contiguous key range.
    tx.objectStore(ADDR_BUCKETS_STORE).delete(IDBKeyRange.bound(`${country}:`, `${country}:￿`));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** What address register is stored for a country, if any. */
export async function getAddressIndex(country: string): Promise<AddressIndex | undefined> {
  return await withGeoDb((db) =>
    requestDone(
      db.transaction(ADDR_INDEX_STORE).objectStore(ADDR_INDEX_STORE).get(country) as IDBRequest<
        AddressIndex | undefined
      >,
    ),
  );
}

/** One settlement's addresses. Undefined when nothing is stored under that key,
 *  which a lookup reads as "this village has no houses in the register". */
export async function getAddressBucket(key: string): Promise<AddressBucket | undefined> {
  return await withGeoDb((db) =>
    requestDone(
      db.transaction(ADDR_BUCKETS_STORE).objectStore(ADDR_BUCKETS_STORE).get(key) as IDBRequest<
        AddressBucket | undefined
      >,
    ),
  );
}

/** Forget a country's address register — the delete button beside it. */
export async function deleteAddressRegister(country: string): Promise<void> {
  await withGeoDb((db) => clearAddressRegister(db, country));
}

export async function loadDecisions(): Promise<Map<string, GeocodeDecision>> {
  const all = await withGeoDb((db) =>
    requestDone(db.transaction(DECISIONS_STORE).objectStore(DECISIONS_STORE).getAll() as IDBRequest<GeocodeDecision[]>),
  );
  // Legacy "accepted" records (from when acceptances were cached too) are
  // ignored: an accepted coordinate's home is the saved GEDCOM, not this store.
  return new Map(
    (all ?? []).filter((d) => d.status === "nomatch" || d.status === "historic").map((d) => [d.key, d]),
  );
}

export async function putDecisions(decisions: GeocodeDecision[]): Promise<void> {
  if (!decisions.length) return;
  await withGeoDb(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DECISIONS_STORE, "readwrite");
        const store = tx.objectStore(DECISIONS_STORE);
        for (const d of decisions) store.put(d);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

/** Forget a batch of remembered decisions in one transaction — the restores
 *  a write carries, the mirror of {@link putDecisions}. A key the store never
 *  held is simply a no-op delete. */
export async function deleteDecisions(keys: readonly string[]): Promise<void> {
  if (!keys.length) return;
  await withGeoDb(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(DECISIONS_STORE, "readwrite");
        const store = tx.objectStore(DECISIONS_STORE);
        for (const key of keys) store.delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

export async function deleteDecision(key: string): Promise<void> {
  await withGeoDb((db) => requestDone(db.transaction(DECISIONS_STORE, "readwrite").objectStore(DECISIONS_STORE).delete(key)));
}

/** Forget every remembered place lookup — Settings › "Clear locally stored
 *  data". These are keyed by the raw PLAC values of the user's own file, so
 *  they are the user's data and a request to erase local data has to reach
 *  them. Imported gazetteer countries are *not* touched: they are public
 *  reference data, they carry nothing from the file, and re-downloading one is
 *  expensive — the Geocode tool deletes them individually. */
export async function clearDecisions(): Promise<void> {
  await withGeoDb((db) => requestDone(db.transaction(DECISIONS_STORE, "readwrite").objectStore(DECISIONS_STORE).clear()));
}

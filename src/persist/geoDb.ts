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
//    raw PLAC value — accepted coordinates (the cross-file lookup cache) and
//    explicit "no match" marks. Per the design (MAPVIEW.md): this cache is
//    the ONLY home of no-match marks; they are never written into the file.

import type { GazEntry } from "../geo/gazetteer";

const DB_NAME = "gedmerge-geo";
const DB_VERSION = 1;
const COUNTRIES_STORE = "countries";
const DECISIONS_STORE = "decisions";

export interface StoredCountry {
  /** ISO-3166 alpha-2 code, e.g. "SI". */
  code: string;
  count: number;
  importedAt: number;
  entries: GazEntry[];
}

export interface CountryMeta {
  code: string;
  count: number;
  importedAt: number;
}

export interface GeocodeDecision {
  /** Exact raw PLAC value this decision applies to. */
  key: string;
  status: "accepted" | "nomatch";
  lat?: number;
  lon?: number;
  /** Display label of the accepted match (gazetteer name or "manual"). */
  label?: string;
  /** GOV id, when the accepted match came from GOV (re-written as `_GOV`). */
  govId?: string;
  ts: number;
}

function openGeoDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(COUNTRIES_STORE)) db.createObjectStore(COUNTRIES_STORE, { keyPath: "code" });
      if (!db.objectStoreNames.contains(DECISIONS_STORE)) db.createObjectStore(DECISIONS_STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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

/** Store (replace) one imported country. Callable from the import worker too. */
export async function putCountry(country: StoredCountry): Promise<void> {
  await withGeoDb((db) => requestDone(db.transaction(COUNTRIES_STORE, "readwrite").objectStore(COUNTRIES_STORE).put(country)));
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

export async function loadDecisions(): Promise<Map<string, GeocodeDecision>> {
  const all = await withGeoDb((db) =>
    requestDone(db.transaction(DECISIONS_STORE).objectStore(DECISIONS_STORE).getAll() as IDBRequest<GeocodeDecision[]>),
  );
  return new Map((all ?? []).map((d) => [d.key, d]));
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

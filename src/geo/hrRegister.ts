import { foldToken } from "../match/text";
import { getAddressBucket, getAddressIndex } from "../persist/geoDb";
import { bucketKey, scopeToParents, searchBucket, type HrAddressBucket, type HrAddressHit, type HrAddressIndex } from "./hrAd";

// Looking a Croatian house up in the register this browser has stored — the
// offline half of hrAd.ts, which parses the download and defines the shapes.
//
// Everything here is IndexedDB reads: one small index record per session, and
// one bucket per settlement asked about. No network, no throttle, no queue —
// which is why the Croatian path can answer a whole village's addresses in the
// time the Slovenian one spends waiting for its first response.

/** Distinct addresses handed back for one row, matching the Slovenian
 *  register's own limit so both registers fill the review list alike. */
const MAX_RESULTS = 6;

/** What a lookup asks for. Structurally the Slovenian register's `RnQuery`, so
 *  one query builder serves both. */
export interface HrQuery {
  settlement: string;
  street?: string;
  number: number;
  suffix?: string;
  altSettlements?: string[];
  parents?: string[];
}

/** The stored index, plus the lookups built over it once. */
interface LoadedIndex {
  index: HrAddressIndex;
  /** Folded settlement name → the ids that bear it (313 names are shared). */
  byName: Map<string, number[]>;
  postNames: Set<string>;
  settlementNames: Set<string>;
}

/** The index, read once per session — it is a few hundred kilobytes and every
 *  lookup needs it. Null once read and found absent; a fresh promise after an
 *  import or a removal (see {@link invalidateHrRegister}). */
let loading: Promise<LoadedIndex | undefined> | undefined;

/** Buckets read this session, newest last. A village is asked about many times
 *  in a row — every house of it is its own row in the review list — so keeping
 *  the last few turns a whole place's lookup into one read. */
const bucketCache = new Map<string, HrAddressBucket | undefined>();
/** Zagreb's bucket alone is some 2 MB; a handful is plenty to cover a file's
 *  worth of consecutive rows without holding the register in memory. */
const BUCKET_CACHE_LIMIT = 12;

/** Drop everything cached — called when the register is imported or removed, so
 *  the next lookup sees what is actually stored. */
export function invalidateHrRegister(): void {
  loading = undefined;
  bucketCache.clear();
}

function loadIndex(): Promise<LoadedIndex | undefined> {
  loading ??= getAddressIndex("HR").then((index) => {
    if (!index) return undefined;
    const byName = new Map<string, number[]>();
    for (const s of index.settlements) {
      const key = foldToken(s.name);
      if (!key) continue;
      const ids = byName.get(key);
      if (ids) ids.push(s.id);
      else byName.set(key, [s.id]);
    }
    return {
      index,
      byName,
      postNames: new Set(index.postNames.map(foldToken)),
      settlementNames: new Set([...byName.keys()]),
    };
  });
  return loading;
}

/** Whether a Croatian address register is stored, and what is in it. Undefined
 *  when none is — which is what makes the Croatian lookup offer nothing rather
 *  than fail. */
export async function hrRegisterInfo(): Promise<{ count: number; importedAt: number } | undefined> {
  const loaded = await loadIndex();
  return loaded ? { count: loaded.index.count, importedAt: loaded.index.importedAt } : undefined;
}

async function bucketFor(id: number): Promise<HrAddressBucket | undefined> {
  const key = bucketKey(id);
  if (bucketCache.has(key)) return bucketCache.get(key);
  const bucket = await getAddressBucket(key);
  if (bucketCache.size >= BUCKET_CACHE_LIMIT) {
    const oldest = bucketCache.keys().next().value;
    if (oldest !== undefined) bucketCache.delete(oldest);
  }
  bucketCache.set(key, bucket);
  return bucket;
}

/** Every house one settlement name holds for a query — across every settlement
 *  of that name, since the name alone does not say which one is meant. The
 *  place's own parent level is what narrows them ({@link scopeToParents}). */
async function searchNamed(
  loaded: LoadedIndex,
  name: string,
  query: HrQuery,
): Promise<HrAddressHit[]> {
  const ids = loaded.byName.get(foldToken(name));
  if (!ids?.length) return [];
  const hits: HrAddressHit[] = [];
  for (const id of ids) {
    const bucket = await bucketFor(id);
    if (bucket) hits.push(...searchBucket(bucket, { number: query.number, suffix: query.suffix, street: query.street }));
  }
  return scopeToParents(hits, query.parents, loaded);
}

/**
 * Look one Croatian house up, walking the same ladder the Slovenian register is
 * walked with: the settlement the file names, then the wider names it sits in,
 * then the "street" read as a settlement of its own — a hamlet a file files
 * under its bigger neighbour, which is as common in Croatia as it is in
 * Slovenia. The rungs *within* a settlement (street, then village numbering,
 * then any street) are {@link searchBucket}'s.
 *
 * Resolves to [] when no register is stored at all, so a browser that has not
 * downloaded it simply sees no register answer — never an error.
 */
export async function searchHrAddress(query: HrQuery): Promise<HrAddressHit[]> {
  const loaded = await loadIndex();
  if (!loaded) return [];
  for (const name of [query.settlement, ...(query.altSettlements ?? [])]) {
    const hits = await searchNamed(loaded, name, query);
    if (hits.length) return hits.slice(0, MAX_RESULTS);
  }
  // The name the number hangs off, read as a village rather than a street.
  if (query.street) {
    const hits = await searchNamed(loaded, query.street, { ...query, street: undefined });
    if (hits.length) return hits.slice(0, MAX_RESULTS);
  }
  return [];
}

/** Look up several houses, merged and deduplicated by coordinate — the shape
 *  {@link import("./rn").searchAddresses} hands back for Slovenia. */
export async function searchHrAddresses(queries: readonly HrQuery[]): Promise<HrAddressHit[]> {
  const merged: HrAddressHit[] = [];
  for (const query of queries) {
    for (const hit of await searchHrAddress(query)) {
      if (merged.some((m) => m.coord.lat === hit.coord.lat && m.coord.lon === hit.coord.lon)) continue;
      merged.push(hit);
    }
  }
  return merged.slice(0, MAX_RESULTS);
}

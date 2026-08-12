import { foldToken } from "../match/text";
import { getAddressBucket, getAddressIndex } from "../persist/geoDb";
import {
  bucketKey,
  readStoredIndex,
  scopeToParents,
  searchBucket,
  tryAlternates,
  type AddressBucket,
  type AddressHit,
  type AddressIndex,
  type RegisterCountry,
} from "./addressRegister";

// Looking a house up in the address register this browser has stored — the
// reading half of addressRegister.ts, which defines the shapes the parsers fill.
//
// Everything here is IndexedDB reads: one small index record per country per
// session, and one bucket per settlement asked about. No network, no throttle,
// no queue — which is why a stored register answers a whole village's addresses
// in the time the online GURS ladder spends waiting for its first response.

/** Distinct addresses handed back for one row, matching the online register's
 *  own limit so both paths fill the review list alike. */
const MAX_RESULTS = 6;

/** What a lookup asks for. Structurally the online register's `RnQuery`, so one
 *  query builder serves every path. */
export interface LocalQuery {
  settlement: string;
  street?: string;
  number: number;
  suffix?: string;
  altSettlements?: string[];
  parents?: string[];
}

/** The stored index, plus the lookups built over it once. */
interface LoadedIndex {
  index: AddressIndex;
  /** Folded settlement name → the ids that bear it (names repeat). */
  byName: Map<string, string[]>;
  parentNames: Set<string>;
  settlementNames: Set<string>;
}

/** Per country: the index read once per session. The promise resolves to
 *  undefined when nothing is stored, which every caller reads as "this country
 *  has no local register". */
const indexes = new Map<RegisterCountry, Promise<LoadedIndex | undefined>>();

/** Buckets read this session, newest last. A village is asked about many times
 *  in a row — every house of it is its own row in the review list — so keeping
 *  the last few turns a whole place's lookup into one read. Ljubljana's bucket
 *  alone is a couple of MB, so the cache stays small. */
const bucketCache = new Map<string, AddressBucket | undefined>();
const BUCKET_CACHE_LIMIT = 12;

// --- Which registers are stored, synchronously ------------------------------
//
// The UI has to decide *while rendering* whether a row's register lookup needs
// the network, because that is what decides whether the online-lookups opt-in
// governs it. That cannot be awaited mid-render, so the answer is kept here as
// plain state, primed on load and refreshed whenever a register is imported or
// removed. Until the first read lands it says "no local register", which errs
// towards the old behaviour rather than towards offering a button that cannot
// yet answer.

let stored: ReadonlySet<RegisterCountry> = new Set();
const watchers = new Set<() => void>();

/** The countries whose address register is stored, as of the last read. A
 *  stable reference between changes, so it can back a `useSyncExternalStore`. */
export function localRegisters(): ReadonlySet<RegisterCountry> {
  return stored;
}

/** Watch {@link localRegisters} for changes. Returns the unsubscribe. */
export function watchLocalRegisters(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function setStored(next: Set<RegisterCountry>): void {
  if (next.size === stored.size && [...next].every((c) => stored.has(c))) return;
  stored = next;
  for (const fn of watchers) fn();
}

/**
 * Re-read what is stored, for the synchronous answer above.
 *
 * Each country on its own, and every failure swallowed: one unreadable register
 * must never hide a good one. It did once — Croatia's index, stored under an
 * older field name, threw inside this loop, so the whole thing rejected and
 * Slovenia was never registered as local either. Every address row then kept
 * its "search the register" button and nothing was looked up automatically,
 * with a perfectly good register sitting in the browser.
 */
async function refreshStored(): Promise<void> {
  const next = new Set<RegisterCountry>();
  for (const country of COUNTRIES) {
    try {
      if (await loadIndex(country)) next.add(country);
    } catch {
      // Not stored, as far as everything above is concerned.
    }
  }
  setStored(next);
}

const COUNTRIES: readonly RegisterCountry[] = ["SI", "HR"];

/** Drop everything cached — called when a register is imported or removed, so
 *  the next lookup sees what is actually stored. */
export function invalidateAddressRegisters(): void {
  indexes.clear();
  bucketCache.clear();
  void refreshStored();
}

function loadIndex(country: RegisterCountry): Promise<LoadedIndex | undefined> {
  let loading = indexes.get(country);
  if (!loading) {
    loading = getAddressIndex(country)
      .then((raw) => {
        // Read leniently: a register stored by an earlier version of this app is
        // worth far more than the field names it happens to use — see
        // readStoredIndex.
        const index = readStoredIndex(raw);
        if (!index) return undefined;
        const byName = new Map<string, string[]>();
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
          parentNames: new Set(index.parentNames.map(foldToken)),
          settlementNames: new Set([...byName.keys()]),
        };
      })
      // A store this cannot read is "no register here", never a throw. The
      // promise is cached, so a rejection would poison every later lookup of
      // the session as well as surfacing as an unhandled rejection — which is
      // exactly how a renamed field once broke the whole tool. Forgotten rather
      // than remembered, so a re-import gets a fresh attempt.
      .catch(() => {
        if (indexes.get(country) === loading) indexes.delete(country);
        return undefined;
      });
    indexes.set(country, loading);
  }
  return loading;
}

/** Whether a country's address register is stored, and what is in it. */
export async function addressRegisterInfo(
  country: RegisterCountry,
): Promise<{ count: number; importedAt: number } | undefined> {
  const loaded = await loadIndex(country);
  return loaded ? { count: loaded.index.count, importedAt: loaded.index.importedAt } : undefined;
}

async function bucketFor(country: RegisterCountry, id: string): Promise<AddressBucket | undefined> {
  const key = bucketKey(country, id);
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
  country: RegisterCountry,
  loaded: LoadedIndex,
  name: string,
  query: LocalQuery,
  opts?: { anyStreet?: boolean },
): Promise<AddressHit[]> {
  const ids = loaded.byName.get(foldToken(name));
  if (!ids?.length) return [];
  const hits: AddressHit[] = [];
  for (const id of ids) {
    const bucket = await bucketFor(country, id);
    if (bucket)
      hits.push(
        ...searchBucket(bucket, { number: query.number, suffix: query.suffix, street: query.street }, opts),
      );
  }
  return scopeToParents(hits, query.parents, loaded);
}

/**
 * Look one house up in a stored register, walking the same ladder the online
 * one is walked with: the settlement the file names, then — where that is worth
 * anything ({@link tryAlternates}) — the wider names it sits in, then the
 * "street" read as a settlement of its own, a hamlet a file files under its
 * bigger neighbour. The rungs *within* a settlement (street, then village
 * numbering, then — for a value naming no street — any street) are
 * {@link searchBucket}'s.
 *
 * Which is what makes the last rung here reachable at all: a named street the
 * settlement does not have answers nothing rather than some same-numbered house
 * on another street, so "Jama 35" written under Mavčiče falls through to naselje
 * Jama, where the house actually is.
 *
 * Resolves to [] when no register is stored for that country at all, so a
 * browser that has not downloaded one simply gets no local answer — never an
 * error.
 */
export async function searchLocalAddress(country: RegisterCountry, query: LocalQuery): Promise<AddressHit[]> {
  const loaded = await loadIndex(country);
  if (!loaded) return [];
  const own = await searchNamed(country, loaded, query.settlement, query);
  if (own.length) return own.slice(0, MAX_RESULTS);
  if (await tryAlternates(query, () => loaded.settlementNames.has(foldToken(query.settlement)))) {
    for (const name of query.altSettlements ?? []) {
      // A settlement the file never named gets the narrow reading only: no
      // street is guessed on top of the settlement already guessed.
      const hits = await searchNamed(country, loaded, name, query, { anyStreet: false });
      if (hits.length) return hits.slice(0, MAX_RESULTS);
    }
  }
  // The name the number hangs off, read as a village rather than a street.
  if (query.street) {
    const hits = await searchNamed(country, loaded, query.street, { ...query, street: undefined });
    if (hits.length) return hits.slice(0, MAX_RESULTS);
  }
  return [];
}

/** Whether a country's register is stored, without awaiting anything. */
export async function hasLocalRegister(country: RegisterCountry): Promise<boolean> {
  return !!(await loadIndex(country));
}

// Prime the synchronous answer as soon as this module is pulled in — two small
// IndexedDB reads, and every later render gets the truth.
void refreshStored();

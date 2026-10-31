import { buildFamily, buildIndividual, buildMediaLinks, buildNoteIndex, type MediaLinks, type NoteIndex } from "../builder";
import { buildSourceContext, buildSourceLookup, type SourceContext, type SourceLookup } from "../source";
import type { Dataset, Family, GedNode, Individual } from "../types";
import { reindexRecord } from "./pointerIndex";

const sourceCacheVersions = new WeakMap<GedNode[], number>();
const sourceCaches = new WeakMap<GedNode[], { version: number; media: MediaLinks; sourceCtx: SourceContext; noteIndex: NoteIndex }>();
const sourceLookupCaches = new WeakMap<GedNode[], { version: number; lookup: SourceLookup }>();

/**
 * Bump `records`' media/source cache version, forcing the next
 * `getMediaAndSourceCtx` call to recompute instead of reusing the cached
 * indexes. Call this from any helper that adds/removes a top-level
 * `SOUR`/`OBJE`/`REPO` record, or changes an existing `OBJE`'s `FILE` value
 * in place (the only ways the cached indexes can go stale, since `sourceIndex`
 * holds live node references and tolerates in-place field edits like a
 * `SOUR`'s `TITL`/`AUTH`/etc.).
 */
export function bumpSourceCacheVersion(records: GedNode[]): void {
  sourceCacheVersions.set(records, (sourceCacheVersions.get(records) ?? 0) + 1);
  bumpContentVersion(records);
}

const contentVersions = new WeakMap<GedNode[], number>();
const contentMemos = new WeakMap<GedNode[], Map<string, { stamp: string; value: unknown }>>();

/** Mark `records`' contents changed, for {@link memoOnContent}. Every typed
 *  rebuild and every source/media bump calls it, so an edit made through the
 *  edit helpers is always seen. */
export function bumpContentVersion(records: GedNode[]): void {
  contentVersions.set(records, (contentVersions.get(records) ?? 0) + 1);
}

/** A stamp of `records`' contents: changes with every rebuild, source/media
 *  bump and change of the record count. */
export function contentStamp(records: GedNode[]): string {
  return `${contentVersions.get(records) ?? 0}:${records.length}`;
}

/**
 * A whole-file derivation of `records` (a habit the file shows, an index),
 * reused until the file changes — a rebuilt person or family, a source/media
 * bump, a record added or removed. `key` names the derivation; `extra` adds
 * to the stamp what else it depends on (the other file of a merge).
 * The value is shared: callers must not mutate it.
 */
export function memoOnContent<T>(records: GedNode[], key: string, compute: () => T, extra = ""): T {
  const stamp = `${contentStamp(records)}|${extra}`;
  let memos = contentMemos.get(records);
  if (!memos) contentMemos.set(records, (memos = new Map()));
  const hit = memos.get(key);
  if (hit && hit.stamp === stamp) return hit.value as T;
  const value = compute();
  memos.set(key, { stamp, value });
  return value;
}

/**
 * Lazily (re)build the shared media-link/source-citation indexes for
 * `records`, reusing the cached pair unless `bumpSourceCacheVersion` marked
 * it stale since the last build. These indexes only depend on the dataset's
 * top-level `SOUR`/`OBJE`/`REPO` records, which most edits (a name, an event,
 * a note, …) never touch, so recomputing them from scratch on every commit
 * was pure wasted work scaling with the whole file's size.
 */
export function getMediaAndSourceCtx(records: GedNode[]): { media: MediaLinks; sourceCtx: SourceContext; noteIndex: NoteIndex } {
  const version = sourceCacheVersions.get(records) ?? 0;
  const cached = sourceCaches.get(records);
  if (cached && cached.version === version) return cached;
  const fresh = { version, media: buildMediaLinks(records), sourceCtx: buildSourceContext(records), noteIndex: buildNoteIndex(records) };
  sourceCaches.set(records, fresh);
  return fresh;
}

/**
 * The `findExistingSource` lookup for `records`, rebuilt lazily on the same
 * `bumpSourceCacheVersion` signal as the other indexes — so a hot loop (the
 * merge resolving one incoming link after another) pays one scan per actual
 * change to the source/media records instead of one scan per link. Kept out
 * of `getMediaAndSourceCtx` so ordinary commits never pay for it.
 */
export function getSourceLookup(records: GedNode[]): SourceLookup {
  const version = sourceCacheVersions.get(records) ?? 0;
  const cached = sourceLookupCaches.get(records);
  if (cached && cached.version === version) return cached.lookup;
  const fresh = { version, lookup: buildSourceLookup(records) };
  sourceLookupCaches.set(records, fresh);
  return fresh.lookup;
}

/**
 * Re-derive the typed `Individual` from its (mutated) raw node and store it
 * back in `dataset.individuals`. Cheaper than rebuilding the whole dataset.
 */
export function rebuildIndividual(dataset: Dataset, indi: Individual): Individual {
  const { media, sourceCtx, noteIndex } = getMediaAndSourceCtx(dataset.records);
  const rebuilt = buildIndividual(indi.raw, media, sourceCtx, noteIndex);
  dataset.individuals.set(rebuilt.id, rebuilt);
  bumpContentVersion(dataset.records);
  reindexRecord(dataset.records, indi.raw);
  return rebuilt;
}

/**
 * Re-derive the typed `Family` from its (mutated) raw node and store it back
 * in `dataset.families`. Cheaper than rebuilding the whole dataset.
 */
export function rebuildFamily(dataset: Dataset, fam: Family): Family {
  const { media, sourceCtx, noteIndex } = getMediaAndSourceCtx(dataset.records);
  const rebuilt = buildFamily(fam.raw, media, sourceCtx, noteIndex);
  dataset.families.set(rebuilt.id, rebuilt);
  bumpContentVersion(dataset.records);
  reindexRecord(dataset.records, fam.raw);
  return rebuilt;
}

/**
 * Re-derive the typed projections of every individual/family whose lines
 * point at one of `xrefs` under one of `tags` — text they copied from a shared
 * record (a note's, a source's title) is stale once that record is edited.
 * `skipId` is the owner the caller already rebuilds through its own commit.
 */
export function rebuildReferrers(dataset: Dataset, xrefs: Set<string>, tags: readonly string[], skipId?: string): void {
  if (!xrefs.size) return;
  const refers = (node: GedNode): boolean =>
    node.children.some((c) => (tags.includes(c.tag) && !!c.value && xrefs.has(c.value.trim())) || refers(c));
  for (const indi of dataset.individuals.values()) {
    if (indi.id !== skipId && refers(indi.raw)) rebuildIndividual(dataset, indi);
  }
  for (const fam of dataset.families.values()) {
    if (fam.id !== skipId && refers(fam.raw)) rebuildFamily(dataset, fam);
  }
}

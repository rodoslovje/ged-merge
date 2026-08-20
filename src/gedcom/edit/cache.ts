import { buildFamily, buildIndividual, buildMediaLinks, buildNoteIndex, type MediaLinks, type NoteIndex } from "../builder";
import { buildSourceContext, buildSourceLookup, type SourceContext, type SourceLookup } from "../source";
import type { Dataset, Family, GedNode, Individual } from "../types";

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
  return rebuilt;
}

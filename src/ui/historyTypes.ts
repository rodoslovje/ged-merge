import type { Dataset, Family, GedNode, Individual } from "../gedcom/types";
import { cloneNode } from "../gedcom/node";
import {
  bumpSourceCacheVersion,
  insertRecord,
  insertRecordAt,
  rebuildFamily,
  rebuildIndividual,
  rebuildNoteReferrers,
  type SharedNoteChange,
} from "../gedcom/edit";
import { clearObjeNodeCache } from "../gedcom/source";

export interface RecordPatch {
  /** "record" covers a top-level non-INDI/FAM record (e.g. a `SOUR`/`OBJE`
   * created or modified by "Add Source") — applied directly against
   * `dataset.records` by xref, with no typed map to update. */
  type: "individual" | "family" | "record";
  id: string;
  /** State before the action. null = this record was created by the action (undo removes it). */
  before: GedNode | null;
  /** State after the action. null = this record was deleted by the action (undo restores it). */
  after: GedNode | null;
  /** For deletion patches (`after: null`): the record's index in
   * `dataset.records` when `before` was captured, so undo can restore it at
   * its original position — keeping the serialized record order (and thus the
   * minimal-diff-against-the-original guarantee) intact. */
  index?: number;
  /** For `type: "record"` patches whose edit is surfaced through an owning
   * individual/family (e.g. a shared OBJE's metadata edited from a person's
   * media list): the owner whose dirty flag tracks this change. The owner's own
   * raw is untouched by such an edit, so undo/redo uses this to re-evaluate the
   * owner's dirty state instead of leaving it stuck. */
  owner?: { kind: "individual" | "family"; id: string };
  /** True when the change came from a whole-file maintenance pass (Normalize,
   * Naming, Geocoding, Health-check fixes, source organizing) rather than a
   * deliberate per-record act. A record whose only changes are mechanical keeps
   * its CHAN/`_UPD` change stamps at save time — a restatement or a gazetteer
   * coordinate is not new research, and stamping thousands of records on one
   * pass would erase the file's change history (see `useDirtyTracking`). */
  mechanical?: boolean;
}

/** Flag a maintenance batch's patches as mechanical (see the field above) —
 *  except creations: a record that did not exist before the pass gets its
 *  CHAN/CREA stamps whatever created it. Mutates and returns the array. */
export function markMechanical(patches: RecordPatch[]): RecordPatch[] {
  for (const p of patches) {
    if (p.before !== null) p.mechanical = true;
  }
  return patches;
}

export function cloneRaw(raw: GedNode): GedNode {
  return cloneNode(raw);
}

/** Undo/redo patches for shared `NOTE` records a note edit touched, surfaced
 *  through the individual/family the edit was made from (see `RecordPatch.owner`). */
export function noteChangePatches(
  changes: SharedNoteChange[],
  owner: { kind: "individual" | "family"; id: string },
): RecordPatch[] {
  return changes.map((c) => ({
    type: "record" as const,
    id: c.xref,
    before: c.before,
    after: c.after,
    ...(c.index !== undefined ? { index: c.index } : {}),
    owner,
  }));
}

export interface RecordSnapshots {
  individuals: Map<string, GedNode>;
  families: Map<string, GedNode>;
  /** Position of each snapshotted record in `dataset.records` at snapshot time. */
  indices: Map<string, number>;
}

/**
 * Snapshot the raw trees of the given individuals/families before a mutating
 * operation. Pair with `patchesFromSnapshots` afterwards to capture every
 * record the operation touched — including cascades the caller can't enumerate
 * up front, e.g. deleting a person prunes a family that drops below two
 * members, which in turn unlinks that family's sole surviving member. Ids not
 * present in the dataset are skipped.
 */
export function snapshotRecords(
  dataset: Dataset,
  indiIds: Iterable<string>,
  famIds: Iterable<string>,
): RecordSnapshots {
  const individuals = new Map<string, GedNode>();
  const families = new Map<string, GedNode>();
  for (const id of indiIds) {
    const indi = dataset.individuals.get(id);
    if (indi) individuals.set(id, cloneRaw(indi.raw));
  }
  for (const id of famIds) {
    const fam = dataset.families.get(id);
    if (fam) families.set(id, cloneRaw(fam.raw));
  }
  const indices = new Map<string, number>();
  dataset.records.forEach((r, i) => {
    if (r.xref && (individuals.has(r.xref) || families.has(r.xref))) indices.set(r.xref, i);
  });
  return { individuals, families, indices };
}

/**
 * Diff the post-operation dataset against `before`, emitting a `RecordPatch`
 * for every snapshotted record that was removed (`after: null`) or whose raw
 * tree changed. Records left untouched produce no patch.
 */
/**
 * Merge sequential patches of one record into a single patch — the first
 * patch's `before`, the last one's `after`. A batch that touches a record
 * twice (a rename, then a coordinate onto the renamed value) must undo to the
 * FIRST before; applied as-is, the later patch's `before` — the half-done
 * state — would win, and undo would stop halfway.
 */
export function coalescePatches(patches: RecordPatch[]): RecordPatch[] {
  const byKey = new Map<string, RecordPatch>();
  const merged: RecordPatch[] = [];
  for (const p of patches) {
    const key = `${p.type}:${p.id}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.after = p.after;
      if (p.after === null && p.index !== undefined) prev.index = p.index;
      // The merged patch is mechanical only if every constituent was.
      if (!p.mechanical) delete prev.mechanical;
    } else {
      const copy = { ...p };
      byKey.set(key, copy);
      merged.push(copy);
    }
  }
  return merged;
}

/**
 * Drop patches that record no change (before and after deeply equal). Such a
 * patch carries no information — undo would reapply the identical tree — but
 * left in a batch it falsely marks its record dirty, lands a CHAN stamp on an
 * untouched record at save time, and makes the file disagree with its own
 * change report. Creation (`before: null`) and deletion (`after: null`)
 * patches always stand.
 */
export function dropNoopPatches(patches: RecordPatch[]): RecordPatch[] {
  return patches.filter(
    (p) => !(p.before && p.after && JSON.stringify(p.before) === JSON.stringify(p.after)),
  );
}

export function patchesFromSnapshots(dataset: Dataset, before: RecordSnapshots): RecordPatch[] {
  const patches: RecordPatch[] = [];
  const diff = (type: "individual" | "family", id: string, beforeRaw: GedNode, currentRaw: GedNode | undefined) => {
    const after = currentRaw ? cloneRaw(currentRaw) : null;
    if (after && JSON.stringify(after) === JSON.stringify(beforeRaw)) return;
    const patch: RecordPatch = { type, id, before: beforeRaw, after };
    if (after === null) {
      const index = before.indices.get(id);
      if (index !== undefined) patch.index = index;
    }
    patches.push(patch);
  };
  for (const [id, raw] of before.individuals) diff("individual", id, raw, dataset.individuals.get(id)?.raw);
  for (const [id, raw] of before.families) diff("family", id, raw, dataset.families.get(id)?.raw);
  return patches;
}

/**
 * Apply a patch batch to the dataset in one direction — `"undo"` puts every
 * record back to its `before`, `"redo"` to its `after` — keeping the typed
 * maps in step. Undo/redo use it, and so does an action that builds its
 * patches first and then applies them forward. Returns whether a shared `NOTE`
 * record was among them, whose referrers' editors must re-read it.
 */
export function applyRecordPatches(dataset: Dataset, patches: RecordPatch[], direction: "undo" | "redo"): boolean {
  const pick: "before" | "after" = direction === "undo" ? "before" : "after";
  // First pass: remove records that need to go away.
  for (const patch of patches) {
    if (patch[pick] === null) {
      const ri = dataset.records.findIndex((r) => r.xref === patch.id);
      if (ri !== -1) dataset.records.splice(ri, 1);
      if (patch.type === "individual") dataset.individuals.delete(patch.id);
      else if (patch.type === "family") dataset.families.delete(patch.id);
      else if (patch.type === "record") { bumpSourceCacheVersion(dataset.records); clearObjeNodeCache(dataset.records); }
    }
  }
  // Second pass: restore or re-add generic top-level records (e.g. a
  // SOUR/OBJE created or pruned by "Add Source") *before* any
  // individual/family rebuild below — that rebuild re-resolves source
  // citations via getMediaAndSourceCtx(dataset.records) (each iteration here
  // also bumps its cache, so the rebuild can't reuse a stale pre-undo
  // version), so a SOUR/OBJE this same batch touched must already be back
  // in place, or a citation pointer resolves dangling (no title/url) until
  // the next edit.
  for (const patch of patches) {
    if (patch.type !== "record") continue;
    const target = patch[pick];
    if (target === null) continue;
    const restored = cloneRaw(target);
    const existing = dataset.records.find((r) => r.xref === patch.id);
    if (existing) {
      existing.value = restored.value;
      existing.children = restored.children;
    } else {
      insertRecord(dataset.records, restored);
    }
    // A SOUR/OBJE this patch touches may now have a different FILE value or
    // existence than `getMediaAndSourceCtx`'s cache last saw.
    bumpSourceCacheVersion(dataset.records);
    clearObjeNodeCache(dataset.records);
  }
  // Third pass: restore individual/family records and rebuild them. Sorted by
  // original position so re-added records (undo of a deletion) land back at
  // their original indices — inserting ascending keeps every later index valid.
  const byPosition = [...patches].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity));
  for (const patch of byPosition) {
    const target = patch[pick];
    if (target === null) continue;
    const restored = cloneRaw(target);
    if (patch.type === "individual") {
      const existing = dataset.individuals.get(patch.id);
      if (existing) {
        existing.raw.value = restored.value;
        existing.raw.children = restored.children;
        rebuildIndividual(dataset, existing);
      } else {
        insertRecordAt(dataset.records, restored, patch.index);
        rebuildIndividual(dataset, { raw: restored } as Individual);
      }
    } else if (patch.type === "family") {
      const existing = dataset.families.get(patch.id);
      if (existing) {
        existing.raw.value = restored.value;
        existing.raw.children = restored.children;
        rebuildFamily(dataset, existing);
      } else {
        insertRecordAt(dataset.records, restored, patch.index);
        rebuildFamily(dataset, { raw: restored } as Family);
      }
    }
  }
  // Shared NOTE records restored above: referrers other than the patched
  // owner still project the pre-undo text — refresh them.
  const noteChanges = patches
    .filter((p) => p.type === "record" && (p.before ?? p.after)?.tag === "NOTE")
    .map((p) => ({ xref: p.id }));
  if (noteChanges.length) rebuildNoteReferrers(dataset, noteChanges);
  return noteChanges.length > 0;
}

/** Queued by App.tsx after an undo/redo; consumed by EditView once it is mounted. */
export interface PendingEditApply {
  patches: RecordPatch[];
  direction: "undo" | "redo";
  navigateTo?: string;
  redoNavigateTo?: string;
}

import type { Dataset, GedNode } from "../gedcom/types";
import { cloneNode } from "../gedcom/node";
import type { SharedNoteChange } from "../gedcom/edit";

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
    } else {
      const copy = { ...p };
      byKey.set(key, copy);
      merged.push(copy);
    }
  }
  return merged;
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

/** Queued by App.tsx after an undo/redo; consumed by EditView once it is mounted. */
export interface PendingEditApply {
  patches: RecordPatch[];
  direction: "undo" | "redo";
  navigateTo?: string;
  redoNavigateTo?: string;
}

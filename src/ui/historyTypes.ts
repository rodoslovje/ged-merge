import type { Dataset, GedNode } from "../gedcom/types";
import { cloneNode } from "../gedcom/node";

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
}

export function cloneRaw(raw: GedNode): GedNode {
  return cloneNode(raw);
}

export interface RecordSnapshots {
  individuals: Map<string, GedNode>;
  families: Map<string, GedNode>;
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
  return { individuals, families };
}

/**
 * Diff the post-operation dataset against `before`, emitting a `RecordPatch`
 * for every snapshotted record that was removed (`after: null`) or whose raw
 * tree changed. Records left untouched produce no patch.
 */
export function patchesFromSnapshots(dataset: Dataset, before: RecordSnapshots): RecordPatch[] {
  const patches: RecordPatch[] = [];
  const diff = (type: "individual" | "family", id: string, beforeRaw: GedNode, currentRaw: GedNode | undefined) => {
    const after = currentRaw ? cloneRaw(currentRaw) : null;
    if (after && JSON.stringify(after) === JSON.stringify(beforeRaw)) return;
    patches.push({ type, id, before: beforeRaw, after });
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

import type { GedNode } from "../gedcom/types";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";

export type RecordKind = "individual" | "family";

export type DirtyOp =
  | { action: "add"; kind: RecordKind; id: string }
  | { action: "remove"; kind: RecordKind; id: string };

export type SnapshotOp =
  | { action: "set"; kind: RecordKind; id: string; value: GedNode }
  | { action: "delete"; kind: RecordKind; id: string };

export interface PatchApplyOps {
  dirty: DirtyOp[];
  snapshots: SnapshotOp[];
}

/** Structural equality for GedNode trees — more robust than JSON.stringify. */
export function nodesEqual(a: GedNode, b: GedNode): boolean {
  return (
    a.tag === b.tag &&
    a.value === b.value &&
    a.xref === b.xref &&
    a.children.length === b.children.length &&
    a.children.every((c, i) => nodesEqual(c, b.children[i]))
  );
}

/**
 * Compute the dirty-state changes implied by applying a set of undo/redo patches.
 * Returns which record ids to add/remove from the dirty set and which snapshots
 * to create/delete — pure, so the calling hook can apply the ops to React state.
 *
 * Cases per patch (in order):
 *  A  appliedState === null    → record disappears → clear dirty + clear snapshot
 *  B  redo + before === null   → redo of creation  → add dirty (new record)
 *  C  current == snapshot      → fully reverted    → clear dirty + clear snapshot
 *  D  redo of modification     → add dirty; restore missing snapshot from before
 *  E  undo, not fully reverted → add dirty
 */
export function computePatchApplyOps(
  patches: RecordPatch[],
  direction: "undo" | "redo",
  getSnapshot: (kind: RecordKind, id: string) => GedNode | undefined,
  getCurrentRaw: (kind: RecordKind, id: string) => GedNode | undefined,
): PatchApplyOps {
  const dirty: DirtyOp[] = [];
  const snapshots: SnapshotOp[] = [];

  for (const patch of patches) {
    if (patch.type === "record") continue;
    const kind = patch.type;
    const { id, before, after } = patch;
    const appliedState = direction === "undo" ? before : after;

    // A: undo of creation or redo of deletion — record now gone.
    if (appliedState === null) {
      snapshots.push({ action: "delete", kind, id });
      dirty.push({ action: "remove", kind, id });
      continue;
    }

    // B: redo of creation — record re-appears; it has no pre-edit snapshot.
    if (direction === "redo" && before === null) {
      dirty.push({ action: "add", kind, id });
      continue;
    }

    const snapshot = getSnapshot(kind, id);
    const current = getCurrentRaw(kind, id);

    // C: record matches its pre-edit snapshot — fully reverted.
    if (snapshot !== undefined && current !== undefined && nodesEqual(current, snapshot)) {
      snapshots.push({ action: "delete", kind, id });
      dirty.push({ action: "remove", kind, id });
      continue;
    }

    // D: redo of modification — still dirty; restore snapshot cleared by a prior undo.
    if (direction === "redo") {
      dirty.push({ action: "add", kind, id });
      if (snapshot === undefined && before !== null) {
        snapshots.push({ action: "set", kind, id, value: cloneRaw(before) });
      }
      continue;
    }

    // E: undo, record still exists but not back to its original state.
    dirty.push({ action: "add", kind, id });
  }

  return { dirty, snapshots };
}

/**
 * Compute which snapshots to capture when an edit is pushed onto the undo stack.
 * Only captures the first time each record becomes dirty (patch.before is the
 * true pre-edit baseline), so all subsequent edits stack on top without overwriting it.
 */
export function computePushCaptureOps(
  patches: RecordPatch[],
  hasSnapshot: (kind: RecordKind, id: string) => boolean,
): Array<{ kind: RecordKind; id: string; value: GedNode }> {
  const ops: Array<{ kind: RecordKind; id: string; value: GedNode }> = [];
  for (const patch of patches) {
    if (patch.type === "record" || patch.before === null) continue;
    const kind = patch.type;
    if (!hasSnapshot(kind, patch.id)) {
      ops.push({ kind, id: patch.id, value: cloneRaw(patch.before) });
    }
  }
  return ops;
}

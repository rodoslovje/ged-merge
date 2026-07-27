import type { GedNode } from "../gedcom/types";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";

export type RecordKind = "individual" | "family";

/** Snapshot maps also cover top-level shared records (SOUR/OBJE) edited via a
 * `type: "record"` patch — keyed the same way, under the "record" kind. */
export type SnapshotKind = RecordKind | "record";

export type DirtyOp =
  | { action: "add"; kind: SnapshotKind; id: string }
  | { action: "remove"; kind: SnapshotKind; id: string };

export type SnapshotOp =
  | { action: "set"; kind: SnapshotKind; id: string; value: GedNode; owner?: { kind: RecordKind; id: string } }
  | { action: "delete"; kind: SnapshotKind; id: string };

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
 * Cases per individual/family patch (in order):
 *  A  appliedState === null    → record disappears → clear dirty + clear snapshot
 *  B  redo + before === null   → redo of creation  → add dirty (new record)
 *  C  current == snapshot      → fully reverted    → clear dirty + clear snapshot
 *  D  redo of modification     → add dirty; restore missing snapshot from before
 *  E  undo, not fully reverted → add dirty
 *
 * A `type: "record"` patch with an `owner` (a shared SOUR/OBJE edited from a
 * person's/family's card — the owner's own raw is untouched) re-evaluates the
 * owner's dirty flag instead: back to the record's pre-edit snapshot → clear the
 * owner (unless the owner has direct edits of its own, is a session-created
 * record with no snapshot, or still has another modified shared record);
 * otherwise keep/mark the owner dirty. A record patch *without* an owner (a
 * Tools fix editing a SOUR/OBJE in its own right) carries its own dirty flag
 * under the "record" kind, following the same C/D/E cases.
 */
export function computePatchApplyOps(
  patches: RecordPatch[],
  direction: "undo" | "redo",
  getSnapshot: (kind: SnapshotKind, id: string) => GedNode | undefined,
  getCurrentRaw: (kind: SnapshotKind, id: string) => GedNode | undefined,
  /** Whether another shared-record snapshot (excluding `excludeId`) is owned by
   * this owner — i.e. the owner may still carry a different shared-record edit. */
  hasOtherOwnedRecordSnapshot: (owner: { kind: RecordKind; id: string }, excludeId: string) => boolean = () => false,
): PatchApplyOps {
  const dirty: DirtyOp[] = [];
  const snapshots: SnapshotOp[] = [];

  for (const patch of patches) {
    const { id, before, after } = patch;
    const appliedState = direction === "undo" ? before : after;

    if (patch.type === "record") {
      const owner = patch.owner;
      // Shared record removed (undo of creation / redo of deletion): drop its
      // snapshot. Owner dirtiness is carried by the owner's own patch in the
      // same batch (the pointer add/remove), so nothing to decide here.
      if (appliedState === null) {
        snapshots.push({ action: "delete", kind: "record", id });
        dirty.push({ action: "remove", kind: "record", id });
        continue;
      }

      const recSnapshot = getSnapshot("record", id);
      const recCurrent = getCurrentRaw("record", id);
      const reverted = recSnapshot !== undefined && recCurrent !== undefined && nodesEqual(recCurrent, recSnapshot);

      if (!owner) {
        // Standalone shared-record edit: the record is its own dirty subject.
        if (reverted) {
          snapshots.push({ action: "delete", kind: "record", id });
          dirty.push({ action: "remove", kind: "record", id });
        } else {
          dirty.push({ action: "add", kind: "record", id });
          // Mirror case D: restore a record snapshot a prior undo deleted.
          if (direction === "redo" && recSnapshot === undefined && before !== null) {
            snapshots.push({ action: "set", kind: "record", id, value: cloneRaw(before) });
          }
        }
        continue;
      }

      if (reverted) {
        snapshots.push({ action: "delete", kind: "record", id });
        // Clear the owner only when nothing else keeps it dirty: its own raw is
        // back at its snapshot (a missing owner snapshot means a session-created
        // owner, which must stay dirty) and no other edited shared record points
        // at it.
        const ownerSnap = getSnapshot(owner.kind, owner.id);
        const ownerCurrent = getCurrentRaw(owner.kind, owner.id);
        const ownerClean = ownerSnap !== undefined && ownerCurrent !== undefined && nodesEqual(ownerCurrent, ownerSnap);
        if (ownerClean && !hasOtherOwnedRecordSnapshot(owner, id)) {
          dirty.push({ action: "remove", kind: owner.kind, id: owner.id });
        }
      } else {
        dirty.push({ action: "add", kind: owner.kind, id: owner.id });
        // Mirror case D: restore a record snapshot a prior undo deleted.
        if (direction === "redo" && recSnapshot === undefined && before !== null) {
          snapshots.push({ action: "set", kind: "record", id, value: cloneRaw(before), owner });
        }
      }
      continue;
    }

    const kind = patch.type;

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

export interface PushCaptureOp {
  kind: SnapshotKind;
  id: string;
  value: GedNode;
  owner?: { kind: RecordKind; id: string };
}

/**
 * Compute which snapshots to capture when an edit is pushed onto the undo stack.
 * Only captures the first time each record becomes dirty (patch.before is the
 * true pre-edit baseline), so all subsequent edits stack on top without overwriting it.
 * Shared-record (`type: "record"`) patches with a pre-edit state are captured too,
 * so undo/redo can tell when the shared record is back to its original.
 */
export function computePushCaptureOps(
  patches: RecordPatch[],
  hasSnapshot: (kind: SnapshotKind, id: string) => boolean,
): PushCaptureOp[] {
  const ops: PushCaptureOp[] = [];
  for (const patch of patches) {
    if (patch.before === null) continue;
    const kind: SnapshotKind = patch.type;
    if (hasSnapshot(kind, patch.id) || ops.some((o) => o.kind === kind && o.id === patch.id)) continue;
    const op: PushCaptureOp = { kind, id: patch.id, value: cloneRaw(patch.before) };
    if (patch.type === "record" && patch.owner) op.owner = patch.owner;
    ops.push(op);
  }
  return ops;
}

/**
 * Whether `markDirty` should capture a first-dirty fallback snapshot for this
 * record: only when none exists yet AND the record pre-exists the session
 * baseline. A session-created record must stay snapshot-less — with a snapshot
 * of its creation state, undoing a later edit on it would look "fully reverted"
 * (case C above) and wrongly clear the still-unsaved new record from the dirty
 * set (dropping it from the save report and count).
 */
export function shouldCaptureFallbackSnapshot(hasSnapshot: boolean, isLoaded: boolean): boolean {
  return !hasSnapshot && isLoaded;
}

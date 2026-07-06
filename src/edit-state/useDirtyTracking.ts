import { useRef, useState } from "react";
import type { GedNode, Dataset } from "../gedcom/types";
import type { RecordPatch } from "../ui/historyTypes";
import { cloneRaw } from "../ui/historyTypes";
import {
  computePatchApplyOps,
  computePushCaptureOps,
  type DirtyOp,
  type RecordKind,
  type SnapshotOp,
} from "./dirty";

export function useDirtyTracking() {
  const [changedPersonIds, setChangedPersonIds] = useState<Set<string>>(new Set());
  const [changedFamilyIds, setChangedFamilyIds] = useState<Set<string>>(new Set());

  // IDs present at load time — used to distinguish "modified existing" from
  // "newly added" when reverting via Remove from save.
  const loadedPersonIds = useRef<Set<string>>(new Set());
  const loadedFamilyIds = useRef<Set<string>>(new Set());

  // Raw-node snapshots taken at first-dirty time, used to detect when a record
  // has returned to its pre-edit state and to revert Remove from save.
  const personSnapshots = useRef<Map<string, GedNode>>(new Map());
  const familySnapshots = useRef<Map<string, GedNode>>(new Map());

  // ── kind-keyed helpers (collapse individual/family duplication) ───────────

  function snapshotsFor(kind: RecordKind) {
    return kind === "individual" ? personSnapshots : familySnapshots;
  }

  function setChangedFor(kind: RecordKind) {
    return kind === "individual" ? setChangedPersonIds : setChangedFamilyIds;
  }

  function applyOps(dirtyOps: DirtyOp[], snapshotOps: SnapshotOp[]) {
    for (const op of snapshotOps) {
      if (op.action === "set") snapshotsFor(op.kind).current.set(op.id, op.value);
      else snapshotsFor(op.kind).current.delete(op.id);
    }
    for (const op of dirtyOps) {
      const setChanged = setChangedFor(op.kind);
      if (op.action === "add") {
        setChanged((prev) => (prev.has(op.id) ? prev : new Set(prev).add(op.id)));
      } else {
        setChanged((prev) => {
          const next = new Set(prev);
          next.delete(op.id);
          return next;
        });
      }
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Mark a record dirty from a direct Edit-mode mutation (the `onDirty` path).
   *  Captures the pre-edit snapshot the first time a record becomes dirty —
   *  fallback only; `captureSnapshotsForPush` covers the normal patch path. */
  function markDirty(kind: RecordKind, id: string, dataset: Dataset) {
    const snaps = snapshotsFor(kind);
    if (!snaps.current.has(id)) {
      const raw =
        kind === "individual"
          ? dataset.individuals.get(id)?.raw
          : dataset.families.get(id)?.raw;
      if (raw) snaps.current.set(id, cloneRaw(raw));
    }
    setChangedFor(kind)((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }

  /** Capture first-dirty snapshots when an edit patch is pushed to the undo
   *  stack. Uses `patch.before` (the true pre-edit state), which is correct
   *  even if `onDirty` was never called or fires after the mutation. */
  function captureSnapshotsForPush(patches: RecordPatch[]) {
    const ops = computePushCaptureOps(patches, (kind, id) =>
      snapshotsFor(kind).current.has(id),
    );
    for (const op of ops) snapshotsFor(op.kind).current.set(op.id, op.value);
  }

  /** Update dirty/snapshot state after EditView applies undo/redo patches.
   *  Must be called after the patches are applied to `dataset`. */
  function onPatchApplied(
    patches: RecordPatch[],
    direction: "undo" | "redo",
    dataset: Dataset,
  ) {
    const { dirty, snapshots } = computePatchApplyOps(
      patches,
      direction,
      (kind, id) => snapshotsFor(kind).current.get(id),
      (kind, id) =>
        kind === "individual"
          ? dataset.individuals.get(id)?.raw
          : dataset.families.get(id)?.raw,
    );
    applyOps(dirty, snapshots);
  }

  /** Remove a record from the dirty set while keeping its snapshot (e.g. after
   *  Remove from save reverts it, but undo still needs to know the original). */
  function removeDirty(kind: RecordKind, id: string) {
    setChangedFor(kind)((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  /** Clear dirty state immediately when a new main file starts loading (before
   *  the parsed dataset is available). The loaded IDs are populated later by
   *  `resetOnLoad` once parsing completes. */
  function prepareForLoad() {
    loadedPersonIds.current = new Set();
    loadedFamilyIds.current = new Set();
    personSnapshots.current = new Map();
    familySnapshots.current = new Map();
    setChangedPersonIds(new Set());
    setChangedFamilyIds(new Set());
  }

  /** Reset all tracking state on main file load. */
  function resetOnLoad(dataset: Dataset) {
    loadedPersonIds.current = new Set(dataset.individuals.keys());
    loadedFamilyIds.current = new Set(dataset.families.keys());
    personSnapshots.current = new Map();
    familySnapshots.current = new Map();
    setChangedPersonIds(new Set());
    setChangedFamilyIds(new Set());
  }

  /** Restore tracking state cached from a previous session (IndexedDB hydrate).
   *  Used instead of {@link resetOnLoad} when the re-parsed main is the edited
   *  serialization, so the pre-edit snapshots and changed-id sets line up with it. */
  function hydrate(state: {
    loadedPersonIds: string[];
    loadedFamilyIds: string[];
    changedPersonIds: string[];
    changedFamilyIds: string[];
    personSnapshots: [string, GedNode][];
    familySnapshots: [string, GedNode][];
  }) {
    loadedPersonIds.current = new Set(state.loadedPersonIds);
    loadedFamilyIds.current = new Set(state.loadedFamilyIds);
    personSnapshots.current = new Map(state.personSnapshots);
    familySnapshots.current = new Map(state.familySnapshots);
    setChangedPersonIds(new Set(state.changedPersonIds));
    setChangedFamilyIds(new Set(state.changedFamilyIds));
  }

  /** Snapshot the current tracking state for persistence. */
  function serialize() {
    return {
      loadedPersonIds: [...loadedPersonIds.current],
      loadedFamilyIds: [...loadedFamilyIds.current],
      changedPersonIds: [...changedPersonIds],
      changedFamilyIds: [...changedFamilyIds],
      personSnapshots: [...personSnapshots.current] as [string, GedNode][],
      familySnapshots: [...familySnapshots.current] as [string, GedNode][],
    };
  }

  /** Advance the baseline after a successful save — the saved file becomes the
   *  new original, so all dirty tracking and snapshots start fresh. */
  function resetOnSave(dataset: Dataset) {
    loadedPersonIds.current = new Set(dataset.individuals.keys());
    loadedFamilyIds.current = new Set(dataset.families.keys());
    personSnapshots.current = new Map();
    familySnapshots.current = new Map();
    setChangedPersonIds(new Set());
    setChangedFamilyIds(new Set());
  }

  return {
    // state
    changedPersonIds,
    changedFamilyIds,
    // refs (exposed for handleRemoveFromSave which needs to read/check them)
    loadedPersonIds,
    loadedFamilyIds,
    personSnapshots,
    familySnapshots,
    // actions
    markDirty,
    captureSnapshotsForPush,
    onPatchApplied,
    removeDirty,
    prepareForLoad,
    resetOnLoad,
    resetOnSave,
    hydrate,
    serialize,
  };
}

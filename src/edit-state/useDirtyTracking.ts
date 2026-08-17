import { useRef, useState } from "react";
import type { GedNode, Dataset } from "../gedcom/types";
import type { RecordPatch } from "../ui/historyTypes";
import { cloneRaw } from "../ui/historyTypes";
import { nodesEqual } from "../gedcom/node";
import { captureBaseline, type SaveBaseline } from "../gedcom/fingerprint";
import { displayName } from "../match/relatives";
import {
  computePatchApplyOps,
  computePushCaptureOps,
  computePushDirtyOps,
  shouldCaptureFallbackSnapshot,
  type DirtyOp,
  type RecordKind,
  type SnapshotKind,
  type SnapshotOp,
} from "./dirty";

/** First-dirty snapshot of a top-level shared record (SOUR/OBJE) edited via a
 * `type: "record"` patch, plus the owner whose dirty flag surfaced that edit. */
export interface SharedRecordSnapshot {
  value: GedNode;
  owner?: { kind: RecordKind; id: string };
}

export function useDirtyTracking() {
  const [changedPersonIds, setChangedPersonIds] = useState<Set<string>>(new Set());
  const [changedFamilyIds, setChangedFamilyIds] = useState<Set<string>>(new Set());
  // Top-level shared records (SOUR/OBJE/NOTE) edited in their own right rather
  // than through a person's card — a Tools fix repairing dates on SOUR records,
  // say. Without this they'd change the file with nothing marked unsaved, so no
  // Save would be offered. Owner-attributed edits stay on the owner's flag.
  const [changedRecordIds, setChangedRecordIds] = useState<Set<string>>(new Set());

  // IDs present at load time — used to distinguish "modified existing" from
  // "newly added" when reverting via Remove from save.
  const loadedPersonIds = useRef<Set<string>>(new Set());
  const loadedFamilyIds = useRef<Set<string>>(new Set());

  // One fingerprint per record as the file arrived (or as it was last saved),
  // so the save can audit its own report against what it is about to write —
  // see `gedcom/fingerprint.ts`. Held alongside the dirty state because it is
  // reset by exactly the same events.
  const baseline = useRef<SaveBaseline>(new Map());

  // Raw-node snapshots taken at first-dirty time, used to detect when a record
  // has returned to its pre-edit state and to revert Remove from save.
  const personSnapshots = useRef<Map<string, GedNode>>(new Map());
  const familySnapshots = useRef<Map<string, GedNode>>(new Map());
  // Same, for shared top-level records (SOUR/OBJE) edited through an owner card.
  const recordSnapshots = useRef<Map<string, SharedRecordSnapshot>>(new Map());

  // ── kind-keyed helpers (collapse individual/family duplication) ───────────

  function snapshotsFor(kind: RecordKind) {
    return kind === "individual" ? personSnapshots : familySnapshots;
  }

  function loadedIdsFor(kind: RecordKind) {
    return kind === "individual" ? loadedPersonIds : loadedFamilyIds;
  }

  function setChangedFor(kind: SnapshotKind) {
    if (kind === "record") return setChangedRecordIds;
    return kind === "individual" ? setChangedPersonIds : setChangedFamilyIds;
  }

  function getSnapshot(kind: SnapshotKind, id: string): GedNode | undefined {
    if (kind === "record") return recordSnapshots.current.get(id)?.value;
    return snapshotsFor(kind).current.get(id);
  }

  function hasSnapshot(kind: SnapshotKind, id: string): boolean {
    if (kind === "record") return recordSnapshots.current.has(id);
    return snapshotsFor(kind).current.has(id);
  }

  function applyOps(dirtyOps: DirtyOp[], snapshotOps: SnapshotOp[]) {
    for (const op of snapshotOps) {
      if (op.kind === "record") {
        if (op.action === "set") recordSnapshots.current.set(op.id, { value: op.value, owner: op.owner });
        else recordSnapshots.current.delete(op.id);
      } else if (op.action === "set") {
        snapshotsFor(op.kind).current.set(op.id, op.value);
      } else {
        snapshotsFor(op.kind).current.delete(op.id);
      }
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

  /** Re-fingerprint the whole file as the baseline every later save is audited
   *  against. One pass over the records, at the three moments the baseline
   *  really moves: a file loads, a save lands, a cached session is restored. */
  function takeBaseline(dataset: Dataset) {
    const nameOf = (id: string | undefined) => {
      const indi = id ? dataset.individuals.get(id) : undefined;
      return indi ? displayName(indi.names[0]) : undefined;
    };
    baseline.current = captureBaseline(dataset, nameOf, (id) => {
      const fam = dataset.families.get(id);
      if (!fam) return undefined;
      return [nameOf(fam.husband), nameOf(fam.wife)].filter(Boolean).join(" + ") || undefined;
    });
  }

  // ── public API ────────────────────────────────────────────────────────────

  /** Mark a record dirty from a direct Edit-mode mutation (the `onDirty` path).
   *  Captures the pre-edit snapshot the first time a *pre-existing* record
   *  becomes dirty — fallback only; `captureSnapshotsForPush` covers the normal
   *  patch path. Session-created records stay snapshot-less (see
   *  {@link shouldCaptureFallbackSnapshot}). */
  function markDirty(kind: RecordKind, id: string, dataset: Dataset) {
    const snaps = snapshotsFor(kind);
    if (shouldCaptureFallbackSnapshot(snaps.current.has(id), loadedIdsFor(kind).current.has(id))) {
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
   *  even if `onDirty` was never called or fires after the mutation. Also
   *  flags standalone shared records (a SOUR/OBJE/REPO an Add Source created,
   *  say) as their own dirty subject — the flag, not the audit, is what keeps
   *  them in the save report across a cached-session restore. */
  function captureSnapshotsForPush(patches: RecordPatch[]) {
    const ops = computePushCaptureOps(patches, hasSnapshot);
    for (const op of ops) {
      if (op.kind === "record") recordSnapshots.current.set(op.id, { value: op.value, owner: op.owner });
      else snapshotsFor(op.kind).current.set(op.id, op.value);
    }
    // After the captures: a session-created record's deletion drops the
    // snapshot the loop above just took from the deletion patch's `before`.
    const { dirty, snapshots } = computePushDirtyOps(
      patches,
      (kind, id) => (kind === "record" ? baseline.current.has(id) : loadedIdsFor(kind).current.has(id)),
    );
    applyOps(dirty, snapshots);
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
      getSnapshot,
      (kind, id) => {
        if (kind === "record") return dataset.records.find((r) => r.xref === id);
        return kind === "individual"
          ? dataset.individuals.get(id)?.raw
          : dataset.families.get(id)?.raw;
      },
      (owner, excludeId) => {
        for (const [id, snap] of recordSnapshots.current) {
          if (id === excludeId) continue;
          if (snap.owner && snap.owner.kind === owner.kind && snap.owner.id === owner.id) return true;
        }
        return false;
      },
      // A shared record has no loaded-id set of its own; the baseline knows
      // every record the file arrived with, which is the same question.
      (kind, id) => (kind === "record" ? baseline.current.has(id) : loadedIdsFor(kind).current.has(id)),
    );
    applyOps(dirty, snapshots);
  }

  /**
   * Re-decide whether a record still counts as changed, and return whether it
   * does. For an edit that can undo an earlier one within the session — the
   * second parent of a child dissolves the stub family the first one made, and
   * takes back the pointer it put on that first parent — leaving the flag set
   * would mark a record as unsaved that the file will receive exactly as it
   * was.
   *
   * Only safe once the mutation is complete: `markDirty` deliberately does not
   * do this, because callers may mark a record before touching it, and a check
   * there would read the state as unchanged and drop a real edit.
   */
  function reconcile(kind: RecordKind, id: string, dataset: Dataset): boolean {
    const raw = kind === "individual" ? dataset.individuals.get(id)?.raw : dataset.families.get(id)?.raw;
    const snaps = snapshotsFor(kind);
    if (!raw) {
      // A record the file never had leaves nothing behind when it goes; a
      // loaded one going missing is itself the change.
      if (loadedIdsFor(kind).current.has(id)) {
        markDirty(kind, id, dataset);
        return true;
      }
      snaps.current.delete(id);
      removeDirty(kind, id);
      return false;
    }
    const snapshot = snaps.current.get(id);
    if (snapshot && nodesEqual(raw, snapshot)) {
      snaps.current.delete(id);
      removeDirty(kind, id);
      return false;
    }
    markDirty(kind, id, dataset);
    return true;
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
    baseline.current = new Map();
    personSnapshots.current = new Map();
    familySnapshots.current = new Map();
    recordSnapshots.current = new Map();
    setChangedPersonIds(new Set());
    setChangedFamilyIds(new Set());
    setChangedRecordIds(new Set());
  }

  /** Reset all tracking state on main file load. */
  function resetOnLoad(dataset: Dataset) {
    loadedPersonIds.current = new Set(dataset.individuals.keys());
    loadedFamilyIds.current = new Set(dataset.families.keys());
    takeBaseline(dataset);
    personSnapshots.current = new Map();
    familySnapshots.current = new Map();
    recordSnapshots.current = new Map();
    setChangedPersonIds(new Set());
    setChangedFamilyIds(new Set());
    setChangedRecordIds(new Set());
  }

  /** Restore tracking state cached from a previous session (IndexedDB hydrate).
   *  Used instead of {@link resetOnLoad} when the re-parsed main is the edited
   *  serialization, so the pre-edit snapshots and changed-id sets line up with it. */
  function hydrate(
    state: {
      loadedPersonIds: string[];
      loadedFamilyIds: string[];
      changedPersonIds: string[];
      changedFamilyIds: string[];
      /** Standalone shared-record edits; absent in pre-existing caches. */
      changedRecordIds?: string[];
      personSnapshots: [string, GedNode][];
      familySnapshots: [string, GedNode][];
      recordSnapshots?: [string, SharedRecordSnapshot][];
    },
    /** The re-parsed main — already carrying the cached edits. Fingerprinting it
     *  makes the audit baseline "the workspace as restored": the edits made
     *  before the reload are described by the hydrated snapshots above, so the
     *  audit only has to catch what happens from here on. */
    dataset: Dataset,
  ) {
    takeBaseline(dataset);
    loadedPersonIds.current = new Set(state.loadedPersonIds);
    loadedFamilyIds.current = new Set(state.loadedFamilyIds);
    personSnapshots.current = new Map(state.personSnapshots);
    familySnapshots.current = new Map(state.familySnapshots);
    recordSnapshots.current = new Map(state.recordSnapshots ?? []);
    setChangedPersonIds(new Set(state.changedPersonIds));
    setChangedFamilyIds(new Set(state.changedFamilyIds));
    setChangedRecordIds(new Set(state.changedRecordIds ?? []));
  }

  /** Snapshot the current tracking state for persistence. */
  function serialize() {
    return {
      loadedPersonIds: [...loadedPersonIds.current],
      loadedFamilyIds: [...loadedFamilyIds.current],
      changedPersonIds: [...changedPersonIds],
      changedFamilyIds: [...changedFamilyIds],
      changedRecordIds: [...changedRecordIds],
      personSnapshots: [...personSnapshots.current] as [string, GedNode][],
      familySnapshots: [...familySnapshots.current] as [string, GedNode][],
      recordSnapshots: [...recordSnapshots.current] as [string, SharedRecordSnapshot][],
    };
  }

  /** Advance the baseline after a successful save — the saved file becomes the
   *  new original, so all dirty tracking and snapshots start fresh. */
  function resetOnSave(dataset: Dataset) {
    loadedPersonIds.current = new Set(dataset.individuals.keys());
    loadedFamilyIds.current = new Set(dataset.families.keys());
    takeBaseline(dataset);
    personSnapshots.current = new Map();
    familySnapshots.current = new Map();
    recordSnapshots.current = new Map();
    setChangedPersonIds(new Set());
    setChangedFamilyIds(new Set());
    setChangedRecordIds(new Set());
  }

  return {
    // state
    changedPersonIds,
    changedFamilyIds,
    changedRecordIds,
    // refs (exposed for handleRemoveFromSave which needs to read/check them)
    loadedPersonIds,
    loadedFamilyIds,
    baseline,
    personSnapshots,
    familySnapshots,
    recordSnapshots,
    // actions
    markDirty,
    captureSnapshotsForPush,
    onPatchApplied,
    reconcile,
    removeDirty,
    prepareForLoad,
    resetOnLoad,
    resetOnSave,
    hydrate,
    serialize,
  };
}

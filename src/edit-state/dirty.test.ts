import { describe, it, expect } from "vitest";
import { bumpSubstantiveCounts, computePatchApplyOps, computePushCaptureOps, computePushDirtyOps, shouldCaptureFallbackSnapshot } from "./dirty";
import { nodesEqual } from "../gedcom/node";
import type { GedNode } from "../gedcom/types";
import type { RecordPatch } from "../ui/historyTypes";

// ── helpers ────────────────────────────────────────────────────────────────

function node(tag: string, value?: string, children: GedNode[] = []): GedNode {
  return { level: 0, tag, children, ...(value !== undefined ? { value } : {}) };
}

function indiPatch(
  id: string,
  before: GedNode | null,
  after: GedNode | null,
): RecordPatch {
  return { type: "individual", id, before, after };
}

function famPatch(
  id: string,
  before: GedNode | null,
  after: GedNode | null,
): RecordPatch {
  return { type: "family", id, before, after };
}

function noSnapshot(_kind: unknown, _id: string): undefined {
  return undefined;
}

function noRecord(_kind: unknown, _id: string): undefined {
  return undefined;
}

/** Every id in these tests except `@I9@` was in the file when it loaded. */
function wasLoaded(_kind: unknown, id: string): boolean {
  return id !== "@I9@";
}

// ── nodesEqual ─────────────────────────────────────────────────────────────

describe("nodesEqual", () => {
  it("returns true for identical nodes", () => {
    const a = node("NAME", "Alice");
    expect(nodesEqual(a, { ...a })).toBe(true);
  });

  it("returns false when tags differ", () => {
    expect(nodesEqual(node("NAME"), node("BIRT"))).toBe(false);
  });

  it("returns false when values differ", () => {
    expect(nodesEqual(node("NAME", "Alice"), node("NAME", "Bob"))).toBe(false);
  });

  it("returns false when child count differs", () => {
    const a = node("INDI", undefined, [node("NAME")]);
    const b = node("INDI");
    expect(nodesEqual(a, b)).toBe(false);
  });

  it("returns true for deep trees", () => {
    const a = node("INDI", undefined, [node("BIRT", undefined, [node("DATE", "1 JAN 1900")])]);
    const b = node("INDI", undefined, [node("BIRT", undefined, [node("DATE", "1 JAN 1900")])]);
    expect(nodesEqual(a, b)).toBe(true);
  });

  it("returns false when deep child value differs", () => {
    const a = node("INDI", undefined, [node("BIRT", undefined, [node("DATE", "1 JAN 1900")])]);
    const b = node("INDI", undefined, [node("BIRT", undefined, [node("DATE", "2 FEB 2000")])]);
    expect(nodesEqual(a, b)).toBe(false);
  });
});

// ── computePatchApplyOps ────────────────────────────────────────────────────

describe("computePatchApplyOps", () => {
  const original = node("INDI", "original");
  const edited = node("INDI", "edited");
  const reEdited = node("INDI", "re-edited");

  // Case A ─────────────────────────────────────────────────────────────────

  it("A: undo of creation clears dirty + snapshot", () => {
    // Undo: apply patch.before (null). Record disappears.
    const patch = indiPatch("@I1@", null, edited);
    const ops = computePatchApplyOps([patch], "undo", noSnapshot, noRecord);
    expect(ops.dirty).toEqual([{ action: "remove", kind: "individual", id: "@I1@" }]);
    expect(ops.snapshots).toEqual([{ action: "delete", kind: "individual", id: "@I1@" }]);
  });

  it("A: redo of deleting a session-created record clears dirty + snapshot", () => {
    // Redo: apply patch.after (null). Record disappears — and the file never
    // had it, so its going leaves nothing to save and nothing to report.
    const patch = indiPatch("@I1@", original, null);
    const ops = computePatchApplyOps([patch], "redo", noSnapshot, noRecord);
    expect(ops.dirty).toEqual([{ action: "remove", kind: "individual", id: "@I1@" }]);
    expect(ops.snapshots).toEqual([{ action: "delete", kind: "individual", id: "@I1@" }]);
  });

  // The bug this guards: an undo→redo cycle over a deletion used to clear the
  // flag for a record the file *did* have, after which the save deleted it with
  // nothing in the change report to say so.
  it("A: redo of deleting a loaded record keeps it dirty, with its snapshot", () => {
    const patch = indiPatch("@I1@", original, null);
    const ops = computePatchApplyOps([patch], "redo", noSnapshot, noRecord, undefined, wasLoaded);
    expect(ops.dirty).toEqual([{ action: "add", kind: "individual", id: "@I1@" }]);
    expect(ops.snapshots).toEqual([
      { action: "set", kind: "individual", id: "@I1@", value: original },
    ]);
  });

  it("A: undo of creating a record the file never had still clears it", () => {
    const patch = indiPatch("@I9@", null, edited);
    const ops = computePatchApplyOps([patch], "undo", noSnapshot, noRecord, undefined, wasLoaded);
    expect(ops.dirty).toEqual([{ action: "remove", kind: "individual", id: "@I9@" }]);
  });

  it("A: a loaded shared record (a source) going away stays dirty too", () => {
    const orig = node("SOUR", "Krstna knjiga");
    const patch: RecordPatch = { type: "record", id: "@S1@", before: orig, after: null };
    const ops = computePatchApplyOps([patch], "redo", noSnapshot, noRecord, undefined, wasLoaded);
    expect(ops.dirty).toEqual([{ action: "add", kind: "record", id: "@S1@" }]);
    expect(ops.snapshots).toEqual([{ action: "set", kind: "record", id: "@S1@", value: orig }]);
  });

  // Case B ─────────────────────────────────────────────────────────────────

  it("B: redo of creation adds dirty, no snapshot change", () => {
    // Redo: apply patch.after. patch.before === null so it was a creation.
    const patch = indiPatch("@I1@", null, edited);
    const ops = computePatchApplyOps([patch], "redo", noSnapshot, noRecord);
    expect(ops.dirty).toEqual([{ action: "add", kind: "individual", id: "@I1@" }]);
    expect(ops.snapshots).toHaveLength(0);
  });

  // Case C ─────────────────────────────────────────────────────────────────

  it("C: undo restores record to original — clears dirty + snapshot", () => {
    // After undo, the record (currently = original) matches the snapshot.
    const patch = indiPatch("@I1@", original, edited);
    const ops = computePatchApplyOps(
      [patch],
      "undo",
      () => original,      // snapshot exists and equals current
      () => original,      // getCurrentRaw returns the same node
    );
    expect(ops.dirty).toEqual([{ action: "remove", kind: "individual", id: "@I1@" }]);
    expect(ops.snapshots).toEqual([{ action: "delete", kind: "individual", id: "@I1@" }]);
  });

  it("C: redo restores record to original — clears dirty + snapshot", () => {
    // After redo of re-edit → back to original (edge case: redo returned to snapshot).
    const patch = indiPatch("@I1@", reEdited, original);
    const ops = computePatchApplyOps(
      [patch],
      "redo",
      () => original,
      () => original,
    );
    expect(ops.dirty).toEqual([{ action: "remove", kind: "individual", id: "@I1@" }]);
    expect(ops.snapshots).toEqual([{ action: "delete", kind: "individual", id: "@I1@" }]);
  });

  // Case D ─────────────────────────────────────────────────────────────────

  it("D: redo of modification adds dirty (snapshot present, current != snapshot)", () => {
    const patch = indiPatch("@I1@", original, edited);
    const ops = computePatchApplyOps(
      [patch],
      "redo",
      () => original,    // snapshot present
      () => edited,      // current is the re-applied edited state
    );
    expect(ops.dirty).toEqual([{ action: "add", kind: "individual", id: "@I1@" }]);
    expect(ops.snapshots).toHaveLength(0); // snapshot already present, no restore
  });

  it("D: redo of modification restores snapshot when missing", () => {
    // Snapshot was cleared by a prior undo (case C). Redo re-dirtied the record
    // so we need to put the snapshot back.
    const patch = indiPatch("@I1@", original, edited);
    const ops = computePatchApplyOps(
      [patch],
      "redo",
      noSnapshot,      // snapshot was cleared
      () => edited,    // current is the re-applied edited state
    );
    expect(ops.dirty).toEqual([{ action: "add", kind: "individual", id: "@I1@" }]);
    expect(ops.snapshots).toHaveLength(1);
    expect(ops.snapshots[0].action).toBe("set");
    expect(ops.snapshots[0].id).toBe("@I1@");
    // value should be a clone of patch.before (original)
    expect((ops.snapshots[0] as { action: "set"; value: GedNode }).value).toEqual(original);
  });

  // Case E ─────────────────────────────────────────────────────────────────

  it("E: undo with snapshot present but current still differs — adds dirty", () => {
    // Undo of second edit: current is now first-edit state, but snapshot is original.
    const firstEdit = node("INDI", "first-edit");
    const secondEdit = node("INDI", "second-edit");
    const patch = indiPatch("@I1@", firstEdit, secondEdit);
    const ops = computePatchApplyOps(
      [patch],
      "undo",
      () => original,    // snapshot of original state
      () => firstEdit,   // current after undo = first-edit, not original
    );
    expect(ops.dirty).toEqual([{ action: "add", kind: "individual", id: "@I1@" }]);
    expect(ops.snapshots).toHaveLength(0);
  });

  it("E: undo with no snapshot — adds dirty", () => {
    const patch = indiPatch("@I1@", original, edited);
    const ops = computePatchApplyOps([patch], "undo", noSnapshot, () => original);
    expect(ops.dirty).toEqual([{ action: "add", kind: "individual", id: "@I1@" }]);
    expect(ops.snapshots).toHaveLength(0);
  });

  // Family patches ──────────────────────────────────────────────────────────

  it("handles family patches with kind=family", () => {
    const patch = famPatch("@F1@", original, null);
    const ops = computePatchApplyOps([patch], "redo", noSnapshot, noRecord);
    expect(ops.dirty[0]).toEqual({ action: "remove", kind: "family", id: "@F1@" });
  });

  // Mixed patches ───────────────────────────────────────────────────────────

  it("handles multiple patches of mixed types", () => {
    const patches: RecordPatch[] = [
      { type: "record", id: "@S1@", before: null, after: node("SOUR") }, // redo of creation
      indiPatch("@I1@", null, edited),                                    // B: redo of creation
      famPatch("@F1@", original, null),                                   // A: redo of deletion
    ];
    const ops = computePatchApplyOps([...patches], "redo", noSnapshot, noRecord);
    expect(ops.dirty).toEqual([
      { action: "add", kind: "record", id: "@S1@" },
      { action: "add", kind: "individual", id: "@I1@" },
      { action: "remove", kind: "family", id: "@F1@" },
    ]);
  });

  // An ownerless shared-record edit (a Tools fix rewriting a SOUR's DATE) is
  // its own dirty subject — nothing else would mark the file unsaved.
  it("record patch without owner dirties the record itself", () => {
    const patch: RecordPatch = { type: "record", id: "@S1@", before: node("SOUR"), after: node("SOUR", "v2") };
    const ops = computePatchApplyOps([patch], "undo", noSnapshot, noRecord);
    expect(ops.dirty).toEqual([{ action: "add", kind: "record", id: "@S1@" }]);
    expect(ops.snapshots).toHaveLength(0);
  });

  it("undoing an ownerless record edit back to its snapshot clears it", () => {
    const orig = node("SOUR", "orig");
    const patch: RecordPatch = { type: "record", id: "@S1@", before: orig, after: node("SOUR", "edited") };
    const ops = computePatchApplyOps([patch], "undo", () => orig, () => node("SOUR", "orig"));
    expect(ops.dirty).toEqual([{ action: "remove", kind: "record", id: "@S1@" }]);
    expect(ops.snapshots).toEqual([{ action: "delete", kind: "record", id: "@S1@" }]);
  });

  it("record patch going away (undo of creation) drops its snapshot and dirty flag", () => {
    const patch: RecordPatch = { type: "record", id: "@S1@", before: null, after: node("SOUR") };
    const ops = computePatchApplyOps([patch], "undo", noSnapshot, noRecord);
    expect(ops.dirty).toEqual([{ action: "remove", kind: "record", id: "@S1@" }]);
    expect(ops.snapshots).toEqual([{ action: "delete", kind: "record", id: "@S1@" }]);
  });

  // Shared-record patches with an owner (regression: undoing a shared OBJE
  // metadata edit used to leave the owner phantom-dirty forever) ────────────

  describe("record patches with owner", () => {
    const owner = { kind: "individual" as const, id: "@I1@" };
    const objeOrig = node("OBJE", "orig-title");
    const objeEdited = node("OBJE", "new-title");
    const ownerRaw = node("INDI", "owner");

    function recPatch(before: GedNode | null, after: GedNode | null): RecordPatch {
      return { type: "record", id: "@O1@", before, after, owner };
    }

    it("undo back to the record snapshot clears the clean owner", () => {
      const ops = computePatchApplyOps(
        [recPatch(objeOrig, objeEdited)],
        "undo",
        (kind, id) => (kind === "record" ? objeOrig : id === "@I1@" ? ownerRaw : undefined),
        (kind) => (kind === "record" ? objeOrig : ownerRaw),
      );
      expect(ops.dirty).toEqual([{ action: "remove", kind: "individual", id: "@I1@" }]);
      expect(ops.snapshots).toEqual([{ action: "delete", kind: "record", id: "@O1@" }]);
    });

    it("undo back to the record snapshot keeps an owner with direct edits dirty", () => {
      const ownerEdited = node("INDI", "owner-edited");
      const ops = computePatchApplyOps(
        [recPatch(objeOrig, objeEdited)],
        "undo",
        (kind) => (kind === "record" ? objeOrig : ownerRaw), // owner snapshot = original
        (kind) => (kind === "record" ? objeOrig : ownerEdited), // but current differs
      );
      expect(ops.dirty).toHaveLength(0);
      expect(ops.snapshots).toEqual([{ action: "delete", kind: "record", id: "@O1@" }]);
    });

    it("undo back to the record snapshot keeps a session-created owner (no snapshot) dirty", () => {
      const ops = computePatchApplyOps(
        [recPatch(objeOrig, objeEdited)],
        "undo",
        (kind) => (kind === "record" ? objeOrig : undefined), // owner has no snapshot
        (kind) => (kind === "record" ? objeOrig : ownerRaw),
      );
      expect(ops.dirty).toHaveLength(0);
    });

    it("undo back to the record snapshot keeps the owner dirty while another owned record is edited", () => {
      const ops = computePatchApplyOps(
        [recPatch(objeOrig, objeEdited)],
        "undo",
        (kind) => (kind === "record" ? objeOrig : ownerRaw),
        (kind) => (kind === "record" ? objeOrig : ownerRaw),
        () => true, // a second shared record owned by @I1@ is still modified
      );
      expect(ops.dirty).toHaveLength(0);
    });

    it("redo of the record edit re-dirties the owner and restores a missing record snapshot", () => {
      const ops = computePatchApplyOps(
        [recPatch(objeOrig, objeEdited)],
        "redo",
        () => undefined, // record snapshot was cleared by the prior undo
        (kind) => (kind === "record" ? objeEdited : ownerRaw),
      );
      expect(ops.dirty).toEqual([{ action: "add", kind: "individual", id: "@I1@" }]);
      expect(ops.snapshots).toHaveLength(1);
      expect(ops.snapshots[0]).toMatchObject({ action: "set", kind: "record", id: "@O1@", owner });
      expect((ops.snapshots[0] as { value: GedNode }).value).toEqual(objeOrig);
    });
  });
});

// ── computePushCaptureOps ───────────────────────────────────────────────────

describe("computePushCaptureOps", () => {
  const snap = node("INDI", "original");
  const snap2 = node("FAM", "original-family");

  it("captures snapshot when record is first dirtied", () => {
    const patch = indiPatch("@I1@", snap, node("INDI", "edited"));
    const ops = computePushCaptureOps([patch], () => false);
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe("individual");
    expect(ops[0].id).toBe("@I1@");
    expect(ops[0].value).toEqual(snap);
  });

  it("does not overwrite an existing snapshot", () => {
    const patch = indiPatch("@I1@", snap, node("INDI", "second-edit"));
    const ops = computePushCaptureOps([patch], () => true); // already has snapshot
    expect(ops).toHaveLength(0);
  });

  it("skips patches where before === null (record creation)", () => {
    const patch = indiPatch("@I1@", null, node("INDI", "new"));
    const ops = computePushCaptureOps([patch], () => false);
    expect(ops).toHaveLength(0);
  });

  it("captures record-type patches under the record kind, carrying the owner", () => {
    const owner = { kind: "individual" as const, id: "@I9@" };
    const patch: RecordPatch = { type: "record", id: "@S1@", before: node("SOUR"), after: node("SOUR", "v2"), owner };
    const ops = computePushCaptureOps([patch], () => false);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: "record", id: "@S1@", owner });
  });

  it("skips record-type creation patches (before === null)", () => {
    const patch: RecordPatch = { type: "record", id: "@S1@", before: null, after: node("SOUR") };
    const ops = computePushCaptureOps([patch], () => false);
    expect(ops).toHaveLength(0);
  });

  it("captures multiple distinct records in one push", () => {
    const patches: RecordPatch[] = [
      indiPatch("@I1@", snap, node("INDI", "edited")),
      famPatch("@F1@", snap2, node("FAM", "edited")),
    ];
    const ops = computePushCaptureOps(patches, () => false);
    expect(ops).toHaveLength(2);
    expect(ops[0]).toMatchObject({ kind: "individual", id: "@I1@" });
    expect(ops[1]).toMatchObject({ kind: "family", id: "@F1@" });
  });

  it("deduplicates when same record appears twice in one push", () => {
    // Second patch for the same record — snapshot already captured from first.
    const patches: RecordPatch[] = [
      indiPatch("@I1@", snap, node("INDI", "edit1")),
      indiPatch("@I1@", node("INDI", "edit1"), node("INDI", "edit2")),
    ];
    const seen = new Set<string>();
    const hasSnap = (_kind: unknown, id: string) => seen.has(id);
    const [first, ...rest] = patches;
    // Simulate: capture for first, then hasSnapshot returns true for second.
    const ops1 = computePushCaptureOps([first], hasSnap);
    ops1.forEach((o) => seen.add(o.id));
    const ops2 = computePushCaptureOps(rest, hasSnap);
    expect(ops1).toHaveLength(1);
    expect(ops2).toHaveLength(0);
  });

  it("returned value is a clone (mutations do not affect the original)", () => {
    const original = node("INDI", "original");
    const patch = indiPatch("@I1@", original, node("INDI", "edited"));
    const [captured] = computePushCaptureOps([patch], () => false);
    captured.value.value = "mutated";
    expect(original.value).toBe("original");
  });
});

// ── computePushDirtyOps ─────────────────────────────────────────────────────

describe("computePushDirtyOps", () => {
  /** `@S9@`/`@R9@` were created this session; every other id was loaded. */
  const loaded = (_kind: unknown, id: string) => id !== "@S9@" && id !== "@R9@";

  it("marks a created shared record dirty (an Add Source's SOUR/REPO)", () => {
    const patches: RecordPatch[] = [
      { type: "record", id: "@S9@", before: null, after: node("SOUR") },
      { type: "record", id: "@R9@", before: null, after: node("REPO") },
    ];
    const { dirty, snapshots } = computePushDirtyOps(patches, loaded);
    expect(dirty).toEqual([
      { action: "add", kind: "record", id: "@S9@" },
      { action: "add", kind: "record", id: "@R9@" },
    ]);
    expect(snapshots).toHaveLength(0);
  });

  it("marks a modified or deleted loaded record dirty", () => {
    const patches: RecordPatch[] = [
      { type: "record", id: "@S1@", before: node("SOUR"), after: node("SOUR", "v2") },
      { type: "record", id: "@S2@", before: node("SOUR"), after: null },
    ];
    const { dirty, snapshots } = computePushDirtyOps(patches, loaded);
    expect(dirty).toEqual([
      { action: "add", kind: "record", id: "@S1@" },
      { action: "add", kind: "record", id: "@S2@" },
    ]);
    expect(snapshots).toHaveLength(0);
  });

  // Created and then pruned within the session: it never reached the file, so
  // nothing may report it — and the snapshot the capture pass took from the
  // deletion patch's `before` would otherwise make it read as "removed".
  it("clears a session-created record on its deletion", () => {
    const patch: RecordPatch = { type: "record", id: "@S9@", before: node("SOUR"), after: null };
    const { dirty, snapshots } = computePushDirtyOps([patch], loaded);
    expect(dirty).toEqual([{ action: "remove", kind: "record", id: "@S9@" }]);
    expect(snapshots).toEqual([{ action: "delete", kind: "record", id: "@S9@" }]);
  });

  it("leaves owner-attributed record patches to the owner's flag", () => {
    const owner = { kind: "individual" as const, id: "@I1@" };
    const patch: RecordPatch = { type: "record", id: "@N1@", before: node("NOTE"), after: node("NOTE", "v2"), owner };
    const { dirty, snapshots } = computePushDirtyOps([patch], loaded);
    expect(dirty).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });

  it("ignores individual and family patches", () => {
    const patches: RecordPatch[] = [
      indiPatch("@I1@", null, node("INDI")),
      famPatch("@F1@", node("FAM"), null),
    ];
    const { dirty, snapshots } = computePushDirtyOps(patches, loaded);
    expect(dirty).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });
});

// ── shouldCaptureFallbackSnapshot ───────────────────────────────────────────
// Regression: markDirty used to snapshot session-created records too, so
// undoing a later edit on a new person restored their creation state, matched
// the snapshot ("fully reverted", case C) and wrongly dropped the still-unsaved
// new record from the dirty set.

describe("shouldCaptureFallbackSnapshot", () => {
  it("captures for a pre-existing record with no snapshot yet", () => {
    expect(shouldCaptureFallbackSnapshot(false, true)).toBe(true);
  });

  it("never captures for a session-created record", () => {
    expect(shouldCaptureFallbackSnapshot(false, false)).toBe(false);
  });

  it("never overwrites an existing snapshot", () => {
    expect(shouldCaptureFallbackSnapshot(true, true)).toBe(false);
    expect(shouldCaptureFallbackSnapshot(true, false)).toBe(false);
  });
});

// ── bumpSubstantiveCounts ──────────────────────────────────────────────────
// The counts decide which dirty records get a CHAN/_UPD refresh at save time:
// hand edits and merges count, whole-file maintenance passes never do.

describe("bumpSubstantiveCounts", () => {
  it("counts substantive patches and skips mechanical ones", () => {
    const counts = new Map<string, number>();
    bumpSubstantiveCounts(counts, [
      indiPatch("@I1@", node("a"), node("b")),
      { ...indiPatch("@I2@", node("x"), node("y")), mechanical: true },
    ], 1);
    expect(counts.get("@I1@")).toBe(1);
    expect(counts.has("@I2@")).toBe(false);
  });

  it("undo decrements what push counted, clearing the entry at zero", () => {
    const counts = new Map<string, number>();
    const first = [indiPatch("@I1@", node("a"), node("b"))];
    const second = [indiPatch("@I1@", node("b"), node("c"))];
    bumpSubstantiveCounts(counts, first, 1);
    bumpSubstantiveCounts(counts, second, 1);
    expect(counts.get("@I1@")).toBe(2);
    bumpSubstantiveCounts(counts, second, -1);
    expect(counts.get("@I1@")).toBe(1); // one hand edit still applied → stamp
    bumpSubstantiveCounts(counts, first, -1);
    expect(counts.has("@I1@")).toBe(false); // fully undone → keep the file's stamp
  });

  it("a record edited by hand and by a pass stays substantive until the hand edit is undone", () => {
    const counts = new Map<string, number>();
    const hand = [indiPatch("@I1@", node("a"), node("b"))];
    const pass = [{ ...indiPatch("@I1@", node("b"), node("c")), mechanical: true }];
    bumpSubstantiveCounts(counts, hand, 1);
    bumpSubstantiveCounts(counts, pass, 1);
    expect(counts.get("@I1@")).toBe(1);
    bumpSubstantiveCounts(counts, hand, -1);
    expect(counts.has("@I1@")).toBe(false);
  });
});

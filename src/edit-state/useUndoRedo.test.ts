import { describe, expect, it, vi } from "vitest";
import { useUndoRedo, withoutMergeEntries, type UndoEntry } from "./useUndoRedo";
import { renderHook } from "../testing/fakeReact";
import { applyRecordPatches, type RecordPatch } from "../ui/historyTypes";
import { cloneNode } from "../gedcom/node";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { serializeGedcom } from "../gedcom/serialize";
import type { Dataset } from "../gedcom/types";

vi.mock("react", () => import("../testing/fakeReact"));

const parse = (lines: string[]): Dataset =>
  buildDataset(parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer));

/** Patches turning `ds` into `next`, for the records `ids` name. */
function step(ds: Dataset, next: Dataset, ids: string[]): RecordPatch[] {
  return ids.map((id) => {
    const type = id.startsWith("@I") ? "individual" as const : "family" as const;
    const map = type === "individual" ? "individuals" : "families";
    const before = ds[map].get(id)?.raw;
    const after = next[map].get(id)?.raw;
    return { type, id, before: before ? cloneNode(before) : null, after: after ? cloneNode(after) : null };
  });
}

// Regression: unloading the incoming file dropped merge entries from the
// middle of the history, though a merge entry also carries the people it
// added to the main file. Undoing the edits around it then stepped over that
// change, leaving the added people (and their links) in a file the history
// claimed was back at its start.
describe("withoutMergeEntries", () => {
  it("keeps a merge entry's main-file change undoable", () => {
    const s0 = ["0 HEAD", "0 @I1@ INDI", "1 NAME Ana /Novak/", "0 TRLR"];
    const s1 = ["0 HEAD", "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 SEX F", "0 TRLR"];
    const s2 = [
      "0 HEAD", "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 SEX F", "1 FAMS @F9@",
      "0 @I9@ INDI", "1 NAME Jože /Kos/", "1 FAMS @F9@", "0 @F9@ FAM", "1 HUSB @I9@", "1 WIFE @I1@", "0 TRLR",
    ];
    const s3 = [...s2.slice(0, 2), "1 NAME Ana /Kos/", ...s2.slice(3)];
    const [d0, d1, d2, d3] = [s0, s1, s2, s3].map(parse);
    const stack: UndoEntry[] = [
      { mode: "edit", patches: step(d0, d1, ["@I1@"]) },
      {
        mode: "merge", before: new Map(), after: new Map(), mainId: "@I1@", compareId: "@X1@",
        patches: step(d1, d2, ["@I1@", "@I9@", "@F9@"]),
      },
      { mode: "import", before: new Set(), after: new Set(["x"]) },
      { mode: "edit", patches: step(d2, d3, ["@I1@"]) },
    ];
    const kept = withoutMergeEntries(stack);
    expect(kept.map((e) => e.mode)).toEqual(["edit", "edit", "edit"]);
    const live = parse(s3);
    for (const e of [...kept].reverse()) {
      if (e.mode === "edit") applyRecordPatches(live, e.patches, "undo");
    }
    expect(serializeGedcom(live.records)).toBe(serializeGedcom(d0.records));
  });

  it("drops a merge entry that changed nothing in the main file", () => {
    const stack: UndoEntry[] = [
      { mode: "merge", before: new Map(), after: new Map(), mainId: "@I1@", compareId: "@X1@" },
      { mode: "merge", before: new Map(), after: new Map(), mainId: "@I1@", compareId: "@X1@", patches: [] },
      { mode: "rejectDup", before: new Set(), after: new Set() },
    ];
    expect(withoutMergeEntries(stack).map((e) => e.mode)).toEqual(["rejectDup"]);
  });
});

/** An edit entry named by `n`, so a test can tell which step came back. */
const edit = (n: number, patches: RecordPatch[] = []): UndoEntry => ({ mode: "edit", patches, navigateTo: `@I${n}@` });
const nameOf = (e: UndoEntry | undefined) => (e?.mode === "edit" ? e.navigateTo : e?.mode);

describe("useUndoRedo stacks", () => {
  it("undo takes the newest step back, redo puts it forward again, and the flags follow", () => {
    const { result } = renderHook(() => useUndoRedo());
    expect([result.current.canUndo, result.current.canRedo]).toEqual([false, false]);
    expect(result.current.undo()).toBeUndefined();
    expect(result.current.redo()).toBeUndefined();
    result.current.push(edit(1));
    result.current.push(edit(2));
    expect([result.current.canUndo, result.current.canRedo]).toEqual([true, false]);
    expect(nameOf(result.current.undo())).toBe("@I2@");
    expect([result.current.canUndo, result.current.canRedo]).toEqual([true, true]);
    expect(nameOf(result.current.undo())).toBe("@I1@");
    expect([result.current.canUndo, result.current.canRedo]).toEqual([false, true]);
    expect(nameOf(result.current.redo())).toBe("@I1@");
    expect(nameOf(result.current.redo())).toBe("@I2@");
    expect([result.current.canUndo, result.current.canRedo]).toEqual([true, false]);
  });

  it("peek names the next step without taking it", () => {
    const { result } = renderHook(() => useUndoRedo());
    result.current.push(edit(1));
    expect(nameOf(result.current.peek("undo"))).toBe("@I1@");
    expect(result.current.peek("redo")).toBeUndefined();
    expect(nameOf(result.current.peek("undo"))).toBe("@I1@");
    result.current.undo();
    expect(result.current.peek("undo")).toBeUndefined();
    expect(nameOf(result.current.peek("redo"))).toBe("@I1@");
  });

  it("a new step after an undo clears what could have been redone", () => {
    const { result } = renderHook(() => useUndoRedo());
    result.current.push(edit(1));
    result.current.push(edit(2));
    result.current.undo();
    result.current.push(edit(3));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.redo()).toBeUndefined();
    expect(nameOf(result.current.undo())).toBe("@I3@");
    expect(nameOf(result.current.undo())).toBe("@I1@");
  });

  it("keeps the hundred newest steps and forgets the oldest", () => {
    const { result } = renderHook(() => useUndoRedo());
    for (let n = 1; n <= 105; n++) result.current.push(edit(n));
    const undone: (string | undefined)[] = [];
    while (result.current.canUndo) undone.push(nameOf(result.current.undo()));
    expect(undone).toHaveLength(100);
    expect(undone[0]).toBe("@I105@");
    expect(undone.at(-1)).toBe("@I6@");
  });

  it("a whole-file pass is one step, however many records it patched", () => {
    const { result } = renderHook(() => useUndoRedo());
    const patches: RecordPatch[] = ["@I1@", "@I2@", "@I3@"].map((id) => ({ type: "individual", id, before: null, after: null }));
    result.current.push({ mode: "edit", patches, stay: true });
    const entry = result.current.undo();
    expect(entry?.mode === "edit" && entry.patches.map((p) => p.id)).toEqual(["@I1@", "@I2@", "@I3@"]);
    expect(result.current.canUndo).toBe(false);
  });

  it("merge decisions and edits share one history, in the order they were made", () => {
    const { result } = renderHook(() => useUndoRedo());
    const before = new Map();
    const after = new Map([["k", { status: "accepted" } as never]]);
    result.current.push(edit(1));
    result.current.push({ mode: "merge", before, after, mainId: "@I1@", compareId: "@X1@" });
    result.current.push({ mode: "import", before: new Set(), after: new Set(["b"]) });
    result.current.push({ mode: "rejectDup", before: new Set(), after: new Set(["p"]) });
    expect([1, 2, 3, 4].map(() => result.current.undo()?.mode)).toEqual(["rejectDup", "import", "merge", "edit"]);
    const merge = (result.current.redo(), result.current.redo());
    expect(merge?.mode === "merge" && merge.after).toBe(after);
  });

  it("unloading the incoming file keeps edits and turns a merge's own records into an edit step", () => {
    const { result } = renderHook(() => useUndoRedo());
    const added: RecordPatch[] = [{ type: "individual", id: "@I9@", before: null, after: null }];
    result.current.push(edit(1));
    result.current.push({ mode: "merge", before: new Map(), after: new Map(), mainId: "@I1@", compareId: "@X1@", patches: added });
    result.current.push({ mode: "import", before: new Set(), after: new Set(["b"]) });
    result.current.push({ mode: "merge", before: new Map(), after: new Map(), mainId: "@I2@", compareId: "@X2@" });
    result.current.push(edit(2));
    result.current.undo(); // edit 2 → redo stack
    result.current.dropMergeEntries();
    expect(result.current.canRedo).toBe(true);
    expect(nameOf(result.current.redo())).toBe("@I2@");
    const steps = [1, 2, 3].map(() => result.current.undo());
    expect(steps.map((e) => e?.mode)).toEqual(["edit", "edit", "edit"]);
    expect(steps[1]).toEqual({ mode: "edit", patches: added, stay: true });
    expect(result.current.canUndo).toBe(false);
  });

  it("dropping merge entries can leave nothing to undo", () => {
    const { result } = renderHook(() => useUndoRedo());
    result.current.push({ mode: "import", before: new Set(), after: new Set(["b"]) });
    result.current.dropMergeEntries();
    expect([result.current.canUndo, result.current.canRedo]).toEqual([false, false]);
    expect(result.current.undo()).toBeUndefined();
  });

  it("serializes both stacks without the duplicate rejections, and hydrates them back", () => {
    const first = renderHook(() => useUndoRedo());
    first.result.current.push(edit(1));
    first.result.current.push({ mode: "rejectDup", before: new Set(), after: new Set(["p"]) });
    first.result.current.push(edit(2));
    first.result.current.push({ mode: "import", before: new Set(), after: new Set(["b"]) });
    first.result.current.undo();
    const saved = first.result.current.serialize();
    expect(saved.undo.map(nameOf)).toEqual(["@I1@", "@I2@"]);
    expect(saved.redo.map(nameOf)).toEqual(["import"]);

    const { result } = renderHook(() => useUndoRedo());
    result.current.hydrate(saved.undo, saved.redo);
    expect([result.current.canUndo, result.current.canRedo]).toEqual([true, true]);
    expect(result.current.redo()?.mode).toBe("import");
    expect(["import", "@I2@", "@I1@"]).toEqual([1, 2, 3].map(() => nameOf(result.current.undo())));
    result.current.hydrate([], []);
    expect([result.current.canUndo, result.current.canRedo]).toEqual([false, false]);
  });

  it("a new main file clears the whole history", () => {
    const { result } = renderHook(() => useUndoRedo());
    result.current.push(edit(1));
    result.current.push(edit(2));
    result.current.undo();
    result.current.clearAll();
    expect([result.current.canUndo, result.current.canRedo]).toEqual([false, false]);
    expect(result.current.undo()).toBeUndefined();
    expect(result.current.redo()).toBeUndefined();
  });

  it("pushRef always points at the live push, so stable callbacks can record steps", () => {
    const { result, rerender } = renderHook(() => useUndoRedo());
    const ref = result.current.pushRef;
    rerender();
    expect(result.current.pushRef).toBe(ref);
    ref.current(edit(7));
    expect(result.current.canUndo).toBe(true);
    expect(nameOf(result.current.undo())).toBe("@I7@");
  });
});

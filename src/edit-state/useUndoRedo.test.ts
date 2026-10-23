import { describe, expect, it } from "vitest";
import { withoutMergeEntries, type UndoEntry } from "./useUndoRedo";
import { applyRecordPatches, cloneRaw, type RecordPatch } from "../ui/historyTypes";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { serializeGedcom } from "../gedcom/serialize";
import type { Dataset } from "../gedcom/types";

const parse = (lines: string[]): Dataset =>
  buildDataset(parseGedcom(new TextEncoder().encode(lines.join("\n")).buffer));

/** Patches turning `ds` into `next`, for the records `ids` name. */
function step(ds: Dataset, next: Dataset, ids: string[]): RecordPatch[] {
  return ids.map((id) => {
    const type = id.startsWith("@I") ? "individual" as const : "family" as const;
    const map = type === "individual" ? "individuals" : "families";
    const before = ds[map].get(id)?.raw;
    const after = next[map].get(id)?.raw;
    return { type, id, before: before ? cloneRaw(before) : null, after: after ? cloneRaw(after) : null };
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

import { describe, it, expect } from "vitest";
import { snapshotRecords, patchesFromSnapshots } from "./historyTypes";
import { insertRecordAt } from "../gedcom/edit";
import type { Dataset, GedNode, Individual } from "../gedcom/types";

// ── helpers ────────────────────────────────────────────────────────────────

function rec(tag: string, xref: string, value?: string): GedNode {
  return { level: 0, tag, xref, children: [], ...(value !== undefined ? { value } : {}) };
}

/** Minimal dataset stub: only the fields snapshot/patch plumbing touches. */
function datasetOf(records: GedNode[]): Dataset {
  const individuals = new Map<string, Individual>();
  const families = new Map<string, never>();
  for (const r of records) {
    if (r.tag === "INDI" && r.xref) individuals.set(r.xref, { id: r.xref, raw: r } as unknown as Individual);
    if (r.tag === "FAM" && r.xref) families.set(r.xref, { id: r.xref, raw: r } as never);
  }
  return { records, individuals, families } as unknown as Dataset;
}

// ── deletion patches carry the record's original position ──────────────────
// Regression: undo of a deletion used to re-insert the record at the end of
// its tag block, silently reordering the file against the original.

describe("deletion patch index", () => {
  it("snapshotRecords records each snapshotted record's index", () => {
    const records = [rec("HEAD", "@H@"), rec("INDI", "@I1@"), rec("INDI", "@I2@"), rec("FAM", "@F1@"), rec("TRLR", "@T@")];
    const ds = datasetOf(records);
    const snaps = snapshotRecords(ds, ["@I2@"], ["@F1@"]);
    expect(snaps.indices.get("@I2@")).toBe(2);
    expect(snaps.indices.get("@F1@")).toBe(3);
  });

  it("patchesFromSnapshots sets index on deletion patches only", () => {
    const records = [rec("INDI", "@I1@"), rec("INDI", "@I2@", "orig"), rec("FAM", "@F1@")];
    const ds = datasetOf(records);
    const snaps = snapshotRecords(ds, ["@I1@", "@I2@"], []);
    // Delete @I1@ (index 0), modify @I2@ in place.
    ds.records.splice(0, 1);
    ds.individuals.delete("@I1@");
    ds.individuals.get("@I2@")!.raw.value = "changed";
    const patches = patchesFromSnapshots(ds, snaps);
    const deleted = patches.find((p) => p.id === "@I1@")!;
    const modified = patches.find((p) => p.id === "@I2@")!;
    expect(deleted.after).toBeNull();
    expect(deleted.index).toBe(0);
    expect(modified.after).not.toBeNull();
    expect(modified.index).toBeUndefined();
  });

  it("insertRecordAt restores a record at its original index", () => {
    const records = [rec("INDI", "@I1@"), rec("INDI", "@I3@"), rec("TRLR", "@T@")];
    insertRecordAt(records, rec("INDI", "@I2@"), 1);
    expect(records.map((r) => r.xref)).toEqual(["@I1@", "@I2@", "@I3@", "@T@"]);
  });

  it("insertRecordAt never inserts past TRLR and falls back without an index", () => {
    const records = [rec("INDI", "@I1@"), rec("TRLR", "@T@")];
    insertRecordAt(records, rec("INDI", "@I2@"), 5); // out of range → tag-group fallback
    expect(records.map((r) => r.xref)).toEqual(["@I1@", "@I2@", "@T@"]);
    insertRecordAt(records, rec("INDI", "@I3@"), 3); // index would land on/after TRLR
    expect(records[records.length - 1].tag).toBe("TRLR");
  });
});

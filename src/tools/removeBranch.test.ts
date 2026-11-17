import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { applyRecordPatches } from "../ui/historyTypes";
import { planBranchRemoval, removeBranch } from "./removeBranch";
import { branchOf, validateDataset } from "./validate";

const load = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const text = (ds: ReturnType<typeof load>) => serializeGedcom(ds.records);

// The main tree (I1–I3) and a detached branch (I5–I7). The branch's source S2
// and note N1 are its own; S1 is cited by both sides. The main tree's I1 names
// the branch's I5 as a godparent.
const FILE = `0 HEAD
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jože /Novak/
1 FAMS @F1@
1 ASSO @I5@
2 RELA Godfather
0 @I2@ INDI
1 NAME Ana /Novak/
1 FAMS @F1@
1 SOUR @S1@
0 @I3@ INDI
1 NAME Tone /Novak/
1 FAMC @F1@
0 @I5@ INDI
1 NAME Franc /Kos/
1 FAMS @F2@
1 SOUR @S1@
0 @I6@ INDI
1 NAME Neža /Kos/
1 FAMS @F2@
1 NOTE @N1@
0 @I7@ INDI
1 NAME Pavel /Kos/
1 BIRT
2 DATE 1930
1 FAMC @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
0 @F2@ FAM
1 HUSB @I5@
1 WIFE @I6@
1 CHIL @I7@
1 MARR
2 SOUR @S2@
0 @S1@ SOUR
1 TITL Parish book
0 @S2@ SOUR
1 TITL Kos letters
1 REPO @R1@
0 @R1@ REPO
1 NAME Archive
0 @N1@ NOTE A note on Neža
0 TRLR
`;

describe("removeBranch — delete a detached branch", () => {
  it("counts what goes before anything is deleted", () => {
    const ds = load(FILE);
    const plan = planBranchRemoval(ds, branchOf(ds, "@I7@"));
    expect(plan.people.sort()).toEqual(["@I5@", "@I6@", "@I7@"]);
    expect(plan.families).toEqual(["@F2@"]);
    expect(plan.sharedFamilies).toEqual([]);
    expect(plan.naming).toEqual(["@I1@"]);
    // S2 and N1 are the branch's alone; S1 is cited by the main tree too, and a
    // repository always stays.
    expect(plan.leftBehind.map((r) => r.xref).sort()).toEqual(["@N1@", "@S2@"]);
    expect(text(ds)).toBe(text(load(FILE))); // asking changes nothing
  });

  it("deletes the branch, its own records and the lines naming it", () => {
    const ds = load(FILE);
    removeBranch(ds, branchOf(ds, "@I7@"));
    expect([...ds.individuals.keys()].sort()).toEqual(["@I1@", "@I2@", "@I3@"]);
    expect([...ds.families.keys()]).toEqual(["@F1@"]);
    const xrefs = ds.records.map((r) => r.xref).filter(Boolean);
    expect(xrefs).toContain("@S1@");
    expect(xrefs).toContain("@R1@");
    expect(xrefs).not.toContain("@S2@");
    expect(xrefs).not.toContain("@N1@");
    expect(ds.individuals.get("@I1@")!.raw.children.some((c) => c.tag === "ASSO")).toBe(false);
    // Nothing left pointing at a record the file no longer holds.
    const report = validateDataset(ds, 2026);
    expect(report.counts.brokenLink).toBe(0);
    expect(report.counts.island).toBe(0);
  });

  it("undoes and redoes in one step, byte for byte", () => {
    const ds = load(FILE);
    const original = text(ds);
    const patches = removeBranch(ds, branchOf(ds, "@I7@"));
    const after = text(ds);
    applyRecordPatches(ds, patches, "undo");
    expect(text(ds)).toBe(original);
    expect(ds.individuals.get("@I6@")?.raw.children.some((c) => c.tag === "NOTE")).toBe(true);
    applyRecordPatches(ds, patches, "redo");
    expect(text(ds)).toBe(after);
    applyRecordPatches(ds, patches, "undo");
    expect(text(ds)).toBe(original);
  });

  it("leaves a family that also holds someone else, without the deleted", () => {
    // F2 names I5 and I6, but I8 — outside the asked group — is a child there
    // by their own FAMC line only.
    const ds = load(FILE.replace("0 @F1@ FAM", "0 @I8@ INDI\n1 NAME Lojze /Kos/\n1 FAMC @F2@\n0 @F1@ FAM"));
    const original = text(ds);
    const plan = planBranchRemoval(ds, ["@I5@", "@I6@", "@I7@"]);
    expect(plan.families).toEqual([]);
    expect(plan.sharedFamilies).toEqual(["@F2@"]);
    expect(plan.outsideMembers).toEqual(["@I8@"]);
    const patches = removeBranch(ds, ["@I5@", "@I6@", "@I7@"]);
    // The marriage keeps F2 from being a bare family of one: it stays, emptied.
    const f2 = ds.families.get("@F2@")!;
    expect(f2.husband).toBeUndefined();
    expect(f2.children).toEqual([]);
    expect(ds.individuals.has("@I8@")).toBe(true);
    applyRecordPatches(ds, patches, "undo");
    expect(text(ds)).toBe(original);
  });

  it("does nothing for a person the file does not hold", () => {
    const ds = load(FILE);
    expect(removeBranch(ds, ["@I99@"])).toEqual([]);
    expect(text(ds)).toBe(text(load(FILE)));
  });
});

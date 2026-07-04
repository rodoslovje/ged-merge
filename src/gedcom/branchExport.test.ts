import { describe, expect, it } from "vitest";
import { parseGedcom } from "./parser";
import { buildDataset } from "./builder";
import { serializeGedcom } from "./serialize";
import { extractBranch } from "./branchExport";
import { findDanglingXrefs } from "../tools/structure";
import type { GedNode } from "./types";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  return buildDataset(parseGedcom(buf.buffer));
}

// Root @I1@ with parents (@I2@ × @I3@ via @F1@), a sibling @I4@, a spouse
// @I5@ (via @F2@), an unrelated person @I9@, plus a source chain
// (@S1@ → @R1@, @N1@) and a submitter referenced from HEAD.
const BASE = [
  "0 HEAD",
  "1 SOUR TEST",
  "1 SUBM @U1@",
  "1 GEDC",
  "2 VERS 5.5.1",
  "1 CHAR UTF-8",
  "0 @U1@ SUBM",
  "1 NAME Tester",
  "0 @I1@ INDI",
  "1 NAME Janez /Novak/",
  "1 FAMC @F1@",
  "1 FAMS @F2@",
  "1 ASSO @I9@",
  "1 BIRT",
  "2 DATE 1 JAN 1900",
  "2 SOUR @S1@",
  "3 PAGE 12",
  "0 @I2@ INDI",
  "1 NAME Franc /Novak/",
  "1 FAMS @F1@",
  "0 @I3@ INDI",
  "1 NAME Marija /Kranjc/",
  "1 FAMS @F1@",
  "0 @I4@ INDI",
  "1 NAME Ana /Novak/",
  "1 FAMC @F1@",
  "0 @I5@ INDI",
  "1 NAME Neža /Dolenc/",
  "1 FAMS @F2@",
  "0 @I9@ INDI",
  "1 NAME Tone /Zupan/",
  "0 @F1@ FAM",
  "1 HUSB @I2@",
  "1 WIFE @I3@",
  "1 CHIL @I1@",
  "1 CHIL @I4@",
  "1 MARR",
  "2 DATE 1890",
  "2 SOUR @S1@",
  "0 @F2@ FAM",
  "1 HUSB @I1@",
  "1 WIFE @I5@",
  "0 @S1@ SOUR",
  "1 TITL Parish book",
  "1 REPO @R1@",
  "1 NOTE @N1@",
  "0 @R1@ REPO",
  "1 NAME Archive",
  "0 @N1@ NOTE Shared note",
  "0 TRLR",
].join("\n") + "\n";

const xrefs = (records: GedNode[]) => records.filter((r) => r.xref).map((r) => r.xref);

describe("extractBranch", () => {
  it("exports an ancestors branch: connecting family, cited sources, no dangling xrefs", () => {
    const ds = buildFromText(BASE);
    const out = extractBranch(ds, ["@I1@", "@I2@", "@I3@"]);

    expect(out.individuals).toBe(3);
    expect(out.families).toBe(1); // @F1@ connects all three; @F2@ has only one member left
    // Source chain and header submitter ride along.
    expect(xrefs(out.records)).toEqual(["@U1@", "@I1@", "@I2@", "@I3@", "@F1@", "@S1@", "@R1@", "@N1@"]);
    expect(out.supporting).toBe(4);

    // Structural pointers out of the branch are gone…
    const i1 = out.records.find((r) => r.xref === "@I1@")!;
    expect(i1.children.some((c) => c.tag === "FAMS")).toBe(false);
    expect(i1.children.some((c) => c.tag === "ASSO")).toBe(false);
    expect(i1.children.some((c) => c.tag === "FAMC" && c.value === "@F1@")).toBe(true);
    const f1 = out.records.find((r) => r.xref === "@F1@")!;
    expect(f1.children.filter((c) => c.tag === "CHIL").map((c) => c.value)).toEqual(["@I1@"]);
    // …while the citation under BIRT survives, PAGE and all.
    const birt = i1.children.find((c) => c.tag === "BIRT")!;
    const sour = birt.children.find((c) => c.tag === "SOUR")!;
    expect(sour.value).toBe("@S1@");
    expect(sour.children.some((c) => c.tag === "PAGE")).toBe(true);

    // The invariant the whole module exists for.
    expect(findDanglingXrefs(out.records)).toEqual([]);

    // The output is a loadable GEDCOM that reparses into the same people.
    const round = buildFromText(serializeGedcom(out.records));
    expect([...round.individuals.keys()]).toEqual(["@I1@", "@I2@", "@I3@"]);
    expect([...round.families.keys()]).toEqual(["@F1@"]);
    expect(round.warnings).toEqual([]);
  });

  it("keeps a couple's family when both spouses are included", () => {
    const ds = buildFromText(BASE);
    const out = extractBranch(ds, ["@I1@", "@I5@"]);
    expect(out.families).toBe(1);
    const famIds = xrefs(out.records).filter((x) => x!.startsWith("@F"));
    expect(famIds).toEqual(["@F2@"]);
    expect(findDanglingXrefs(out.records)).toEqual([]);
  });

  it("exports a single person with every family link scrubbed", () => {
    const ds = buildFromText(BASE);
    const out = extractBranch(ds, ["@I1@"]);
    expect(out.individuals).toBe(1);
    expect(out.families).toBe(0);
    const i1 = out.records.find((r) => r.xref === "@I1@")!;
    expect(i1.children.some((c) => c.tag === "FAMC" || c.tag === "FAMS")).toBe(false);
    expect(findDanglingXrefs(out.records)).toEqual([]);
  });

  it("ignores unknown ids and leaves vendor subtrees untouched", () => {
    const withVendor = BASE.replace("1 ASSO @I9@", "1 ASSO @I9@\n1 _VENDOR @I9@\n2 _KIND friend");
    const ds = buildFromText(withVendor);
    const out = extractBranch(ds, ["@I1@", "@NOPE@"]);
    expect(out.individuals).toBe(1);
    const i1 = out.records.find((r) => r.xref === "@I1@")!;
    // The standard ASSO pointer is scrubbed; the vendor subtree keeps its
    // pointer verbatim (the validator skips vendor subtrees too).
    expect(i1.children.some((c) => c.tag === "ASSO")).toBe(false);
    const vendor = i1.children.find((c) => c.tag === "_VENDOR")!;
    expect(vendor.value).toBe("@I9@");
    expect(vendor.children).toHaveLength(1);
    expect(findDanglingXrefs(out.records)).toEqual([]);
  });

  it("does not touch the source dataset", () => {
    const ds = buildFromText(BASE);
    const before = serializeGedcom(ds.records);
    extractBranch(ds, ["@I1@", "@I2@", "@I3@"]);
    expect(serializeGedcom(ds.records)).toBe(before);
  });
});

import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { applyRecordPatches } from "../ui/historyTypes";
import { validateConformance } from "./conformance/conformance";
import { fixConformance } from "./fixConformance";
import { recordsWithTag } from "./recordRewrite";

function dataset(vers: "5.5.1" | "7.0", body: string) {
  const head = vers === "7.0"
    ? "0 HEAD\n1 GEDC\n2 VERS 7.0\n"
    : "0 HEAD\n1 SOUR TEST\n1 SUBM @U1@\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n0 @U1@ SUBM\n1 NAME Test\n";
  return buildDataset(parseGedcom(new TextEncoder().encode(`${head}${body}\n0 TRLR`).buffer));
}

const xrefIssues = (ds: ReturnType<typeof dataset>) => validateConformance(ds).filter((i) => i.category === "xrefShape");

describe("renaming a record id the version refuses", () => {
  it("7.0: a source id with lower case gets one the version accepts, unique, and every citation follows", () => {
    const ds = dataset("7.0", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 BIRT
2 SOUR @S_vj@
0 @S_VJ@ SOUR
1 TITL Taken
0 @S_vj@ SOUR
1 TITL Register`);
    const original = serializeGedcom(ds.records);
    expect(xrefIssues(ds)).toHaveLength(1);
    const patches = fixConformance(ds, "xrefs", { id: "@S_vj@", value: "7.0" });
    expect(validateConformance(ds)).toEqual([]);
    const renamed = ds.records.find((r) => r.children.some((c) => c.value === "Register"))!;
    expect(renamed.xref).toBe("@S_VJ_2@");
    expect(serializeGedcom(ds.records)).toContain("2 SOUR @S_VJ_2@");
    expect(ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "BIRT")!.children[0].value).toBe("@S_VJ_2@");
    // The record keeps its place in the file, and undo puts the old id back.
    expect(ds.records.indexOf(renamed)).toBe(3);
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records)).toBe(original);
  });

  it("5.5.1: an id that starts with a sign or runs past 22 characters is shortened and given a letter", () => {
    const ds = dataset("5.5.1", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 FAMS @_F1@
0 @_F1@ FAM
1 HUSB @I1@
1 NOTE @N123456789012345678901@
0 @N123456789012345678901@ NOTE A note`);
    expect(xrefIssues(ds)).toHaveLength(2);
    fixConformance(ds, "xrefs", { id: "@_F1@", value: "5.5.1" });
    fixConformance(ds, "xrefs", { id: "@N123456789012345678901@", value: "5.5.1" });
    expect(validateConformance(ds)).toEqual([]);
    expect(ds.families.has("@X_F1@")).toBe(true);
    expect(ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "FAMS")!.value).toBe("@X_F1@");
  });
});

describe("removing a custom tag", () => {
  it("removes every line of the tag with what is beneath it, in strict 5.5.1 and 7.0 alike", () => {
    for (const vers of ["5.5.1", "7.0"] as const) {
      const ds = dataset(vers, `0 @I1@ INDI
1 NAME Bo /Horvat/
1 _GOV 123
2 _NOTE beneath
1 BIRT
2 _GOV 456
0 @I2@ INDI
1 NAME Ana /Horvat/`);
      const original = serializeGedcom(ds.records);
      const patches = fixConformance(ds, "customTags", { value: "_GOV" });
      expect(patches).toHaveLength(1);
      const out = serializeGedcom(ds.records);
      expect(out).not.toContain("_GOV");
      expect(out).not.toContain("_NOTE");
      expect(validateConformance(ds)).toEqual([]);
      applyRecordPatches(ds, patches, "undo");
      expect(serializeGedcom(ds.records)).toBe(original);
    }
  });

  it("a record of the tag goes with the lines pointing at it", () => {
    const ds = dataset("7.0", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 RESI
2 PLAC Ljubljana
3 _LOC @P1@
0 @P1@ _LOC
1 NAME Ljubljana`);
    fixConformance(ds, "customTags", { value: "_LOC" });
    const out = serializeGedcom(ds.records);
    expect(out).not.toContain("@P1@");
    expect(out).toContain("2 PLAC Ljubljana");
  });
});

describe("removing a misplaced standard tag", () => {
  for (const vers of ["5.5.1", "7.0"] as const) {
    it(`${vers}: the lines go where they are misplaced, and nowhere else`, () => {
      const ds = dataset(vers, `0 @I1@ INDI
1 NAME Bo /Horvat/
1 BIRT
2 DATE 1850
0 @R1@ REPO
1 NAME Matricula Online
1 WWW https://example.org
2 DATE 8 NOV 2026
3 TIME 10:00
0 @R2@ REPO
1 NAME Arhiv
1 WWW https://example.com`);
      const original = serializeGedcom(ds.records);
      const [finding] = validateConformance(ds).filter((i) => i.category === "misplacedTag");
      expect([finding.sample, finding.messageVars.parent]).toEqual(["DATE", "REPO.WWW"]);
      const patches = fixConformance(ds, "customTags", { value: "DATE", parent: "REPO.WWW" });
      expect(patches.map((p) => p.id)).toEqual(["@R1@"]);
      expect(validateConformance(ds)).toEqual([]);
      const text = serializeGedcom(ds.records);
      expect(text).not.toContain("8 NOV 2026");
      expect(text).not.toContain("TIME");
      expect(text).toContain("2 DATE 1850");
      applyRecordPatches(ds, patches, "undo");
      expect(serializeGedcom(ds.records)).toBe(original);
    });
  }
});

describe("the records behind a finding that names a tag", () => {
  it("lists each record with its count: under the finding's path, or anywhere for an extension", () => {
    const ds = dataset("7.0", `0 @I1@ INDI
1 NAME Bo /Horvat/
1 BIRT
2 PLAC Kranj
1 _FOO a
0 @S1@ SOUR
1 TITL Prva
1 PLAC Kranj
0 @S2@ SOUR
1 TITL Druga
1 DATA
2 EVEN BIRT
3 PLAC Kranj
0 @S3@ SOUR
1 TITL Tretja
1 PLAC Kranj
1 PLAC Naklo
2 _FOO b
1 _FOO c`);
    // Only the place written on the source itself — not the one in its coverage, nor a person's.
    expect(recordsWithTag(ds.records, "PLAC", "SOUR")).toEqual([{ id: "@S1@", count: 1 }, { id: "@S3@", count: 2 }]);
    expect(recordsWithTag(ds.records, "_FOO")).toEqual([{ id: "@I1@", count: 1 }, { id: "@S3@", count: 2 }]);
  });
});

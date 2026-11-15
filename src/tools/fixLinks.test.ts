import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { GedNode } from "../gedcom/types";
import { validateConformance } from "./conformance/conformance";
import { fixBrokenLinks } from "./fixLinks";
import { validateDataset } from "./validate";

/** A file in `vers` with a header complete enough that strict conformance
 *  has nothing to say about it, around `body`. */
function dataset(vers: "5.5.1" | "7.0", body: string) {
  const head = vers === "7.0"
    ? "0 HEAD\n1 GEDC\n2 VERS 7.0\n"
    : "0 HEAD\n1 SOUR TEST\n1 SUBM @U1@\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n0 @U1@ SUBM\n1 NAME Test\n";
  return buildDataset(parseGedcom(new TextEncoder().encode(`${head}${body}\n0 TRLR`).buffer));
}

type Ds = ReturnType<typeof dataset>;
const rec = (ds: Ds, xref: string) => ds.records.find((r) => r.xref === xref)!;
const lines = (node: GedNode): string[] => node.children.map((c) => `${c.tag}${c.value !== undefined ? ` ${c.value}` : ""}`);
const broken = (ds: Ds) => validateDataset(ds, 2026).counts.brokenLink ?? 0;

/** Fix, then check in both versions' strict tables: no finding, and a second
 *  run changes nothing. */
function fixClean(body: string, reported = true) {
  const out: Ds[] = [];
  for (const vers of ["5.5.1", "7.0"] as const) {
    const ds = dataset(vers, body);
    expect(validateConformance(ds)).toEqual([]);
    if (reported) expect(broken(ds)).toBeGreaterThan(0);
    expect(fixBrokenLinks(ds).length).toBeGreaterThan(0);
    expect(validateConformance(ds)).toEqual([]);
    expect(broken(ds)).toBe(0);
    const once = serializeGedcom(ds.records);
    expect(fixBrokenLinks(ds)).toHaveLength(0);
    expect(serializeGedcom(ds.records)).toBe(once);
    out.push(ds);
  }
  return out;
}

describe("fixBrokenLinks repairs one-way links", () => {
  it("a one-way FAMC gets the family's CHIL, in birth order among the children", () => {
    for (const ds of fixClean(`0 @I1@ INDI
1 NAME Ana /Kos/
1 BIRT
2 DATE 1905
1 FAMC @F1@
0 @I2@ INDI
1 NAME Jan /Kos/
1 BIRT
2 DATE 1900
1 FAMC @F1@
0 @I3@ INDI
1 NAME Eva /Kos/
1 BIRT
2 DATE 1910
1 FAMC @F1@
0 @F1@ FAM
1 CHIL @I2@
1 CHIL @I3@
1 MARR
2 DATE 1899`)) {
      expect(lines(rec(ds, "@F1@"))).toEqual(["CHIL @I2@", "CHIL @I1@", "CHIL @I3@", "MARR"]);
      expect(ds.families.get("@F1@")!.children).toEqual(["@I2@", "@I1@", "@I3@"]);
    }
  });

  it("a one-way FAMS gets HUSB or WIFE by sex", () => {
    for (const ds of fixClean(`0 @I1@ INDI
1 NAME Jan /Kos/
1 SEX M
1 FAMS @F1@
0 @I2@ INDI
1 NAME Ana /Novak/
1 SEX F
1 FAMS @F1@
0 @F1@ FAM
1 MARR
2 DATE 1899`)) {
      expect(lines(rec(ds, "@F1@"))).toEqual(["HUSB @I1@", "WIFE @I2@", "MARR"]);
    }
  });

  it("with no sex, takes the one free slot", () => {
    for (const ds of fixClean(`0 @I1@ INDI
1 NAME Jan /Kos/
1 SEX M
1 FAMS @F1@
0 @I2@ INDI
1 NAME Ana /Novak/
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@`)) {
      expect(lines(rec(ds, "@F1@"))).toEqual(["HUSB @I1@", "WIFE @I2@"]);
    }
  });

  it("leaves a one-way FAMS alone when its slot is taken, or the sex can't choose one", () => {
    const body = `0 @I1@ INDI
1 NAME Jan /Kos/
1 SEX M
1 FAMS @F1@
0 @I2@ INDI
1 NAME Peter /Kos/
1 SEX M
1 FAMS @F1@
0 @I3@ INDI
1 NAME Mojca /Kos/
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I1@
0 @F2@ FAM
1 MARR
2 DATE 1899`;
    for (const vers of ["5.5.1", "7.0"] as const) {
      const ds = dataset(vers, body);
      const before = serializeGedcom(ds.records);
      expect(broken(ds)).toBe(2);
      expect(fixBrokenLinks(ds)).toHaveLength(0);
      // Neither replaced, guessed nor deleted: both stay reported.
      expect(serializeGedcom(ds.records)).toBe(before);
      expect(broken(ds)).toBe(2);
    }
  });

  it("7.0: a spouse slot holding @VOID@ is kept and counts as taken", () => {
    const ds = dataset("7.0", `0 @I1@ INDI
1 NAME Jan /Kos/
1 SEX M
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @VOID@`);
    const before = serializeGedcom(ds.records);
    expect(fixBrokenLinks(ds)).toHaveLength(0);
    expect(serializeGedcom(ds.records)).toBe(before);
  });

  it("a family's one-way CHIL/HUSB gets the person's FAMC/FAMS", () => {
    // Reported from the family's side (spouseNotReciprocal/childNotReciprocal).
    for (const ds of fixClean(`0 @I1@ INDI
1 NAME Jan /Kos/
1 SEX M
0 @I2@ INDI
1 NAME Eva /Kos/
1 BIRT
2 DATE 1910
1 NOTE Born at home
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@`)) {
      expect(lines(rec(ds, "@I1@"))).toEqual(["NAME Jan /Kos/", "SEX M", "FAMS @F1@"]);
      // FAMC sits before the notes, by INDI_CHILD_ORDER.
      expect(lines(rec(ds, "@I2@"))).toEqual(["NAME Eva /Kos/", "BIRT", "FAMC @F1@", "NOTE Born at home"]);
    }
  });

  it("still removes a pointer to a record that isn't in the file", () => {
    for (const ds of fixClean(`0 @I1@ INDI
1 NAME Jan /Kos/
1 SEX M
1 FAMC @F9@
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I9@`)) {
      expect(lines(rec(ds, "@I1@"))).toEqual(["NAME Jan /Kos/", "SEX M", "FAMS @F1@"]);
      expect(lines(rec(ds, "@F1@"))).toEqual(["HUSB @I1@"]);
    }
  });

  it("fills a spouse slot freed by removing a missing person in the same run", () => {
    for (const ds of fixClean(`0 @I1@ INDI
1 NAME Jan /Kos/
1 SEX M
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I9@`)) {
      expect(lines(rec(ds, "@F1@"))).toEqual(["HUSB @I1@"]);
    }
  });

  it("scoped to one finding, adds just that back-pointer", () => {
    const ds = dataset("7.0", `0 @I1@ INDI
1 NAME Ana /Kos/
1 FAMC @F1@
0 @I2@ INDI
1 NAME Jan /Kos/
1 FAMC @F1@
0 @F1@ FAM`);
    expect(broken(ds)).toBe(2);
    const patches = fixBrokenLinks(ds, { id: "@I1@", target: "@F1@" });
    // The family changed; the person's own line was already there.
    expect(patches.map((p) => p.id)).toEqual(["@F1@"]);
    expect(ds.families.get("@F1@")!.children).toEqual(["@I1@"]);
    expect(broken(ds)).toBe(1);
  });
});

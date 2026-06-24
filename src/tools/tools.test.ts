import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { validateDataset } from "./validate";
import { findDuplicates } from "./duplicates";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

describe("validateDataset", () => {
  it("flags missing name, sex, vitals and orphan status", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 SEX U
0 TRLR`);
    const report = validateDataset(ds, 2026);
    const cats = report.issues.map((i) => i.category).sort();
    expect(cats).toContain("missingName");
    expect(cats).toContain("missingSex");
    expect(cats).toContain("missingVitals");
    expect(cats).toContain("orphan");
  });

  it("detects death before birth and future dates", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX F
1 BIRT
2 DATE 1900
1 DEAT
2 DATE 1880
0 @I2@ INDI
1 NAME Bo /Kovač/
1 SEX M
1 BIRT
2 DATE 2099
0 TRLR`);
    const report = validateDataset(ds, 2026);
    const cats = report.issues.map((i) => i.category);
    expect(cats).toContain("deathBeforeBirth");
    expect(cats).toContain("futureDate");
  });

  it("detects broken and non-reciprocal family links", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Eva /Horvat/
1 SEX F
1 FAMC @F9@
0 @F1@ FAM
1 CHIL @I7@
0 TRLR`);
    const report = validateDataset(ds, 2026);
    const broken = report.issues.filter((i) => i.category === "brokenLink");
    // I1 points at a family that doesn't exist (@F9@);
    // F1 lists a child that doesn't exist (@I7@).
    expect(broken.length).toBeGreaterThanOrEqual(2);
    expect(report.counts.brokenLink).toBe(broken.length);
  });

  it("reports a clean file as having no issues", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jan /Kos/
1 SEX M
1 BIRT
2 DATE 1900
1 FAMS @F1@
0 @I2@ INDI
1 NAME Mojca /Kos/
1 SEX F
1 BIRT
2 DATE 1902
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
0 TRLR`);
    const report = validateDataset(ds, 2026);
    expect(report.issues).toHaveLength(0);
  });
});

describe("findDuplicates", () => {
  it("surfaces a near-identical person pair without matching anyone to themselves", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 12 JAN 1850
2 PLAC Ljubljana
0 @I2@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 12 JAN 1850
2 PLAC Ljubljana
0 @I3@ INDI
1 NAME Francka /Zupan/
1 SEX F
1 BIRT
2 DATE 3 MAR 1888
0 TRLR`);
    const pairs = findDuplicates(ds);
    expect(pairs).toHaveLength(1);
    const [pair] = pairs;
    expect([pair.aId, pair.bId].sort()).toEqual(["@I1@", "@I2@"]);
    expect(pair.aId).not.toBe(pair.bId);
    expect(pair.score).toBeGreaterThanOrEqual(70);
  });
});

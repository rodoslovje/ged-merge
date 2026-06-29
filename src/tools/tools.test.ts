import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { validateDataset } from "./validate";
import { validateStructure } from "./structure";
import { countFixableDates, dateFixContext, fixDates, proposeDateFix } from "./fixDates";
import { findDuplicates } from "./duplicates";
import { buildSourceTree, mediaUsedBy } from "./sources";
import { collectLocalMediaFiles } from "./mediaFiles";
import { buildPlaceTree, UNSPECIFIED, UNSPECIFIED_PLACE } from "./places";
import { fixBrokenLinks } from "./fixLinks";
import { countInferableSex, fixSexFromRole } from "./fixSex";
import { fixDuplicatePointers } from "./fixDuplicatePointers";

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

  it("flags implausible ages across the family", () => {
    // Father born 1800, child born 1900 → father aged 100 at birth (> 80).
    // Mother born 1880 → mother aged 20 (ok). Spouse gap 80 (> 32).
    // Husband married 1899 at age 99 (> 90). Person who lived 1700–1850 → 150 (> 99).
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jože /Novak/
1 SEX M
1 BIRT
2 DATE 1800
1 FAMS @F1@
0 @I2@ INDI
1 NAME Ana /Novak/
1 SEX F
1 BIRT
2 DATE 1880
1 FAMS @F1@
0 @I3@ INDI
1 NAME Otrok /Novak/
1 SEX M
1 BIRT
2 DATE 1900
1 FAMC @F1@
0 @I4@ INDI
1 NAME Star /Methuselah/
1 SEX M
1 BIRT
2 DATE 1700
1 DEAT
2 DATE 1850
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 MARR
2 DATE 1899
0 TRLR`);
    const report = validateDataset(ds, 2026);
    const cats = report.issues.map((i) => i.category);
    expect(cats).toContain("ageAtDeath"); // I4: 150 years
    expect(cats).toContain("ageAtMarriage"); // I1: married at 99
    expect(cats).toContain("parentAge"); // I3: father was 100
    expect(cats).toContain("spouseAgeGap"); // 80-year gap
    // The father-age finding is reported on the child record.
    expect(report.issues.find((i) => i.category === "parentAge")?.id).toBe("@I3@");
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

  it("detects a pedigree loop (a person who is their own ancestor)", () => {
    // I1 is a child of F2 (parent I2); I2 is a child of F1 (parent I1).
    // So each is their own grandparent — a FAMC cycle.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX F
1 FAMS @F1@
1 FAMC @F2@
0 @I2@ INDI
1 NAME Bo /Novak/
1 SEX M
1 FAMS @F2@
1 FAMC @F1@
0 @F1@ FAM
1 WIFE @I1@
1 CHIL @I2@
0 @F2@ FAM
1 HUSB @I2@
1 CHIL @I1@
0 TRLR`);
    const report = validateDataset(ds, 2026);
    const loop = report.issues.filter((i) => i.category === "pedigreeLoop");
    expect(loop.map((i) => i.id).sort()).toEqual(["@I1@", "@I2@"]);
    expect(loop.every((i) => i.severity === "error")).toBe(true);
    expect(report.counts.pedigreeLoop).toBe(2);
  });

  it("does not flag a normal acyclic pedigree as a loop", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Child /Novak/
1 SEX M
1 FAMC @F1@
0 @I2@ INDI
1 NAME Father /Novak/
1 SEX M
1 FAMS @F1@
0 @I3@ INDI
1 NAME Mother /Novak/
1 SEX F
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
0 TRLR`);
    const report = validateDataset(ds, 2026);
    expect(report.counts.pedigreeLoop).toBe(0);
  });

  it("flags sex/role contradictions (female husband, male wife)", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX F
1 FAMS @F1@
0 @I2@ INDI
1 NAME Bo /Novak/
1 SEX M
1 FAMS @F1@
0 @I3@ INDI
1 NAME Cita /Kos/
1 SEX U
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
0 @F2@ FAM
1 HUSB @I3@
0 TRLR`);
    const report = validateDataset(ds, 2026);
    const conflicts = report.issues.filter((i) => i.category === "roleSexConflict");
    // I1 is a female husband; I2 is a male wife; I3 (SEX U) is not flagged.
    expect(conflicts.map((i) => i.id).sort()).toEqual(["@I1@", "@I2@"]);
    expect(conflicts.every((i) => i.severity === "error")).toBe(true);
    expect(report.counts.roleSexConflict).toBe(2);
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

describe("validateStructure", () => {
  it("flags an unknown standard tag but allows vendor (_) tags", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 ZZZZ something
1 _CUSTOM ok
0 TRLR`);
    const report = validateStructure(ds);
    const unknown = report.issues.filter((i) => i.category === "unknownTag");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].messageVars?.tag).toBe("ZZZZ");
    expect(unknown[0].recordId).toBe("@I1@");
    expect(unknown[0].recordTag).toBe("INDI");
  });

  it("does not flag standard-looking tags nested under a vendor (_) subtree", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @L0@ _LABL
1 TITL Important
1 COLR red
0 TRLR`);
    const unknown = validateStructure(ds).issues.filter((i) => i.category === "unknownTag");
    expect(unknown).toHaveLength(0);
  });

  it("catalogues only outermost custom (_) tags, skipping the whole subtree below", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 _RACE White
0 @I2@ INDI
1 NAME Bo /Novak/
1 _RACE White
0 @TF1@ _STF
1 _NKY KeyName
1 _TAG CEME
0 @L0@ _LABL
1 COLR red
0 TRLR`);
    const report = validateStructure(ds);
    const custom = report.issues.filter((i) => i.category === "customTag");
    const byTag = Object.fromEntries(custom.map((i) => [i.messageVars?.tag, i.messageVars?.count]));
    // Only the outermost _ tags: nested _NKY/_TAG (under _STF) and COLR (under
    // _LABL) are part of the skipped subtree, so neither custom nor unknown.
    expect(byTag).toEqual({ _RACE: 2, _STF: 1, _LABL: 1 });
    expect(custom.every((i) => i.severity === "info")).toBe(true);
    expect(report.issues.filter((i) => i.category === "unknownTag")).toHaveLength(0);
  });

  it("recognizes CORP (7.0) and EDTN (5.5.1 source edition)", () => {
    const ds = dataset(`0 HEAD
1 SOUR App
2 CORP Vendor Inc
0 @S1@ SOUR
1 EDTN 2nd
0 TRLR`);
    const unknown = validateStructure(ds).issues.filter((i) => i.category === "unknownTag");
    expect(unknown).toHaveLength(0);
  });

  it("clears vendor FROM/TO line-tags via the vendor-subtree rule, not a whitelist", () => {
    // MacFamilyTree writes a stored date range as FROM/TO line-tags inside its
    // private _STO record; suppressed because the subtree is vendor-defined.
    const inVendor = dataset(`0 HEAD
1 CHAR UTF-8
0 @8211043@ _STO
1 FROM 1789
1 TO 1823
0 TRLR`);
    expect(validateStructure(inVendor).issues.filter((i) => i.category === "unknownTag")).toHaveLength(0);
    // But FROM/TO as stray line-tags in a standard context are still flagged.
    const standard = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 FROM 1789
0 TRLR`);
    const flagged = validateStructure(standard).issues.filter((i) => i.category === "unknownTag");
    expect(flagged.map((i) => i.messageVars?.tag)).toContain("FROM");
  });

  it("carries the record tag so non-INDI records can be identified, not linked", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @S1@ SOUR
1 ZZZZ x
0 TRLR`);
    const unknown = validateStructure(ds).issues.filter((i) => i.category === "unknownTag");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].recordId).toBe("@S1@");
    expect(unknown[0].recordTag).toBe("SOUR");
  });

  it("does not flag standard tags like DATE.TIME", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 CHAN
2 DATE 1 JAN 2020
3 TIME 12:30:00
0 TRLR`);
    const unknown = validateStructure(ds).issues.filter((i) => i.category === "unknownTag");
    expect(unknown).toHaveLength(0);
  });

  it("does not flag the GEDCOM 7 multimedia-link CROP region", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 OBJE @O1@
2 CROP
3 TOP 1187
3 LEFT 1138
3 HEIGHT 233
3 WIDTH 412
0 @O1@ OBJE
1 FILE group.jpg
2 FORM image/jpeg
0 TRLR`);
    const unknown = validateStructure(ds).issues.filter((i) => i.category === "unknownTag");
    expect(unknown).toHaveLength(0);
  });

  it("counts repeated unknown tags into a single de-duplicated issue", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 ZZZZ a
1 ZZZZ b
0 TRLR`);
    const unknown = validateStructure(ds).issues.filter((i) => i.category === "unknownTag");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].messageVars?.count).toBe(2);
  });

  it("flags an unparseable date but not real or placeholder dates", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE notadate
1 DEAT
2 DATE 12 MAR 1949
1 EVEN
2 DATE __.__.____
0 TRLR`);
    const bad = validateStructure(ds).issues.filter((i) => i.category === "badDate");
    expect(bad).toHaveLength(1);
    expect(bad[0].sample).toBe("notadate");
    expect(bad[0].recordId).toBe("@I1@");
    // Tooltip shows the actual problematic line, reconstructed from the node.
    expect(bad[0].tooltip).toBe("2 DATE notadate");
    // "notadate" can't be safely repaired, so it isn't marked fixable.
    expect(bad[0].fix).toBeUndefined();
  });

  it("marks a repairable date fixable and previews the result in the file's format", () => {
    // File's dominant style is "D MMM YYYY", so the previewed fix uses it.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 12 MAR 1949
1 DEAT
2 DATE 26. 6. 1912
0 TRLR`);
    const bad = validateStructure(ds).issues.filter((i) => i.category === "badDate");
    expect(bad).toHaveLength(1);
    expect(bad[0].fix).toBe("26 JUN 1912");
    expect(bad[0].tooltip).toBe("2 DATE 26. 6. 1912 → 26 JUN 1912");
  });

  it("folds in parser warnings: a line whose level skips its parent", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
3 NAME orphaned level
0 TRLR`);
    const report = validateStructure(ds);
    expect(report.counts.level).toBeGreaterThan(0);
    expect(report.issues.some((i) => i.category === "level" && i.line != null)).toBe(true);
  });

  it("is clean for a well-formed file", () => {
    const ds = dataset(`0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX F
1 BIRT
2 DATE 1900
0 TRLR`);
    expect(validateStructure(ds).issues).toHaveLength(0);
  });
});

describe("fixDates", () => {
  it("repairs spaced numeric dates but leaves ambiguous ones", () => {
    // A numeric-dominant file → repaired in its own numeric style.
    const numericCtx = dateFixContext(dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 26.6.1912
0 TRLR`));
    expect(proposeDateFix("26. 6. 1912", numericCtx)).toBe("26.6.1912");
    expect(proposeDateFix("31. 3. 1931", numericCtx)).toBe("31.3.1931");
    // A comma year-pair is read as a period and formalized to FROM…TO.
    expect(proposeDateFix("1951, 1960", numericCtx)).toBe("FROM 1951 TO 1960");
    expect(proposeDateFix("1957, 1960", numericCtx)).toBe("FROM 1957 TO 1960");
    // …but only when it's two plausible, ascending years.
    expect(proposeDateFix("1960, 1951", numericCtx)).toBeUndefined();
    expect(proposeDateFix("1951, 1951", numericCtx)).toBeUndefined();
    // Already-parseable values are never touched.
    expect(proposeDateFix("26.6.1912", numericCtx)).toBeUndefined();
    expect(proposeDateFix("12 MAR 1949", numericCtx)).toBeUndefined();
  });

  it("re-renders a repaired date in the file's month-word format", () => {
    // The file's dominant style is "D MMM YYYY" → the repair matches it.
    const ctx = dateFixContext(dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 26 JUN 1912
1 DEAT
2 DATE 6 APR 1975
0 TRLR`));
    expect(proposeDateFix("31. 3. 1931", ctx)).toBe("31 MAR 1931");
    expect(proposeDateFix("6. 4. 1975", ctx)).toBe("6 APR 1975");
  });

  it("detects month-first (US) order and swaps month/day in the suggestion", () => {
    // File writes month-word dates month-first (JAN 26 1990) → MDY.
    const ctx = dateFixContext(dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE JAN 26 1990
1 DEAT
2 DATE FEB 3 1995
0 TRLR`));
    // 6. 4. 1975 read as M.D.Y → June 4 (not April 6 as the EU test above gets).
    expect(proposeDateFix("6. 4. 1975", ctx)).toBe("4 JUN 1975");
  });

  it("rewrites fixable DATE values in place across record types and undoes cleanly", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Boris /Trampuž/
1 BIRT
2 DATE 26 JUN 1912
1 DEAT
2 DATE 26. 6. 1912
0 @O1@ OBJE
1 FILE photo.jpg
1 DATE 31. 3. 1931
1 NOTE 1951, 1960
0 TRLR`);
    expect(countFixableDates(ds)).toBe(2);

    const patches = fixDates(ds);
    // One INDI patch, one OBJE ("record") patch.
    expect(patches.map((p) => p.type).sort()).toEqual(["individual", "record"]);
    // The repaired dates now parse, so the structural check no longer flags them.
    expect(validateStructure(ds).counts.badDate).toBe(0);
    // The repaired death date is rendered in the file's month-word style.
    expect(ds.individuals.get("@I1@")?.events.find((e) => e.tag === "DEAT")?.date?.raw).toBe("26 JUN 1912");

    expect(countFixableDates(ds)).toBe(0);
  });
});

describe("fixBrokenLinks", () => {
  it("removes dangling and non-reciprocal pointers, leaving a clean file", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Eva /Horvat/
1 SEX F
1 FAMC @F9@
1 FAMS @F1@
0 @I2@ INDI
1 NAME Bo /Horvat/
1 SEX M
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I1@
1 CHIL @I7@
0 @F2@ FAM
1 HUSB @I9@
0 TRLR`);
    // Before: I1 FAMC→missing @F9@; F1 CHIL→missing @I7@; F2 HUSB→missing @I9@.
    expect(validateDataset(ds, 2026).counts.brokenLink).toBe(3);

    const patches = fixBrokenLinks(ds);
    // I1 (dropped FAMC), F1 (dropped CHIL), F2 (dropped HUSB) each changed once.
    expect(patches.length).toBe(3);

    const after = validateDataset(ds, 2026);
    expect(after.counts.brokenLink).toBe(0);

    // The valid reciprocal F1 ↔ I1/I2 link is untouched.
    expect(ds.individuals.get("@I1@")!.spouseOf).toContain("@F1@");
    expect(ds.families.get("@F1@")!.children).toHaveLength(0);
  });

  it("returns no patches when there is nothing to fix", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jan /Kos/
1 SEX M
0 TRLR`);
    expect(fixBrokenLinks(ds)).toHaveLength(0);
  });
});

describe("fixSexFromRole", () => {
  it("sets SEX U from HUSB → M / WIFE → F, leaving recorded sex alone", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Bo /Horvat/
0 @I2@ INDI
1 NAME Eva /Horvat/
0 @I3@ INDI
1 NAME Jan /Kos/
1 SEX M
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
0 TRLR`);
    // I1 (husband) and I2 (wife) are SEX U; I3 already male and not a spouse.
    expect(countInferableSex(ds)).toBe(2);

    const patches = fixSexFromRole(ds);
    expect(patches.length).toBe(2);
    expect(ds.individuals.get("@I1@")!.sex).toBe("M");
    expect(ds.individuals.get("@I2@")!.sex).toBe("F");
    // Re-running is a no-op once the sexes are filled in.
    expect(fixSexFromRole(ds)).toHaveLength(0);
  });

  it("leaves a person with conflicting roles (HUSB here, WIFE there) untouched", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ambiguous /Person/
0 @I2@ INDI
1 NAME Other /Person/
1 SEX F
0 @I3@ INDI
1 NAME Third /Person/
1 SEX M
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I1@
0 TRLR`);
    expect(countInferableSex(ds)).toBe(0);
    expect(fixSexFromRole(ds)).toHaveLength(0);
    expect(ds.individuals.get("@I1@")!.sex).toBe("U");
  });
});

describe("fixDuplicatePointers", () => {
  it("drops repeated CHIL/FAMS/FAMC lines, keeping one of each", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Bo /Horvat/
1 SEX M
1 FAMS @F1@
1 FAMS @F1@
0 @I2@ INDI
1 NAME Eva /Horvat/
1 SEX F
1 FAMS @F1@
0 @I3@ INDI
1 NAME Maj /Horvat/
1 SEX F
1 FAMC @F1@
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I3@
0 TRLR`);
    // I1 (FAMS twice), I3 (FAMC twice), F1 (CHIL twice) → 3 redundant pointers.
    expect(validateDataset(ds, 2026).counts.duplicatePointer).toBe(3);

    const patches = fixDuplicatePointers(ds);
    expect(patches.length).toBe(3); // I1, I3, F1 each changed once

    const after = validateDataset(ds, 2026);
    expect(after.counts.duplicatePointer).toBe(0);
    // One pointer of each kind survives — the valid links are intact.
    expect(ds.individuals.get("@I1@")!.spouseOf).toEqual(["@F1@"]);
    expect(ds.individuals.get("@I3@")!.childOf).toEqual(["@F1@"]);
    expect(ds.families.get("@F1@")!.children).toEqual(["@I3@"]);
  });

  it("returns no patches when there is nothing to fix", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jan /Kos/
1 SEX M
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
0 TRLR`);
    expect(fixDuplicatePointers(ds)).toHaveLength(0);
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

  it("does not flag cousins with the same surname, town and era but different parents", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Margaret Frances /Sustarich/
1 SEX F
1 BIRT
2 DATE 9 JUL 1904
2 PLAC Calumet,,Houghton,Michigan,United States
1 FAMC @F1@
0 @I2@ INDI
1 NAME Agnes Rose /Sustarich/
1 SEX F
1 BIRT
2 DATE 14 FEB 1903
2 PLAC Calumet,,Houghton,Michigan,United States
1 FAMC @F2@
0 @I3@ INDI
1 NAME Jacob Jack /Sustarich/
1 SEX M
0 @I4@ INDI
1 NAME Margaret /Butala/
1 SEX F
0 @I5@ INDI
1 NAME John /Sustarich/
1 SEX M
0 @I6@ INDI
1 NAME Annie /Sedlar/
1 SEX F
0 @F1@ FAM
1 HUSB @I3@
1 WIFE @I4@
1 CHIL @I1@
0 @F2@ FAM
1 HUSB @I5@
1 WIFE @I6@
1 CHIL @I2@
0 TRLR`);
    expect(findDuplicates(ds).some((p) => [p.aId, p.bId].includes("@I1@"))).toBe(false);
  });

  it("does not flag two siblings (shared parents, born different years)", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 12 JAN 1850
2 PLAC Ljubljana
1 FAMC @F1@
0 @I2@ INDI
1 NAME Jozef /Novak/
1 SEX M
1 BIRT
2 DATE 3 MAR 1853
2 PLAC Ljubljana
1 FAMC @F1@
0 @I3@ INDI
1 NAME Anton /Novak/
1 SEX M
0 @I4@ INDI
1 NAME Marija /Kovac/
1 SEX F
0 @F1@ FAM
1 HUSB @I3@
1 WIFE @I4@
1 CHIL @I1@
1 CHIL @I2@
0 TRLR`);
    expect(findDuplicates(ds)).toHaveLength(0);
  });

  it("does not flag twins (shared parents, same birth year, different given names)", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Anton /Rogelj/
1 SEX M
1 BIRT
2 DATE 2 JUN 1888
2 PLAC Žablje,Kranj,Slovenia
1 FAMC @F1@
0 @I2@ INDI
1 NAME Alojz /Rogelj/
1 SEX M
1 BIRT
2 DATE 2 JUN 1888
2 PLAC Žablje,Kranj,Slovenia
1 FAMC @F1@
0 @I3@ INDI
1 NAME Valentin /Rogelj/
1 SEX M
0 @I4@ INDI
1 NAME Jera /Vrtnik/
1 SEX F
0 @F1@ FAM
1 HUSB @I3@
1 WIFE @I4@
1 CHIL @I1@
1 CHIL @I2@
0 TRLR`);
    expect(findDuplicates(ds)).toHaveLength(0);
  });

  it("does not flag different given names sharing only a surname and era", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Franjo /Troha/
1 SEX M
1 BIRT
2 DATE ABT 1880
0 @I2@ INDI
1 NAME Jakov /Troha/
1 SEX M
1 BIRT
2 DATE 30 APR 1879
2 PLAC Stara Sušica,Primorje-Gorski Kotar,Croatia
0 TRLR`);
    expect(findDuplicates(ds).some((p) => [p.aId, p.bId].includes("@I1@"))).toBe(false);
  });

  it("does not flag a namesake child (same name and parents, born after a dead sibling)", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 12 JAN 1850
1 DEAT
2 DATE 1852
1 FAMC @F1@
0 @I2@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 4 MAY 1853
1 FAMC @F1@
0 @I3@ INDI
1 NAME Anton /Novak/
1 SEX M
0 @I4@ INDI
1 NAME Marija /Kovac/
1 SEX F
0 @F1@ FAM
1 HUSB @I3@
1 WIFE @I4@
1 CHIL @I1@
1 CHIL @I2@
0 TRLR`);
    expect(findDuplicates(ds)).toHaveLength(0);
  });

  it("still flags a true duplicate that shares parents and birth year", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 12 JAN 1850
1 FAMC @F1@
0 @I2@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 12 JAN 1850
1 FAMC @F1@
0 @I3@ INDI
1 NAME Anton /Novak/
1 SEX M
0 @I4@ INDI
1 NAME Marija /Kovac/
1 SEX F
0 @F1@ FAM
1 HUSB @I3@
1 WIFE @I4@
1 CHIL @I1@
1 CHIL @I2@
0 TRLR`);
    const pairs = findDuplicates(ds);
    expect(pairs).toHaveLength(1);
    expect([pairs[0].aId, pairs[0].bId].sort()).toEqual(["@I1@", "@I2@"]);
  });
});

describe("mediaUsedBy", () => {
  it("carries each citing record's crop region for the shared photo", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 OBJE @O1@
2 CROP
3 TOP 10
3 LEFT 20
3 HEIGHT 100
3 WIDTH 80
0 @I2@ INDI
1 NAME Bo /Novak/
1 OBJE @O1@
2 CROP
3 TOP 200
3 LEFT 300
3 HEIGHT 120
3 WIDTH 90
0 @I3@ INDI
1 NAME Cita /Novak/
1 OBJE @O1@
0 @O1@ OBJE
1 FILE group.jpg
0 TRLR`);
    const uses = mediaUsedBy(ds, "@O1@");
    const byId = new Map(uses.map((u) => [u.persons[0].id, u.crop]));
    expect(byId.get("@I1@")).toEqual({ top: 10, left: 20, height: 100, width: 80 });
    expect(byId.get("@I2@")).toEqual({ top: 200, left: 300, height: 120, width: 90 });
    // A reference without a CROP carries no region.
    expect(byId.get("@I3@")).toBeUndefined();
  });
});

describe("buildSourceTree", () => {
  it("nests REPO → SOUR → OBJE and tracks the records that cite them", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 BIRT
2 DATE 1850
2 SOUR @S1@
3 OBJE @O1@
0 @R1@ REPO
1 NAME Nadškofijski arhiv
1 WWW https://example.org
0 @S1@ SOUR
1 TITL Krstna knjiga
1 REPO @R1@
1 OBJE @O1@
0 @O1@ OBJE
1 FILE https://example.org/scan.jpg
1 TITL Stran 42
0 @S2@ SOUR
1 TITL Brez hrambe
0 TRLR`);
    const tree = buildSourceTree(ds);
    expect(tree.repoCount).toBe(1);
    expect(tree.sourceCount).toBe(2);

    const repo = tree.repos.find((r) => r.xref === "@R1@");
    expect(repo?.name).toBe("Nadškofijski arhiv");
    expect(repo?.sources).toHaveLength(1);

    const src = repo!.sources[0];
    expect(src.title).toBe("Krstna knjiga");
    expect(src.usedBy.map((u) => u.persons.map((p) => p.id))).toEqual([["@I1@"]]);
    expect(src.media[0].url).toBe("https://example.org/scan.jpg");
    expect(src.media[0].usedBy.map((u) => u.persons.map((p) => p.id))).toEqual([["@I1@"]]);

    // A source with no REPO falls into the synthetic "no repository" bucket.
    const noRepo = tree.repos.find((r) => r.xref === undefined);
    expect(noRepo?.sources.map((s) => s.xref)).toEqual(["@S2@"]);
  });

  it("names a TITL-less source from PERI and lists every field in the tooltip", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 DEAT
2 SOUR @S1@
0 @S1@ SOUR
1 _STE @T37@
1 PERI Gorenjski glas, 28 Jan 1970
1 DATE 28 Jan 1970
1 REPO @R1@
0 @R1@ REPO
1 NAME dLib.si
0 TRLR`);
    const src = buildSourceTree(ds).repos.flatMap((r) => r.sources).find((s) => s.xref === "@S1@")!;
    // Falls back to PERI when there is no TITL/ABBR (no longer the bare xref).
    expect(src.title).toBe("Gorenjski glas, 28 Jan 1970");
    // Tooltip carries the descriptive fields; structural tags (REPO, _STE) are omitted.
    expect(src.tooltip).toBe("PERI: Gorenjski glas, 28 Jan 1970\nDATE: 28 Jan 1970");
  });
});

describe("buildPlaceTree", () => {
  it("arranges places country-first and groups no-country places under Unspecified", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Kos/
1 BIRT
2 PLAC Šentvid 23, Ljubljana, Slovenija
0 @I2@ INDI
1 NAME Bo /Kos/
1 BIRT
2 PLAC Kranj
0 TRLR`);
    const tree = buildPlaceTree(ds);
    expect(tree.distinctCount).toBe(2);
    expect(tree.totalUses).toBe(2);

    const si = tree.roots.find((r) => r.name === "Slovenija");
    expect(si?.children.map((c) => c.name)).toEqual(["Ljubljana"]);
    const lj = si!.children[0];
    // A locality with a house number is kept combined as one address node.
    expect(lj.children[0].name).toBe("Šentvid 23");

    const unspecified = tree.roots.find((r) => r.name === UNSPECIFIED);
    expect(unspecified?.children.map((c) => c.name)).toEqual(["Kranj"]);
    expect(unspecified?.children[0].uses.map((u) => u.persons.map((p) => p.id))).toEqual([["@I2@"]]);
  });

  it("sorts house numbers numerically, not lexicographically", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME A /X/
1 RESI
2 PLAC Vas 10, Kranj, Slovenija
0 @I2@ INDI
1 NAME B /X/
1 RESI
2 PLAC Vas 2, Kranj, Slovenija
0 TRLR`);
    const tree = buildPlaceTree(ds);
    // House numbers stay combined with the locality ("Vas 2" / "Vas 10"); the
    // numeric-aware collator must still order them 2 before 10, not lexically.
    const kranj = tree.roots
      .find((r) => r.name === "Slovenija")!
      .children.find((c) => c.name === "Kranj")!;
    expect(kranj.children.map((c) => c.name)).toEqual(["Vas 2", "Vas 10"]);
  });

  it("buckets a standalone ADDR (no PLAC) under Unspecified place", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Kos/
1 RESI
2 ADDR Trg Brolo 11, p.p. 114
0 TRLR`);
    const tree = buildPlaceTree(ds);
    const bucket = tree.roots.find((r) => r.name === UNSPECIFIED_PLACE);
    expect(bucket).toBeTruthy();
    const brolo = bucket!.children.find((c) => c.name === "Trg Brolo");
    expect(brolo).toBeTruthy();
    expect(brolo!.count).toBe(1);
    // The standalone address still counts toward the totals.
    expect(tree.totalUses).toBe(1);
    // A real PLAC place must not land in the address bucket.
    expect(tree.roots.some((r) => r.name === UNSPECIFIED)).toBe(false);
  });

  it("nests an event's ADDR as a level beneath its place", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Kos/
1 RESI
2 PLAC Kranj, Slovenija
2 ADDR Kidričeva 38, Kranj
0 TRLR`);
    const tree = buildPlaceTree(ds);
    const si = tree.roots.find((r) => r.name === "Slovenija");
    const kranj = si!.children.find((c) => c.name === "Kranj");
    const addr = kranj!.children.find((c) => c.name === "Kidričeva 38");
    expect(addr).toBeTruthy();
    expect(addr!.uses.map((u) => u.persons.map((p) => p.id))).toEqual([["@I1@"]]);
  });
});

describe("collectLocalMediaFiles", () => {
  it("collects inline and shared local files, skips URLs, links usages", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 OBJE
2 FILE photos/ana.jpg
1 OBJE @O1@
0 @I2@ INDI
1 NAME Bo /Novak/
1 OBJE @O1@
1 OBJE
2 FILE https://example.com/web.jpg
0 @O1@ OBJE
1 FILE shared/bo.jpg
1 TITL Portrait
0 TRLR`);
    const files = collectLocalMediaFiles(ds);
    const byFile = new Map(files.map((f) => [f.file, f]));
    // The inline file and the shared file are both collected; the URL is skipped.
    expect([...byFile.keys()].sort()).toEqual(["photos/ana.jpg", "shared/bo.jpg"]);
    // The shared file is referenced by both individuals, with its title kept.
    const shared = byFile.get("shared/bo.jpg")!;
    expect(shared.title).toBe("Portrait");
    expect(shared.usedBy.flatMap((u) => u.persons.map((p) => p.id)).sort()).toEqual(["@I1@", "@I2@"]);
  });

  it("skips a labelled URL where the link trails a caption", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Uršula /Sajovic/
1 OBJE @O1@
0 @O1@ OBJE
1 FILE #018 - https://data.matricula-online.eu/sl/slovenia/ljubljana/sencur/03164/?pg=18
0 TRLR`);
    expect(collectLocalMediaFiles(ds)).toEqual([]);
  });

  it("reports a shared record cited by no individual, with no usages", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @O1@ OBJE
1 FILE orphan.jpg
0 TRLR`);
    const files = collectLocalMediaFiles(ds);
    expect(files).toHaveLength(1);
    expect(files[0].file).toBe("orphan.jpg");
    expect(files[0].usedBy).toEqual([]);
  });
});

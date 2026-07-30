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
import { bulkNormalize } from "./bulkNormalize";

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

  it("flags a mother with children by two fathers in the same years", () => {
    // Marija has Kotnik children 1862–1872 and, in the middle of that run, a
    // Žnidar child in 1866 — impossible for one mother.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Remec/
1 SEX F
1 BIRT
2 DATE 01.10.1843
1 FAMS @F1@
1 FAMS @F2@
0 @I2@ INDI
1 NAME Jožef /Kotnik/
1 SEX M
1 FAMS @F1@
0 @I3@ INDI
1 NAME Anton /Žnidar/
1 SEX M
1 FAMS @F2@
0 @I4@ INDI
1 NAME Jakob /Kotnik/
1 BIRT
2 DATE 11.07.1862
1 FAMC @F1@
0 @I5@ INDI
1 NAME Ana /Kotnik/
1 BIRT
2 DATE 12.03.1872
1 FAMC @F1@
0 @I6@ INDI
1 NAME Neža /Žnidar/
1 BIRT
2 DATE 04.05.1866
1 FAMC @F2@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I1@
1 CHIL @I4@
1 CHIL @I5@
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I1@
1 CHIL @I6@
0 TRLR`);
    const report = validateDataset(ds, 2026);
    const issue = report.issues.find((i) => i.category === "parallelFamilies");
    expect(issue?.id).toBe("@I1@"); // reported on the mother
    expect(issue?.messageVars?.child).toContain("Neža Žnidar");
    expect(issue?.messageVars?.spanA).toBe("1862–1872");
    expect(report.counts.parallelFamilies).toBe(1);
  });

  it("leaves consecutive marriages, adopted children and the father side alone", () => {
    // Ana's Novak children (1860, 1864) all precede her Kovač child (1870);
    // Jože fathers children with two women at once (possible); the child that
    // does fall inside another run is adopted.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX F
1 FAMS @F1@
1 FAMS @F2@
0 @I2@ INDI
1 NAME Jože /Novak/
1 SEX M
1 FAMS @F1@
1 FAMS @F3@
0 @I3@ INDI
1 NAME Franc /Kovač/
1 SEX M
1 FAMS @F2@
0 @I4@ INDI
1 NAME Micka /Zupan/
1 SEX F
1 FAMS @F3@
0 @I5@ INDI
1 BIRT
2 DATE 1860
1 FAMC @F1@
0 @I6@ INDI
1 BIRT
2 DATE 1864
1 FAMC @F1@
0 @I7@ INDI
1 BIRT
2 DATE 1870
1 FAMC @F2@
0 @I8@ INDI
1 BIRT
2 DATE 1862
1 FAMC @F3@
0 @I9@ INDI
1 BIRT
2 DATE 1863
1 FAMC @F2@
2 PEDI adopted
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I1@
1 CHIL @I5@
1 CHIL @I6@
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I1@
1 CHIL @I7@
1 CHIL @I9@
0 @F3@ FAM
1 HUSB @I2@
1 WIFE @I4@
1 CHIL @I8@
0 TRLR`);
    const report = validateDataset(ds, 2026);
    expect(report.counts.parallelFamilies).toBe(0);
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

  it("does not flag a genuine same-sex couple as a sex/role conflict", () => {
    // Two men — one fills the HUSB slot, one the WIFE slot (the standard way to
    // store a same-sex marriage in GEDCOM). This is not a contradiction.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX M
1 FAMS @F1@
0 @I2@ INDI
1 NAME Bo /Novak/
1 SEX M
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
0 TRLR`);
    const report = validateDataset(ds, 2026);
    expect(report.counts.roleSexConflict).toBe(0);
  });

  it("flags two different people crammed into one spouse slot", () => {
    // Two HUSB lines: the builder keeps only the last (@I2@), so @I1@ is hidden.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX M
1 FAMS @F1@
0 @I2@ INDI
1 NAME Bo /Novak/
1 SEX M
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 HUSB @I2@
0 TRLR`);
    const report = validateDataset(ds, 2026);
    const hidden = report.issues.filter((i) => i.category === "multiSpouseSlot");
    expect(hidden).toHaveLength(1);
    expect(report.counts.multiSpouseSlot).toBe(1);
    // Names the shown (last) and hidden (earlier) partner.
    expect(hidden[0].messageVars?.shown).toContain("Bo");
    expect(hidden[0].messageVars?.hidden).toContain("Ana");
  });

  it("does not flag a repeated identical spouse pointer as a hidden partner", () => {
    // Same xref twice in HUSB — a redundant line, not two people.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 SEX M
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 HUSB @I1@
0 TRLR`);
    const report = validateDataset(ds, 2026);
    expect(report.counts.multiSpouseSlot).toBe(0);
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

  it("classifies vendor tags the registry knows, keeping unknown ones generic", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 _UID ABC-123
1 _TOTALLY_MADE_UP x
0 TRLR`);
    const custom = validateStructure(ds).issues.filter((i) => i.category === "customTag");
    const known = custom.find((i) => i.messageVars?.tag === "_UID");
    const generic = custom.find((i) => i.messageVars?.tag === "_TOTALLY_MADE_UP");
    expect(known?.messageKey).toBe("tools.validate.struct.issue.customTagKnown");
    expect(known?.messageVars).toMatchObject({ software: "multiple programs" });
    expect(known?.messageVars?.meaningEn).toBeTruthy();
    expect(known?.messageVars?.meaningSl).toBeTruthy();
    expect(generic?.messageKey).toBe("tools.validate.struct.issue.customTag");
  });

  it("classifies bare tags declared by the file's own _STF source-template fields", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @TF35@ _STF
1 _NKY SourceTemplate_KeyName_MicrofilmRollNumber
1 _TAG ROLN
0 @S1@ SOUR
1 TITL Census 1910
1 ROLN 12345
1 BOGUS x
0 TRLR`);
    const report = validateStructure(ds);
    const roln = report.issues.find((i) => i.messageVars?.tag === "ROLN");
    expect(roln?.category).toBe("customTag");
    expect(roln?.messageKey).toBe("tools.validate.struct.issue.customTagKnown");
    expect(roln?.messageVars).toMatchObject({ software: "MacFamilyTree" });
    expect(roln?.messageVars?.meaningEn).toBe("source-template field (microfilm roll number)");
    // An undeclared bare tag is still unknown.
    const bogus = report.issues.find((i) => i.messageVars?.tag === "BOGUS");
    expect(bogus?.category).toBe("unknownTag");
  });

  it("folds a MacFamilyTree SECG second given name into the parsed given when it's extra", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Sonja //
2 GIVN Sonja
2 SECG Lidija
0 @I2@ INDI
1 NAME Milan Ivan /Miklič/
2 GIVN Milan
2 SECG Ivan
0 TRLR
`);
    // Extra second given is folded in; a restated one isn't duplicated.
    expect(ds.individuals.get("@I1@")!.names[0].given).toBe("Sonja Lidija");
    expect(ds.individuals.get("@I2@")!.names[0].given).toBe("Milan Ivan");
  });

  it("classifies MacFamilyTree's bare vendor tags as custom info, not unknown warnings", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
2 SECG Teresa
1 RACE White
1 MISE WWII
0 @S1@ SOUR
1 PERI Kranjski zvon, Dec 1934
0 TRLR
`);
    const report = validateStructure(ds);
    expect(report.issues.filter((i) => i.category === "unknownTag")).toHaveLength(0);
    const custom = report.issues.filter((i) => i.category === "customTag");
    expect(custom.map((i) => i.sample).sort()).toEqual(["MISE", "RACE", "SECG"]);
    expect(custom.every((i) => i.severity === "info" && i.messageKey === "tools.validate.struct.issue.customTagKnown")).toBe(true);
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

  it("flags pointers to records that don't exist, but not calendar escapes", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
1 NOTE @N9@
1 BIRT
2 DATE @#DJULIAN@ 4 MAR 1799
2 SOUR @S1@
1 ASSO @I7@
0 @S1@ SOUR
1 TITL Krstna knjiga
0 TRLR`);
    const dangling = validateStructure(ds).issues.filter((i) => i.category === "danglingXref");
    const byXref = Object.fromEntries(dangling.map((i) => [i.messageVars?.xref, i.messageVars?.tag]));
    // @S1@ resolves; the DATE calendar escape is not a pointer.
    expect(byXref).toEqual({ "@N9@": "NOTE", "@I7@": "ASSO" });
    expect(dangling.every((i) => i.severity === "error")).toBe(true);
    expect(dangling[0].recordId).toBe("@I1@");
  });

  it("surfaces a duplicate record xref (detected at load) as its own category", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Novak/
0 @I1@ INDI
1 NAME Bo /Kos/
0 TRLR`);
    expect(ds.warnings.some((w) => w.kind === "structure" && w.message.startsWith("Duplicate xref @I1@"))).toBe(true);
    const dup = validateStructure(ds).issues.filter((i) => i.category === "duplicateXref");
    expect(dup).toHaveLength(1);
    expect(dup[0].severity).toBe("error");
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

  it("repairs comma'd month-word dates, whose month word leaves nothing to guess", () => {
    const ctx = dateFixContext(dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 BIRT
2 DATE 26 JUN 1912
1 DEAT
2 DATE 6 APR 1975
0 TRLR`));
    // US written form, in a day-first file: the month word pins the month, so
    // the day/year are unambiguous and the result is re-rendered day-first.
    expect(proposeDateFix("Apr 12, 1979", ctx)).toBe("12 APR 1979");
    expect(proposeDateFix("Dec 27, 1975", ctx)).toBe("27 DEC 1975");
    expect(proposeDateFix("Apr. 12, 1979", ctx)).toBe("12 APR 1979");
    expect(proposeDateFix("12 Apr, 1979", ctx)).toBe("12 APR 1979");
    expect(proposeDateFix("Sep, 1979", ctx)).toBe("SEP 1979");
    // Dropping a comma must not invent a date out of free text.
    expect(proposeDateFix("1979, Ljubljana", ctx)).toBeUndefined();
    expect(proposeDateFix("spring, 1979", ctx)).toBeUndefined();
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

  it("scoped to one pointer, repairs that finding and leaves the others", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Eva /Horvat/
1 SEX F
1 FAMC @F8@
1 FAMC @F9@
0 @F2@ FAM
1 HUSB @I9@
0 TRLR`);
    expect(validateDataset(ds, 2026).counts.brokenLink).toBe(3);

    // Only the @F9@ pointer on @I1@ — its sibling @F8@ and the family's dead
    // HUSB are other findings, each with its own row and its own fix button.
    const patches = fixBrokenLinks(ds, { id: "@I1@", target: "@F9@" });
    expect(patches).toHaveLength(1);
    expect(ds.individuals.get("@I1@")!.childOf).toEqual(["@F8@"]);
    expect(ds.families.get("@F2@")!.husband).toBe("@I9@");
    expect(validateDataset(ds, 2026).counts.brokenLink).toBe(2);

    // …then the family-side one, named by its own record and target.
    expect(fixBrokenLinks(ds, { id: "@F2@", target: "@I9@" })).toHaveLength(1);
    expect(ds.families.get("@F2@")!.husband).toBeUndefined();
    expect(validateDataset(ds, 2026).counts.brokenLink).toBe(1);
  });

  it("scoped to a record, repairs every broken pointer it carries", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Eva /Horvat/
1 SEX F
1 FAMC @F8@
1 FAMS @F9@
0 @F2@ FAM
1 HUSB @I9@
0 TRLR`);
    expect(fixBrokenLinks(ds, { id: "@I1@" })).toHaveLength(1);
    expect(ds.individuals.get("@I1@")!.childOf).toHaveLength(0);
    expect(ds.individuals.get("@I1@")!.spouseOf).toHaveLength(0);
    expect(validateDataset(ds, 2026).counts.brokenLink).toBe(1);
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

  it("reports monotonic progress over the individuals scanned", () => {
    // Enough individuals to cross the progress interval (256) at least twice.
    const people = Array.from({ length: 600 }, (_, i) =>
      `0 @I${i + 1}@ INDI\n1 NAME Oseba${i} /Priimek${i}/\n1 SEX M\n1 BIRT\n2 DATE ${1800 + (i % 100)}`,
    ).join("\n");
    const ds = dataset(`0 HEAD\n1 CHAR UTF-8\n${people}\n0 TRLR`);
    const calls: Array<[number, number]> = [];
    findDuplicates(ds, undefined, undefined, (done, total) => calls.push([done, total]));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [done, total] of calls) {
      expect(total).toBe(600);
      expect(done).toBeGreaterThan(0);
      expect(done).toBeLessThanOrEqual(total);
    }
    const dones = calls.map(([done]) => done);
    expect([...dones].sort((a, b) => a - b)).toEqual(dones);
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

  it("does not flag same-named cousins whose fathers differ, even with both mothers named Marija", () => {
    // The classic dense-cluster false positive: same name, same birth year
    // (different months), fathers Anton vs Jakob (similarity 0.600 — the old
    // single 0.6 threshold called that an *agreement*), and the ubiquitous
    // mother given name agreeing on both sides. The father conflict must veto;
    // the cheap mother agreement must not rescue the pair.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Sattler/
1 SEX F
1 BIRT
2 DATE 16 JUN 1903
1 FAMC @F1@
0 @I2@ INDI
1 NAME Marija /Sattler/
1 SEX F
1 BIRT
2 DATE 25 SEP 1903
1 FAMC @F2@
0 @I3@ INDI
1 NAME Anton /Sattler/
1 SEX M
0 @I4@ INDI
1 NAME Marija /Horvat/
1 SEX F
0 @I5@ INDI
1 NAME Jakob /Sattler/
1 SEX M
0 @I6@ INDI
1 NAME Marija /Zupan/
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
    expect(findDuplicates(ds)).toHaveLength(0);
  });

  it("still flags a same-day pair whose mother is recorded under a cross-language variant", () => {
    // Two copies of one christening entry (identical exact birth day) with the
    // mother written Gertrud in one and Jera in the other (the same name in
    // the German vs Slovene register). The parent vetoes must not fire on a
    // day-identical pair.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Rihtaršič/
1 SEX M
1 BIRT
2 DATE 18 OCT 1869
1 FAMC @F1@
0 @I2@ INDI
1 NAME Janez /Rihtaršič/
1 SEX M
1 BIRT
2 DATE 18 OCT 1869
1 FAMC @F2@
0 @I3@ INDI
1 NAME Jakob /Rihtaršič/
1 SEX M
0 @I4@ INDI
1 NAME Gertrud /Kos/
1 SEX F
0 @I5@ INDI
1 NAME Jakob /Rihtaršič/
1 SEX M
0 @I6@ INDI
1 NAME Jera /Kos/
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
    const pairs = findDuplicates(ds);
    expect(pairs.some((p) => [p.aId, p.bId].sort().join("|") === "@I1@|@I2@")).toBe(true);
  });

  it("still flags a same-day pair whose father is recorded under a cross-language variant", () => {
    // Same christening entry, father written Georg vs Jurij (similarity 0.47,
    // deep in the conflict band) — the same-exact-birth-day escape must
    // pre-empt the father veto.
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Marija /Potokar/
1 SEX F
1 BIRT
2 DATE 14 NOV 1843
1 FAMC @F1@
0 @I2@ INDI
1 NAME Marija /Potokar/
1 SEX F
1 BIRT
2 DATE 14 NOV 1843
1 FAMC @F2@
0 @I3@ INDI
1 NAME Georg /Potokar/
1 SEX M
0 @I4@ INDI
1 NAME Jurij /Potokar/
1 SEX M
0 @F1@ FAM
1 HUSB @I3@
1 CHIL @I1@
0 @F2@ FAM
1 HUSB @I4@
1 CHIL @I2@
0 TRLR`);
    const pairs = findDuplicates(ds);
    expect(pairs.some((p) => [p.aId, p.bId].sort().join("|") === "@I1@|@I2@")).toBe(true);
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

  it("reports each path's coordinate, taking the prevailing one where they disagree", () => {
    const ds = dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Kos/
1 BIRT
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.23887
4 LONG E14.35561
1 DEAT
2 PLAC Bled, Slovenija
0 @I2@ INDI
1 NAME Bo /Kos/
1 BIRT
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.23887
4 LONG E14.35561
0 @I3@ INDI
1 NAME Cita /Kos/
1 BIRT
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.9
4 LONG E14.9
0 TRLR`);
    const si = buildPlaceTree(ds).roots.find((r) => r.name === "Slovenija")!;
    const kranj = si.children.find((c) => c.name === "Kranj")!;
    // Two records agree, one disagrees — the majority value is the one shown.
    expect(kranj.coord).toEqual({ lat: 46.23887, lon: 14.35561 });
    // A place the file never geocoded reports none, and neither does the
    // country level above it: a coordinate belongs to the path that wrote it.
    expect(si.children.find((c) => c.name === "Bled")!.coord).toBeUndefined();
    expect(si.coord).toBeUndefined();
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

describe("bulkNormalize vendor-tag dialect", () => {
  const person = (headSour: string) => `0 HEAD
1 CHAR UTF-8${headSour ? `\n1 SOUR ${headSour}` : ""}
0 @I1@ INDI
1 NAME Janez /Novak/
1 MISE Gefreiter, k.k. Landsturm
2 DATE 1915
0 TRLR`;

  it("keeps MacFamilyTree's native MISE when the file is MacFamilyTree's own", () => {
    const { dataset: out, report } = bulkNormalize(dataset(person("SyniumFamilyTree")));
    const raw = out.individuals.get("@I1@")!.raw;
    expect(raw.children.some((c) => c.tag === "MISE")).toBe(true);
    expect(raw.children.some((c) => c.tag === "_MILT")).toBe(false);
    expect(report.vendorTagsRenamed).toBe(0);
  });

  it("still canonicalizes MISE in a file from any other producer", () => {
    const { dataset: out, report } = bulkNormalize(dataset(person("Gramps")));
    const raw = out.individuals.get("@I1@")!.raw;
    expect(raw.children.some((c) => c.tag === "_MILT")).toBe(true);
    expect(report.vendorTagsRenamed).toBe(1);

    const noHeader = bulkNormalize(dataset(person("")));
    expect(noHeader.report.vendorTagsRenamed).toBe(1);
  });

  it("still renames _MILI in a Brother's Keeper file — _MILT is BK's own spelling too", () => {
    const { dataset: out, report } = bulkNormalize(dataset(`0 HEAD
1 CHAR UTF-8
1 SOUR BROSKEEP
0 @I1@ INDI
1 NAME Janez /Novak/
1 _MILI Landsturm
0 TRLR`));
    const raw = out.individuals.get("@I1@")!.raw;
    expect(raw.children.some((c) => c.tag === "_MILT")).toBe(true);
    expect(report.vendorTagsRenamed).toBe(1);
  });

  it("keeps _SEPR in a Brother's Keeper file — SEPA is foreign to BK's dialect", () => {
    const { dataset: out, report } = bulkNormalize(dataset(`0 HEAD
1 CHAR UTF-8
1 SOUR BROSKEEP
0 @F1@ FAM
1 _SEPR
2 DATE 5 JAN 1930
0 TRLR`));
    const raw = out.families.get("@F1@")!.raw;
    expect(raw.children.some((c) => c.tag === "_SEPR")).toBe(true);
    expect(report.vendorTagsRenamed).toBe(0);
  });
});

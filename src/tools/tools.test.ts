import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { validateDataset } from "./validate";
import { findDuplicates } from "./duplicates";
import { buildSourceTree } from "./sources";
import { buildPlaceTree, UNSPECIFIED, UNSPECIFIED_PLACE } from "./places";
import { fixBrokenLinks } from "./fixLinks";

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

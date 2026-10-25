import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../../gedcom/builder";
import { parseGedcom } from "../../gedcom/parser";
import type { GedNode } from "../../gedcom/types";
import { serializeGedcom } from "../../gedcom/serialize";
import { applyRecordPatches } from "../../ui/historyTypes";
import { validateStructure } from "../structure";
import { countFixableConformance, fixConformance } from "../fixConformance";
import { nodeAtPath, tableFor, validateConformance, type ConformanceIssue } from "./conformance";
import { SPEC_55, SPEC_551, SPEC_555 } from "./spec551";
import { SPEC_70 } from "./spec70";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const HEAD_551 = `0 HEAD
1 SOUR TEST
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8`;
const HEAD_70 = `0 HEAD
1 GEDC
2 VERS 7.0`;

/** The findings of a body under a 5.5.1 (or 7.0) header. */
function check551(body: string): ConformanceIssue[] {
  return validateConformance(dataset(`${HEAD_551}\n${body}\n0 TRLR`));
}
function check70(body: string): ConformanceIssue[] {
  return validateConformance(dataset(`${HEAD_70}\n${body}\n0 TRLR`));
}
/** Message kind (last key segment) of each finding. */
const kinds = (issues: ConformanceIssue[]) => issues.map((i) => i.messageKey.split(".").pop());

describe("tableFor", () => {
  const records = (vers?: string) => dataset(`0 HEAD\n${vers ? `1 GEDC\n2 VERS ${vers}\n` : ""}0 TRLR`).records;
  it("picks the table by the version the header declares", () => {
    expect(tableFor(records("5.5.1"))).toBe(SPEC_551);
    expect(tableFor(records("5.5.5"))).toBe(SPEC_555);
    expect(tableFor(records("5.5"))).toBe(SPEC_55);
    expect(tableFor(records("7.0"))).toBe(SPEC_70);
    expect(tableFor(records("7.0.14"))).toBe(SPEC_70);
  });
  it("holds no table for a version it does not know, and checks nothing then", () => {
    expect(tableFor(records("4.0"))).toBeUndefined();
    expect(tableFor(records())).toBeUndefined();
    expect(validateConformance(dataset("0 HEAD\n0 @I1@ INDI\n1 SEX Q\n0 TRLR"))).toEqual([]);
  });
});

describe("table integrity", () => {
  for (const table of [SPEC_551, SPEC_555, SPEC_55, SPEC_70]) {
    it(`${table.version}: every child, root and enumeration names something the table defines`, () => {
      for (const id of Object.values(table.roots)) expect(table.structs[id], id).toBeDefined();
      for (const [id, [payload, list]] of Object.entries(table.structs)) {
        for (const item of list.split(" ").filter(Boolean)) {
          const m = /^([A-Z0-9_]+)(?:=([^:]+))?:(01|11|0M|1M|03)$/.exec(item);
          expect(m, `${id}: ${item}`).not.toBeNull();
          expect(table.structs[m![2] ?? m![1]], `${id}: ${item}`).toBeDefined();
        }
        if (/^[EL]:/.test(payload)) expect(table.enums[payload.slice(2)], `${id}: ${payload}`).toBeDefined();
      }
    });
  }
});

describe("cardinality", () => {
  it("flags a line repeated beyond what the standard allows", () => {
    const issues = check551(`0 @I1@ INDI
1 NAME Ana /Novak/
2 GIVN Ana
2 GIVN Anna
1 SEX F
1 SEX M
1 BIRT
2 DATE 1900
2 DATE 1901
2 SOUR @S1@
3 PAGE 12
3 PAGE 13
0 @S1@ SOUR
1 TITL Register`);
    const tooMany = issues.filter((i) => i.messageKey.endsWith("tooMany"));
    expect(tooMany.map((i) => `${i.messageVars.parent} ${i.messageVars.tag} ${i.messageVars.count}`).sort()).toEqual([
      "INDI SEX 2",
      "INDI.BIRT DATE 2",
      "INDI.BIRT.SOUR PAGE 2",
      "INDI.NAME GIVN 2",
    ]);
    // Different values: nothing to drop safely.
    expect(tooMany.every((i) => !i.repeat)).toBe(true);
    expect(tooMany.every((i) => i.category === "cardinality" && i.severity === "warning")).toBe(true);
  });

  it("marks a repeat made of exact copies as fixable", () => {
    const [issue] = check551(`0 @I1@ INDI\n1 SEX F\n1 SEX F`);
    expect(issue).toMatchObject({ category: "cardinality", repeat: true, sample: "SEX", recordId: "@I1@" });
  });

  it("leaves two different partners in one FAM slot to its own finding, but counts a repeated one", () => {
    const fam = (wife2: string) => `0 @I1@ INDI\n0 @I2@ INDI\n0 @I3@ INDI\n0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 WIFE ${wife2}`;
    expect(check551(fam("@I3@"))).toEqual([]);
    expect(check551(fam("@I2@"))).toMatchObject([{ messageKey: "tools.validate.struct.issue.tooMany", repeat: true }]);
  });

  it("flags a required line that is missing", () => {
    const issues = validateConformance(dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 TRLR`));
    expect(issues.map((i) => `${i.messageVars.parent} ${i.messageVars.tag}`).sort()).toEqual([
      "HEAD CHAR",
      "HEAD SOUR",
      "HEAD.GEDC FORM",
    ]);
    expect(check70(`0 @O1@ OBJE\n1 FILE a.jpg`)).toMatchObject([
      { messageKey: "tools.validate.struct.issue.missing", messageVars: { tag: "FORM", parent: "OBJE.FILE" } },
    ]);
  });

  it("holds 5.5.5 to its own header", () => {
    const ds = dataset(`0 HEAD\n1 SOUR T\n1 GEDC\n2 VERS 5.5.5\n2 FORM LINEAGE-LINKED\n1 CHAR ANSEL\n0 TRLR`);
    expect(kinds(validateConformance(ds)).sort()).toEqual(["enumValue", "missing"]);
  });
});

describe("misplaced tags", () => {
  it("reports a standard tag under a line that cannot carry it, once per habit", () => {
    const issues = check551(`0 @I1@ INDI\n1 BIRT\n2 RIN 1\n0 @I2@ INDI\n1 BIRT\n2 RIN 2`);
    expect(issues).toMatchObject([
      { category: "misplacedTag", messageVars: { tag: "RIN", parent: "INDI.BIRT", count: 2, version: "5.5.1" }, recordId: "@I1@" },
    ]);
  });

  it("leaves extensions, vendor tags and unknown tags to the tag inventory", () => {
    expect(check551(`0 @I1@ INDI\n1 _UID X\n2 DATE 1\n1 WWWW x\n1 BIRT\n2 _FOO\n3 SEX M`)).toEqual([]);
  });

  it("reports a record type the version does not have", () => {
    expect(check70(`0 @N1@ NOTE text`)).toMatchObject([
      { category: "misplacedTag", messageKey: "tools.validate.struct.issue.misplacedRoot", messageVars: { tag: "NOTE" } },
    ]);
  });

  it("accepts the 5.5 multimedia shape 5.5.1 readers are told to read", () => {
    expect(check551(`0 @I1@ INDI\n1 OBJE\n2 FORM jpg\n2 FILE a.jpg\n2 TITL A`)).toEqual([]);
    expect(validateConformance(dataset(`0 HEAD\n1 GEDC\n2 VERS 5.5\n0 @O1@ OBJE\n1 FORM jpg\n1 BLOB\n0 TRLR`))
      .filter((i) => i.category === "misplacedTag")).toEqual([]);
  });
});

describe("pointer targets", () => {
  it("flags a pointer at a record of the wrong type, as an error", () => {
    const issues = check551(`0 @I1@ INDI
1 BIRT
2 FAMC @I2@
2 SOUR @R1@
1 ALIA @F1@
1 ANCI @I2@
0 @I2@ INDI
0 @F1@ FAM
1 SUBM @I1@
0 @R1@ REPO
1 NAME Archive`);
    expect(issues.map((i) => `${i.messageVars.tag} ${i.messageVars.actual}→${i.messageVars.expected}`).sort()).toEqual([
      "ALIA FAM→INDI",
      "ANCI INDI→SUBM",
      "FAMC INDI→FAM",
      "SOUR REPO→SOUR",
      "SUBM INDI→SUBM",
    ]);
    expect(issues.every((i) => i.category === "pointerType" && i.severity === "error")).toBe(true);
  });

  it("leaves a record's own family links to the broken-link finding", () => {
    expect(check551(`0 @I1@ INDI\n1 FAMC @I2@\n1 FAMS @I2@\n0 @I2@ INDI\n0 @F1@ FAM\n1 HUSB @F1@\n1 CHIL @F1@`)).toEqual([]);
  });

  it("leaves a pointer to a missing record to the dangling-reference finding", () => {
    expect(check551(`0 @I1@ INDI\n1 FAMC @F9@`)).toEqual([]);
  });

  it("allows @VOID@ only in 7.0", () => {
    expect(kinds(check551(`0 @I1@ INDI\n1 ALIA @VOID@`))).toEqual(["voidPointer"]);
    expect(check70(`0 @I1@ INDI\n1 ALIA @VOID@`)).toEqual([]);
  });

  it("knows where a pointer is optional, required, or not allowed", () => {
    // 5.5.1: a citation may be text; 7.0: it must point (or be @VOID@).
    expect(check551(`0 @I1@ INDI\n1 SOUR Parish register`)).toEqual([]);
    expect(kinds(check70(`0 @I1@ INDI\n1 SOUR Parish register`))).toEqual(["pointerExpected"]);
    // A repository link without a pointer: 5.5.1 allows it, 7.0 says @VOID@
    // — the fix keeps the call number beneath it.
    expect(check551(`0 @S1@ SOUR\n1 TITL Book\n1 REPO\n2 CALN 5`)).toEqual([]);
    const empty = check70(`0 @S1@ SOUR\n1 TITL Book\n1 REPO\n2 CALN 5`);
    expect(kinds(empty)).toEqual(["pointerEmpty"]);
    expect(empty[0].fix).toBe("@VOID@");
    expect(check70(`0 @S1@ SOUR\n1 TITL Book\n1 REPO @VOID@\n2 CALN 5`)).toEqual([]);
    // 7.0's NOTE is text; a shared note is SNOTE.
    expect(kinds(check70(`0 @I1@ INDI\n1 NOTE @N1@\n0 @N1@ SNOTE x`))).toEqual(["pointerUnexpected"]);
    expect(check70(`0 @I1@ INDI\n1 SNOTE @N1@\n0 @N1@ SNOTE x`)).toEqual([]);
  });

  it("holds a 5.5-style association to the record its TYPE names", () => {
    const body = (type: string) => `0 @I1@ INDI\n1 ASSO @F1@\n2 TYPE ${type}\n2 RELA witness\n0 @F1@ FAM`;
    expect(check551(body("FAM"))).toEqual([]);
    expect(kinds(check551(body("INDI")))).toEqual(["pointerType"]);
  });
});

describe("enumerations", () => {
  it("checks SEX against each version's list", () => {
    expect(kinds(check551(`0 @I1@ INDI\n1 SEX X`))).toEqual(["enumValue"]);
    expect(check70(`0 @I1@ INDI\n1 SEX X`)).toEqual([]);
  });

  it("offers the standard spelling for a value that differs only in case", () => {
    expect(check551(`0 @I1@ INDI\n1 FAMC @F1@\n2 PEDI Adopted\n0 @F1@ FAM`)).toMatchObject([
      { category: "enumValue", messageKey: "tools.validate.struct.issue.enumCase", fix: "adopted", path: "0.0" },
    ]);
    expect(check70(`0 @I1@ INDI\n1 FAMC @F1@\n2 PEDI adopted\n0 @F1@ FAM`)).toMatchObject([{ fix: "ADOPTED" }]);
  });

  it("offers nothing for a value outside the list", () => {
    const [issue] = check551(`0 @I1@ INDI\n1 SOUR @S1@\n2 QUAY high\n0 @S1@ SOUR`);
    expect(issue).toMatchObject({ messageKey: "tools.validate.struct.issue.enumValue", messageVars: { allowed: "0, 1, 2, 3" } });
    expect(issue.fix).toBeUndefined();
  });

  it("lowers MyHeritage's QUAY 4 to the standard's best, 3", () => {
    expect(check551(`0 @I1@ INDI\n1 SOUR @S1@\n2 QUAY 4\n0 @S1@ SOUR`)).toMatchObject([
      { category: "enumValue", messageKey: "tools.validate.struct.issue.quayAbove", fix: "3", path: "0.0" },
    ]);
    expect(check70(`0 @I1@ INDI\n1 BIRT\n2 SOUR @S1@\n3 QUAY 5\n0 @S1@ SOUR`)).toMatchObject([{ fix: "3" }]);
  });

  it("reads 7.0's list-valued RESN item by item", () => {
    expect(check70(`0 @I1@ INDI\n1 RESN confidential, LOCKED`)).toMatchObject([{ fix: "CONFIDENTIAL, LOCKED" }]);
    expect(check70(`0 @I1@ INDI\n1 RESN CONFIDENTIAL, PRIVACY`)).toEqual([]);
    expect(check70(`0 @I1@ INDI\n1 RESN CONFIDENTIAL, NONE`)[0].fix).toBeUndefined();
  });

  it("admits 5.5.1's parenthesised roles and 7.0's extension values", () => {
    expect(check551(`0 @I1@ INDI\n1 SOUR @S1@\n2 EVEN BIRT\n3 ROLE (godfather)\n0 @S1@ SOUR`)).toEqual([]);
    expect(kinds(check551(`0 @I1@ INDI\n1 SOUR @S1@\n2 EVEN BIRT\n3 ROLE godfather\n0 @S1@ SOUR`))).toEqual(["enumValue"]);
    expect(check70(`0 @I1@ INDI\n1 NAME A\n2 TYPE _NICK`)).toEqual([]);
  });

  it("covers the other enumerated lines", () => {
    expect(kinds(check551(`0 @I1@ INDI\n1 ADOP\n2 FAMC @F1@\n3 ADOP father\n0 @F1@ FAM`))).toEqual(["enumValue"]);
    expect(kinds(check551(`0 @I1@ INDI\n1 BAPL\n2 STAT DONE\n3 DATE 1 JAN 2000`))).toEqual(["enumValue"]);
    expect(kinds(check551(`0 @I1@ INDI\n1 OBJE\n2 FILE a.jpg\n3 FORM jpg\n4 MEDI Photo`))).toEqual(["enumCase"]);
    expect(kinds(check70(`0 @I1@ INDI\n1 NAME A\n2 TYPE nick`))).toEqual(["nameTypeNearest"]);
    expect(kinds(check70(`0 @I1@ INDI\n1 ASSO @VOID@\n2 ROLE witn`))).toEqual(["enumCase"]);
    expect(kinds(validateConformance(dataset(`0 HEAD\n1 SOUR T\n1 GEDC\n2 VERS 5.5.1\n2 FORM Lineage-Linked\n1 CHAR ANSI\n0 TRLR`)))).toEqual([
      "enumCase",
      "enumValue",
    ]);
  });

  it("does not offer a fix on a record without an xref (the undo patch needs one)", () => {
    const issues = validateConformance(dataset(`0 HEAD\n1 SOUR T\n1 GEDC\n2 VERS 5.5.1\n2 FORM Lineage-Linked\n1 CHAR UTF-8\n0 TRLR`));
    expect(issues).toMatchObject([{ messageKey: "tools.validate.struct.issue.enumCase" }]);
    expect(issues[0].fix).toBeUndefined();
  });

  it("checks 7.0's Y-or-nothing event lines", () => {
    expect(check70(`0 @I1@ INDI\n1 BIRT Y\n1 DEAT`)).toEqual([]);
    expect(check70(`0 @I1@ INDI\n1 BIRT y`)).toMatchObject([{ messageKey: "tools.validate.struct.issue.badY", fix: "Y" }]);
    expect(check70(`0 @I1@ INDI\n1 BIRT nezakonski`)).toMatchObject([{ fix: "nezakonski", toNote: true }]);
  });

  it("rewrites a 5.5.1 calendar escape left in a 7.0 date, where the word has a place", () => {
    expect(check70(`0 @I1@ INDI\n1 BIRT\n2 DATE ABT @#DJULIAN@ 1700`)).toMatchObject([
      { messageKey: "tools.validate.struct.issue.calendarEscape", fix: "ABT JULIAN 1700" },
    ]);
    expect(check70(`0 @I1@ INDI\n1 BIRT\n2 DATE @#DFRENCH R@ 1 VEND 11`)).toMatchObject([{ fix: "FRENCH_R 1 VEND 11" }]);
    expect(check70(`0 @I1@ INDI\n1 BIRT\n2 DATE @#DROMAN@ 1700`)[0].fix).toBeUndefined();
    expect(check70(`0 @I1@ INDI\n1 BIRT\n2 DATE @#DJULIAN@ ABT 1700`)[0].fix).toBeUndefined();
    // 5.5.1's own grammar; an unreadable escape is "Unparseable dates".
    expect(check551(`0 @I1@ INDI\n1 BIRT\n2 DATE @#DJULIAN@ 1700\n1 DEAT\n2 DATE @#DBOGUS@ 1700`)).toEqual([]);
  });
});

describe("value formats and record ids", () => {
  it("reads AGE by each version's grammar", () => {
    const age = (v: string, check = check551) => check(`0 @I1@ INDI\n1 DEAT\n2 AGE ${v}`);
    for (const ok of ["42y", "42y 3m 2d", "< 1y", ">5m", "CHILD", "stillborn", "3d"]) expect(age(ok), ok).toEqual([]);
    for (const bad of ["73", "0", "39-40", "about 40"]) expect(kinds(age(bad)), bad).toEqual(["badAge"]);
    expect(age("2y 3w", check70)).toEqual([]);
    expect(kinds(age("CHILD", check70))).toEqual(["badAge"]);
  });

  it("checks 7.0's LANG as a BCP 47 tag", () => {
    expect(check70(`0 @I1@ INDI\n1 NAME A\n2 TRAN B\n3 LANG sl`)).toEqual([]);
    expect(check70(`0 @I1@ INDI\n1 NAME A\n2 TRAN B\n3 LANG de-AT`)).toEqual([]);
    // 5.5.1's language names do not carry over.
    expect(kinds(check70(`0 @I1@ INDI\n1 NAME A\n2 TRAN B\n3 LANG Slovenian`))).toEqual(["badLang"]);
    expect(kinds(check70(`0 @I1@ INDI\n1 NAME A\n2 TRAN B\n3 LANG Slovenian language`))).toEqual(["badLang"]);
  });

  it("checks the record id's shape", () => {
    expect(kinds(check551(`0 @I12345678901234567890X@ INDI`))).toEqual(["xrefLong"]);
    expect(kinds(check551(`0 @-1@ INDI`))).toEqual(["xrefStart"]);
    expect(kinds(check70(`0 @i1@ INDI`))).toEqual(["xrefChars"]);
    expect(check70(`0 @I_1@ INDI`)).toEqual([]);
  });
});

describe("validateStructure integration", () => {
  it("folds conformance findings into the structure report with their counts", () => {
    const ds = dataset(`${HEAD_551}\n0 @I1@ INDI\n1 SEX m\n1 ALIA @F1@\n0 @F1@ FAM\n0 TRLR`);
    const report = validateStructure(ds);
    expect(report.counts.enumValue).toBe(1);
    expect(report.counts.pointerType).toBe(1);
    // Errors first.
    expect(report.issues[0].category).toBe("pointerType");
  });
});

describe("fixConformance", () => {
  const text = `${HEAD_551}
0 @I1@ INDI
1 SEX f
1 SEX f
1 FAMC @F1@
2 PEDI Adopted
1 BIRT
2 DATE 1900
2 DATE 1901
0 @F1@ FAM
1 CHIL @I1@
0 @S1@ SOUR
1 REPO @R1@
2 CALN 1
3 MEDI Book
0 @R1@ REPO
1 NAME Archive
0 TRLR`;

  it("counts and fixes recased values and exact repeats, and nothing else", () => {
    const ds = dataset(text);
    expect(countFixableConformance(ds, "values")).toBe(4); // two SEX, PEDI, MEDI
    expect(countFixableConformance(ds, "repeats")).toBe(1);
    const before = serializeGedcom(ds.records, ds);

    const values = fixConformance(ds, "values");
    expect(values.map((p) => `${p.type} ${p.id}`).sort()).toEqual(["individual @I1@", "record @S1@"]);
    const repeats = fixConformance(ds, "repeats");
    expect(repeats).toHaveLength(1);

    const indi = ds.individuals.get("@I1@")!;
    expect(indi.sex).toBe("F");
    expect(indi.raw.children.filter((c) => c.tag === "SEX")).toHaveLength(1);
    expect(nodeAtPath(indi.raw, "1.0")?.value).toBe("adopted");
    // The differing repeat stays: which DATE is right is the user's question.
    const remaining = validateConformance(ds);
    expect(remaining).toMatchObject([{ messageVars: { tag: "DATE", parent: "INDI.BIRT" } }]);

    // Undo restores the file byte for byte.
    applyRecordPatches(ds, repeats, "undo");
    applyRecordPatches(ds, values, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it("fixes one finding from its own row", () => {
    const ds = dataset(text);
    const pedi = validateConformance(ds).find((i) => i.messageVars.tag === "PEDI")!;
    const patches = fixConformance(ds, undefined, { id: pedi.recordId!, path: pedi.path });
    expect(patches).toHaveLength(1);
    const sexes = ds.individuals.get("@I1@")!.raw.children.filter((c: GedNode) => c.tag === "SEX").map((c) => c.value);
    expect(sexes).toEqual(["f", "f"]);
    expect(fixConformance(ds, undefined, { id: "@I9@" })).toEqual([]);
  });

  it("gives a 7.0 name type outside the enumeration its standard form", () => {
    const ds = dataset(
      `${HEAD_70}\n0 @I1@ INDI\n1 NAME Ana /Novak/\n1 NAME Anica //\n2 TYPE variation\n1 NAME Marija //\n2 TYPE religious\n0 TRLR`,
    );
    expect(kinds(validateConformance(ds))).toEqual(["nameTypeNearest", "nameTypeOther"]);
    fixConformance(ds, "values");
    const names = ds.individuals.get("@I1@")!.names;
    expect(names.slice(1).map((n) => [n.type, n.typePhrase])).toEqual([["AKA", undefined], ["OTHER", "religious"]]);
    expect(validateConformance(ds)).toEqual([]);
  });

  it("adds a media file's missing FORM read off its name, and leaves a nameless one", () => {
    const ds = dataset(`${HEAD_70}
0 @O1@ OBJE
1 FILE https://en.geneanet.org/cemetery/view/13234512
0 @O2@ OBJE
1 FILE scans/krst.JPG
1 FILE scans/poroka
0 @O3@ OBJE
1 FILE www.familysearch.org/ark:/61903/3:1:939V-5RTW-6
0 TRLR`);
    const missing = validateConformance(ds).filter((i) => i.messageVars.tag === "FORM");
    expect(missing.every((i) => i.category === "missingLine")).toBe(true);
    // One row per form the fix would add; the nameless file has its own.
    expect(missing.map((i) => [i.fix, i.messageVars.count])).toEqual([[undefined, undefined], ["text/html", 2], ["image/jpeg", 1]]);
    expect(countFixableConformance(ds, "forms")).toBe(3);
    const before = serializeGedcom(ds.records, ds);

    const patches = fixConformance(ds, "forms");
    expect(patches.map((p) => p.id)).toEqual(["@O1@", "@O2@", "@O3@"]);
    expect(serializeGedcom(ds.records, ds)).toContain("1 FILE https://en.geneanet.org/cemetery/view/13234512\n2 FORM text/html\n");
    expect(serializeGedcom(ds.records, ds)).toContain("1 FILE scans/krst.JPG\n2 FORM image/jpeg\n");
    expect(validateConformance(ds).map((i) => i.messageVars.tag)).toEqual(["FORM"]);

    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it("moves media titles and formats kept beside FILE under it, in every media record", () => {
    const ds = dataset(`${HEAD_551}
0 @O1@ OBJE
1 FILE a.jpg
1 FORM jpg
1 TITL Krst 1870
0 @O2@ OBJE
1 FILE b.jpg
2 TITL Poroka
1 TITL Poroka
0 @O3@ OBJE
1 FILE c.jpg
2 FORM jpg
2 TITL Pogreb
1 TITL Different
0 TRLR`);
    const habit = validateConformance(ds).filter((i) => i.category === "misplacedTag");
    expect(habit.map((i) => [i.sample, i.relocate])).toEqual([["FORM", true], ["TITL", true]]);
    expect(countFixableConformance(ds, "relocate")).toBe(2); // O3's two titles differ
    const before = serializeGedcom(ds.records, ds);

    const patches = fixConformance(ds, "relocate");
    expect(patches.map((p) => p.id)).toEqual(["@O1@", "@O2@"]);
    const out = serializeGedcom(ds.records, ds);
    expect(out).toContain("0 @O1@ OBJE\n1 FILE a.jpg\n2 FORM jpg\n2 TITL Krst 1870\n");
    expect(out).toContain("0 @O2@ OBJE\n1 FILE b.jpg\n2 TITL Poroka\n0 @O3@"); // the copy goes
    expect(out).toContain("2 TITL Pogreb\n1 TITL Different\n"); // left for the user

    // Only on the user's word: the FILE's own title stays, the other goes.
    expect(fixConformance(ds)).toEqual([]); // a run of every fix never picks one
    expect(countFixableConformance(ds, "fileTitles")).toBe(1);
    const titles = fixConformance(ds, "fileTitles");
    expect(titles.map((p) => p.id)).toEqual(["@O3@"]);
    expect(serializeGedcom(ds.records, ds)).toContain("0 @O3@ OBJE\n1 FILE c.jpg\n2 FORM jpg\n2 TITL Pogreb\n0 TRLR");
    expect(validateConformance(ds).filter((i) => i.category === "misplacedTag")).toEqual([]);

    applyRecordPatches(ds, titles, "undo");
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it.each([["5.5.1", HEAD_551], ["7.0", HEAD_70]])("moves a source's own AGNC under its DATA in %s", (_v, head) => {
    const ds = dataset(`${head}
0 @S1@ SOUR
1 TITL Krstna knjiga
1 AGNC Župnija Kranj
1 REPO @R1@
0 @S2@ SOUR
1 TITL Mrliška knjiga
1 AGNC Župnija Naklo
1 DATA
2 AGNC Župnija Naklo
0 @S3@ SOUR
1 TITL Poročna knjiga
1 AGNC NŠAL
1 DATA
2 AGNC Župnija Šenčur
0 @R1@ REPO
1 NAME NŠAL
0 TRLR`);
    const habit = validateConformance(ds).filter((i) => i.category === "misplacedTag");
    expect(habit.map((i) => [i.sample, i.agency, i.messageVars.count])).toEqual([["AGNC", true, 3]]);
    expect(countFixableConformance(ds, "agency")).toBe(2); // S3's two agencies differ
    const before = serializeGedcom(ds.records, ds);

    const patches = fixConformance(ds, "agency");
    expect(patches.map((p) => p.id)).toEqual(["@S1@", "@S2@"]);
    const out = serializeGedcom(ds.records, ds);
    expect(out).toContain("0 @S1@ SOUR\n1 TITL Krstna knjiga\n1 DATA\n2 AGNC Župnija Kranj\n1 REPO @R1@\n");
    expect(out).toContain("0 @S2@ SOUR\n1 TITL Mrliška knjiga\n1 DATA\n2 AGNC Župnija Naklo\n0 @S3@"); // the copy goes
    expect(out).toContain("1 AGNC NŠAL\n1 DATA\n2 AGNC Župnija Šenčur\n"); // left for the user
    // The moved lines add no finding of their own in either version.
    const after = validateConformance(ds).filter((i) => i.recordId === "@S1@" || i.recordId === "@S2@");
    expect(after).toEqual([]);

    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it.each([["5.5.1", HEAD_551], ["7.0", HEAD_70]])("restates a source's flat PLAC/DATE as DATA > EVEN in %s", (_v, head) => {
    const ds = dataset(`${head}
0 @S1@ SOUR
1 TITL Krstna knjiga / Taufbuch - 03164 | Šenčur
1 PLAC Šenčur
1 DATE 1784-1812
1 AGNC Nadškofijski arhiv Ljubljana
0 @S2@ SOUR
1 TITL U.S., World War II Draft Registration Cards, 1942
1 DATE 2010
1 PLAC Lehi, UT, USA
0 TRLR`);
    const rows = validateConformance(ds).filter((i) => i.category === "misplacedTag");
    expect(rows.filter((i) => i.coverage).map((i) => i.sample).sort()).toEqual(["DATE", "PLAC"]);
    expect(countFixableConformance(ds, "coverage")).toBe(1); // S2's title names no register
    const before = serializeGedcom(ds.records, ds);

    const patches = fixConformance(ds, "coverage");
    expect(patches.map((p) => p.id)).toEqual(["@S1@"]);
    const out = serializeGedcom(ds.records, ds);
    expect(out).toMatch(/0 @S1@ SOUR\n1 TITL [^\n]+\n1 DATA\n2 EVEN (BIRT|BAPM)\n3 DATE FROM 1784 TO 1812\n3 PLAC Šenčur\n2 AGNC Nadškofijski arhiv Ljubljana\n0 @S2@/);
    expect(out).toContain("1 DATE 2010\n1 PLAC Lehi, UT, USA\n"); // left for the user
    expect(validateConformance(ds).filter((i) => i.recordId === "@S1@")).toEqual([]);

    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it("fixes every finding a grouped row stands for, and only those", () => {
    const ds = dataset(`${HEAD_70}
0 @I1@ INDI
1 NAME Veronica /Svetlecic/
2 TYPE aka
0 @I2@ INDI
1 NAME Franc /Zaletel/
2 TYPE aka
0 @I3@ INDI
1 NAME Mina /Božnar/
2 TYPE married
0 TRLR`);
    const aka = validateConformance(ds).find((i) => i.sample === "aka")!;
    const patches = fixConformance(ds, undefined, {
      match: { tag: "TYPE", parent: String(aka.messageVars.parent), sample: "aka", fix: "AKA" },
    });
    expect(patches.map((p) => p.id)).toEqual(["@I1@", "@I2@"]);
    const out = serializeGedcom(ds.records, ds);
    expect(out.match(/2 TYPE AKA\n/g)).toHaveLength(2);
    expect(out).toContain("2 TYPE married\n"); // another value: its own row
  });

  it.each([["5.5.1", HEAD_551], ["7.0", HEAD_70]])("makes a text SOUR inside a citation its PAGE in %s", (_v, head) => {
    const ds = dataset(`${head}
0 @S1@ SOUR
1 TITL Pokopališče Zgornje Bitnje
0 @I1@ INDI
1 NAME Ivana /Križnar/
1 BURI
2 SOUR @S1@
3 SOUR P02
1 DEAT
2 SOUR @S1@
3 PAGE P03
3 SOUR P04
0 TRLR`);
    expect(countFixableConformance(ds, "citationPage")).toBe(1); // the DEAT one has another PAGE
    const before = serializeGedcom(ds.records, ds);
    const patches = fixConformance(ds, "citationPage");
    const out = serializeGedcom(ds.records, ds);
    expect(out).toContain("1 BURI\n2 SOUR @S1@\n3 PAGE P02\n1 DEAT\n2 SOUR @S1@\n3 PAGE P03\n3 SOUR P04\n");
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it("restates MyHeritage's Discovery and Record citations too", () => {
    const ds = dataset(`${HEAD_70}
0 @S1@ SOUR
1 TITL MyHeritage
0 @I1@ INDI
1 NAME Jurij /Pajer/
1 SOUR @S1@
2 PAGE Georg Pajer
2 EVEN Discovery
0 @I2@ INDI
1 NAME Leopold /Petan/
1 SOUR @S1@
2 EVEN Record
3 ROLE 40000:273139647:
0 TRLR`);
    expect(validateConformance(ds).filter((i) => i.smartMatch).map((i) => i.messageVars.count)).toEqual([2]);
    fixConformance(ds, "smartMatch");
    const out = serializeGedcom(ds.records, ds);
    expect(out).toContain("1 SOUR @S1@\n2 PAGE Georg Pajer\n0 @I2@");
    expect(out).toContain("1 SOUR @S1@\n2 PAGE 40000:273139647:\n0 TRLR");
    expect(validateConformance(ds)).toEqual([]);
  });

  it.each([["5.5.1", HEAD_551], ["7.0", HEAD_70]])("keeps a media record's DATE/PLAC as _DATE/_PLACE in %s", (_v, head) => {
    const ds = dataset(`${head}
0 @O1@ OBJE
1 FILE a.jpg
2 FORM jpg
1 DATE 1935
1 PLAC Kranj
0 @O2@ OBJE
1 FILE b.jpg
2 FORM jpg
1 DATE 1940
1 _DATE 1941
0 TRLR`);
    expect(countFixableConformance(ds, "mediaInfo")).toBe(2); // O2's dates differ
    const before = serializeGedcom(ds.records, ds);
    const patches = fixConformance(ds, "mediaInfo");
    const out = serializeGedcom(ds.records, ds);
    expect(out).toContain("1 _DATE 1935\n1 _PLACE Kranj\n");
    expect(out).toContain("1 DATE 1940\n1 _DATE 1941\n"); // left as it is
    expect(validateConformance(ds).filter((i) => i.recordId === "@O1@")).toEqual([]);
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it.each([["5.5.1", HEAD_551], ["7.0", HEAD_70]])("moves a PEDI on CHIL to the child's FAMC in %s", (_v, head) => {
    const pedi = head === HEAD_70 ? "ADOPTED" : "adopted";
    const ds = dataset(`${head}
0 @I1@ INDI
1 NAME Ana /Kos/
1 FAMC @F1@
0 @I2@ INDI
1 NAME Janez /Kos/
1 FAMC @F1@
2 PEDI ${pedi}
0 @I3@ INDI
1 NAME Miha /Kos/
1 FAMC @F1@
2 PEDI ${head === HEAD_70 ? "FOSTER" : "foster"}
0 @F1@ FAM
1 CHIL @I1@
2 PEDI ${pedi}
1 CHIL @I2@
2 PEDI ${pedi}
1 CHIL @I3@
2 PEDI ${pedi}
0 TRLR`);
    expect(countFixableConformance(ds, "childPedi")).toBe(2); // I3 says otherwise
    const before = serializeGedcom(ds.records, ds);
    const patches = fixConformance(ds, "childPedi");
    expect(patches.map((p) => p.id).sort()).toEqual(["@F1@", "@I1@"]);
    const out = serializeGedcom(ds.records, ds);
    expect(out).toContain(`0 @I1@ INDI\n1 NAME Ana /Kos/\n1 FAMC @F1@\n2 PEDI ${pedi}\n`);
    expect(out).toContain(`0 @F1@ FAM\n1 CHIL @I1@\n1 CHIL @I2@\n1 CHIL @I3@\n2 PEDI ${pedi}\n`);
    expect(validateConformance(ds).filter((i) => i.recordId === "@I1@")).toEqual([]);
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it.each([["5.5.1", HEAD_551], ["7.0", HEAD_70]])("keeps a Smart Match id as the citation's PAGE in %s", (_v, head) => {
    const ds = dataset(`${head}
0 @S1@ SOUR
1 TITL Robnik Web Site
0 @I1@ INDI
1 NAME Metod /Robnik/
1 SOUR @S1@
2 QUAY 3
2 DATA
3 TEXT Dodano za potrditev Smart Match
2 EVEN Smart Matching
3 ROLE 1500001
0 @I2@ INDI
1 NAME Marija /Maček/
1 SOUR @S1@
2 EVEN Smart Matching
3 ROLE 1500002
0 TRLR`);
    const rows = validateConformance(ds).filter((i) => i.smartMatch);
    expect(rows.map((i) => i.messageVars.count)).toEqual([2]);
    expect(validateConformance(ds).filter((i) => i.sample === "1500001")).toEqual([]); // not a role finding too
    const before = serializeGedcom(ds.records, ds);
    const patches = fixConformance(ds, "smartMatch");
    const out = serializeGedcom(ds.records, ds);
    expect(out).toContain("1 SOUR @S1@\n2 PAGE 1500001\n2 QUAY 3\n2 DATA\n3 TEXT Dodano za potrditev Smart Match\n0 @I2@");
    expect(out).toContain("1 SOUR @S1@\n2 PAGE 1500002\n0 TRLR");
    expect(validateConformance(ds).filter((i) => i.recordId === "@I1@" || i.recordId === "@I2@")).toEqual([]);
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it("writes MyHeritage's PEDI step as OTHER + PHRASE step, keeping which parent it means", () => {
    const ds = dataset(`${HEAD_70}
0 @I1@ INDI
1 NAME Aisha /Alvarado/
1 FAMC @F1@
2 PEDI step
2 _PEDW step
0 @F1@ FAM
1 CHIL @I1@
0 TRLR`);
    fixConformance(ds, "values");
    expect(serializeGedcom(ds.records, ds)).toContain("1 FAMC @F1@\n2 PEDI OTHER\n3 PHRASE step\n2 _PEDW step\n");
    expect(validateConformance(ds).filter((i) => i.category === "enumValue")).toEqual([]);
  });

  it("writes a 7.0 value outside a set that has OTHER as OTHER, keeping it as the PHRASE", () => {
    // MyHeritage's Smart Match citation puts the matched person's number in ROLE.
    const ds = dataset(`${HEAD_70}
0 @S1@ SOUR
1 TITL MyHeritage
0 @I1@ INDI
1 NAME Metod /Robnik/
1 SOUR @S1@
2 EVEN BIRT
3 ROLE 1500001
0 TRLR`);
    const [issue] = validateConformance(ds).filter((i) => i.category === "enumValue");
    expect(issue).toMatchObject({ messageKey: "tools.validate.struct.issue.enumOther", fix: "OTHER", fixPhrase: "1500001" });
    expect(issue.tooltip).toContain("WITN"); // the allowed values ride on the hover
    const patches = fixConformance(ds, "values");
    expect(serializeGedcom(ds.records, ds)).toContain("2 EVEN BIRT\n3 ROLE OTHER\n4 PHRASE 1500001\n");
    expect(validateConformance(ds).filter((i) => i.category === "enumValue")).toEqual([]);
    applyRecordPatches(ds, patches, "undo");
  });

  it.each([["5.5.1", HEAD_551], ["7.0", HEAD_70]])("keeps a date on an association as its note in %s", (_v, head) => {
    const ds = dataset(`${head}
0 @I1@ INDI
1 NAME Luka /Renko/
1 EDUC
2 DATE 1980
2 ASSO @I2@
3 DATE 1979-1980
3 NOTE vzgojiteljica v vrtcu
3 ROLE OTHER
1 ASSO @I2@
2 ROLE OTHER
2 DATE 7 MAY 1928
0 @I2@ INDI
1 NAME Ana /Kos/
0 TRLR`);
    expect(countFixableConformance(ds, "assoDates")).toBe(2);
    const before = serializeGedcom(ds.records, ds);
    const patches = fixConformance(ds, "assoDates");
    const out = serializeGedcom(ds.records, ds);
    expect(out).toContain("2 ASSO @I2@\n3 NOTE 1979-1980\n3 NOTE vzgojiteljica v vrtcu\n");
    expect(out).toContain("1 ASSO @I2@\n2 ROLE OTHER\n2 NOTE 7 MAY 1928\n");
    expect(validateConformance(ds).filter((i) => i.assoDate)).toEqual([]);
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it("lifts CHAN/CREA below the records onto them, as one row", () => {
    const body = `0 @I1@ INDI
1 NAME Alojz /Homan/
1 BIRT
2 DATE 5 MAY 1905
2 CHAN
3 DATE 2 SEP 2025
4 TIME 10:21:13
2 CREA
3 DATE 10 SEP 2025
1 DEAT
2 DATE 30 NOV 1907
2 CHAN
3 DATE 2 SEP 2025
4 TIME 10:21:23
2 CREA
3 DATE 1 JAN 2020
1 CHAN
2 DATE 1 AUG 2025
0 @I2@ INDI
1 NAME Ana /Kos/
1 OCCU kmetica
2 CHAN
3 DATE 3 MAR 2024
1 CHAN
2 DATE 1 AUG 2026`;
    const ds70 = dataset(`${HEAD_70}\n${body}\n0 TRLR`);
    const rows = validateConformance(ds70).filter((i) => i.category === "misplacedTag");
    expect(rows.map((i) => [i.messageKey.split(".").pop(), i.stamps, i.messageVars.count])).toEqual([["misplacedStamps", true, 5]]);
    expect(countFixableConformance(ds70, "stamps")).toBe(2);
    const before = serializeGedcom(ds70.records, ds70);

    const patches = fixConformance(ds70, "stamps");
    const out = serializeGedcom(ds70.records, ds70);
    // The newest change is newer than the record's own; the oldest creation is new to it.
    expect(out).toContain("1 BIRT\n2 DATE 5 MAY 1905\n1 DEAT\n2 DATE 30 NOV 1907\n1 CHAN\n2 DATE 2 SEP 2025\n3 TIME 10:21:23\n");
    expect(out).toMatch(/\n1 CREA\n2 DATE 1 JAN 2020\n/);
    // An older stamp leaves the record's newer change alone.
    expect(out).toContain("1 OCCU kmetica\n1 CHAN\n2 DATE 1 AUG 2026\n");
    expect(validateConformance(ds70)).toEqual([]);

    applyRecordPatches(ds70, patches, "undo");
    expect(serializeGedcom(ds70.records, ds70)).toBe(before);

    // 5.5.1 has no CREA: the creation goes up as _CREA.
    const ds551 = dataset(`${HEAD_551}\n${body}\n0 TRLR`);
    fixConformance(ds551, "stamps");
    const out551 = serializeGedcom(ds551.records, ds551);
    expect(out551).toMatch(/\n1 _CREA\n2 DATE 1 JAN 2020\n/);
    expect(out551).not.toMatch(/\n[2-9] (CHAN|CREA)\n/);
    expect(validateConformance(ds551).filter((i) => i.recordId === "@I1@" || i.recordId === "@I2@")).toEqual([]);
  });

  it("moves the text on a 7.0 event line into a note on the event", () => {
    const ds = dataset(`${HEAD_70}
0 @I1@ INDI
1 BIRT ali Ravna Gora?
2 DATE 1863
1 DEAT Bokalce 51
2 NOTE Bokalce 51
1 BURI y
0 TRLR`);
    expect(countFixableConformance(ds, "notes")).toBe(2);
    expect(countFixableConformance(ds, "values")).toBe(1);
    const before = serializeGedcom(ds.records, ds);

    const patches = fixConformance(ds, "notes");
    expect(patches).toHaveLength(1);
    const out = serializeGedcom(ds.records, ds);
    expect(out).toContain("1 BIRT\n2 DATE 1863\n2 NOTE ali Ravna Gora?\n");
    // The same note already there is not written twice.
    expect(out).toContain("1 DEAT\n2 NOTE Bokalce 51\n1 BURI y\n");
    expect(validateConformance(ds).map((i) => i.messageKey.split(".").pop())).toEqual(["badY"]);

    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records, ds)).toBe(before);
  });

  it("writes a moved format as 7.0's media type", () => {
    const ds = dataset(`${HEAD_70}\n0 @O1@ OBJE\n1 FILE a.jpg\n1 FORM jpg\n1 TITL Krst\n0 TRLR`);
    fixConformance(ds, "relocate");
    expect(serializeGedcom(ds.records, ds)).toContain("0 @O1@ OBJE\n1 FILE a.jpg\n2 FORM image/jpeg\n2 TITL Krst\n");
  });

  it("is a no-op on a file of another version or a clean one", () => {
    expect(fixConformance(dataset("0 HEAD\n0 @I1@ INDI\n1 SEX m\n0 TRLR"))).toEqual([]);
  });
});

/**
 * The anonymized real-world corpus. A table that is wrong shows up here as a
 * finding on a line the standard allows; every finding below was checked
 * against the spec and is a genuine defect of the file (the exporter's habit
 * noted beside it). The files that are clean must stay clean.
 */
describe("corpus", () => {
  const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../__fixtures__/corpus");
  const EXPECTED: Record<string, string[]> = {
    // Ancestry: publication facts under PUBL, web links in citation DATA, a
    // marriage on the person, media TYPE "image".
    "ancestry-5.5.1-utf8.ged": ["enumValue TYPE@OBJE.FILE.FORM.TYPE", "misplaced DATE@OBJE", "misplaced DATE@SOUR.PUBL", "misplaced MARR@INDI", "misplaced PLAC@OBJE", "misplaced PLAC@SOUR.PUBL", "misplaced SOUR@INDI.SEX", "misplaced WWW@INDI.BIRT.SOUR.DATA", "misplaced WWW@INDI.BURI.SOUR.DATA", "misplaced WWW@INDI.SOUR.DATA"],
    // Windows code pages declared as CHAR ANSI, which no 5.5.x lists.
    "brotherskeeper-5.5-w1250.ged": ["enumValue CHAR@HEAD.CHAR"],
    "brotherskeeper-5.5.1-w1250.ged": ["enumValue CHAR@HEAD.CHAR"],
    // Address parts straight under RESI instead of under its ADDR.
    "familyhistorian-5.5.1-utf8.ged": ["misplaced ADR1@INDI.RESI", "misplaced CITY@INDI.RESI", "misplaced NAME@INDI.RESI"],
    "familyhistorian-5.5.1-w1250.ged": ["enumValue CHAR@HEAD.CHAR"],
    // Event-level ASSO, which 5.5.1 does not have (7.0 does).
    "geneanet-5.5.1-utf8.ged": ["misplaced ASSO@FAM.MARR", "misplaced ASSO@INDI.BIRT"],
    "geneanet-5.5.1-w1250.ged": ["enumValue CHAR@HEAD.CHAR", "misplaced SOUR@HEAD.CHAR"],
    "gramps-5.5.1-utf8.ged": [],
    // MyHeritage: RIN on events and citations, QUAY 4, a bare-number AGE,
    // repeated PAGE lines, "Adopted".
    "myheritage-5.5.1-utf8.ged": ["badAge AGE@INDI.DEAT.AGE", "enumCase PEDI@INDI.FAMC.PEDI", "misplaced RIN@FAM.DIV", "misplaced RIN@FAM.EVEN", "misplaced RIN@FAM.EVEN.SOUR", "misplaced RIN@FAM.MARR", "misplaced RIN@FAM.MARR.SOUR", "misplaced RIN@INDI.BAPM", "misplaced RIN@INDI.BIRT", "misplaced RIN@INDI.BIRT.SOUR", "misplaced RIN@INDI.BURI", "misplaced RIN@INDI.CHR", "misplaced RIN@INDI.DEAT", "misplaced RIN@INDI.DEAT.SOUR", "misplaced RIN@INDI.EVEN", "misplaced RIN@INDI.EVEN.SOUR", "misplaced RIN@INDI.OCCU", "misplaced RIN@INDI.RESI", "misplaced RIN@INDI.SOUR", "quayAbove QUAY@FAM.EVEN.SOUR.QUAY", "quayAbove QUAY@FAM.MARR.SOUR.QUAY", "quayAbove QUAY@INDI.BIRT.SOUR.QUAY", "quayAbove QUAY@INDI.DEAT.SOUR.QUAY", "quayAbove QUAY@INDI.EVEN.SOUR.QUAY", "quayAbove QUAY@INDI.SOUR.QUAY", "tooMany PAGE@FAM.EVEN.SOUR", "tooMany PAGE@FAM.MARR.SOUR", "tooMany PAGE@INDI.BIRT.SOUR", "tooMany PAGE@INDI.DEAT.SOUR", "tooMany PAGE@INDI.EVEN.SOUR", "tooMany PAGE@INDI.SOUR"],
    // An alias written as a name instead of a pointer.
    "reunion-5.5.1-utf8.ged": ["pointerExpected ALIA@INDI.ALIA"],
    // A NAME line inside source citations.
    "rootsmagic-5.5.1-utf8.ged": ["misplaced NAME@FAM.MARR.SOUR", "misplaced NAME@INDI.BIRT.SOUR", "misplaced NAME@INDI.BURI.SOUR", "misplaced NAME@INDI.DEAT.SOUR", "misplaced NAME@INDI.SOUR"],
    // MacFamilyTree 7.0: CHAN/CREA on events, 5.5.1 leftovers (NOTE records,
    // GEDC.FORM, source DATE/PLAC/AGNC), FILE without FORM, TRAN without LANG,
    // event descriptions on BIRT/MARR, lower-case NAME TYPE.
    "synium-7.0-utf8.ged": ["badY BIRT@INDI.BIRT", "badY MARR@FAM.MARR", "badY NATU@INDI.NATU", "enumCase TYPE@INDI.NAME.TYPE", "misplaced AGNC@SOUR", "misplaced DATE@SOUR", "misplaced FORM@HEAD.GEDC", "misplaced PLAC@REPO", "misplaced PLAC@SOUR", "misplacedRoot NOTE@", "misplacedStamps CREA@INDI.NAME", "missing LANG@FAM.MARR.PLAC.TRAN", "missing LANG@INDI.BIRT.PLAC.TRAN", "missing LANG@INDI.DEAT.PLAC.TRAN", "missing LANG@INDI.RESI.PLAC.TRAN", "missingMany FORM@OBJE.FILE", "nameTypeNearest TYPE@INDI.NAME.TYPE", "pointerUnexpected NOTE@FAM.MARR.NOTE", "pointerUnexpected NOTE@INDI.RESI.NOTE", "pointerUnexpected NOTE@SOUR.NOTE"],
    // A DATE on NAME lines; a header with no SOUR.
    "unknown-5.5.1-utf8.ged": ["misplaced DATE@INDI.NAME", "missing SOUR@HEAD"],
    // webtrees: RESN NONE, RESN on source/media records, TIME on event dates.
    "webtrees-5.5.1-utf8.ged": ["enumCase PEDI@INDI.FAMC.PEDI", "enumValue RESN@FAM.MARR.RESN", "enumValue RESN@INDI.BIRT.RESN", "misplaced RESN@OBJE", "misplaced RESN@SOUR", "misplaced TIME@INDI.DEAT.DATE", "tooMany NICK@INDI.NAME"],
  };
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ged")).sort();

  it("covers every fixture", () => {
    expect(files).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const file of files) {
    it(`${file}: only the file's known defects`, () => {
      const buf = readFileSync(resolve(DIR, file));
      const ds = buildDataset(parseGedcom(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));
      const found = [...new Set(validateConformance(ds).map(
        (i) => `${i.messageKey.split(".").pop()} ${i.messageVars.tag}@${i.messageVars.parent}`,
      ))].sort();
      expect(found).toEqual(EXPECTED[file]);
    });
  }

  it("the bundled sample files are clean", () => {
    const SAMPLES = resolve(dirname(fileURLToPath(import.meta.url)), "../../../public/samples");
    for (const file of readdirSync(SAMPLES).filter((f) => f.endsWith(".ged"))) {
      const buf = readFileSync(resolve(SAMPLES, file));
      const ds = buildDataset(parseGedcom(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer));
      expect(validateConformance(ds), file).toEqual([]);
    }
  });
});

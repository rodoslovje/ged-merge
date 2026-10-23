import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../../gedcom/builder";
import { parseGedcom } from "../../gedcom/parser";
import { validateStructure } from "../structure";
import { tableFor, validateConformance, type ConformanceIssue } from "./conformance";
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
    const issues = check551(`0 @I1@ INDI\n1 FAMC @I2@\n0 @I2@ INDI\n1 FAMS @F1@\n0 @F1@ FAM\n1 HUSB @F1@`);
    expect(issues.map((i) => `${i.messageVars.tag} ${i.messageVars.actual}→${i.messageVars.expected}`).sort()).toEqual([
      "FAMC INDI→FAM",
      "HUSB FAM→INDI",
    ]);
    expect(issues.every((i) => i.category === "pointerType" && i.severity === "error")).toBe(true);
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
    const [issue] = check551(`0 @I1@ INDI\n1 SOUR @S1@\n2 QUAY 4\n0 @S1@ SOUR`);
    expect(issue).toMatchObject({ messageKey: "tools.validate.struct.issue.enumValue", messageVars: { allowed: "0, 1, 2, 3" } });
    expect(issue.fix).toBeUndefined();
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
    expect(kinds(check70(`0 @I1@ INDI\n1 NAME A\n2 TYPE nick`))).toEqual(["enumValue"]);
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
    expect(check70(`0 @I1@ INDI\n1 BIRT nezakonski`)[0].fix).toBeUndefined();
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
    const ds = dataset(`${HEAD_551}\n0 @I1@ INDI\n1 SEX m\n1 FAMC @I1@\n0 TRLR`);
    const report = validateStructure(ds);
    expect(report.counts.enumValue).toBe(1);
    expect(report.counts.pointerType).toBe(1);
    // Errors first.
    expect(report.issues[0].category).toBe("pointerType");
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
    "myheritage-5.5.1-utf8.ged": ["badAge AGE@INDI.DEAT.AGE", "enumCase PEDI@INDI.FAMC.PEDI", "enumValue QUAY@FAM.EVEN.SOUR.QUAY", "enumValue QUAY@FAM.MARR.SOUR.QUAY", "enumValue QUAY@INDI.BIRT.SOUR.QUAY", "enumValue QUAY@INDI.DEAT.SOUR.QUAY", "enumValue QUAY@INDI.EVEN.SOUR.QUAY", "enumValue QUAY@INDI.SOUR.QUAY", "misplaced RIN@FAM.DIV", "misplaced RIN@FAM.EVEN", "misplaced RIN@FAM.EVEN.SOUR", "misplaced RIN@FAM.MARR", "misplaced RIN@FAM.MARR.SOUR", "misplaced RIN@INDI.BAPM", "misplaced RIN@INDI.BIRT", "misplaced RIN@INDI.BIRT.SOUR", "misplaced RIN@INDI.BURI", "misplaced RIN@INDI.CHR", "misplaced RIN@INDI.DEAT", "misplaced RIN@INDI.DEAT.SOUR", "misplaced RIN@INDI.EVEN", "misplaced RIN@INDI.EVEN.SOUR", "misplaced RIN@INDI.OCCU", "misplaced RIN@INDI.RESI", "misplaced RIN@INDI.SOUR", "tooMany PAGE@FAM.EVEN.SOUR", "tooMany PAGE@FAM.MARR.SOUR", "tooMany PAGE@INDI.BIRT.SOUR", "tooMany PAGE@INDI.DEAT.SOUR", "tooMany PAGE@INDI.EVEN.SOUR", "tooMany PAGE@INDI.SOUR"],
    // An alias written as a name instead of a pointer.
    "reunion-5.5.1-utf8.ged": ["pointerExpected ALIA@INDI.ALIA"],
    // A NAME line inside source citations.
    "rootsmagic-5.5.1-utf8.ged": ["misplaced NAME@FAM.MARR.SOUR", "misplaced NAME@INDI.BIRT.SOUR", "misplaced NAME@INDI.BURI.SOUR", "misplaced NAME@INDI.DEAT.SOUR", "misplaced NAME@INDI.SOUR"],
    // MacFamilyTree 7.0: CHAN/CREA on events, 5.5.1 leftovers (NOTE records,
    // GEDC.FORM, source DATE/PLAC/AGNC), FILE without FORM, TRAN without LANG,
    // event descriptions on BIRT/MARR, lower-case NAME TYPE.
    "synium-7.0-utf8.ged": ["badY BIRT@INDI.BIRT", "badY MARR@FAM.MARR", "badY NATU@INDI.NATU", "enumCase TYPE@INDI.NAME.TYPE", "enumValue TYPE@INDI.NAME.TYPE", "misplaced AGNC@SOUR", "misplaced CHAN@FAM.MARR", "misplaced CHAN@INDI.BIRT", "misplaced CHAN@INDI.BURI", "misplaced CHAN@INDI.CHR", "misplaced CHAN@INDI.DEAT", "misplaced CHAN@INDI.NATU", "misplaced CHAN@INDI.OCCU", "misplaced CHAN@INDI.RESI", "misplaced CREA@FAM.MARR", "misplaced CREA@INDI.BIRT", "misplaced CREA@INDI.BURI", "misplaced CREA@INDI.CHR", "misplaced CREA@INDI.DEAT", "misplaced CREA@INDI.NAME", "misplaced CREA@INDI.NATU", "misplaced CREA@INDI.OCCU", "misplaced CREA@INDI.RELI", "misplaced CREA@INDI.RESI", "misplaced DATE@SOUR", "misplaced FORM@HEAD.GEDC", "misplaced PLAC@REPO", "misplaced PLAC@SOUR", "misplacedRoot NOTE@", "missing FORM@OBJE.FILE", "missing LANG@FAM.MARR.PLAC.TRAN", "missing LANG@INDI.BIRT.PLAC.TRAN", "missing LANG@INDI.DEAT.PLAC.TRAN", "missing LANG@INDI.RESI.PLAC.TRAN", "pointerUnexpected NOTE@FAM.MARR.NOTE", "pointerUnexpected NOTE@INDI.RESI.NOTE", "pointerUnexpected NOTE@SOUR.NOTE"],
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

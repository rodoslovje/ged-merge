import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { GedNode } from "../gedcom/types";
import { childrenByTag, childValue, findByPath, firstChild } from "../gedcom/node";
import { inferMainProfile } from "./profile";
import { normalizeDataset } from "./normalize";
import { migrateVersion } from "./migrate";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

function head(version: string): string {
  return `0 HEAD\n1 GEDC\n2 VERS ${version}\n`;
}

/** Parse `body` under a HEAD declaring `version` and migrate to `to`. */
function migrated(version: "5.5.1" | "7.0", body: string, to: "5.5.1" | "7.0") {
  const ds = dataset(head(version) + body + "0 TRLR\n");
  const changes: Array<{ before: string; after: string }> = [];
  const changed = migrateVersion(ds.records, version, to, (before, after) =>
    changes.push({ before, after }),
  );
  return { records: ds.records, changes, changed };
}

function record(records: GedNode[], xref: string): GedNode {
  const rec = records.find((r) => r.xref === xref);
  expect(rec, `record ${xref}`).toBeDefined();
  return rec!;
}

describe("migrateVersion 5.5.1 → 7.0", () => {
  it("renames NOTE records and their pointers to SNOTE, keeps text NOTEs", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @N1@ NOTE Shared text\n0 @I1@ INDI\n1 NOTE @N1@\n1 NOTE inline text\n",
      "7.0",
    );
    expect(record(records, "@N1@").tag).toBe("SNOTE");
    const indi = record(records, "@I1@");
    const notes = indi.children.filter((c) => c.tag === "SNOTE" || c.tag === "NOTE");
    expect(notes.map((n) => `${n.tag} ${n.value}`)).toEqual([
      "SNOTE @N1@",
      "NOTE inline text",
    ]);
  });

  it("converts ROMN/FONE to TRAN with a language tag", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 NAME 山田 /太郎/\n2 ROMN Yamada /Taro/\n3 TYPE romaji\n2 FONE やまだ /たろう/\n3 TYPE kana\n",
      "7.0",
    );
    const name = firstChild(record(records, "@I1@"), "NAME")!;
    const trans = childrenByTag(name, "TRAN");
    expect(trans).toHaveLength(2);
    expect(childValue(trans[0], "LANG")).toBe("ja-Latn");
    expect(childValue(trans[1], "LANG")).toBe("ja-Hrkt");
    expect(trans[0].children.some((c) => c.tag === "TYPE")).toBe(false);
  });

  it("moves interpreted and phrase dates into a PHRASE substructure", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 BIRT\n2 DATE INT 1900 (about the turn of the century)\n1 DEAT\n2 DATE (sometime in winter)\n",
      "7.0",
    );
    const indi = record(records, "@I1@");
    const birtDate = findByPath(indi, ["BIRT", "DATE"])!;
    expect(birtDate.value).toBe("1900");
    expect(childValue(birtDate, "PHRASE")).toBe("about the turn of the century");
    const deatDate = findByPath(indi, ["DEAT", "DATE"])!;
    expect(deatDate.value).toBeUndefined();
    expect(childValue(deatDate, "PHRASE")).toBe("sometime in winter");
  });

  it("resolves dual years, keeps the original as a phrase, and maps BC to BCE", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 BIRT\n2 DATE 30 JAN 1648/49\n1 DEAT\n2 DATE 44 BC\n",
      "7.0",
    );
    const indi = record(records, "@I1@");
    const birtDate = findByPath(indi, ["BIRT", "DATE"])!;
    expect(birtDate.value).toBe("30 JAN 1649");
    expect(childValue(birtDate, "PHRASE")).toBe("30 JAN 1648/49");
    expect(findByPath(indi, ["DEAT", "DATE"])!.value).toBe("44 BCE");
  });

  it("leaves numeric slash dates and century turns alone where they are not dual years", () => {
    const { records, changed } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 BIRT\n2 DATE 1989/01/05\n",
      "7.0",
    );
    expect(findByPath(record(records, "@I1@"), ["BIRT", "DATE"])!.value).toBe("1989/01/05");
    expect(changed).toBe(0);
  });

  it("reorders a reversed BET range and converts calendar escapes", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 BIRT\n2 DATE BET 1900 AND 1880\n1 DEAT\n2 DATE @#DJULIAN@ 6 MAY 1682\n",
      "7.0",
    );
    const indi = record(records, "@I1@");
    expect(findByPath(indi, ["BIRT", "DATE"])!.value).toBe("BET 1880 AND 1900");
    expect(findByPath(indi, ["DEAT", "DATE"])!.value).toBe("JULIAN 6 MAY 1682");
  });

  it("replaces age keywords with bounded ages plus a phrase", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 DEAT\n2 AGE CHILD\n1 BURI\n2 AGE 40Y 2M\n",
      "7.0",
    );
    const indi = record(records, "@I1@");
    const deatAge = findByPath(indi, ["DEAT", "AGE"])!;
    expect(deatAge.value).toBe("< 8y");
    expect(childValue(deatAge, "PHRASE")).toBe("Child");
    expect(findByPath(indi, ["BURI", "AGE"])!.value).toBe("40y 2m");
  });

  it("maps ASSO RELA to a ROLE enum, with OTHER + PHRASE fallback", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 ASSO @I2@\n2 RELA boter\n1 ASSO @I3@\n2 RELA family lawyer\n0 @I2@ INDI\n0 @I3@ INDI\n",
      "7.0",
    );
    const assos = childrenByTag(record(records, "@I1@"), "ASSO");
    expect(childValue(assos[0], "ROLE")).toBe("GODP");
    const other = firstChild(assos[1], "ROLE")!;
    expect(other.value).toBe("OTHER");
    expect(childValue(other, "PHRASE")).toBe("family lawyer");
  });

  it("folds AFN/RFN/RIN into EXID with a type URI", () => {
    const { records } = migrated("5.5.1", "0 @I1@ INDI\n1 AFN 123A-BCD\n1 RIN 42\n", "7.0");
    const exids = childrenByTag(record(records, "@I1@"), "EXID");
    expect(exids.map((e) => e.value)).toEqual(["123A-BCD", "42"]);
    expect(childValue(exids[0], "TYPE")).toBe("https://gedcom.io/terms/v7/AFN");
    expect(childValue(exids[1], "TYPE")).toBe("https://gedcom.io/terms/v7/RIN");
  });

  it("restructures OBJE records: FORM/TITL under FILE, extension to media type", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @M1@ OBJE\n1 FILE photo.jpg\n2 FORM jpg\n3 TYPE photo\n2 TITL Grandpa\n0 @M2@ OBJE\n1 FORM tif\n1 TITL Scan\n1 FILE scan.tif\n",
      "7.0",
    );
    const m1File = firstChild(record(records, "@M1@"), "FILE")!;
    const m1Form = firstChild(m1File, "FORM")!;
    expect(m1Form.value).toBe("image/jpeg");
    expect(childValue(m1Form, "MEDI")).toBe("photo");
    const m2 = record(records, "@M2@");
    expect(firstChild(m2, "FORM")).toBeUndefined();
    expect(firstChild(m2, "TITL")).toBeUndefined();
    const m2File = firstChild(m2, "FILE")!;
    expect(childValue(m2File, "FORM")).toBe("image/tiff");
    expect(childValue(m2File, "TITL")).toBe("Scan");
  });

  it("does not touch the header", () => {
    const { records } = migrated("5.5.1", "0 @N1@ NOTE x\n", "7.0");
    const headRec = records.find((r) => r.tag === "HEAD")!;
    expect(childValue(firstChild(headRec, "GEDC")!, "VERS")).toBe("5.5.1");
  });

  it("keeps every FILE of a multi-FILE OBJE, spreading a record-level FORM over all of them", () => {
    // FILE is {1:M} in both specs; a local scan + its online copy under one
    // OBJE is the shape the app itself reads first-FILE-wise, so migration
    // must not drop or mis-nest the second FILE.
    const { records } = migrated(
      "5.5.1",
      "0 @M1@ OBJE\n1 FORM jpg\n1 TITL Poroka\n1 FILE a.jpg\n1 FILE b.jpg\n",
      "7.0",
    );
    const files = record(records, "@M1@").children.filter((c) => c.tag === "FILE");
    expect(files.map((f) => f.value)).toEqual(["a.jpg", "b.jpg"]);
    // The stray record-level FORM serves every FILE; the TITL goes to the first.
    expect(files.map((f) => childValue(f, "FORM"))).toEqual(["image/jpeg", "image/jpeg"]);
    expect(files.map((f) => childValue(f, "TITL"))).toEqual(["Poroka", undefined]);
  });
});

describe("migrateVersion 7.0 → 5.5.1", () => {
  it("renames SNOTE records and pointers back to NOTE", () => {
    const { records } = migrated(
      "7.0",
      "0 @N1@ SNOTE Shared text\n0 @I1@ INDI\n1 SNOTE @N1@\n",
      "5.5.1",
    );
    expect(record(records, "@N1@").tag).toBe("NOTE");
    expect(firstChild(record(records, "@I1@"), "NOTE")!.value).toBe("@N1@");
  });

  it("folds date PHRASE substructures back into INT / phrase syntax", () => {
    const { records } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 BIRT\n2 DATE 1900\n3 PHRASE about the turn of the century\n1 DEAT\n2 DATE\n3 PHRASE sometime in winter\n",
      "5.5.1",
    );
    const indi = record(records, "@I1@");
    const birtDate = findByPath(indi, ["BIRT", "DATE"])!;
    expect(birtDate.value).toBe("INT 1900 (about the turn of the century)");
    expect(firstChild(birtDate, "PHRASE")).toBeUndefined();
    expect(findByPath(indi, ["DEAT", "DATE"])!.value).toBe("(sometime in winter)");
  });

  it("converts calendar tags, BCE, weeks-based ages and SEX X", () => {
    const { records } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 SEX X\n1 BIRT\n2 DATE JULIAN 6 MAY 1682\n1 DEAT\n2 DATE 44 BCE\n2 AGE 51w 6d\n",
      "5.5.1",
    );
    const indi = record(records, "@I1@");
    expect(firstChild(indi, "SEX")!.value).toBe("U");
    expect(findByPath(indi, ["BIRT", "DATE"])!.value).toBe("@#DJULIAN@ 6 MAY 1682");
    expect(findByPath(indi, ["DEAT", "DATE"])!.value).toBe("44 B.C.");
    expect(findByPath(indi, ["DEAT", "AGE"])!.value).toBe("363d");
  });

  it("converts TRAN back to ROMN/FONE and ROLE back to RELA", () => {
    const { records } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 NAME 山田 /太郎/\n2 TRAN Yamada /Taro/\n3 LANG ja-Latn\n2 TRAN やまだ /たろう/\n3 LANG ja-Hrkt\n1 ASSO @I2@\n2 ROLE GODP\n1 ASSO @I3@\n2 ROLE OTHER\n3 PHRASE family lawyer\n0 @I2@ INDI\n0 @I3@ INDI\n",
      "5.5.1",
    );
    const indi = record(records, "@I1@");
    const name = firstChild(indi, "NAME")!;
    const romn = firstChild(name, "ROMN")!;
    expect(childValue(romn, "TYPE")).toBe("romaji");
    expect(childValue(firstChild(name, "FONE")!, "TYPE")).toBe("kana");
    const assos = childrenByTag(indi, "ASSO");
    expect(childValue(assos[0], "RELA")).toBe("godparent");
    const rela = firstChild(assos[1], "RELA")!;
    expect(rela.value).toBe("family lawyer");
    expect(firstChild(rela, "PHRASE")).toBeUndefined();
  });

  it("maps EXID back to legacy identifier tags or to REFN", () => {
    const { records } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 EXID 123A-BCD\n2 TYPE https://gedcom.io/terms/v7/AFN\n1 EXID abc\n2 TYPE https://example.com/id\n",
      "5.5.1",
    );
    const indi = record(records, "@I1@");
    const afn = firstChild(indi, "AFN")!;
    expect(afn.value).toBe("123A-BCD");
    expect(firstChild(afn, "TYPE")).toBeUndefined();
    const refn = firstChild(indi, "REFN")!;
    expect(refn.value).toBe("abc");
    expect(childValue(refn, "TYPE")).toBe("https://example.com/id");
  });

  it("keeps 7-only structures as extension tags and downgrades media types", () => {
    const { records } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 UID 9ce7...\n1 CREA\n2 DATE 1 JAN 2020\n1 NO MARR\n0 @M1@ OBJE\n1 FILE photo.jpg\n2 FORM image/jpeg\n3 MEDI PHOTO\n",
      "5.5.1",
    );
    const indi = record(records, "@I1@");
    expect(firstChild(indi, "_UID")!.value).toBe("9ce7...");
    expect(firstChild(indi, "_CREA")).toBeDefined();
    expect(firstChild(indi, "_NO")!.value).toBe("MARR");
    const form = firstChild(firstChild(record(records, "@M1@"), "FILE")!, "FORM")!;
    expect(form.value).toBe("jpg");
    expect(childValue(form, "TYPE")).toBe("PHOTO");
  });

  it("downgrades every FILE of a multi-FILE OBJE, none dropped", () => {
    const { records } = migrated(
      "7.0",
      "0 @M1@ OBJE\n1 FILE a.jpg\n2 FORM image/jpeg\n2 TITL Poroka\n1 FILE b.png\n2 FORM image/png\n",
      "5.5.1",
    );
    const files = record(records, "@M1@").children.filter((c) => c.tag === "FILE");
    expect(files.map((f) => f.value)).toEqual(["a.jpg", "b.png"]);
    expect(files.map((f) => childValue(f, "FORM"))).toEqual(["jpg", "png"]);
    expect(childValue(files[0], "TITL")).toBe("Poroka");
  });
});

describe("normalizeDataset version migration wiring", () => {
  const MAIN7 = head("7.0") + "0 @I1@ INDI\n1 NAME Franc /Novak/\n0 TRLR\n";
  const COMPARE551 =
    head("5.5.1") +
    "0 @N1@ NOTE shared\n0 @I1@ INDI\n1 NAME Ana /Novak/\n1 NOTE @N1@\n1 BIRT\n2 DATE INT 1900 (za silvestrovo)\n0 TRLR\n";

  it("migrates a 5.5.1 compare into a 7.0 main and reports it", () => {
    const { dataset: out, report } = normalizeDataset(
      dataset(COMPARE551),
      inferMainProfile(dataset(MAIN7)),
    );
    expect(report.versionMigration).toMatchObject({ from: "5.5.1", to: "7.0" });
    expect(report.versionMigration!.changed).toBeGreaterThanOrEqual(3);
    expect(report.versionMigration!.examples.length).toBeGreaterThan(0);
    expect(out.records.find((r) => r.xref === "@N1@")!.tag).toBe("SNOTE");
  });

  it("reports a zero-change migration when the versions differ but nothing needed rewriting", () => {
    const clean551 = head("5.5.1") + "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 BIRT\n2 DATE 5 JAN 1885\n0 TRLR\n";
    const { report } = normalizeDataset(dataset(clean551), inferMainProfile(dataset(MAIN7)));
    expect(report.versionMigration).toMatchObject({ from: "5.5.1", to: "7.0", changed: 0 });
  });

  it("does not fire when both files share a version family", () => {
    const main551 = head("5.5.1") + "0 @I1@ INDI\n1 NAME Franc /Novak/\n0 TRLR\n";
    const { report } = normalizeDataset(dataset(COMPARE551), inferMainProfile(dataset(main551)));
    expect(report.versionMigration).toBeUndefined();
  });

  it("treats an undeclared version as legacy 5.5.x", () => {
    const noVersion = "0 HEAD\n0 @I1@ INDI\n1 NAME Ana /Novak/\n1 SEX X\n0 TRLR\n";
    // unknown compare into unknown main: same family, no migration.
    const { report } = normalizeDataset(dataset(noVersion), inferMainProfile(dataset(noVersion)));
    expect(report.versionMigration).toBeUndefined();
    // 7.0 compare into unknown main: downgraded.
    const compare7 = head("7.0") + "0 @I1@ INDI\n1 SEX X\n0 TRLR\n";
    const { dataset: out, report: report2 } = normalizeDataset(
      dataset(compare7),
      inferMainProfile(dataset(noVersion)),
    );
    expect(report2.versionMigration).toMatchObject({ from: "7.0", to: "unknown" });
    const sex = firstChild(out.records.find((r) => r.xref === "@I1@")!, "SEX")!;
    expect(sex.value).toBe("U");
  });
});

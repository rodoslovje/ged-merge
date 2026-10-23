import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { GedNode } from "../gedcom/types";
import { childrenByTag, childValue, findByPath, firstChild } from "../gedcom/node";
import { inferMainProfile } from "./profile";
import { normalizeDataset } from "./normalize";
import { migrateVersion } from "./migrate";
import { serializeGedcom } from "../gedcom/serialize";

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

  it("reads only a following year as the second half of a dual year", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 BIRT\n2 DATE 1890/12\n1 DEAT\n2 DATE 1699/00\n1 BURI\n2 DATE 1890/91\n",
      "7.0",
    );
    const indi = record(records, "@I1@");
    const birt = findByPath(indi, ["BIRT", "DATE"])!;
    expect(birt.value).toBe("1890/12");
    expect(firstChild(birt, "PHRASE")).toBeUndefined();
    expect(findByPath(indi, ["DEAT", "DATE"])!.value).toBe("1700");
    expect(findByPath(indi, ["BURI", "DATE"])!.value).toBe("1891");
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

  it("converts every calendar escape and era marker of a range, ordering BCE ranges by era", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 BIRT\n2 DATE BET @#DJULIAN@ 1700 AND @#DJULIAN@ 1710\n" +
        "1 DEAT\n2 DATE BET 300 BC AND 100 BC\n1 BURI\n2 DATE BET 100 BC AND 300 BC\n",
      "7.0",
    );
    const indi = record(records, "@I1@");
    expect(findByPath(indi, ["BIRT", "DATE"])!.value).toBe("BET JULIAN 1700 AND JULIAN 1710");
    // 300 BCE comes before 100 BCE: already chronological.
    expect(findByPath(indi, ["DEAT", "DATE"])!.value).toBe("BET 300 BCE AND 100 BCE");
    expect(findByPath(indi, ["BURI", "DATE"])!.value).toBe("BET 300 BCE AND 100 BCE");
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

  it("keeps the file's own wording of a role on the ROLE's PHRASE", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 ASSO @I2@\n2 RELA Godmother\n1 ASSO @I2@\n2 RELA godparent\n0 @I2@ INDI\n",
      "7.0",
    );
    const [godmother, godparent] = childrenByTag(record(records, "@I1@"), "ASSO").map((a) => firstChild(a, "ROLE")!);
    expect(godmother.value).toBe("GODP");
    expect(childValue(godmother, "PHRASE")).toBe("Godmother");
    // The enumeration's own word needs no phrase.
    expect(firstChild(godparent, "PHRASE")).toBeUndefined();
    migrateVersion(records, "7.0", "5.5.1", () => {});
    expect(childrenByTag(record(records, "@I1@"), "ASSO").map((a) => childValue(a, "RELA"))).toEqual([
      "Godmother",
      "godparent",
    ]);
  });

  it("drops an ASSO's TYPE INDI, which 7.0 does not define, and keeps TYPE FAM", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 ASSO @I2@\n2 TYPE INDI\n2 RELA boter\n1 ASSO @F1@\n2 TYPE FAM\n2 RELA witness\n0 @I2@ INDI\n0 @F1@ FAM\n",
      "7.0",
    );
    const assos = childrenByTag(record(records, "@I1@"), "ASSO");
    // A pointer at a person is all 7.0 has, so the tag saying so is noise.
    expect(firstChild(assos[0], "TYPE")).toBeUndefined();
    expect(childValue(assos[0], "ROLE")).toBe("GODP");
    // A pointer at a family is one 7.0 cannot express either — the line saying
    // the association names no person is left for the reader to see.
    expect(childValue(assos[1], "TYPE")).toBe("FAM");
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

  it("gives a media format with no registered type a media type that keeps it", () => {
    const { records } = migrated(
      "5.5.1",
      "0 @M1@ OBJE\n1 FILE a.djvu\n2 FORM djvu\n1 FILE b.xyz\n2 FORM xyz\n",
      "7.0",
    );
    const files = record(records, "@M1@").children.filter((c) => c.tag === "FILE");
    expect(files.map((f) => childValue(f, "FORM"))).toEqual(["image/vnd.djvu", "application/x-xyz"]);
    migrateVersion(records, "7.0", "5.5.1", () => {});
    expect(files.map((f) => childValue(f, "FORM"))).toEqual(["djvu", "xyz"]);
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
    expect(firstChild(firstChild(indi, "SEX")!, "_SEX")!.value).toBe("X");
    expect(findByPath(indi, ["BIRT", "DATE"])!.value).toBe("@#DJULIAN@ 6 MAY 1682");
    expect(findByPath(indi, ["DEAT", "DATE"])!.value).toBe("44 B.C.");
    expect(findByPath(indi, ["DEAT", "AGE"])!.value).toBe("363d");
  });

  it("converts a calendar keyword after a qualifier and on both ends of a range", () => {
    const { records } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 BIRT\n2 DATE ABT JULIAN 1750\n1 DEAT\n2 DATE BET JULIAN 1700 AND JULIAN 1710\n" +
        "1 BURI\n2 DATE BET 300 BCE AND 100 BCE\n",
      "5.5.1",
    );
    const indi = record(records, "@I1@");
    expect(findByPath(indi, ["BIRT", "DATE"])!.value).toBe("ABT @#DJULIAN@ 1750");
    expect(findByPath(indi, ["DEAT", "DATE"])!.value).toBe("BET @#DJULIAN@ 1700 AND @#DJULIAN@ 1710");
    expect(findByPath(indi, ["BURI", "DATE"])!.value).toBe("BET 300 B.C. AND 100 B.C.");
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

  it("moves an individual event's ASSO onto the person's own record", () => {
    // 5.5.1 defines ASSO under INDI and nowhere else, so a baptism's godparent
    // has to travel up one level — role, note and citation with it.
    const { records, changes } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 CHR\n2 DATE 12 MAR 1874\n2 ASSO @I2@\n3 ROLE GODP\n3 NOTE from the register\n0 @I2@ INDI\n",
      "5.5.1",
    );
    const indi = record(records, "@I1@");
    const chr = firstChild(indi, "CHR")!;
    expect(firstChild(chr, "ASSO")).toBeUndefined();
    const moved = childrenByTag(indi, "ASSO");
    expect(moved).toHaveLength(1);
    expect(moved[0].value).toBe("@I2@");
    expect(childValue(moved[0], "RELA")).toBe("godparent");
    // Whole: what documented the association came along, restacked to its new depth.
    expect(childValue(moved[0], "NOTE")).toBe("from the register");
    expect(moved[0].level).toBe(1);
    expect(firstChild(moved[0], "RELA")!.level).toBe(2);
    // And the move is disclosed rather than silent.
    expect(changes).toContainEqual({ before: "CHR.ASSO @I2@", after: "INDI.ASSO @I2@" });
  });

  it("moves a family's ASSO to a spouse's record, which is what 5.5.1 has", () => {
    const { records } = migrated(
      "7.0",
      "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I9@\n1 MARR\n2 DATE 1899\n2 ASSO @I2@\n3 ROLE WITN\n1 ASSO @I3@\n2 ROLE OTHER\n3 PHRASE best man\n0 @I1@ INDI\n0 @I9@ INDI\n0 @I2@ INDI\n0 @I3@ INDI\n",
      "5.5.1",
    );
    const fam = record(records, "@F1@");
    // Neither the family nor its marriage keeps one: 5.5.1 has no form for either.
    expect(childrenByTag(fam, "ASSO")).toHaveLength(0);
    expect(firstChild(firstChild(fam, "MARR")!, "ASSO")).toBeUndefined();
    // The husband's record takes both, the marriage's witness and the family's
    // own; their order among themselves says nothing and is not asserted.
    const husb = childrenByTag(record(records, "@I1@"), "ASSO");
    expect(husb.map((a) => a.value).sort()).toEqual(["@I2@", "@I3@"]);
    expect(childValue(husb.find((a) => a.value === "@I3@")!, "RELA")).toBe("best man");
    expect(childrenByTag(record(records, "@I9@"), "ASSO")).toHaveLength(0);
  });

  it("leaves a spouseless family's ASSO where it is rather than dropping it", () => {
    const { records } = migrated(
      "7.0",
      "0 @F1@ FAM\n1 CHIL @I1@\n1 ASSO @I2@\n2 ROLE WITN\n0 @I1@ INDI\n0 @I2@ INDI\n",
      "5.5.1",
    );
    // Nowhere to send it, and an unexpected structure a reader can still find
    // beats one that is gone.
    expect(childrenByTag(record(records, "@F1@"), "ASSO")).toHaveLength(1);
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

  it("keeps a note's MIME, LANG and TRAN as extension tags, not as a name variant", () => {
    const { records } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 NOTE <b>Hi</b>\n2 MIME text/html\n2 LANG en\n2 TRAN Živjo\n3 LANG sl\n" +
        "0 @N1@ SNOTE Shared\n1 LANG en\n",
      "5.5.1",
    );
    const note = firstChild(record(records, "@I1@"), "NOTE")!;
    expect(note.children.map((c) => c.tag)).toEqual(["_MIME", "_LANG", "_TRAN"]);
    expect(childValue(note, "_TRAN")).toBe("Živjo");
    expect(record(records, "@N1@").children.map((c) => c.tag)).toEqual(["_LANG"]);
  });

  it("writes @VOID@ pointers the way 5.5.1 can, or drops them", () => {
    const { records } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 FAMC @VOID@\n1 BAPM\n2 ASSO @VOID@\n3 PHRASE Ana Novak\n3 ROLE GODP\n4 PHRASE botra\n" +
        "2 SOUR @VOID@\n3 PAGE Parish book, p. 4\n3 DATA\n4 TEXT baptized\n2 SDATE 3 MAR 1900\n" +
        "0 @F1@ FAM\n1 HUSB @VOID@\n2 PHRASE unknown soldier\n1 WIFE @I1@\n",
      "5.5.1",
    );
    const indi = record(records, "@I1@");
    expect(firstChild(indi, "FAMC")).toBeUndefined();
    const bapm = firstChild(indi, "BAPM")!;
    expect(firstChild(bapm, "ASSO")).toBeUndefined();
    expect(childValue(bapm, "NOTE")).toBe("Ana Novak (botra)");
    const sour = firstChild(bapm, "SOUR")!;
    expect(sour.value).toBe("Parish book, p. 4");
    expect(sour.children.map((c) => `${c.tag} ${c.value}`)).toEqual(["TEXT baptized"]);
    expect(childValue(bapm, "_SDATE")).toBe("3 MAR 1900");
    const fam = record(records, "@F1@");
    expect(firstChild(fam, "HUSB")).toBeUndefined();
    expect(childValue(fam, "NOTE")).toBe("unknown soldier");
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

describe("migrateVersion 5.5.1 → 7.0 → 5.5.1", () => {
  it("brings a 5.5.1 file back as it was", () => {
    const body =
      "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 BIRT\n2 DATE BET @#DJULIAN@ 1700 AND @#DJULIAN@ 1710\n" +
      "1 DEAT\n2 DATE ABT @#DJULIAN@ 1750\n1 BURI\n2 DATE BET 300 B.C. AND 100 B.C.\n" +
      "1 ASSO @I2@\n2 RELA Godmother\n1 NOTE @N1@\n1 OBJE\n2 FILE scan.djvu\n3 FORM djvu\n" +
      "0 @I2@ INDI\n1 NAME Eva /Kos/\n0 @N1@ NOTE Shared\n";
    const { records } = migrated("5.5.1", body, "7.0");
    migrateVersion(records, "7.0", "5.5.1", () => {});
    expect(serializeGedcom(records)).toBe(head("5.5.1") + body + "0 TRLR\n");
  });

  it("brings the vendor lines 7.0 standardized back in the file's own spelling", () => {
    const body =
      "0 @I1@ INDI\n1 NAME Ana /Novak/\n2 GIVN Ana\n2 _MARNM Kovač\n2 SURN Novak\n2 _MARNM /Horvat/\n3 SOUR @S1@\n" +
      "1 NAME Anica //\n2 TYPE aka\n1 _uid 0A1B2C\n1 _FID GPZG-CXL\n" +
      "0 @I2@ INDI\n1 NAME Eva /Kos/\n1 _FSFTID LXYZ-123\n0 @S1@ SOUR\n1 TITL Register\n";
    const { records } = migrated("5.5.1", body, "7.0");
    migrateVersion(records, "7.0", "5.5.1", () => {});
    expect(serializeGedcom(records)).toBe(head("5.5.1") + body + "0 TRLR\n");
  });
});

describe("migrateVersion — vendor tags with a GEDCOM 7 standard form", () => {
  it("turns _UID, the FamilySearch ids and _MARNM into UID, EXID and a married NAME", () => {
    const { records, changes } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 NAME Ana /Novak/\n2 _MARNM Kovač\n3 SOUR @S1@\n1 _UID 0A1B2C\n1 _FID GPZG-CXL\n" +
        "0 @I2@ INDI\n1 NAME Eva /Kos/\n1 _FSFTID LXYZ-123\n0 @S1@ SOUR\n",
      "7.0",
    );
    const text = serializeGedcom(records);
    expect(text).toContain(
      "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 NAME Ana /Kovač/\n2 TYPE MARRIED\n2 SOUR @S1@\n1 UID 0A1B2C\n" +
        "1 EXID GPZG-CXL\n2 TYPE https://www.familysearch.org/tree/person/\n",
    );
    expect(text).toContain("1 EXID LXYZ-123\n2 TYPE https://www.familysearch.org/tree/person/\n");
    expect(text).not.toMatch(/_MARNM|_UID|_FID|_FSFTID/);
    expect(changes).toContainEqual({ before: "NAME._MARNM Kovač", after: "NAME Ana /Kovač/" });
    expect(changes).toContainEqual({ before: "_UID 0A1B2C", after: "UID 0A1B2C" });
  });

  it("keeps the married name readable as the person's married surname", () => {
    const ds = dataset(head("5.5.1") + "0 @I1@ INDI\n1 NAME Ana /Novak/\n2 _MARNM Kovač\n0 TRLR\n");
    migrateVersion(ds.records, "5.5.1", "7.0", () => {});
    const rebuilt = dataset(serializeGedcom(ds.records).replace("VERS 5.5.1", "VERS 7.0"));
    const names = rebuilt.individuals.get("@I1@")!.names;
    expect(names.map((n) => [n.surname, n.type])).toEqual([["Novak", undefined], ["Kovač", "MARRIED"]]);
  });

  it("leaves a 7.0 file's own married NAMEs and FamilySearch EXIDs to their 5.5.1 forms on the way down", () => {
    const { records } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 NAME Ana /Kovač/\n2 TYPE MARRIED\n1 UID 0A1B2C\n" +
        "1 EXID GPZG-CXL\n2 TYPE https://www.familysearch.org/tree/person/\n",
      "5.5.1",
    );
    expect(serializeGedcom(records)).toContain(
      "1 NAME Ana /Novak/\n1 NAME Ana /Kovač/\n2 TYPE married\n1 _UID 0A1B2C\n1 _FSFTID GPZG-CXL\n",
    );
  });

  it("does not touch the vendor tags of a file that stays in its version", () => {
    const { records, changed } = migrated("7.0", "0 @I1@ INDI\n1 NAME Ana /Novak/\n2 _MARNM Kovač\n1 _UID 1\n", "7.0");
    expect(changed).toBe(0);
    expect(serializeGedcom(records)).toContain("2 _MARNM Kovač\n1 _UID 1\n");
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

  it("spells name types 7.0's way in both directions", () => {
    const body = "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 NAME Anica //\n2 TYPE aka\n1 NAME /Kovač/\n2 TYPE variation\n";
    const typesOf = (records: GedNode[]) =>
      childrenByTag(record(records, "@I1@"), "NAME").map((n) => childValue(n, "TYPE"));
    const up = migrated("5.5.1", body, "7.0");
    expect(typesOf(up.records)).toEqual([undefined, "AKA", "variation"]);
    expect(up.changes).toContainEqual({ before: "TYPE aka", after: "TYPE AKA" });
    const down = migrated("7.0", body.replace("TYPE aka", "TYPE AKA"), "5.5.1");
    expect(typesOf(down.records)).toEqual([undefined, "aka", "variation"]);
  });

  it("merges a name variant into a 7.0 main as AKA even when the main writes aka", () => {
    const main = head("7.0") + "0 @I1@ INDI\n1 NAME Franc /Novak/\n1 NAME Frenk //\n2 TYPE aka\n0 TRLR\n";
    const compare = head("7.0") + "0 @I1@ INDI\n1 NAME Ana /Novak/\n2 _AKA Anica\n0 TRLR\n";
    const { dataset: out } = normalizeDataset(dataset(compare), inferMainProfile(dataset(main)));
    const names = childrenByTag(out.records.find((r) => r.xref === "@I1@")!, "NAME");
    expect(names.map((n) => childValue(n, "TYPE"))).toEqual([undefined, "AKA"]);
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

describe("migrateVersion — the events lifted as first-class ones", () => {
  // Every tag and substructure here is spelled alike in 5.5.1 and 7.0; only an
  // ordinance status's enumeration differs.
  const EVENTS =
    "0 @I1@ INDI\n1 NAME Ana /Novak/\n1 ORDN\n2 DATE 1905\n1 CHRA\n2 DATE 1920\n1 BLES\n1 BARM\n1 BASM\n" +
    "1 BAPL\n2 DATE 1950\n2 TEMP SLAKE\n2 STAT COMPLETED\n3 DATE 1951\n1 CONL\n2 TEMP SLAKE\n1 ENDL\n" +
    "1 SLGC\n2 TEMP LOGAN\n2 FAMC @F1@\n1 FAMC @F1@\n" +
    "0 @F1@ FAM\n1 CHIL @I1@\n1 ANUL\n2 DATE 1921\n1 DIVF\n1 MARC\n1 MARS\n1 RESI\n2 DATE 1901\n1 CENS\n1 NCHI 4\n" +
    "1 SLGS\n2 TEMP SLAKE\n2 STAT COMPLETED\n3 DATE 1956\n";

  it.each([["5.5.1", "7.0"], ["7.0", "5.5.1"]] as const)("leaves them untouched from %s to %s", (from, to) => {
    const { records, changed } = migrated(from, EVENTS, to);
    expect(changed).toBe(0);
    expect(serializeGedcom(records)).toContain(EVENTS);
  });

  it("upgrades an ordinance status to the 7.0 enumeration", () => {
    const { records, changes } = migrated(
      "5.5.1",
      "0 @I1@ INDI\n1 BAPL\n2 STAT PRE-1970\n3 DATE 1970\n1 ENDL\n2 STAT Completed\n3 DATE 1990\n" +
      "0 @F1@ FAM\n1 SLGS\n2 STAT DNS/CAN\n3 DATE 2000\n",
      "7.0",
    );
    const indi = record(records, "@I1@");
    expect(findByPath(indi, ["BAPL", "STAT"])!.value).toBe("PRE_1970");
    expect(findByPath(indi, ["ENDL", "STAT"])!.value).toBe("COMPLETED");
    expect(findByPath(record(records, "@F1@"), ["SLGS", "STAT"])!.value).toBe("DNS_CAN");
    expect(changes).toHaveLength(3);
  });

  it("downgrades the two statuses 5.5.1 punctuates differently, and leaves an unknown one alone", () => {
    const { records } = migrated(
      "7.0",
      "0 @I1@ INDI\n1 BAPL\n2 STAT PRE_1970\n3 DATE 1970\n1 CONL\n2 STAT Waiting\n3 DATE 1990\n" +
      "0 @F1@ FAM\n1 SLGS\n2 STAT DNS_CAN\n3 DATE 2000\n",
      "5.5.1",
    );
    const indi = record(records, "@I1@");
    expect(findByPath(indi, ["BAPL", "STAT"])!.value).toBe("PRE-1970");
    expect(findByPath(indi, ["CONL", "STAT"])!.value).toBe("Waiting");
    expect(findByPath(record(records, "@F1@"), ["SLGS", "STAT"])!.value).toBe("DNS/CAN");
  });
});

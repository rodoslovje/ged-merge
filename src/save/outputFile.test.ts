import { describe, expect, it } from "vitest";
import { SUBMITTER_NAME } from "../gedcom/newFile";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { GedNode } from "../gedcom/types";
import { completeStructure, convertVersion, outputOptions, prepareDownload, SCHEMA_BASE, writeSchema } from "./outputFile";

const when = new Date(Date.UTC(2026, 9, 23, 12, 0, 0));

function parse(text: string) {
  return parseGedcom(new TextEncoder().encode(text).buffer);
}

/** Load `text`, prepare it as a download in `version` (default: its own) and
 *  write it out. */
function download(text: string, version?: "5.5.1" | "7.0") {
  const ds = parse(text);
  const records: GedNode[] = ds.records;
  const prepared = prepareDownload(records, ds, version, when);
  const out = serializeGedcom(records, outputOptions(ds, version ?? (ds.version === "7.0" ? "7.0" : "5.5.1")));
  return { ...prepared, out, lines: out.trimEnd().split("\n") };
}

describe("convertVersion — saving in the other GEDCOM version", () => {
  const v551 = [
    "0 HEAD", "1 SOUR Other", "1 SUBM @U1@", "1 SUBN @S1@", "1 FILE old.ged", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 EMAIL ana@@example.si", "1 NOTE @N1@", "1 _UID 42",
    "1 BIRT", "2 DATE @#DJULIAN@ 1 JAN 1700",
    "0 @N1@ NOTE A shared note",
    "0 @U1@ SUBM", "1 NAME Ana",
    "0 @S1@ SUBN",
    "0 TRLR", "",
  ].join("\n");

  it("5.5.1 → 7.0: version, header, shared notes, dates, schema and escapes", () => {
    const { conversion, lines } = download(v551, "7.0");
    expect(conversion?.length).toBeGreaterThan(0);
    expect(lines.slice(0, 3)).toEqual(["0 HEAD", "1 GEDC", "2 VERS 7.0"]);
    expect(lines).not.toContain("2 FORM LINEAGE-LINKED");
    expect(lines).not.toContain("1 CHAR UTF-8");
    expect(lines).not.toContain("1 FILE old.ged");
    expect(lines).toContain("0 @N1@ SNOTE A shared note");
    expect(lines).toContain("1 SNOTE @N1@");
    expect(lines).toContain("2 DATE JULIAN 1 JAN 1700");
    expect(lines).toContain("1 EMAIL ana@example.si");
    expect(lines).toContain("0 @S1@ _SUBN");
    expect(lines).toContain("1 _SUBN @S1@");
    expect(lines).toContain("1 SCHMA");
    expect(lines).toContain(`2 TAG _SUBN ${SCHEMA_BASE}_SUBN`);
    // _UID has a standard form in 7.0, so it is converted, not declared.
    expect(lines).toContain("1 UID 42");
    expect(lines.some((l) => l.includes("_UID"))).toBe(false);
    // The submitter stays: optional in 7.0, but the file's own.
    expect(lines).toContain("0 @U1@ SUBM");
    const back = parse(lines.join("\n") + "\n");
    expect(back.version).toBe("7.0");
    expect(back.records.find((r) => r.xref === "@I1@")?.children.find((c) => c.tag === "EMAIL")?.value).toBe("ana@example.si");
  });

  it("7.0 → 5.5.1: version, FORM, CHAR, submitter, notes, no schema", () => {
    const v7 = [
      "0 HEAD", "1 GEDC", "2 VERS 7.0", "1 SCHMA", "2 TAG _UID https://example.org/uid",
      "0 @I1@ INDI", "1 EMAIL ana@example.si", "1 SNOTE @N1@", "1 _UID 42",
      "0 @N1@ SNOTE Shared",
      "0 TRLR", "",
    ].join("\n");
    const { fixes, lines } = download(v7, "5.5.1");
    expect(fixes).toEqual(expect.arrayContaining(["subm", "char"]));
    const gedc = lines.indexOf("1 GEDC");
    expect(lines.slice(gedc, gedc + 3)).toEqual(["1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED"]);
    expect(lines).toContain("1 CHAR UTF-8");
    expect(lines).toContain("0 @U1@ SUBM");
    expect(lines).toContain("0 @N1@ NOTE Shared");
    expect(lines).toContain("1 NOTE @N1@");
    expect(lines).toContain("1 EMAIL ana@@example.si");
    expect(lines.some((l) => l.includes("SCHMA"))).toBe(false);
    expect(parse(lines.join("\n") + "\n").version).toBe("5.5.1");
  });

  it("a converted file follows the target's at-sign rule, whatever the source spelled", () => {
    const bare551 = "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @I1@ INDI\n1 EMAIL ana@example.si\n1 NOTE a@@b\n0 TRLR\n";
    expect(download(bare551).out).toContain("1 EMAIL ana@example.si\n"); // untouched, own version
    const to7 = download(bare551, "7.0").out;
    expect(to7).toContain("1 EMAIL ana@example.si\n");
    expect(to7).toContain("1 NOTE a@b\n");
    const v7 = "0 HEAD\n1 GEDC\n2 VERS 7.0\n0 @I1@ INDI\n1 EMAIL ana@example.si\n1 NOTE a@@b\n0 TRLR\n";
    const to551 = download(v7, "5.5.1").out;
    expect(to551).toContain("1 EMAIL ana@@example.si\n");
    expect(to551).toContain("1 NOTE a@@@@b\n");
  });

  it("converts nothing when saved in the file's own version", () => {
    expect(download(v551).conversion).toBeNull();
    expect(convertVersion(parse(v551).records, "5.5.1", "5.5.1")).toEqual([]);
  });
});

describe("writeSchema — GEDCOM 7 extension tags", () => {
  it("declares every extension tag a 7.0 file uses, after GEDC, in the file's spelling", () => {
    const { lines } = download([
      "0 HEAD", "1 GEDC", "2 VERS 7.0",
      "0 @I1@ INDI", "1 _UID 123", "1 NAME Ana /Novak/", "2 _MARNM Kos", "1 _myTag x", "2 _UID 4",
      "0 TRLR", "",
    ].join("\n"));
    expect(lines.slice(0, 7)).toEqual([
      "0 HEAD",
      "1 GEDC",
      "2 VERS 7.0",
      "1 SCHMA",
      `2 TAG _MARNM ${SCHEMA_BASE}_MARNM`,
      `2 TAG _UID ${SCHEMA_BASE}_UID`,
      `2 TAG _myTag ${SCHEMA_BASE}_myTag`,
    ]);
  });

  it("keeps the header's own entries and never repeats one", () => {
    const { lines } = download([
      "0 HEAD", "1 GEDC", "2 VERS 7.0", "1 SCHMA", "2 TAG _UID https://example.org/uid",
      "0 @I1@ INDI", "1 _UID 1", "1 _FSFTID ABCD-123",
      "0 TRLR", "",
    ].join("\n"));
    expect(lines.filter((l) => l.startsWith("2 TAG"))).toEqual([
      "2 TAG _UID https://example.org/uid",
      `2 TAG _FSFTID ${SCHEMA_BASE}_FSFTID`,
    ]);
    expect(lines.filter((l) => l === "1 SCHMA")).toHaveLength(1);
  });

  it("writes no schema for a 7.0 file without extensions, nor for 5.5.1", () => {
    expect(writeSchema(parse("0 HEAD\n1 GEDC\n2 VERS 7.0\n0 @I1@ INDI\n0 TRLR\n").records)).toEqual([]);
    expect(download("0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @I1@ INDI\n1 _UID 1\n0 TRLR\n").out).not.toContain("SCHMA");
  });
});

describe("completeStructure — header and trailer", () => {
  it("gives a headerless file a 5.5.1 header and a trailer", () => {
    const { fixes, lines } = download("0 @I1@ INDI\n1 NAME Ana /Novak/\n");
    expect(fixes).toEqual(expect.arrayContaining(["head", "trlr"]));
    expect(lines[0]).toBe("0 HEAD");
    expect(lines).toContain("1 GEDC");
    expect(lines).toContain("2 VERS 5.5.1");
    expect(lines).toContain("2 FORM LINEAGE-LINKED");
    expect(lines).toContain("1 CHAR UTF-8");
    expect(lines).toContain("1 SOUR GEDMERGE");
    expect(lines[lines.length - 1]).toBe("0 TRLR");
    // Read back, the file is a declared 5.5.1 file with no version warning.
    const back = parse(lines.join("\n") + "\n");
    expect(back.version).toBe("5.5.1");
    expect(back.warnings.filter((w) => w.kind === "version")).toEqual([]);
  });

  it("adds only what is missing, and nothing to a complete file", () => {
    const complete = "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n0 @I1@ INDI\n0 TRLR\n";
    expect(completeStructure(parse(complete).records, "5.5.1", false)).not.toContain("head");
    expect(completeStructure(parse(complete).records, "5.5.1", false)).not.toContain("gedc");
    expect(completeStructure(parse(complete).records, "5.5.1", false)).not.toContain("trlr");
    expect(completeStructure(parse(complete).records, "5.5.1", false)).not.toContain("char");

    const noTrlr = parse("0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n0 @I1@ INDI\n");
    expect(completeStructure(noTrlr.records, "5.5.1", false)).toEqual(expect.arrayContaining(["trlr", "gedc"]));
  });

  it("lists without changing anything when not applying", () => {
    const ds = parse("0 @I1@ INDI\n");
    const before = serializeGedcom(ds.records);
    completeStructure(ds.records, "5.5.1", false);
    expect(serializeGedcom(ds.records)).toBe(before);
  });

  it("fills a header that does not declare its version", () => {
    const { fixes, lines } = download("0 HEAD\n1 CHAR UTF-8\n0 @I1@ INDI\n0 TRLR\n");
    expect(fixes).toContain("gedc");
    const at = lines.indexOf("1 GEDC");
    expect(lines.slice(at, at + 4)).toEqual(["1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8"]);
  });

  it("gives a 5.5.1 file without a submitter one, named by the header", () => {
    const { fixes, lines } = download("0 HEAD\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n0 @U1@ INDI\n0 TRLR\n");
    expect(fixes).toEqual(["subm"]);
    // @U1@ is taken by a person, so the submitter takes the next free id.
    expect(lines).toContain("1 SUBM @U2@");
    expect(lines.slice(-3)).toEqual(["0 @U2@ SUBM", `1 NAME ${SUBMITTER_NAME}`, "0 TRLR"]);
    // The header's own order: SOUR, DATE, then SUBM.
    const head = lines.slice(0, lines.indexOf("1 GEDC"));
    expect(head.indexOf("1 SUBM @U2@")).toBeGreaterThan(head.findIndex((l) => l.startsWith("1 DATE")));
  });

  it("points the header at the file's own submitter, or gives a dangling pointer its record", () => {
    const own = download("0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n0 @S9@ SUBM\n1 NAME Ana\n0 TRLR\n");
    expect(own.lines).toContain("1 SUBM @S9@");
    expect(own.lines.filter((l) => l.endsWith(" SUBM"))).toEqual(["0 @S9@ SUBM"]);

    const dangling = download("0 HEAD\n1 SUBM @X1@\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n0 TRLR\n");
    expect(dangling.fixes).toContain("subm");
    expect(dangling.lines).toContain("0 @X1@ SUBM");
  });

  it("names a submitter it has to make after the reader, when Settings give a name", () => {
    const text = "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n0 TRLR\n";
    const ds = parse(text);
    const { fixes } = prepareDownload(ds.records, ds, "5.5.1", when, "  Ana   Novak ");
    expect(fixes).toEqual(["subm"]);
    const lines = serializeGedcom(ds.records, outputOptions(ds, "5.5.1")).trimEnd().split("\n");
    expect(lines.slice(-3)).toEqual(["0 @U1@ SUBM", "1 NAME Ana Novak", "0 TRLR"]);
    // An empty or blank setting falls back to the program's name.
    const blank = parse(text);
    prepareDownload(blank.records, blank, "5.5.1", when, "   ");
    expect(blank.records.find((r) => r.tag === "SUBM")?.children[0].value).toBe(SUBMITTER_NAME);
  });

  it("never renames the file's own submitter, whatever the setting says", () => {
    const text = "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n0 @S9@ SUBM\n1 NAME Ana\n0 TRLR\n";
    const ds = parse(text);
    prepareDownload(ds.records, ds, "5.5.1", when, "Janez Kranjec");
    const subms = ds.records.filter((r) => r.tag === "SUBM");
    expect(subms).toHaveLength(1);
    expect(subms[0].children.find((c) => c.tag === "NAME")?.value).toBe("Ana");
    // A 7.0 save adds none, named or not.
    const v7 = parse("0 HEAD\n1 GEDC\n2 VERS 7.0\n0 TRLR\n");
    prepareDownload(v7.records, v7, "7.0", when, "Janez Kranjec");
    expect(v7.records.some((r) => r.tag === "SUBM")).toBe(false);
  });

  it("leaves a 5.5.1 file with a submitter, and a 7.0 file without one, alone", () => {
    const ok = "0 HEAD\n1 SUBM @U1@\n1 GEDC\n2 VERS 5.5.1\n2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n0 @U1@ SUBM\n1 NAME Ana\n0 TRLR\n";
    expect(completeStructure(parse(ok).records, "5.5.1", false)).toEqual([]);
    const v7 = "0 HEAD\n1 GEDC\n2 VERS 7.0\n0 @I1@ INDI\n0 TRLR\n";
    expect(completeStructure(parse(v7).records, "7.0", false)).toEqual([]);
  });

  it("gives a 7.0 header GEDC first and no CHAR", () => {
    const ds = parse("0 @I1@ INDI\n");
    completeStructure(ds.records, "7.0");
    const head = ds.records[0];
    expect(head.tag).toBe("HEAD");
    expect(head.children[0].tag).toBe("GEDC");
    expect(head.children.some((c) => c.tag === "CHAR")).toBe(false);
  });
});

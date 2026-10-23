import { describe, expect, it } from "vitest";
import { SUBMITTER_NAME } from "../gedcom/newFile";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import type { GedNode } from "../gedcom/types";
import { completeStructure, outputOptions, prepareDownload, SCHEMA_BASE, writeSchema } from "./outputFile";

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

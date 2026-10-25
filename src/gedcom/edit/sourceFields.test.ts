import { describe, expect, it } from "vitest";
import { buildDataset } from "../builder";
import { parseGedcom } from "../parser";
import { filingNumberOf, periodicalOf } from "../source";
import { validateConformance } from "../../tools/conformance/conformance";
import {
  createSourceRecord, keepsSourceTag, setSourceRecordFields, settleSourceFields, sourceRecordEditFields, titleWithPeriodical,
} from "./sources";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));
}
const wrap = (body: string, version = "5.5.1") =>
  `0 HEAD\n1 GEDC\n2 VERS ${version}\n${version === "7.0" ? "" : "2 FORM LINEAGE-LINKED\n1 CHAR UTF-8\n"}${body}0 TRLR\n`;
/** What the conformance check finds on the source records alone. */
const sourceFindings = (ds: { records: Parameters<typeof validateConformance>[0]["records"] }) =>
  validateConformance(ds).filter((i) => i.recordTag === "SOUR").map((i) => i.messageKey);
const lines = (node: { children: { tag: string; value?: string; children: unknown[] }[] }) =>
  node.children.map((c) => `${c.tag}${c.value ? ` ${c.value}` : ""}`);

describe("a source's filing number and periodical (FILN/PERI, in neither standard)", () => {
  it("keeps the bare tag only in the file's own format, where the file writes it", () => {
    const habit = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 FILN 123\n"));
    expect(keepsSourceTag(habit.records, "FILN")).toBe(true);
    expect(keepsSourceTag(habit.records, "FILN", { standard: "5.5.1" })).toBe(false);
    // GED Merge's own earlier extension is no habit to copy.
    const none = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 _FILN 1\n"));
    expect(keepsSourceTag(none.records, "FILN")).toBe(false);
    expect(keepsSourceTag(none.records, "PERI")).toBe(false);
  });

  it("joins a periodical to the title once", () => {
    expect(titleWithPeriodical("Obituary", "Slovenec")).toBe("Obituary, Slovenec");
    expect(titleWithPeriodical("", "Slovenec")).toBe("Slovenec");
    expect(titleWithPeriodical("Slovenec, 3 May 1910", "slovenec")).toBe("Slovenec, 3 May 1910");
    expect(titleWithPeriodical("Obituary", undefined)).toBe("Obituary");
  });

  it("writes a new source's fields in the file's own lines where it keeps them", () => {
    const ds = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 FILN 1\n1 PERI Daily\n"));
    const fields = { title: "Register", periodical: "Weekly", agency: "Archive", filingNumber: "007" };
    const own = createSourceRecord(ds.records, fields);
    expect(lines(own)).toEqual(["TITL Register", "PERI Weekly", "AGNC Archive", "FILN 007"]);
    expect(filingNumberOf(own)).toBe("007");
    expect(periodicalOf(own)).toBe("Weekly");
  });

  for (const version of ["5.5.1", "7.0"] as const) {
    it(`writes the standard's forms in a strict ${version} file: the call number, the title`, () => {
      const ds = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n", version));
      const fields = { title: "Register", periodical: "Weekly", agency: "Archive", filingNumber: "007" };
      const rec = createSourceRecord(ds.records, fields, undefined, { standard: version });
      // The id is written bare for the caller to settle once its repository
      // link is in place; with none, it hangs on a link to no repository.
      settleSourceFields(rec, version);
      expect(lines(rec)).toEqual(["TITL Register, Weekly", "DATA", version === "7.0" ? "REPO @VOID@" : "REPO"]);
      expect(lines(rec.children.find((c) => c.tag === "REPO")!)).toEqual(["CALN 007"]);
      expect(sourceFindings(ds)).toEqual([]);
    });

    it(`edits a source into the standard's forms in a strict ${version} file`, () => {
      const ds = dataset(wrap("0 @R1@ REPO\n1 NAME Archive\n0 @S1@ SOUR\n1 TITL Book\n1 PERI Daily\n1 _FILN 123\n1 REPO @R1@\n", version));
      const rec = ds.records.find((r) => r.xref === "@S1@")!;
      const overrides = { standard: version };
      setSourceRecordFields(ds.records, rec, { title: "Book", filingNumber: "124" }, undefined, overrides);
      expect(lines(rec)).toEqual(["TITL Book, Daily", "REPO @R1@"]);
      expect(lines(rec.children.find((c) => c.tag === "REPO")!)).toEqual(["CALN 124"]);
      expect(sourceFindings(ds)).toEqual([]);
      // The repository goes, the call number stays — on a link to none.
      setSourceRecordFields(ds.records, rec, { title: "Book, Daily", repoXref: "", repoCaln: "124" }, undefined, overrides);
      expect(lines(rec)).toEqual(["TITL Book, Daily", version === "7.0" ? "REPO @VOID@" : "REPO"]);
      expect(sourceRecordEditFields(ds.records, rec)).toMatchObject({ repoXref: "", repoCaln: "124" });
      expect(sourceFindings(ds)).toEqual([]);
    });
  }

  it("is checked against the version: 7.0 has no repository link without a pointer", () => {
    expect(sourceFindings(dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 REPO\n2 CALN 5\n", "7.0")))).not.toEqual([]);
    expect(sourceFindings(dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 REPO\n2 CALN 5\n")))).toEqual([]);
  });

  it("keeps the file's own FILN when it writes one, turning the old extension into it", () => {
    const ds = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 FILN 123\n0 @S2@ SOUR\n1 TITL Other\n1 _FILN 9\n"));
    const s2 = ds.records.find((r) => r.xref === "@S2@")!;
    expect(settleSourceFields(s2, "5.5.1", { FILN: true }).length).toBe(1);
    expect(lines(s2)).toEqual(["TITL Other", "FILN 9"]);
    // Idempotent: nothing left to settle.
    expect(settleSourceFields(s2, "5.5.1", { FILN: true })).toEqual([]);
  });

  it("adds a call number only once, beside a link that already states it", () => {
    const ds = dataset(wrap("0 @R1@ REPO\n1 NAME A\n0 @S1@ SOUR\n1 TITL Book\n1 FILN 5\n1 REPO @R1@\n2 CALN 5\n"));
    const rec = ds.records.find((r) => r.xref === "@S1@")!;
    settleSourceFields(rec, "5.5.1");
    expect(lines(rec.children.find((c) => c.tag === "REPO")!)).toEqual(["CALN 5"]);
    expect(settleSourceFields(rec, "5.5.1")).toEqual([]);
  });
});

describe("a source's date range in the source editor", () => {
  it("is read and written inside DATA › EVEN where the record states its coverage there", () => {
    const ds = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 DATA\n2 EVEN BIRT\n3 DATE FROM 1768 TO 1758\n3 PLAC Kranj\n"));
    const rec = ds.records.find((r) => r.xref === "@S1@")!;
    expect(sourceRecordEditFields(ds.records, rec).dateRange).toBe("FROM 1768 TO 1758");
    setSourceRecordFields(ds.records, rec, { title: "Book", place: "Kranj", dateRange: "FROM 1758 TO 1768" });
    const even = rec.children.find((c) => c.tag === "DATA")!.children[0];
    expect(lines(even)).toEqual(["DATE FROM 1758 TO 1768", "PLAC Kranj"]);
    expect(rec.children.some((c) => c.tag === "DATE" || c.tag === "_DATE")).toBe(false);
  });

  it("stays on the record's own line where it has one, and a strict target writes the extension", () => {
    const ds = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 DATE FROM 1768 TO 1758\n"));
    const rec = ds.records.find((r) => r.xref === "@S1@")!;
    expect(sourceRecordEditFields(ds.records, rec).dateRange).toBe("FROM 1768 TO 1758");
    setSourceRecordFields(ds.records, rec, { title: "Book", dateRange: "FROM 1758 TO 1768" });
    expect(lines(rec)).toEqual(["TITL Book", "DATE FROM 1758 TO 1768"]);
    setSourceRecordFields(ds.records, rec, { title: "Book", dateRange: "FROM 1758 TO 1769" }, undefined, { standard: "7.0" });
    expect(lines(rec)).toEqual(["TITL Book", "_DATE FROM 1758 TO 1769"]);
  });

  it("is left alone when the editor does not say", () => {
    const ds = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 DATE 1768\n"));
    const rec = ds.records.find((r) => r.xref === "@S1@")!;
    setSourceRecordFields(ds.records, rec, { title: "Book 2" });
    expect(lines(rec)).toEqual(["TITL Book 2", "DATE 1768"]);
  });
});

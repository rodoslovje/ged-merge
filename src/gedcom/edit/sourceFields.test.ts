import { describe, expect, it } from "vitest";
import { buildDataset } from "../builder";
import { parseGedcom } from "../parser";
import { filingNumberOf, periodicalOf } from "../source";
import { createSourceRecord, setSourceRecordFields, sourceFieldTag, sourceRecordEditFields } from "./sources";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));
}
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const lines = (node: { children: { tag: string; value?: string; children: unknown[] }[] }) =>
  node.children.map((c) => `${c.tag}${c.value ? ` ${c.value}` : ""}`);

describe("a source's filing number and periodical (FILN/PERI, in neither standard)", () => {
  it("keeps the bare tag only in the file's own format, where the file writes it", () => {
    const habit = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 FILN 123\n"));
    expect(sourceFieldTag(habit.records, "FILN")).toBe("FILN");
    expect(sourceFieldTag(habit.records, "FILN", { standard: "5.5.1" })).toBe("_FILN");
    const none = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n"));
    expect(sourceFieldTag(none.records, "FILN")).toBe("_FILN");
    expect(sourceFieldTag(none.records, "PERI")).toBe("_PERI");
  });

  it("writes a new source's fields in the target's forms: the agency inside DATA when strict", () => {
    const ds = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 FILN 1\n1 PERI Daily\n"));
    const fields = { title: "Register", periodical: "Weekly", agency: "Archive", filingNumber: "007" };
    const own = createSourceRecord(ds.records, fields);
    expect(lines(own)).toEqual(["TITL Register", "PERI Weekly", "AGNC Archive", "FILN 007"]);
    const strict = createSourceRecord(ds.records, fields, undefined, { standard: "7.0" });
    expect(lines(strict)).toEqual(["TITL Register", "_PERI Weekly", "DATA", "_FILN 007"]);
    expect(lines(strict.children.find((c) => c.tag === "DATA")!)).toEqual(["AGNC Archive"]);
    expect(filingNumberOf(strict)).toBe("007");
    expect(periodicalOf(strict)).toBe("Weekly");
  });

  it("edits the field under whichever spelling it has, and a strict target rewrites a bare one", () => {
    const ds = dataset(wrap("0 @S1@ SOUR\n1 TITL Book\n1 FILN 123\n"));
    const rec = ds.records.find((r) => r.xref === "@S1@")!;
    setSourceRecordFields(ds.records, rec, { title: "Book", filingNumber: "124" });
    expect(lines(rec)).toEqual(["TITL Book", "FILN 124"]);
    setSourceRecordFields(ds.records, rec, { title: "Book", filingNumber: "125" }, undefined, { standard: "5.5.1" });
    expect(lines(rec)).toEqual(["TITL Book", "_FILN 125"]);
    setSourceRecordFields(ds.records, rec, { title: "Book", filingNumber: "" }, undefined, { standard: "5.5.1" });
    expect(lines(rec)).toEqual(["TITL Book"]);
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

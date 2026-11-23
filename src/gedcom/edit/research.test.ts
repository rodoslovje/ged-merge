import { describe, expect, it } from "vitest";
import { buildDataset } from "../builder";
import { cloneNode } from "../node";
import { parseGedcom } from "../parser";
import { readResearchNote, readResearchNotes } from "../research";
import { serializeGedcom } from "../serialize";
import { prepareDownload } from "../../save/outputFile";
import { validateConformance } from "../../tools/conformance/conformance";
import {
  createResearchNote, fileResearchNote, rebuildIndividual, researchIndex, researchNotesOn, researchNotesUnder,
  researchRecords, unfileResearchNote, writeResearchNote, type ResearchFields,
} from ".";

const dataset = (version: "5.5.1" | "7.0") =>
  buildDataset(parseGedcom(new TextEncoder().encode([
    ...(version === "7.0"
      ? ["0 HEAD", "1 GEDC", "2 VERS 7.0", "1 SOUR TEST"]
      : ["0 HEAD", "1 SOUR TEST", "1 SUBM @U1@", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8", "0 @U1@ SUBM", "1 NAME Tester"]),
    "0 @I1@ INDI", "1 NAME Franc /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1 JAN 1850", "1 DEAT", "2 DATE ABT 1910", "1 CHAN", "2 DATE 1 JAN 2020",
    "0 TRLR",
  ].join("\n")).buffer));

const FIELDS: ResearchFields = { kind: "QUESTION", done: false, text: "Did he die in America?\nCheck the lists.", links: ["https://example.org"], media: [] };

describe("research note edits", () => {
  for (const version of ["5.5.1", "7.0"] as const) {
    it(`creates, files and rewrites a note in a valid ${version} file`, () => {
      const ds = dataset(version);
      const indi = ds.individuals.get("@I1@")!;
      const death = indi.raw.children.find((c) => c.tag === "DEAT")!;

      const record = createResearchNote(ds.records, FIELDS, "23 NOV 2026");
      expect(record.xref).toBe("@RN1@");
      // Before the trailer, like any record of a tag the file has none of.
      expect(ds.records[ds.records.length - 2]).toBe(record);
      fileResearchNote(death, "@RN1@");
      fileResearchNote(indi.raw, "@RN1@");
      fileResearchNote(indi.raw, "@RN1@"); // once
      rebuildIndividual(ds, indi);

      expect(serializeGedcom([indi.raw]).trimEnd().split("\n")).toEqual([
        "0 @I1@ INDI", "1 NAME Franc /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1 JAN 1850",
        "1 DEAT", "2 DATE ABT 1910", "2 _RESEARCH @RN1@",
        // Ahead of the record's change stamp.
        "1 _RESEARCH @RN1@", "1 CHAN", "2 DATE 1 JAN 2020",
      ]);
      expect(researchNotesOn(ds.records, death).map((n) => n.id)).toEqual(["@RN1@"]);
      expect(researchNotesUnder(ds.records, indi.raw)).toEqual([
        { note: { id: "@RN1@", created: "23 NOV 2026", ...FIELDS }, events: [undefined, "DEAT"] },
      ]);
      expect(researchIndex(ds.records).refs.get("@RN1@")).toHaveLength(2);

      // Settled, with another kind and no link: the date stays.
      writeResearchNote(ds.records, record, { ...FIELDS, kind: "TASK", done: true, links: [] });
      expect(serializeGedcom([record]).trimEnd().split("\n")).toEqual([
        "0 @RN1@ _RESEARCH", "1 TYPE TASK", "1 STAT DONE", "1 DATE 23 NOV 2026",
        "1 NOTE Did he die in America?", "2 CONT Check the lists.",
      ]);
      expect(researchRecords(ds.records).get("@RN1@")).toBe(record);
      expect(researchNotesOn(ds.records, death)[0]).toMatchObject({ kind: "TASK", done: true });

      const out = ds.records.map(cloneNode); // the download works on a copy
      prepareDownload(out, ds, version, undefined, undefined, true);
      expect(validateConformance({ records: out })).toEqual([]);

      unfileResearchNote(death, "@RN1@");
      unfileResearchNote(indi.raw, "@RN1@");
      rebuildIndividual(ds, indi);
      // Taken off everything, the note is still in the file: not filed.
      expect(readResearchNotes(ds.records)).toMatchObject({ notes: [{ id: "@RN1@" }] });
      expect(researchIndex(ds.records).refs.size).toBe(0);
    });
  }

  it("numbers a second note after the first", () => {
    const ds = dataset("5.5.1");
    createResearchNote(ds.records, FIELDS);
    expect(createResearchNote(ds.records, FIELDS).xref).toBe("@RN2@");
    expect(researchRecords(ds.records).size).toBe(2);
  });

  it("keeps a line the app does not write when a note is rewritten", () => {
    const ds = dataset("5.5.1");
    const record = createResearchNote(ds.records, FIELDS, "23 NOV 2026");
    record.children.push({ level: 1, tag: "CHAN", children: [{ level: 2, tag: "DATE", value: "24 NOV 2026", children: [] }] });
    record.children.splice(2, 0, { level: 1, tag: "_PRIO", value: "1", children: [] });
    // Handed a whole note as read, date and all: the date is not written twice.
    writeResearchNote(ds.records, record, { ...readResearchNote(record), text: "New text" });
    expect(record.children.map((c) => c.tag)).toEqual(["TYPE", "STAT", "_PRIO", "DATE", "NOTE", "WWW", "CHAN"]);
  });
});

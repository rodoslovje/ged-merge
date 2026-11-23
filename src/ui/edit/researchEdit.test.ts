import { describe, expect, it } from "vitest";
import { buildDataset } from "../../gedcom/builder";
import { cloneNode } from "../../gedcom/node";
import { parseGedcom } from "../../gedcom/parser";
import { readResearchNotes } from "../../gedcom/research";
import { serializeGedcom } from "../../gedcom/serialize";
import { prepareDownload } from "../../save/outputFile";
import { validateConformance } from "../../tools/conformance/conformance";
import { findDanglingXrefs } from "../../tools/structure";
import { applyRecordPatches } from "../historyTypes";
import { applyResearchEdit, NEW_RESEARCH_FIELDS, removeResearchNotes, researchDraftOf } from "./researchEdit";

const dataset = (version: "5.5.1" | "7.0") =>
  buildDataset(parseGedcom(new TextEncoder().encode([
    ...(version === "7.0"
      ? ["0 HEAD", "1 GEDC", "2 VERS 7.0", "1 SOUR TEST"]
      : ["0 HEAD", "1 SOUR TEST", "1 SUBM @U1@", "1 GEDC", "2 VERS 5.5.1", "2 FORM LINEAGE-LINKED", "1 CHAR UTF-8", "0 @U1@ SUBM", "1 NAME Tester"]),
    "0 @I1@ INDI", "1 NAME Franc /Novak/", "1 SEX M", "1 FAMS @F1@", "1 BIRT", "2 DATE 1 JAN 1850", "1 DEAT", "2 DATE ABT 1910",
    "0 @I2@ INDI", "1 NAME Ana /Kos/", "1 SEX F", "1 FAMS @F1@",
    "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 MARR", "2 DATE 1875",
    "0 TRLR",
  ].join("\n")).buffer));

const FIELDS = { ...NEW_RESEARCH_FIELDS, text: "Did he die in America?" };

describe("applyResearchEdit", () => {
  for (const version of ["5.5.1", "7.0"] as const) {
    it(`writes a note, its media and its filing as one undo step (${version})`, () => {
      const ds = dataset(version);
      const original = serializeGedcom(ds.records);
      const death = ds.individuals.get("@I1@")!.raw.children.findIndex((c) => c.tag === "DEAT");
      const marriage = ds.families.get("@F1@")!.raw.children.findIndex((c) => c.tag === "MARR");

      const patches = applyResearchEdit(
        ds,
        undefined,
        FIELDS,
        [{ recordId: "@I1@" }, { recordId: "@I1@", eventIndex: death }, { recordId: "@F1@", eventIndex: marriage }],
        { files: ["clippings/farm.jpg"], version },
      );
      // The media record, the note, and the two records it is filed under.
      expect(patches.map((p) => `${p.type} ${p.id} ${p.before ? "changed" : "new"}`)).toEqual([
        "record @O1@ new", "record @RN1@ new", "individual @I1@ changed", "family @F1@ changed",
      ]);
      const draft = researchDraftOf(ds, "@RN1@")!;
      expect(draft.fields).toMatchObject({ text: "Did he die in America?", media: ["@O1@"] });
      // The person's own pointer goes after their events, so each event
      // keeps the position it is named by.
      expect(draft.targets).toEqual([
        { recordId: "@I1@", eventIndex: death },
        { recordId: "@I1@", eventIndex: undefined },
        { recordId: "@F1@", eventIndex: marriage },
      ]);
      const out = ds.records.map(cloneNode); // the download works on a copy
      prepareDownload(out, ds, version, undefined, undefined, true);
      expect(validateConformance({ records: out })).toEqual([]);
      expect(findDanglingXrefs(out)).toEqual([]);

      applyRecordPatches(ds, patches, "undo");
      expect(serializeGedcom(ds.records)).toBe(original);
      applyRecordPatches(ds, patches, "redo");
      expect(readResearchNotes(ds.records).refs.get("@RN1@")).toHaveLength(3);
    });
  }

  it("refiles a note: only the places that changed are touched", () => {
    const ds = dataset("5.5.1");
    applyResearchEdit(ds, undefined, FIELDS, [{ recordId: "@I1@" }]);
    const patches = applyResearchEdit(ds, "@RN1@", { ...FIELDS, done: true }, [{ recordId: "@I2@" }]);
    expect(patches.map((p) => p.id).sort()).toEqual(["@I1@", "@I2@", "@RN1@"]);
    expect(researchDraftOf(ds, "@RN1@")).toMatchObject({ fields: { done: true }, targets: [{ recordId: "@I2@" }] });
    // The same edit again changes nothing but restates the note.
    const again = applyResearchEdit(ds, "@RN1@", { ...FIELDS, done: true }, [{ recordId: "@I2@" }]);
    expect(again.map((p) => p.id)).toEqual(["@RN1@"]);
    expect(JSON.stringify(again[0].before)).toBe(JSON.stringify(again[0].after));
  });

  it("reuses the media record a picked file already has", () => {
    const ds = dataset("5.5.1");
    applyResearchEdit(ds, undefined, FIELDS, [], { files: ["farm.jpg"], version: "5.5.1" });
    const patches = applyResearchEdit(ds, undefined, FIELDS, [], { files: ["farm.jpg"], version: "5.5.1" });
    expect(patches.map((p) => p.id)).toEqual(["@RN2@"]);
    expect(researchDraftOf(ds, "@RN2@")!.fields.media).toEqual(["@O1@"]);
  });

  it("deletes a note with every pointer to it, and undo brings both back", () => {
    const ds = dataset("5.5.1");
    applyResearchEdit(ds, undefined, FIELDS, [{ recordId: "@I1@" }, { recordId: "@I2@" }]);
    const filed = serializeGedcom(ds.records);
    const patches = applyResearchEdit(ds, "@RN1@", null, []);
    expect(serializeGedcom(ds.records)).not.toContain("_RESEARCH");
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records)).toBe(filed);
  });

  it("does nothing for a note that is not there", () => {
    const ds = dataset("5.5.1");
    expect(applyResearchEdit(ds, "@RN9@", FIELDS, [])).toEqual([]);
    expect(applyResearchEdit(ds, undefined, null, [])).toEqual([]);
  });
});

describe("removeResearchNotes", () => {
  it("deletes several notes as one undo step, one patch per record", () => {
    const ds = dataset("5.5.1");
    const death = ds.individuals.get("@I1@")!.raw.children.findIndex((c) => c.tag === "DEAT");
    applyResearchEdit(ds, undefined, { ...FIELDS, done: true }, [{ recordId: "@I1@" }, { recordId: "@I2@" }]);
    applyResearchEdit(ds, undefined, { ...FIELDS, text: "Still open" }, [{ recordId: "@I1@" }]);
    applyResearchEdit(ds, undefined, { ...FIELDS, done: true, text: "Checked the register" }, [{ recordId: "@I1@", eventIndex: death }]);
    const before = serializeGedcom(ds.records);

    const patches = removeResearchNotes(ds, ["@RN1@", "@RN3@"]);
    // The person filed under both notes is patched once.
    expect(patches.map((p) => `${p.type} ${p.id}`).sort()).toEqual([
      "individual @I1@", "individual @I2@", "record @RN1@", "record @RN3@",
    ]);
    const left = readResearchNotes(ds.records);
    expect(left.notes.map((n) => n.id)).toEqual(["@RN2@"]);
    expect([...left.refs.keys()]).toEqual(["@RN2@"]);
    expect(findDanglingXrefs(ds.records)).toEqual([]);

    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records)).toBe(before);
    applyRecordPatches(ds, patches, "redo");
    expect(readResearchNotes(ds.records).notes.map((n) => n.id)).toEqual(["@RN2@"]);
  });
});

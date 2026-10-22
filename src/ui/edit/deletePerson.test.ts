import { describe, expect, it } from "vitest";
import { deletePerson } from "./deletePerson";
import { applyRecordPatches } from "../historyTypes";
import { parseGedcom } from "../../gedcom/parser";
import { buildDataset } from "../../gedcom/builder";
import { serializeGedcom } from "../../gedcom/serialize";

// Regression: deleting a person left the shared notes and media only they
// pointed at as free-standing records (citation removal already prunes an
// uncited source, so a source only they cited goes the same way).
describe("deletePerson", () => {
  const text = [
    "0 HEAD",
    "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 NOTE @N1@", "1 NOTE @N2@", "1 OBJE @O2@",
    "1 BIRT", "2 SOUR @S1@", "2 SOUR @S2@",
    "0 @I2@ INDI", "1 NAME Jože /Kos/", "1 NOTE @N2@", "1 SOUR @S2@",
    "0 @N1@ NOTE Only hers", "1 OBJE @O1@",
    "0 @N2@ NOTE Shared",
    "0 @N3@ NOTE Already an orphan",
    "0 @O1@ OBJE", "1 FILE house.jpg",
    "0 @O2@ OBJE", "1 FILE portrait.jpg",
    "0 @S1@ SOUR", "1 TITL Her register", "1 REPO @R1@",
    "0 @S2@ SOUR", "1 TITL Shared register",
    "0 @R1@ REPO", "1 NAME Archive",
    "0 TRLR",
  ].join("\n");

  it("prunes the notes, media and sources only the person pointed at", () => {
    const ds = buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
    deletePerson(ds, ds.individuals.get("@I1@")!);
    const xrefs = ds.records.map((r) => r.xref).filter(Boolean);
    expect(xrefs).toEqual(["@I2@", "@N2@", "@N3@", "@S2@", "@R1@"]);
  });

  it("undo restores the file byte-identical", () => {
    const ds = buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
    const before = serializeGedcom(ds.records);
    const patches = deletePerson(ds, ds.individuals.get("@I1@")!);
    applyRecordPatches(ds, patches, "undo");
    expect(serializeGedcom(ds.records)).toBe(before);
    applyRecordPatches(ds, patches, "redo");
    expect(ds.records.some((r) => r.xref === "@O1@")).toBe(false);
  });
});

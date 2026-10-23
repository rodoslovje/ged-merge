import { describe, expect, it } from "vitest";
import { buildDataset } from "../builder";
import { parseGedcom } from "../parser";
import { serializeGedcom } from "../serialize";
import { setEventField, setFamilyEventField } from "../edit";
import { buildEditReport, enrichEditReport } from "../editReport";
import { cloneNode } from "../node";

function build(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const indiFile = (...eventLines: string[]) =>
  ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 RESI", ...eventLines, "0 TRLR"].join("\n");

const famFile = (...eventLines: string[]) =>
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1",
    "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 FAMS @F1@",
    "0 @I2@ INDI", "1 NAME Marija /Kovač/", "1 FAMS @F1@",
    "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@", "1 MARR", ...eventLines,
    "0 TRLR",
  ].join("\n");

/** The lines of the first event under the record, as written. */
function eventLines(out: string, from: string): string[] {
  const lines = out.split("\n");
  const at = lines.indexOf(from);
  const end = lines.findIndex((l, i) => i > at && /^[01] /.test(l));
  return lines.slice(at, end);
}

describe("AGE edits", () => {
  it("writes, rewrites and removes an event's AGE", () => {
    const ds = build(indiFile("2 DATE 1880"));
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "RESI", { age: "25y" });
    expect(eventLines(serializeGedcom(ds.records), "1 RESI")).toEqual(["1 RESI", "2 DATE 1880", "2 AGE 25y"]);
    setEventField(indi, "RESI", { age: "" });
    expect(eventLines(serializeGedcom(ds.records), "1 RESI")).toEqual(["1 RESI", "2 DATE 1880"]);
  });

  it("drops an old PHRASE with the value it described, and writes a new one", () => {
    const ds = build(indiFile("2 AGE < 8y", "3 PHRASE Child"));
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "RESI", { age: "< 1y", agePhrase: "Infant" });
    expect(eventLines(serializeGedcom(ds.records), "1 RESI")).toEqual(["1 RESI", "2 AGE < 1y", "3 PHRASE Infant"]);
    setEventField(indi, "RESI", { age: "5y" });
    expect(eventLines(serializeGedcom(ds.records), "1 RESI")).toEqual(["1 RESI", "2 AGE 5y"]);
  });

  it("writes a family event's spouse ages under HUSB/WIFE, leaving the family's own HUSB alone", () => {
    const ds = build(famFile("2 DATE 1855"));
    const fam = ds.families.get("@F1@")!;
    setFamilyEventField(fam, "MARR", { husbandAge: "27y", wifeAge: "19y" });
    const out = serializeGedcom(ds.records);
    expect(eventLines(out, "1 MARR")).toEqual(["1 MARR", "2 HUSB", "3 AGE 27y", "2 WIFE", "3 AGE 19y", "2 DATE 1855"]);
    expect(out).toContain("1 HUSB @I1@");
    setFamilyEventField(fam, "MARR", { husbandAge: "" });
    expect(eventLines(serializeGedcom(ds.records), "1 MARR")).toEqual(["1 MARR", "2 WIFE", "3 AGE 19y", "2 DATE 1855"]);
  });
});

describe("structured address edits", () => {
  it("adds labelled lines to a line-only ADDR without touching the line", () => {
    const ds = build(indiFile("2 ADDR Dunajska 5"));
    setEventField(ds.individuals.get("@I1@")!, "RESI", { addressParts: { CITY: "Ljubljana", POST: "1000" } });
    expect(eventLines(serializeGedcom(ds.records), "1 RESI")).toEqual(["1 RESI", "2 ADDR Dunajska 5", "3 CITY Ljubljana", "3 POST 1000"]);
  });

  it("keeps writing only the line when only the line is edited", () => {
    const ds = build(indiFile("2 ADDR Dunajska 5"));
    setEventField(ds.individuals.get("@I1@")!, "RESI", { address: "Dunajska 7" });
    expect(eventLines(serializeGedcom(ds.records), "1 RESI")).toEqual(["1 RESI", "2 ADDR Dunajska 7"]);
  });

  it("clearing the line of a structured ADDR keeps its labelled lines", () => {
    const ds = build(indiFile("2 ADDR Dunajska 5", "3 CITY Ljubljana"));
    setEventField(ds.individuals.get("@I1@")!, "RESI", { address: "" });
    expect(eventLines(serializeGedcom(ds.records), "1 RESI")).toEqual(["1 RESI", "2 ADDR", "3 CITY Ljubljana"]);
  });

  it("creates an ADDR with no line for parts alone, and removes it once empty", () => {
    const ds = build(indiFile("2 DATE 1900"));
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "RESI", { addressParts: { ADR1: "Glavni trg 3", CTRY: "Slovenija" } });
    expect(eventLines(serializeGedcom(ds.records), "1 RESI")).toEqual(["1 RESI", "2 DATE 1900", "2 ADDR", "3 ADR1 Glavni trg 3", "3 CTRY Slovenija"]);
    setEventField(indi, "RESI", { addressParts: { ADR1: "", CTRY: "" } });
    expect(eventLines(serializeGedcom(ds.records), "1 RESI")).toEqual(["1 RESI", "2 DATE 1900"]);
  });

  it("edits the first contact line and keeps the others", () => {
    const ds = build(indiFile("2 ADDR Dunajska 5", "2 PHON 111", "2 PHON 222", "2 EMAI a@b.si"));
    setEventField(ds.individuals.get("@I1@")!, "RESI", { phone: "333", email: "", fax: "444" });
    expect(eventLines(serializeGedcom(ds.records), "1 RESI")).toEqual(["1 RESI", "2 ADDR Dunajska 5", "2 PHON 333", "2 PHON 222", "2 FAX 444"]);
  });

  it("shows an age and an address part in the save preview", () => {
    const ds = build(indiFile("2 DATE 1880", "2 ADDR Dunajska 5"));
    const indi = ds.individuals.get("@I1@")!;
    const before = cloneNode(indi.raw);
    setEventField(indi, "RESI", { age: "25y", addressParts: { CITY: "Ljubljana" } });
    const base = buildEditReport(new Set(["@I1@"]), new Set(), ds, new Set(["@I1@"]), new Set());
    const report = enrichEditReport(base, ds, new Map([["@I1@", before]]), new Map(), (k) => k);
    expect(report.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: "1880 · Dunajska 5", to: "1880 · Dunajska 5, Ljubljana · 25y" }),
      ]),
    );
  });

  it("a new event can be made of an address part alone", () => {
    const ds = build(indiFile());
    const indi = ds.individuals.get("@I1@")!;
    expect(setEventField(indi, "CENS", { addressParts: { CITY: "Kranj" } })).toBeDefined();
  });
});

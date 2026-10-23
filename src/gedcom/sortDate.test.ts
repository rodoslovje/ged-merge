import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { serializeDataset, serializeGedcom } from "./serialize";
import { setEventFieldAtIndex } from "./edit";
import { orderingDate } from "./sortDate";
import { eventOrderSignature, sortEventsByDate } from "../merge/applyFields";
import { migrateVersion } from "../normalize/migrate";
import { byFactDate, type FactLine } from "../report/model";
import { parseDate } from "./date";

function load(version: string, body: string) {
  const text = `0 HEAD\n1 GEDC\n2 VERS ${version}\n${body}0 TRLR\n`;
  return { text, ds: buildDataset(parseGedcom(new TextEncoder().encode(text).buffer)) };
}

describe("SDATE (sort date)", () => {
  it("reads SDATE and the 5.5.1 _SDATE onto the event, apart from its date", () => {
    const { ds } = load("7.0", "0 @I1@ INDI\n1 BAPM\n2 DATE\n3 PHRASE Easter Sunday\n2 SDATE 1850\n");
    const ev = ds.individuals.get("@I1@")!.events[0];
    expect(ev.sortDate?.year).toBe(1850);
    expect(ev.date?.year).toBeUndefined();
    expect(orderingDate(ev)?.year).toBe(1850);
    const { ds: ds5 } = load("5.5.1", "0 @I1@ INDI\n1 RESI\n2 _SDATE 1880\n");
    expect(ds5.individuals.get("@I1@")!.events[0].sortDate?.year).toBe(1880);
  });

  it("saves an untouched file byte for byte", () => {
    const { text, ds } = load("7.0", "0 @I1@ INDI\n1 RESI\n2 DATE\n3 PHRASE in his youth\n2 SDATE 1870\n");
    expect(serializeDataset(ds).replace(/\r\n/g, "\n")).toBe(text);
  });

  it("orders the save's event sort, and moves the reorder gate's signature", () => {
    const body = "0 @I1@ INDI\n1 BIRT\n2 DATE 1850\n1 RESI\n2 DATE 1900\n1 RESI\n2 SDATE 1870\n1 DEAT\n2 DATE 1920\n";
    const { ds } = load("7.0", body);
    const rec = ds.individuals.get("@I1@")!.raw;
    const before = eventOrderSignature(rec);
    sortEventsByDate(rec);
    const order = rec.children.map((c) => `${c.tag}${c.children.find((d) => d.tag === "DATE" || d.tag === "SDATE")?.value ?? ""}`);
    expect(order).toEqual(["BIRT1850", "RESI1870", "RESI1900", "DEAT1920"]);
    // A new sort date is a structural edit: it decides where the event goes.
    const { ds: ds2 } = load("7.0", body);
    const indi = ds2.individuals.get("@I1@")!;
    setEventFieldAtIndex(indi, 2, { sortDate: "1910", sortDateTag: "SDATE" });
    expect(eventOrderSignature(indi.raw)).not.toBe(before);
  });

  it("writes a new sort date in the file's own spelling, and removes it", () => {
    const { ds } = load("5.5.1", "0 @I1@ INDI\n1 RESI\n2 DATE 1900\n2 PLAC Kranj\n");
    const indi = ds.individuals.get("@I1@")!;
    setEventFieldAtIndex(indi, 0, { sortDate: "1890", sortDateTag: "_SDATE" });
    expect(serializeGedcom([indi.raw])).toContain("1 RESI\n2 DATE 1900\n2 _SDATE 1890\n2 PLAC Kranj");
    setEventFieldAtIndex(indi, 0, { sortDate: "" });
    expect(serializeGedcom([indi.raw])).not.toContain("SDATE");
  });

  it("round-trips through the 5.5.1 ⇄ 7.0 migration", () => {
    const { ds } = load("7.0", "0 @I1@ INDI\n1 RESI\n2 SDATE 1870\n");
    migrateVersion(ds.records, "7.0", "5.5.1", () => {});
    expect(serializeGedcom(ds.records)).toContain("2 _SDATE 1870");
    migrateVersion(ds.records, "5.5.1", "7.0", () => {});
    expect(serializeGedcom(ds.records)).toContain("2 SDATE 1870");
  });

  it("orders report lines", () => {
    const line = (tag: string, date?: string, sort?: string): FactLine => ({
      tag, glyph: "", parsed: date ? parseDate(date) : undefined, sortDate: sort ? parseDate(sort) : undefined,
    });
    const out = byFactDate([line("RESI", "1900"), line("OCCU", undefined, "1880")]);
    expect(out.map((l) => l.tag)).toEqual(["OCCU", "RESI"]);
  });
});

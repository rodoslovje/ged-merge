import { describe, expect, it } from "vitest";
import { buildDataset } from "../builder";
import { parseGedcom } from "../parser";
import { serializeGedcom } from "../serialize";
import { parseCoordInput } from "../place";
import { setEventField, setEventFieldAtIndex } from "../edit";

function build(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const file = (...eventLines: string[]) =>
  ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8", "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 RESI", ...eventLines, "0 TRLR"].join("\n");

const HOUSE = { lat: 46.241374, lon: 14.355805 };

describe("event coordinate update", () => {
  it("writes the standard PLAC MAP for one event only", () => {
    const ds = build(file("2 PLAC Kranj, Slovenija", "2 ADDR Kidričeva cesta 38"));
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "RESI", { coord: HOUSE });

    const out = serializeGedcom(ds.records);
    expect(out).toContain("3 MAP");
    expect(out).toContain("4 LATI N46.24137");
    expect(out).toContain("4 LONG E14.35581");
    // The address text is untouched; only the place gained a MAP.
    expect(out).toContain("2 ADDR Kidričeva cesta 38");
    expect(build(out).individuals.get("@I1@")!.events[0].place?.coord?.lat).toBeCloseTo(HOUSE.lat, 5);
  });

  it("removes the coordinate on null, keeping the place", () => {
    const ds = build(file("2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.24137", "4 LONG E14.35581"));
    const indi = ds.individuals.get("@I1@")!;
    expect(indi.events[0].place?.coord).toBeDefined();
    setEventField(indi, "RESI", { coord: null });

    const out = serializeGedcom(ds.records);
    expect(out).not.toContain("MAP");
    expect(out).not.toContain("LATI");
    expect(out).toContain("2 PLAC Kranj, Slovenija");
  });

  it("ignores a coordinate when the event has no place to hang it on", () => {
    const ds = build(file("2 DATE 1890"));
    const indi = ds.individuals.get("@I1@")!;
    setEventField(indi, "RESI", { coord: HOUSE });
    // No PLAC is invented — a bare MAP would be invalid GEDCOM.
    const out = serializeGedcom(ds.records);
    expect(out).not.toContain("MAP");
    expect(out).not.toContain("PLAC");
  });

  it("leaves the coordinate alone when the update omits it", () => {
    const ds = build(file("2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.24137", "4 LONG E14.35581"));
    const indi = ds.individuals.get("@I1@")!;
    // Editing the date must not drop the coordinate.
    setEventField(indi, "RESI", { date: "1890" });
    expect(serializeGedcom(ds.records)).toContain("4 LATI N46.24137");
  });
});

describe("parseCoordInput", () => {
  it("accepts the forms a user would paste", () => {
    expect(parseCoordInput("46.24137, 14.35580")).toEqual({ lat: 46.24137, lon: 14.3558 });
    expect(parseCoordInput("46.24137 14.35580")).toEqual({ lat: 46.24137, lon: 14.3558 });
    // The GEDCOM hemisphere form, as copied out of a file.
    expect(parseCoordInput("N46.24137 E14.3558")).toEqual({ lat: 46.24137, lon: 14.3558 });
    expect(parseCoordInput("S12.5, W70.25")).toEqual({ lat: -12.5, lon: -70.25 });
  });

  it("rejects anything that is not exactly two valid values", () => {
    expect(parseCoordInput("46.24137")).toBeUndefined();
    expect(parseCoordInput("46.24137, 14.3558, 9")).toBeUndefined();
    expect(parseCoordInput("")).toBeUndefined();
    expect(parseCoordInput("here, there")).toBeUndefined();
    // Out of range is rejected by parseCoordPair.
    expect(parseCoordInput("95, 14")).toBeUndefined();
  });
});

describe("repeated events", () => {
  // Three RESI events at one place, as a residence history looks. Editing one
  // must not touch the others — setEventField would hit the first every time.
  const THREE = [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Janez /Novak/",
    "1 RESI", "2 DATE OCT 1997", "2 PLAC Ljubljana,Ljubljana,Slovenia",
    "3 MAP", "4 LATI N46.0543", "4 LONG E14.505", "2 ADDR Cesta v Pecale 50",
    "1 RESI", "2 DATE JUN 2004", "2 PLAC Ljubljana,Ljubljana,Slovenia",
    "1 RESI", "2 DATE JUN 2014", "2 PLAC Ljubljana,Ljubljana,Slovenia",
    "0 TRLR",
  ].join("\n");

  it("replaces the coordinate of the edited event only", () => {
    const ds = build(THREE);
    const indi = ds.individuals.get("@I1@")!;
    // The house found in the register, replacing the settlement coordinate.
    setEventFieldAtIndex(indi, 0, {
      date: "OCT 1997", place: "Ljubljana,Ljubljana,Slovenia", address: "Cesta v Pecale 50",
      coord: { lat: 46.1098, lon: 14.5321 },
    });

    const out = serializeGedcom(ds.records);
    expect(out).toContain("4 LATI N46.1098");
    // The old settlement coordinate is replaced, not kept alongside.
    expect(out).not.toContain("N46.0543");
    expect(out.split("\n").filter((l) => l === "3 MAP")).toHaveLength(1);

    const events = build(out).individuals.get("@I1@")!.events.filter((e) => e.tag === "RESI");
    expect(events[0].place?.coord?.lat).toBeCloseTo(46.1098, 4);
    expect(events[1].place?.coord).toBeUndefined();
    expect(events[2].place?.coord).toBeUndefined();
  });

  it("writes onto a later event without disturbing the first", () => {
    const ds = build(THREE);
    const indi = ds.individuals.get("@I1@")!;
    setEventFieldAtIndex(indi, 2, { place: "Ljubljana,Ljubljana,Slovenia", coord: { lat: 46.2, lon: 14.6 } });

    const events = build(serializeGedcom(ds.records)).individuals.get("@I1@")!.events.filter((e) => e.tag === "RESI");
    expect(events[0].place?.coord?.lat).toBeCloseTo(46.0543, 4);
    expect(events[1].place?.coord).toBeUndefined();
    expect(events[2].place?.coord?.lat).toBeCloseTo(46.2, 4);
  });
});

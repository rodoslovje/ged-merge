import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { framePins, mapFlags, residencePins, type MapPin } from "./mapPins";

const resi = (year: number, place: string, lat?: string, lon?: string) => [
  "1 RESI", `2 DATE ${year}`, `2 PLAC ${place}`,
  ...(lat && lon ? ["3 MAP", `4 LATI ${lat}`, `4 LONG ${lon}`] : []),
];

const ds = buildDataset(parseGedcom(new TextEncoder().encode([
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  // Moved from Kranj to Ljubljana: the later residence counts.
  "0 @I1@ INDI", "1 NAME Ana /Novak/", ...resi(2010, "Kranj, Slovenija", "N46.2389", "E14.3556"), ...resi(2020, "Ljubljana, Slovenija", "N46.0511", "E14.5051"),
  "0 @I2@ INDI", "1 NAME Marko /Horvat/", ...resi(2020, "Ljubljana, Slovenija", "N46.0511", "E14.5051"),
  "0 @I3@ INDI", "1 NAME Luka /Novak/", ...resi(2015, "Maribor, Slovenija", "N46.5547", "E15.6459"),
  // The last residence has no coordinates: the one before it that has stands.
  "0 @I4@ INDI", "1 NAME Tim /Novak/", ...resi(2012, "Koper, Slovenija", "N45.5481", "E13.7302"), ...resi(2022, "Nekje"),
  // No residence with coordinates at all.
  "0 @I5@ INDI", "1 NAME Eva /Horvat/", "1 BIRT", "2 PLAC Celje, Slovenija", "3 MAP", "4 LATI N46.2309", "4 LONG E15.2604",
  "0 TRLR", "",
].join("\n")).buffer));

describe("residencePins", () => {
  const pins = residencePins(ds, ["@I1@", "@I2@", "@I3@", "@I4@", "@I5@", "@I1@"]);

  it("gathers the people of one place under one pin, the fullest first", () => {
    expect(pins[0]).toMatchObject({ place: "Ljubljana", ids: ["@I1@", "@I2@"] });
    expect(pins.map((p) => p.place).sort()).toEqual(["Koper", "Ljubljana", "Maribor"]);
  });

  it("goes by a residence alone, and by the last that carries coordinates", () => {
    expect(pins.some((p) => p.ids.includes("@I5@"))).toBe(false);
    expect(pins.find((p) => p.ids.includes("@I4@"))?.place).toBe("Koper");
  });
});

describe("mapFlags", () => {
  const pins = residencePins(ds, ["@I1@", "@I2@", "@I3@", "@I4@"]);

  it("gives places apart a flag each", () => {
    const flags = mapFlags(pins, [{ x: 0.5, y: 0.5 }, { x: 0.9, y: 0.2 }, { x: 0.1, y: 0.8 }], 1.5);
    expect(flags.map((f) => f.place)).toEqual(pins.map((p) => p.place));
  });

  it("lets places that would stand on each other share the larger one's flag", () => {
    const flags = mapFlags(pins, [{ x: 0.5, y: 0.5 }, { x: 0.52, y: 0.51 }, { x: 0.1, y: 0.8 }], 1.5);
    expect(flags).toHaveLength(2);
    expect(flags[0]).toMatchObject({ place: "Ljubljana", ids: ["@I1@", "@I2@", pins[1].ids[0]] });
  });
});

describe("framePins", () => {
  const pin = (place: string, lat: number, lon: number, people: number): MapPin =>
    ({ place, coord: { lat, lon }, ids: Array.from({ length: people }, (_, i) => `${place}${i}`) });
  const home = [pin("Kranj", 46.24, 14.36, 40), pin("Ljubljana", 46.05, 14.51, 30), pin("Maribor", 46.55, 15.65, 10)];

  it("leaves a lone place overseas off the map", () => {
    const { on, away } = framePins([...home, pin("Windsor", 42.3, -83.0, 1)]);
    expect(on.map((p) => p.place)).toEqual(["Kranj", "Ljubljana", "Maribor"]);
    expect(away.map((p) => p.place)).toEqual(["Windsor"]);
  });

  it("keeps a place that lies about as near as the rest", () => {
    const { on, away } = framePins([...home, pin("Koper", 45.55, 13.73, 1)]);
    expect(on).toHaveLength(4);
    expect(away).toEqual([]);
  });

  it("holds a family split between two countries whole", () => {
    const { away } = framePins([pin("Kranj", 46.24, 14.36, 6), pin("Windsor", 42.3, -83.0, 5)]);
    expect(away).toEqual([]);
  });
});

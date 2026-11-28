import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { CALLOUT, framePins, layoutCallouts, mapFlags, residencePins, type MapPin } from "./mapPins";

const resi = (year: number | undefined, place: string, lat?: string, lon?: string) => [
  "1 RESI", ...(year ? [`2 DATE ${year}`] : []), `2 PLAC ${place}`,
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
  // Born into a dated home, living at an undated one: the undated is the present.
  "0 @I6@ INDI", "1 NAME Danaja /Novak/", ...resi(1996, "Radovljica, Slovenija", "N46.3444", "E14.1744"), ...resi(undefined, "Mlaka pri Kranju, Slovenija", "N46.2700", "E14.3400"),
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

  it("takes the residence without a date for the present one", () => {
    expect(residencePins(ds, ["@I6@"]).map((p) => p.place)).toEqual(["Mlaka pri Kranju"]);
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

describe("layoutCallouts", () => {
  const flag = (place: string, x: number, y: number, people = 1) =>
    ({ place, x, y, ids: Array.from({ length: people }, (_, i) => `${place}${i}`) });
  const byPlace = (list: ReturnType<typeof layoutCallouts>) => Object.fromEntries(list.map((c) => [c.place, c]));

  it("puts a box on the side its place is nearer, beside it", () => {
    const c = byPlace(layoutCallouts([flag("West", 0.3, 0.5), flag("East", 0.7, 0.2)], 40, 30));
    expect(c.West.side).toBe("left");
    expect(c.East.side).toBe("right");
    expect(c.East.top).toBeLessThan(c.West.top);
  });

  it("pushes boxes of one side apart, and keeps them on the map", () => {
    const list = layoutCallouts([flag("A", 0.3, 0.5, 3), flag("B", 0.35, 0.5, 3), flag("C", 0.3, 0.99, 3)], 40, 30, 1);
    const left = list.sort((a, b) => a.top - b.top);
    for (let i = 1; i < left.length; i++) expect((left[i].top - left[i - 1].top) * 30).toBeGreaterThanOrEqual(4 * CALLOUT.line + CALLOUT.pad);
    expect(left[2].top * 30 + 4 * CALLOUT.line + CALLOUT.pad).toBeLessThanOrEqual(29);
  });

  it("writes out fewer names when a side has more boxes than room", () => {
    const many = Array.from({ length: 12 }, (_, i) => flag(`P${i}`, 0.3, i / 12, 6));
    expect(layoutCallouts(many, 40, 80)[0].names).toBe(CALLOUT.names);
    expect(layoutCallouts(many, 40, 20)[0].names).toBeLessThan(2);
  });

  it("lets two neighbours change places rather than cross their lines", () => {
    // A coast and its hinterland: places at one height but far apart across
    // the map, with boxes pushed well below them by the ones above.
    const W = 40, H = 30;
    const flags = [flag("Top", 0.3, 0.3, 4), flag("Mid", 0.32, 0.34, 4), flag("Inland", 0.46, 0.4), flag("Coast", 0.25, 0.42), flag("South", 0.4, 0.44)];
    const list = layoutCallouts(flags, W, H);
    const inner = 0.5 + CALLOUT.width;
    const turn = (p: number[], q: number[], r: number[]) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
    const line = (c: (typeof list)[number]) => [[c.x * W, c.y * H], [inner, c.tie * H]];
    for (const a of list) {
      for (const b of list) {
        if (a === b) continue;
        const [p, q] = line(a);
        const [r, s] = line(b);
        expect(turn(p, q, r) !== turn(p, q, s) && turn(r, s, p) !== turn(r, s, q), `${a.place} × ${b.place}`).toBe(false);
      }
    }
  });
});

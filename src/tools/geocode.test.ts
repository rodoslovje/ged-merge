import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { serializeDataset } from "../gedcom/serialize";
import { buildGazetteerIndex, parseGeoNamesLine, type GazEntry } from "../geo/gazetteer";
import { applyGeocode, scanGeocode } from "./geocode";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  return buildDataset(parseGedcom(buf.buffer));
}

const SAMPLE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Janez /Novak/
1 BIRT
2 DATE 4 MAR 1880
2 PLAC Kranj, Slovenija
1 DEAT
2 PLAC Ljubljana, Slovenija
3 MAP
4 LATI N46.05108
4 LONG E14.50513
0 @I2@ INDI
1 NAME Marija /Kovač/
1 BIRT
2 PLAC Kranj, Slovenija
1 RESI
2 PLAC Neznani Kraj XY
1 DEAT
2 PLAC Stražišče,Kranj,Slovenia
0 @I3@ INDI
1 NAME France /Novak/
1 BIRT
2 PLAC Stražišče,Kranj,Slovenia
3 MAP
4 LATI N46.2331
4 LONG E14.3308
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 MARR
2 PLAC Kranj, Slovenija
0 TRLR
`;

const GAZ_ROWS = [
  "3197378\tKranj\tKranj\tKrainburg\t46.23887\t14.35561\tP\tPPLA\tSI\t\t52\t\t\t\t37941\t\t388\tEurope/Ljubljana\t2019-09-05",
  "3239110\tLjubljana\tLjubljana\tLaibach\t46.05108\t14.50513\tP\tPPLC\tSI\t\t61\t\t\t\t272220\t\t299\tEurope/Ljubljana\t2019-09-05",
];

const index = buildGazetteerIndex(GAZ_ROWS.map(parseGeoNamesLine).filter((e): e is GazEntry => !!e));

describe("scanGeocode", () => {
  it("groups by raw value, counts missing, proposes candidates", () => {
    const ds = buildFromText(SAMPLE);
    const scan = scanGeocode(ds, index, new Map());
    // "Ljubljana, Slovenija" is fully covered; three rows remain.
    expect(scan.coveredDistinct).toBe(1);
    expect(scan.totalOccurrences).toBe(7);
    expect(scan.coveredOccurrences).toBe(2);
    expect(scan.rows).toHaveLength(3);
    // One occurrence of Stražišče already carries a coordinate — proposed
    // for the other occurrence as the file's own, confidently.
    const straz = scan.rows.find((r) => r.key === "Stražišče,Kranj,Slovenia")!;
    expect(straz.missing).toBe(1);
    expect(straz.fileCoord).toEqual({ lat: 46.2331, lon: 14.3308 });
    expect(straz.confident).toBe(true);
    const kranj = scan.rows.find((r) => r.key === "Kranj, Slovenija")!;
    expect(kranj.count).toBe(3);
    expect(kranj.missing).toBe(3);
    expect(kranj.candidates[0].entry.name).toBe("Kranj");
    expect(kranj.confident).toBe(true);
    const unknown = scan.rows.find((r) => r.key === "Neznani Kraj XY")!;
    expect(unknown.candidates).toHaveLength(0);
    expect(unknown.confident).toBe(false);
  });

  it("attaches cached decisions and works without a gazetteer", () => {
    const ds = buildFromText(SAMPLE);
    const cached = new Map([
      ["Kranj, Slovenija", { key: "Kranj, Slovenija", status: "accepted" as const, lat: 46.2, lon: 14.3, ts: 1 }],
      ["Neznani Kraj XY", { key: "Neznani Kraj XY", status: "nomatch" as const, ts: 1 }],
    ]);
    const scan = scanGeocode(ds, undefined, cached);
    expect(scan.rows.find((r) => r.key === "Kranj, Slovenija")!.cached?.status).toBe("accepted");
    expect(scan.rows.find((r) => r.key === "Neznani Kraj XY")!.cached?.status).toBe("nomatch");
  });
});

describe("applyGeocode", () => {
  it("writes MAP into every missing PLAC, skips covered ones, patches + rebuilds", () => {
    const ds = buildFromText(SAMPLE);
    const assignments = new Map([["Kranj, Slovenija", { lat: 46.23887, lon: 14.35561 }]]);
    const patches = applyGeocode(ds, assignments);
    // I1 (BIRT), I2 (BIRT) and F1 (MARR) change; I1's DEAT already had MAP.
    expect(patches.map((p) => p.id).sort()).toEqual(["@F1@", "@I1@", "@I2@"]);
    // The typed model reflects the new coordinates without a reload.
    const birt = ds.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birt.place?.coord).toEqual({ lat: 46.23887, lon: 14.35561 });
    // The DEAT coordinate is untouched (no double MAP).
    const deatPlac = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "DEAT")!
      .children.find((c) => c.tag === "PLAC")!;
    expect(deatPlac.children.filter((c) => c.tag === "MAP")).toHaveLength(1);
    // Serialization emits the standard nested structure.
    const text = serializeDataset(ds);
    expect(text).toContain("2 PLAC Kranj, Slovenija");
    expect(text).toContain("3 MAP");
    expect(text).toContain("4 LATI N46.23887");
    expect(text).toContain("4 LONG E14.35561");
    // A re-scan reports the value as covered.
    const rescan = scanGeocode(ds, index, new Map());
    expect(rescan.rows.find((r) => r.key === "Kranj, Slovenija")).toBeUndefined();
  });

  it("is a no-op for values that don't occur or are already covered", () => {
    const ds = buildFromText(SAMPLE);
    const patches = applyGeocode(ds, new Map([["Ljubljana, Slovenija", { lat: 1, lon: 1 }], ["Nowhere", { lat: 2, lon: 2 }]]));
    expect(patches).toHaveLength(0);
  });
});

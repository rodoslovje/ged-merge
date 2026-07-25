import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { serializeDataset } from "../gedcom/serialize";
import { countSplitCoordFills, fillPlaceCoordsFromFile, scanPlaceCoords } from "./placeCoords";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  return buildDataset(parseGedcom(buf.buffer));
}

// "Stražišče,Kranj,Slovenia" is coordinated on I3 (BIRT) but not on I2 (DEAT) —
// the split-coordinate case. "Kranj, Slovenija" has no coordinate anywhere
// (nothing to copy), "Ljubljana, Slovenija" is fully coordinated, "Neznani
// Kraj XY" is a lone missing value — none of these should be reported.
const SAMPLE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Janez /Novak/
1 BIRT
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

describe("scanPlaceCoords", () => {
  it("reports only values coordinated on some occurrences but not others", () => {
    const ds = buildFromText(SAMPLE);
    const found = scanPlaceCoords(ds).fills;
    expect(found).toEqual([
      { value: "Stražišče,Kranj,Slovenia", address: "", coord: { lat: 46.2331, lon: 14.3308 }, covered: 1, missing: 1 },
    ]);
    expect(countSplitCoordFills(found)).toBe(1);
  });

  it("reports a value carrying two genuinely different coordinates, and offers no fill", () => {
    // Three occurrences: two at one coordinate, one 40 km away, one missing.
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Bled
3 MAP
4 LATI N46.3683
4 LONG E14.1136
1 DEAT
2 PLAC Bled
3 MAP
4 LATI N46.3683
4 LONG E14.1136
1 RESI
2 PLAC Bled
3 MAP
4 LATI N46.0000
4 LONG E14.0000
0 @I2@ INDI
1 BIRT
2 PLAC Bled
0 TRLR
`;
    const { fills, conflicts } = scanPlaceCoords(buildFromText(text));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].value).toBe("Bled");
    // Most-used spot first, so the likely-correct one leads.
    expect(conflicts[0].coords.map((c) => c.coord)).toEqual([
      { lat: 46.3683, lon: 14.1136 },
      { lat: 46, lon: 14 },
    ]);
    // Which one to copy is unresolved, so nothing is offered for bulk filling.
    expect(fills).toEqual([]);
  });

  it("treats rounding variants as one spot and still fills from them", () => {
    // N46.3683 vs N46.36832 is ~2 m apart — a re-geocode, not a contradiction.
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Bled
3 MAP
4 LATI N46.3683
4 LONG E14.1136
1 DEAT
2 PLAC Bled
3 MAP
4 LATI N46.36832
4 LONG E14.11361
1 RESI
2 PLAC Bled
0 TRLR
`;
    const { fills, conflicts } = scanPlaceCoords(buildFromText(text));
    expect(conflicts).toEqual([]);
    expect(fills).toHaveLength(1);
    expect(fills[0].missing).toBe(1);
  });

  it("lets one settlement hold different coordinates for different addresses", () => {
    // The whole point of grouping by place + address: two houses in Kranj are
    // different locations, so this is not an inconsistency to report or "fix".
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 RESI
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.24137
4 LONG E14.35580
2 ADDR Kidričeva cesta 38
1 CENS
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.23887
4 LONG E14.35561
2 ADDR Koroška cesta 1
0 TRLR
`;
    expect(scanPlaceCoords(buildFromText(text))).toEqual({ fills: [], conflicts: [] });
  });

  it("reports two coordinates for the *same* address", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 RESI
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.24137
4 LONG E14.35580
2 ADDR Kidričeva cesta 38
1 CENS
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.05108
4 LONG E14.50513
2 ADDR Kidričeva cesta 38
0 TRLR
`;
    const { conflicts } = scanPlaceCoords(buildFromText(text));
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ value: "Kranj, Slovenija", address: "Kidričeva cesta 38" });
  });

  it("is empty when nothing is split", () => {
    const text = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj
0 TRLR
`;
    expect(scanPlaceCoords(buildFromText(text))).toEqual({ fills: [], conflicts: [] });
  });
});

describe("fillPlaceCoordsFromFile", () => {
  it("writes the file coordinate into the missing occurrence only, undoably", () => {
    const ds = buildFromText(SAMPLE);
    const patches = fillPlaceCoordsFromFile(ds);
    // Only I2 (the coordinate-less Stražišče) changes.
    expect(patches.map((p) => p.id)).toEqual(["@I2@"]);
    const deat = ds.individuals.get("@I2@")!.events.find((e) => e.tag === "DEAT")!;
    expect(deat.place?.coord).toEqual({ lat: 46.2331, lon: 14.3308 });
    // The uncoordinated "Kranj, Slovenija" values are untouched — nothing to copy.
    const text = serializeDataset(ds);
    expect(text).not.toContain("3 MAP\n4 LATI N46.23887");
    // A rescan finds nothing left to fill.
    expect(scanPlaceCoords(ds).fills).toEqual([]);
  });
});

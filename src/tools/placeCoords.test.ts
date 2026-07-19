import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { serializeDataset } from "../gedcom/serialize";
import { countSplitCoordFills, fillPlaceCoordsFromFile, scanSplitCoordPlaces } from "./placeCoords";

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

describe("scanSplitCoordPlaces", () => {
  it("reports only values coordinated on some occurrences but not others", () => {
    const ds = buildFromText(SAMPLE);
    const found = scanSplitCoordPlaces(ds);
    expect(found).toEqual([
      { value: "Stražišče,Kranj,Slovenia", coord: { lat: 46.2331, lon: 14.3308 }, covered: 1, missing: 1 },
    ]);
    expect(countSplitCoordFills(found)).toBe(1);
  });

  it("prefers the most frequent coordinate when a value carries several", () => {
    // Three occurrences: two at one coordinate, one at another, one missing.
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
    const found = scanSplitCoordPlaces(buildFromText(text));
    expect(found).toEqual([{ value: "Bled", coord: { lat: 46.3683, lon: 14.1136 }, covered: 3, missing: 1 }]);
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
    expect(scanSplitCoordPlaces(buildFromText(text))).toEqual([]);
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
    expect(scanSplitCoordPlaces(ds)).toEqual([]);
  });
});

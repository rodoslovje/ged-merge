import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { parseCoordPair } from "../gedcom/place";
import { branchIds, eventKindOf, filterPoints, projectPoints, yearRange, type MapEventKind } from "./points";
import { clusterPoints, latToWorldY, lonToWorldX } from "./cluster";

function buildFromText(text: string) {
  const buf = new TextEncoder().encode(text);
  return buildDataset(parseGedcom(buf.buffer));
}

const SAMPLE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 4 MAR 1880
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.2389
4 LONG E14.3556
1 DEAT
2 DATE 1950
2 PLAC Ljubljana, Slovenija
3 MAP
4 LATI N46.05
4 LONG E14.51
1 FAMS @F1@
0 @I2@ INDI
1 NAME Marija /Kovač/
1 SEX F
1 BIRT
2 PLAC Škofja Loka
3 MAP
4 LATI N46.1656
4 LONG E14.3061
1 FAMS @F1@
0 @I3@ INDI
1 NAME France /Novak/
1 SEX M
1 FAMC @F1@
1 RESI
2 DATE 1930
2 PLAC Trst
3 MAP
4 LATI N45::38::35"
4 LONG E13::46::13"
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 MARR
2 DATE 12 FEB 1905
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.2389
4 LONG E14.3556
0 TRLR
`;

describe("parseCoordPair", () => {
  it("parses hemisphere-prefixed decimals", () => {
    expect(parseCoordPair("N46.05", "E14.51")).toEqual({ lat: 46.05, lon: 14.51 });
    expect(parseCoordPair("S12.5", "W70.25")).toEqual({ lat: -12.5, lon: -70.25 });
  });

  it("parses plain signed decimals", () => {
    expect(parseCoordPair("46.05", "-14.51")).toEqual({ lat: 46.05, lon: -14.51 });
  });

  it("parses the webtrees DMS form", () => {
    const c = parseCoordPair('N46::3::19"', 'E14::30::52"');
    expect(c?.lat).toBeCloseTo(46 + 3 / 60 + 19 / 3600, 6);
    expect(c?.lon).toBeCloseTo(14 + 30 / 60 + 52 / 3600, 6);
  });

  it("rejects out-of-range and garbage values", () => {
    expect(parseCoordPair("N95.0", "E14.0")).toBeUndefined();
    expect(parseCoordPair("N46.0", "E190.0")).toBeUndefined();
    expect(parseCoordPair("unknown", "E14.0")).toBeUndefined();
    expect(parseCoordPair("", "")).toBeUndefined();
  });
});

describe("coordinate lifting (builder)", () => {
  it("puts PLAC.MAP coordinates on the event's place", () => {
    const ds = buildFromText(SAMPLE);
    const birt = ds.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(birt.place?.coord).toEqual({ lat: 46.2389, lon: 14.3556 });
    const resi = ds.individuals.get("@I3@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.place?.coord?.lat).toBeCloseTo(45.643, 3);
  });
});

describe("projectPoints", () => {
  const ds = buildFromText(SAMPLE);
  const points = projectPoints(ds);

  it("projects individual and family events with coordinates", () => {
    // I1 BIRT+DEAT, I2 BIRT, I3 RESI, F1 MARR = 5 points.
    expect(points).toHaveLength(5);
    const marr = points.find((p) => p.tag === "MARR")!;
    expect(marr.personIds.sort()).toEqual(["@I1@", "@I2@"]);
    expect(marr.familyId).toBe("@F1@");
    expect(marr.year).toBe(1905);
    expect(marr.kind).toBe("marriage");
  });

  it("computes the dated year range", () => {
    expect(yearRange(points)).toEqual({ min: 1880, max: 1950 });
  });

  it("classifies tags into kinds", () => {
    expect(eventKindOf("BURI")).toBe("burial");
    expect(eventKindOf("_INTE")).toBe("burial");
    expect(eventKindOf("CENS")).toBe("residence");
    expect(eventKindOf("OCCU")).toBe("other");
  });

  it("filters by kind, year window, undated and person scope", () => {
    const all = new Set<MapEventKind>(["birth", "marriage", "death", "burial", "residence", "other"]);
    expect(filterPoints(points, { kinds: new Set(["birth"]), includeUndated: true })).toHaveLength(2);
    // Year window drops the undated I2 birth unless includeUndated.
    expect(filterPoints(points, { kinds: all, yearFrom: 1900, includeUndated: false })).toHaveLength(3);
    expect(filterPoints(points, { kinds: all, yearFrom: 1900, includeUndated: true })).toHaveLength(4);
    // Person scope: I3 only.
    expect(filterPoints(points, { kinds: all, includeUndated: true, personIds: new Set(["@I3@"]) })).toHaveLength(1);
    // Privacy exclusion drops shared family events too.
    const excl = filterPoints(points, { kinds: all, includeUndated: true, excludePersonIds: new Set(["@I2@"]) });
    expect(excl.every((p) => !p.personIds.includes("@I2@"))).toBe(true);
    expect(excl).toHaveLength(3);
  });
});

describe("branchIds", () => {
  const ds = buildFromText(SAMPLE);

  it("walks ancestors through FAMC", () => {
    expect([...branchIds(ds, "@I3@", "ancestors")].sort()).toEqual(["@I1@", "@I2@", "@I3@"]);
  });

  it("walks descendants through FAMS", () => {
    expect([...branchIds(ds, "@I1@", "descendants")].sort()).toEqual(["@I1@", "@I3@"]);
  });
});

describe("clusterPoints", () => {
  const ds = buildFromText(SAMPLE);
  const points = projectPoints(ds);

  it("merges nearby points at low zoom and splits them at high zoom", () => {
    const low = clusterPoints(points, 0);
    expect(low).toHaveLength(1);
    expect(low[0].points).toHaveLength(5);
    const high = clusterPoints(points, 14);
    // Kranj birth + marriage share a cell; Ljubljana, Škofja Loka, Trst apart.
    expect(high).toHaveLength(4);
  });

  it("projects mercator world pixels monotonically", () => {
    expect(lonToWorldX(-180, 0)).toBe(0);
    expect(lonToWorldX(180, 0)).toBe(256);
    expect(latToWorldY(85.06, 0)).toBeLessThan(latToWorldY(0, 0));
    expect(latToWorldY(0, 0)).toBeCloseTo(128, 5);
  });
});

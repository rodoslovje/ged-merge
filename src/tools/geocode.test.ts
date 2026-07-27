import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { serializeDataset } from "../gedcom/serialize";
import { buildGazetteerIndex, parseGeoNamesLine, type GazEntry } from "../geo/gazetteer";
import {
  applyGeocode,
  chosenCoordFor,
  collectPlaceValues,
  movePlaceForAddresses,
  placeAddrKey,
  renamePlaceValue,
  scanGeocode,
  type GeocodeRow,
} from "./geocode";

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

  it("lists the people whose events still miss the coordinate", () => {
    const ds = buildFromText(SAMPLE);
    const scan = scanGeocode(ds, index, new Map());
    // I1 BIRT + I2 BIRT + F1 MARR (attributed to both spouses).
    const kranj = scan.rows.find((r) => r.key === "Kranj, Slovenija")!;
    expect(kranj.missingIn.sort()).toEqual(["@I1@", "@I2@"]);
    // Only I2's DEAT misses it — I3's occurrence already has a MAP.
    const straz = scan.rows.find((r) => r.key === "Stražišče,Kranj,Slovenia")!;
    expect(straz.missingIn).toEqual(["@I2@"]);
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

describe("chosenCoordFor", () => {
  const labels = { fromFile: "from file", cached: "cached" };
  const base: GeocodeRow = { key: "X", count: 1, missing: 1, candidates: [], confident: false, missingIn: [] };
  const cand = index.entries.find((e) => e.name === "Kranj")!;

  it("prefers override > cached > file coordinate > best candidate", () => {
    const row: GeocodeRow = {
      ...base,
      fileCoord: { lat: 1, lon: 1 },
      candidates: [{ entry: cand, score: 1 }],
      cached: { key: "X", status: "accepted", lat: 2, lon: 2, label: "remembered", ts: 1 },
    };
    expect(chosenCoordFor(row, { coord: { lat: 3, lon: 3 }, label: "manual" }, labels)?.coord).toEqual({ lat: 3, lon: 3 });
    expect(chosenCoordFor(row, undefined, labels)).toEqual({ coord: { lat: 2, lon: 2 }, label: "remembered" });
    expect(chosenCoordFor({ ...row, cached: undefined }, undefined, labels)).toEqual({
      coord: { lat: 1, lon: 1 },
      label: "from file",
    });
    expect(chosenCoordFor({ ...row, cached: undefined, fileCoord: undefined }, undefined, labels)).toEqual({
      coord: { lat: cand.lat, lon: cand.lon },
      label: "Kranj",
    });
  });

  it("ignores a no-match cache entry and returns undefined with nothing to offer", () => {
    expect(
      chosenCoordFor({ ...base, cached: { key: "X", status: "nomatch", ts: 1 } }, undefined, labels),
    ).toBeUndefined();
  });
});

describe("renamePlaceValue", () => {
  it("renames every PLAC carrying exactly the raw value, leaving others alone", () => {
    const ds = buildFromText(SAMPLE);
    const patches = renamePlaceValue(ds, "Kranj, Slovenija", "Kranj, Gorenjska, Slovenija");
    // @I1@ (BIRT), @I2@ (BIRT), @F1@ (MARR) carry the exact value.
    expect(patches.map((p) => p.id).sort()).toEqual(["@F1@", "@I1@", "@I2@"]);
    const text = serializeDataset(ds);
    expect(text).not.toContain("2 PLAC Kranj, Slovenija\n");
    expect(text).toContain("2 PLAC Kranj, Gorenjska, Slovenija");
    // The comma-free variant spelled differently is untouched.
    expect(text).toContain("2 PLAC Stražišče,Kranj,Slovenia");
  });

  it("is a no-op for an empty or unchanged target", () => {
    const ds = buildFromText(SAMPLE);
    expect(renamePlaceValue(ds, "Kranj, Slovenija", "  ")).toEqual([]);
    expect(renamePlaceValue(ds, "Kranj, Slovenija", "Kranj, Slovenija")).toEqual([]);
  });

  it("splits into PLAC + ADDR when an address is given", () => {
    const ds = buildFromText(SAMPLE);
    const patches = renamePlaceValue(ds, "Neznani Kraj XY", "Kranj, Slovenija", "Glavni trg 1");
    expect(patches.map((p) => p.id)).toEqual(["@I2@"]);
    const text = serializeDataset(ds);
    expect(text).toContain("1 RESI\n2 PLAC Kranj, Slovenija\n2 ADDR Glavni trg 1");
  });

  it("with an unchanged place but a new address, still writes the ADDR", () => {
    const ds = buildFromText(SAMPLE);
    const patches = renamePlaceValue(ds, "Neznani Kraj XY", "Neznani Kraj XY", "Glavni trg 1");
    expect(patches).toHaveLength(1);
    expect(serializeDataset(ds)).toContain("2 PLAC Neznani Kraj XY\n2 ADDR Glavni trg 1");
  });

  it("keeps an existing MAP subtree when renaming a partially covered value", () => {
    const ds = buildFromText(SAMPLE);
    renamePlaceValue(ds, "Stražišče,Kranj,Slovenia", "Stražišče, Kranj, Slovenija");
    const text = serializeDataset(ds);
    expect(text).toContain("2 PLAC Stražišče, Kranj, Slovenija\n3 MAP\n4 LATI N46.2331\n4 LONG E14.3308");
  });
});

describe("movePlaceForAddresses", () => {
  /** Two hamlets filed under one village, the way a post office groups them. */
  const SPLIT = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Gradac, Metlika, Slovenia
3 MAP
4 LATI N45.6667
4 LONG E15.2833
3 _GOV object_999
2 ADDR Klošter 12
1 DEAT
2 PLAC Gradac, Metlika, Slovenia
2 ADDR Gradac 4
0 @I2@ INDI
1 BIRT
2 PLAC Gradac, Metlika, Slovenia
2 ADDR Klošter 12
1 RESI
2 PLAC Gradac, Metlika, Slovenia
0 TRLR
`;

  const KLOSTER = placeAddrKey("Gradac, Metlika, Slovenia", "Klošter 12");

  it("moves only the events at the given pairs", () => {
    const ds = buildFromText(SPLIT);
    const patches = movePlaceForAddresses(ds, new Set([KLOSTER]), "Klošter, Metlika, Slovenia");
    expect(patches.map((p) => p.id).sort()).toEqual(["@I1@", "@I2@"]);
    const text = serializeDataset(ds);
    // Both Klošter events moved; the Gradac address and the address-less RESI
    // stayed — the whole point of keying the edit by place *and* address.
    expect(text.split("\n").filter((l) => l === "2 PLAC Klošter, Metlika, Slovenia")).toHaveLength(2);
    expect(text.split("\n").filter((l) => l === "2 PLAC Gradac, Metlika, Slovenia")).toHaveLength(2);
    // The address line is untouched — it still names the house.
    expect(text).toContain("2 ADDR Klošter 12");
  });

  it("drops the old settlement's coordinate and GOV id", () => {
    const ds = buildFromText(SPLIT);
    movePlaceForAddresses(ds, new Set([KLOSTER]), "Klošter, Metlika, Slovenia");
    const text = serializeDataset(ds);
    expect(text).not.toContain("LATI N45.6667");
    expect(text).not.toContain("_GOV");
    // And the typed model agrees, without a reload.
    expect(ds.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")!.place?.coord).toBeUndefined();
  });

  it("is a no-op without a target, without keys, or when already there", () => {
    const ds = buildFromText(SPLIT);
    expect(movePlaceForAddresses(ds, new Set([KLOSTER]), "  ")).toEqual([]);
    expect(movePlaceForAddresses(ds, new Set(), "Klošter, Metlika, Slovenia")).toEqual([]);
    expect(movePlaceForAddresses(ds, new Set([KLOSTER]), "Gradac, Metlika, Slovenia")).toEqual([]);
  });
});

describe("collectPlaceValues", () => {
  it("lists each distinct raw PLAC once, sorted", () => {
    expect(collectPlaceValues(buildFromText(SAMPLE))).toEqual([
      "Kranj, Slovenija",
      "Ljubljana, Slovenija",
      "Neznani Kraj XY",
      "Stražišče,Kranj,Slovenia",
    ]);
  });
});

describe("applyGeocode", () => {
  it("writes MAP into every missing PLAC, skips covered ones, patches + rebuilds", () => {
    const ds = buildFromText(SAMPLE);
    const assignments = new Map([["Kranj, Slovenija", { coord: { lat: 46.23887, lon: 14.35561 }, govId: "object_310010" }]]);
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
    // The GOV id is written as the GEDCOM-L `_GOV` sibling of MAP.
    expect(text).toContain("3 _GOV object_310010");
    // A re-scan reports the value as covered.
    const rescan = scanGeocode(ds, index, new Map());
    expect(rescan.rows.find((r) => r.key === "Kranj, Slovenija")).toBeUndefined();
  });

  it("is a no-op for values that don't occur or are already covered", () => {
    const ds = buildFromText(SAMPLE);
    const patches = applyGeocode(
      ds,
      new Map([
        ["Ljubljana, Slovenija", { coord: { lat: 1, lon: 1 } }],
        ["Nowhere", { coord: { lat: 2, lon: 2 } }],
      ]),
    );
    expect(patches).toHaveLength(0);
  });
});

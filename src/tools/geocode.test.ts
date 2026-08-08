import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { serializeDataset } from "../gedcom/serialize";
import { buildGazetteerIndex, parseGeoNamesLine, type GazEntry } from "../geo/gazetteer";
import {
  applyGeocode,
  buildWriteSet,
  carryPickAcrossRename,
  chosenCoordFor,
  collectPlaceValues,
  confidentCandidate,
  countGeocodePending,
  countryOf,
  isRegisterAddress,
  movePlaceForAddresses,
  placeAddrKey,
  reconcileNoMatchAfterScan,
  reconcilePicksAfterScan,
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

  it("lists fully covered values apart, as placed rows without a lookup", () => {
    const ds = buildFromText(SAMPLE);
    const scan = scanGeocode(ds, index, new Map());
    // "Ljubljana, Slovenija" is finished work: not in the worklist, offered
    // behind "Show already placed" with its own coordinate and everyone the
    // value occurs on — and no gazetteer candidates (nothing was looked up).
    expect(scan.rows.find((r) => r.key === "Ljubljana, Slovenija")).toBeUndefined();
    expect(scan.placed).toHaveLength(1);
    const lj = scan.placed[0];
    expect(lj.key).toBe("Ljubljana, Slovenija");
    expect(lj.placed).toBe(true);
    expect(lj.missing).toBe(0);
    expect(lj.count).toBe(1);
    expect(lj.fileCoord).toEqual({ lat: 46.05108, lon: 14.50513 });
    expect(lj.candidates).toHaveLength(0);
    expect(lj.confident).toBe(false);
    expect(lj.missingIn).toEqual(["@I1@"]);
  });

  it("attaches remembered no-match marks only, and works without a gazetteer", () => {
    const ds = buildFromText(SAMPLE);
    const cached = new Map([
      // A legacy "accepted" record (from when acceptances were cached too)
      // must be ignored: accepted coordinates live in the saved file.
      ["Kranj, Slovenija", { key: "Kranj, Slovenija", status: "accepted" as const, lat: 46.2, lon: 14.3, ts: 1 }],
      ["Neznani Kraj XY", { key: "Neznani Kraj XY", status: "nomatch" as const, ts: 1 }],
    ]);
    const scan = scanGeocode(ds, undefined, cached);
    expect(scan.rows.find((r) => r.key === "Kranj, Slovenija")!.cached).toBeUndefined();
    expect(scan.rows.find((r) => r.key === "Neznani Kraj XY")!.cached?.status).toBe("nomatch");
  });
});

describe("confidentCandidate", () => {
  const cand = (score: number) => ({ entry: parseGeoNamesLine(GAZ_ROWS[0])!, score });

  it("holds bulk actions to a clear, high-scoring name match", () => {
    expect(confidentCandidate([cand(0.99)])).toBe(true);
    expect(confidentCandidate([cand(0.99), cand(0.9)])).toBe(true);
  });

  it("refuses a fuzzy guess, an ambiguous pair, and an empty list", () => {
    // A row can be `confident` merely because the file already carries a
    // coordinate for it — that must never let a fuzzy candidate through to
    // the bulk rename, which is why the name's own confidence is separate.
    expect(confidentCandidate([cand(0.89)])).toBe(false);
    expect(confidentCandidate([cand(0.99), cand(0.97)])).toBe(false);
    expect(confidentCandidate([])).toBe(false);
  });
});

describe("isRegisterAddress", () => {
  it("recognizes a place value that is really a house", () => {
    expect(isRegisterAddress("Črni vrh 35")).toBe(true);
    expect(isRegisterAddress("Kranj (Slovenija), Stražišče 114 - župnija Šmartin")).toBe(true);
  });

  it("leaves everything else to the place list", () => {
    // No house number to resolve.
    expect(isRegisterAddress("Kranj, Slovenija")).toBe(false);
    // A house the Slovenian register does not cover.
    expect(isRegisterAddress("Ringstrasse 1, Wien, Austria")).toBe(false);
    // A street with no number: nothing to ask the register for.
    expect(isRegisterAddress("Gosposvetska cesta, Kranj, Slovenija")).toBe(false);
  });
});

describe("scanGeocode and house addresses", () => {
  const WITH_HOUSES = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Črni vrh 35
1 RESI
2 PLAC Črni vrh
1 DEAT
2 PLAC Ringstrasse 1, Wien, Austria
0 TRLR
`;

  it("leaves the houses to the grouped address rows, and keeps the rest", () => {
    const ds = buildFromText(WITH_HOUSES);
    const keys = scanGeocode(ds, undefined, new Map()).rows.map((r) => r.key);
    // The settlement and the address the register cannot cover still need a
    // place row; the Slovenian house is reviewed under its settlement instead.
    expect(keys.sort()).toEqual(["Ringstrasse 1, Wien, Austria", "Črni vrh"]);
    // The chip badge counts exactly what the list shows.
    expect(countGeocodePending(ds)).toBe(2);
  });
});

describe("scanGeocode row order", () => {
  const WITH_NUMBERS = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Ringstrasse 10, Wien, Austria
1 RESI
2 PLAC Ringstrasse 4, Wien, Austria
1 DEAT
2 PLAC Ringstrasse 2, Wien, Austria
0 TRLR
`;

  it("orders embedded house numbers numerically, not as text", () => {
    const ds = buildFromText(WITH_NUMBERS);
    const keys = scanGeocode(ds, undefined, new Map()).rows.map((r) => r.key);
    expect(keys).toEqual([
      "Ringstrasse 2, Wien, Austria",
      "Ringstrasse 4, Wien, Austria",
      "Ringstrasse 10, Wien, Austria",
    ]);
  });
});

describe("chosenCoordFor", () => {
  const labels = { fromFile: "from file" };
  const base: GeocodeRow = { key: "X", count: 1, missing: 1, candidates: [], confident: false, missingIn: [] };
  const cand = index.entries.find((e) => e.name === "Kranj")!;

  it("prefers override > file coordinate > best candidate", () => {
    const row: GeocodeRow = {
      ...base,
      fileCoord: { lat: 1, lon: 1 },
      candidates: [{ entry: cand, score: 1 }],
    };
    expect(chosenCoordFor(row, { coord: { lat: 3, lon: 3 }, label: "manual" }, labels)?.coord).toEqual({ lat: 3, lon: 3 });
    expect(chosenCoordFor(row, undefined, labels)).toEqual({
      coord: { lat: 1, lon: 1 },
      label: "from file",
    });
    expect(chosenCoordFor({ ...row, fileCoord: undefined }, undefined, labels)).toEqual({
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

  it("keeps the FORM describing the value it sits on", () => {
    // A FORM names each comma part of its PLAC. A rename that changes how many
    // parts there are leaves it naming levels the value no longer has —
    // "United States, , , , United States" collapsing to "United States" under
    // a five-label FORM was the case that showed it.
    const ds = buildFromText(`0 HEAD
0 @I9@ INDI
1 NAME Test /Case/
1 BIRT
2 PLAC United States, , , , United States
3 FORM Place, Municipality, County, State, Country
1 DEAT
2 PLAC Kranj, Slovenija
3 FORM Place, Country
0 TRLR
`);
    renamePlaceValue(ds, "United States, , , , United States", "United States");
    const text = serializeDataset(ds);
    expect(text).toContain("2 PLAC United States\n");
    expect(text).not.toContain("Place, Municipality, County, State, Country");
    // A FORM that still lines up with its value is left exactly as written.
    expect(text).toContain("3 FORM Place, Country");
  });

  it("writes the register's own levels when the caller knows them", () => {
    const ds = buildFromText(`0 HEAD
0 @I9@ INDI
1 NAME Test /Case/
1 BIRT
2 PLAC Kranj, , , Slovenija
3 FORM Place, Municipality, Region, Country
0 TRLR
`);
    renamePlaceValue(ds, "Kranj, , , Slovenija", "Kranj, Slovenija", undefined, "Place, Country");
    const text = serializeDataset(ds);
    expect(text).toContain("2 PLAC Kranj, Slovenija\n");
    expect(text).toContain("3 FORM Place, Country");
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

  it("does not count a record whose place is unchanged and whose ADDR already has a value", () => {
    // An unchanged place part plus an occupied ADDR writes nothing — reporting
    // it as a changed record inflated the note and pushed an empty undo step.
    const withAddr = buildFromText(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Neznani Kraj XY
2 ADDR Glavni trg 1
0 TRLR
`);
    expect(renamePlaceValue(withAddr, "Neznani Kraj XY", "Neznani Kraj XY", "Glavni trg 2")).toHaveLength(0);
  });
});

describe("staged review state", () => {
  const row = (key: string, over: Partial<GeocodeRow> = {}): GeocodeRow => ({
    key, count: 1, missing: 1, candidates: [], confident: false, missingIn: [], ...over,
  });
  const scanOf = (rows: GeocodeRow[], placed: GeocodeRow[] = []) => ({
    rows, placed, coveredDistinct: 0, totalOccurrences: rows.length, coveredOccurrences: 0,
  });
  const pick = { coord: { lat: 46.1, lon: 14.2 }, label: "x" };

  it("a rescan keeps picks and marks on surviving keys only, and seeds cached no-matches", () => {
    // The incident this pins: renaming one row rescans the list, and every
    // *other* row's staged work used to be at risk of silent discard.
    const scan = scanOf(
      [row("Kranj"), row("Neznano", { cached: { key: "Neznano", status: "nomatch", ts: 1 } })],
      [row("Bled", { missing: 0, placed: true })],
    );
    const chosen = reconcilePicksAfterScan(scan, new Map([["Kranj", pick], ["Izginuli", pick], ["Bled", pick]]));
    expect([...chosen.keys()]).toEqual(["Kranj", "Bled"]);
    const noMatch = reconcileNoMatchAfterScan(scan, new Set(["Izginuli"]));
    expect([...noMatch]).toEqual(["Neznano"]);
  });

  it("a rename carries the pick to the new key, unless that row has its own", () => {
    const carried = carryPickAcrossRename(new Map([["Krajn", pick]]), "Krajn", "Kranj");
    expect(carried.get("Kranj")).toBe(pick);
    expect(carried.has("Krajn")).toBe(false);
    // Merging into a row with staged work of its own: that one stands.
    const own = { coord: { lat: 46.9, lon: 14.9 }, label: "own" };
    const merged = carryPickAcrossRename(new Map([["Krajn", pick], ["Kranj", own]]), "Krajn", "Kranj");
    expect(merged.get("Kranj")).toBe(own);
    expect(merged.has("Krajn")).toBe(false);
  });

  it("the write set overwrites only for placed rows, and remembers only new no-matches", () => {
    const scan = scanOf(
      [row("Kranj"), row("Neznano", { cached: { key: "Neznano", status: "nomatch", ts: 1 } }), row("Novo")],
      [row("Bled", { missing: 0, placed: true })],
    );
    const gov = { ...pick, govId: "object_1" };
    const { assignments, toStore } = buildWriteSet(
      scan,
      new Map([["Kranj", gov], ["Bled", pick]]),
      new Set(["Neznano", "Novo"]),
      99,
    );
    // A pending row's pick fills gaps; only the placed row's is a re-geocode.
    expect(assignments.get("Kranj")).toEqual({ coord: pick.coord, govId: "object_1" });
    expect(assignments.get("Bled")).toEqual({ coord: pick.coord, overwrite: true });
    // The already-cached no-match is not stored again.
    expect(toStore).toEqual([{ key: "Novo", status: "nomatch", ts: 99 }]);
  });
});

describe("applyGeocode write-noop precision", () => {
  it("re-picking the position a value already holds writes nothing", () => {
    // The file stores 5 decimals; a gazetteer candidate carries full precision.
    // Compared exactly, re-accepting the very entry a value came from read as a
    // change and rewrote every occurrence with byte-identical text.
    const ds = buildFromText(SAMPLE);
    const assignments = new Map([
      ["Ljubljana, Slovenija", { coord: { lat: 46.051082, lon: 14.505129 }, overwrite: true }],
    ]);
    expect(applyGeocode(ds, assignments)).toHaveLength(0);
    // A genuinely different position still overwrites.
    const moved = new Map([["Ljubljana, Slovenija", { coord: { lat: 46.06, lon: 14.51 }, overwrite: true }]]);
    expect(applyGeocode(ds, moved)).toHaveLength(1);
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

  it("keeps the coordinate but drops the old GOV id when the target is unplaced", () => {
    const ds = buildFromText(SPLIT);
    movePlaceForAddresses(ds, new Set([KLOSTER]), "Klošter, Metlika, Slovenia");
    const text = serializeDataset(ds);
    // Nothing in the file places Klošter, so the old position is better than none.
    expect(text).toContain("LATI N45.6667");
    // The GOV id named Gradac, so it cannot follow the events out of it.
    expect(text).not.toContain("_GOV");
    // And the typed model agrees, without a reload.
    expect(ds.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")!.place?.coord).toEqual({
      lat: 45.6667,
      lon: 15.2833,
    });
  });

  it("takes the target place's own coordinate when the file has one", () => {
    const ds = buildFromText(`${SPLIT.slice(0, SPLIT.indexOf("0 TRLR"))}0 @I3@ INDI
1 BIRT
2 PLAC Klošter, Metlika, Slovenia
3 MAP
4 LATI N45.7
4 LONG E15.3
3 _GOV object_111
0 TRLR
`);
    movePlaceForAddresses(ds, new Set([KLOSTER]), "Klošter, Metlika, Slovenia");
    const moved = ds.individuals.get("@I1@")!.events.find((e) => e.tag === "BIRT")!;
    expect(moved.place?.coord).toEqual({ lat: 45.7, lon: 15.3 });
    expect(serializeDataset(ds)).toContain("2 PLAC Klošter, Metlika, Slovenia\n3 MAP\n4 LATI N45.7\n4 LONG E15.3\n3 _GOV object_111\n2 ADDR Klošter 12");
    // The event that had no coordinate is placed there too — the destination is
    // where it says it is, whether or not it was placed before.
    expect(ds.individuals.get("@I2@")!.events.find((e) => e.tag === "BIRT")!.place?.coord).toEqual({
      lat: 45.7,
      lon: 15.3,
    });
  });

  it("prefers a coordinate the caller supplies (a register pick) over the file's", () => {
    const ds = buildFromText(SPLIT);
    movePlaceForAddresses(ds, new Set([KLOSTER]), "Klošter, Metlika, Slovenia", {
      coord: { lat: 45.71, lon: 15.31 },
      govId: "object_222",
    });
    const text = serializeDataset(ds);
    expect(text).toContain("4 LATI N45.71\n4 LONG E15.31\n3 _GOV object_222");
    // The events that stayed in Gradac keep the old coordinate and its GOV id.
    expect(text).toContain("2 PLAC Gradac, Metlika, Slovenia");
    expect(ds.individuals.get("@I2@")!.events.find((e) => e.tag === "BIRT")!.place?.coord).toEqual({
      lat: 45.71,
      lon: 15.31,
    });
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

  it("overwrite re-geocodes a placed value, sparing address-bound house pins", () => {
    const REGEOCODE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 NAME A /B/
1 BIRT
2 PLAC Vinji Vrh, Slovenija
3 MAP
4 LATI N45.9
4 LONG E15.3
3 _GOV object_old
1 RESI
2 ADDR Vinji Vrh 5
2 PLAC Vinji Vrh, Slovenija
3 MAP
4 LATI N45.91234
4 LONG E15.31234
1 DEAT
2 PLAC Vinji Vrh, Slovenija
0 TRLR
`;
    const ds = buildFromText(REGEOCODE);
    const patches = applyGeocode(
      ds,
      new Map([["Vinji Vrh, Slovenija", { coord: { lat: 45.85, lon: 15.35 }, overwrite: true }]]),
    );
    expect(patches.map((p) => p.id)).toEqual(["@I1@"]);
    const events = ds.individuals.get("@I1@")!.events;
    // The settlement occurrence moves to the new pick, and the stale _GOV —
    // which named the old position — goes with it.
    expect(events.find((e) => e.tag === "BIRT")!.place?.coord).toEqual({ lat: 45.85, lon: 15.35 });
    const text = serializeDataset(ds);
    expect(text).not.toContain("_GOV");
    // The address-bound occurrence keeps its own house position.
    expect(events.find((e) => e.tag === "RESI")!.place?.coord).toEqual({ lat: 45.91234, lon: 15.31234 });
    // The occurrence with no coordinate is filled, as any geocode write is.
    expect(events.find((e) => e.tag === "DEAT")!.place?.coord).toEqual({ lat: 45.85, lon: 15.35 });
  });
});

describe("countryOf", () => {
  it("names the country the value stands in, however the file spells it", () => {
    expect(countryOf("Ravna Gora,Primorje-Gorski Kotar,Croatia")).toBe("hr");
    expect(countryOf("Kranj, Slovenija")).toBe("si");
    expect(countryOf("Slovenia,,Slovenia")).toBe("si");
  });

  it("gives no country when the value names none", () => {
    // A bare settlement has no jurisdiction chain — it must not become a
    // "country" of its own; a trailing comma means the country was omitted.
    expect(countryOf("Kranj")).toBe("");
    expect(countryOf("Novo mesto,")).toBe("");
    // What a real file's last comma part usually is: a parish patron, a
    // hospital, or a date somebody typed into a place field. None is a country.
    expect(countryOf("Vojnik, sv. Jernej")).toBe("");
    expect(countryOf("Ljubljana, bolnica")).toBe("");
    expect(countryOf("10 avg 1908 ob 17. uri")).toBe("");
  });
});

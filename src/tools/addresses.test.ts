import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import {
  addressesByPlace,
  applyAddressCoords,
  renameAddress,
  replaceLocality,
  scanAddresses,
  suggestMovedPlace,
} from "./addresses";
import { placeAddrKey } from "./geocode";
import { scanPlaceCoords } from "./placeCoords";

function build(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const FILE = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 RESI
2 DATE 1890
2 PLAC Kranj, Slovenija
2 ADDR Kidričeva cesta 38
1 DEAT
2 DATE 1899
2 PLAC Kranj, Slovenija
2 ADDR Kidričeva cesta 38
1 BIRT
2 PLAC Šentvid pri Stični 23, Slovenija
2 ADDR Šentvid pri Stični 23
1 CENS
2 PLAC Wien, Austria
2 ADDR Ringstrasse 1
1 OCCU Kmet
2 PLAC Kranj, Slovenija
0 TRLR`;

describe("scanAddresses", () => {
  const rows = scanAddresses(build(FILE));

  it("groups events at one house into a single row", () => {
    // RESI and DEAT share the pair, so one review covers both events.
    const kranj = rows.find((r) => r.address === "Kidričeva cesta 38")!;
    expect(kranj).toMatchObject({ place: "Kranj, Slovenija", count: 2 });
    // Written in an ADDR line beside the place, so the place is the file's own
    // value and the row can still be moved elsewhere.
    expect(kranj.derived).toBeUndefined();
    expect(kranj.rawKeys).toEqual([placeAddrKey("Kranj, Slovenija", "Kidričeva cesta 38")]);
    // Nothing placed these events yet, so the row carries no coordinate.
    expect(kranj.coord).toBeUndefined();
    expect(kranj.queries).toEqual([{ settlement: "Kranj", street: "Kidričeva cesta", number: 38 }]);
    expect(kranj.people).toEqual(["@I1@"]);
  });

  it("files a house named by the place value under its settlement", () => {
    // The PLAC names the house itself; the row is about that house, and the
    // place it groups under is the settlement left when the number is lifted.
    const row = rows.find((r) => r.address === "Šentvid pri Stični 23")!;
    expect(row).toMatchObject({ place: "Šentvid pri Stični, Slovenija", derived: true, count: 1 });
    expect(row.queries).toEqual([{ settlement: "Šentvid pri Stični", number: 23 }]);
    // The coordinate is written back to the value the events actually carry.
    expect(row.rawKeys).toEqual([placeAddrKey("Šentvid pri Stični 23, Slovenija", "Šentvid pri Stični 23")]);
  });

  it("lists what the register cannot answer, with no query to run", () => {
    // Not Slovenia: the register does not cover it — but the address is still a
    // place to be pinned by hand, so it is reviewed like any other.
    const wien = rows.find((r) => r.key === placeAddrKey("Wien, Austria", "Ringstrasse 1"))!;
    expect(wien.queries).toEqual([]);
    expect(wien.count).toBe(1);
  });

  it("skips events that name no address", () => {
    expect(rows.some((r) => r.address === "")).toBe(false);
  });
});

describe("scanAddresses and an address with no house number", () => {
  // A hamlet named in the ADDR line: "Stražišče" is where the event happened,
  // and it is not the place value, so nothing else in the app can place it.
  const NO_NUMBER = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj, Slovenija
2 ADDR Stražišče
1 DEAT
2 PLAC Kranj, Slovenija
2 ADDR Stražišče 114
0 TRLR`;

  it("reviews it beside the numbered houses of the same place", () => {
    const rows = scanAddresses(build(NO_NUMBER));
    expect(rows.map((r) => r.address).sort()).toEqual(["Stražišče", "Stražišče 114"]);
    // No number, so no register query — the row is placed by hand instead.
    expect(rows.find((r) => r.address === "Stražišče")!.queries).toEqual([]);
    expect(rows.find((r) => r.address === "Stražišče 114")!.queries).toHaveLength(1);
  });
});

describe("scanAddresses on a file that keeps no ADDR lines", () => {
  /** Village numbering written straight into PLAC, the Prevodnik house style. */
  const IN_PLACE = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Črni vrh 35
1 RESI
2 PLAC Črni vrh 46
0 @I2@ INDI
1 BIRT
2 PLAC Črni vrh 35
1 DEAT
2 PLAC Črni vrh
0 TRLR`;

  const rows = scanAddresses(build(IN_PLACE));

  it("reads each house out of its place value and groups them by settlement", () => {
    expect(rows.map((r) => r.address)).toEqual(["Črni vrh 35", "Črni vrh 46"]);
    expect(rows.every((r) => r.place === "Črni vrh" && r.derived)).toBe(true);
    // Two people at number 35, one at 46; the place-only event is no address.
    expect(rows.map((r) => r.count)).toEqual([2, 1]);
    expect(rows[0].people).toEqual(["@I1@", "@I2@"]);
    expect(rows[0].queries).toEqual([{ settlement: "Črni vrh", number: 35 }]);
  });

  it("writes the accepted house onto the place value the events carry", () => {
    const ds = build(IN_PLACE);
    const house = { lat: 46.10101, lon: 14.20202 };
    applyAddressCoords(ds, new Map(scanAddresses(ds)[0].rawKeys.map((k) => [k, house])));
    const out = serializeGedcom(ds.records);
    // Both events at 35 got it; 46 and the place-only event did not.
    expect(out.split("\n").filter((l) => l === "4 LATI N46.10101")).toHaveLength(2);
    expect(scanAddresses(build(out)).map((r) => r.address)).toEqual(["Črni vrh 46"]);
  });
});

describe("scanAddresses and a packed place value", () => {
  /** The Brother's Keeper style: place, house and parish in one PLAC. */
  const PACKED = `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Kranj (Slovenija), Stražišče 114 - župnija Šmartin
1 DEAT
2 PLAC Kranj (Slovenija), Stražišče 114 - župnija Kranj
0 TRLR`;

  it("merges the file's spellings of one house into a single row", () => {
    const rows = scanAddresses(build(PACKED));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ place: "Kranj, Slovenija", address: "Stražišče 114", derived: true, count: 2 });
    // The parish is not part of where the house is, so both values are the same
    // row — and both are written when it is accepted.
    expect(rows[0].rawKeys).toEqual([
      placeAddrKey("Kranj (Slovenija), Stražišče 114 - župnija Šmartin", ""),
      placeAddrKey("Kranj (Slovenija), Stražišče 114 - župnija Kranj", ""),
    ]);
    // Stražišče is a settlement of its own, so the register is asked for the
    // house on a Kranj street first and falls back to it (see searchAddress).
    expect(rows[0].queries).toEqual([{ settlement: "Kranj", street: "Stražišče", number: 114 }]);
  });
});

describe("applyAddressCoords", () => {
  const HOUSE = { lat: 46.241374, lon: 14.355805 };

  it("writes the standard PLAC MAP on every event at the pair, and only those", () => {
    const ds = build(FILE);
    const patches = applyAddressCoords(ds, new Map([[placeAddrKey("Kranj, Slovenija", "Kidričeva cesta 38"), HOUSE]]));
    expect(patches).toHaveLength(1);
    expect(patches[0].type).toBe("individual");

    const out = serializeGedcom(ds.records);
    // Standard tag only — nothing custom is written.
    expect(out).not.toContain("_MAP");
    // Both RESI and DEAT at that house got it, and nothing else did: the OCCU
    // event shares the place string but names no address, so it stays empty.
    // Otherwise one house's position would spread across all of Kranj.
    expect(out.split("\n").filter((l) => l === "4 LATI N46.24137")).toHaveLength(2);
    const occuAt = out.split("\n").findIndex((l) => l.startsWith("1 OCCU"));
    expect(out.split("\n").slice(occuAt, occuAt + 3)).toEqual(["1 OCCU Kmet", "2 PLAC Kranj, Slovenija", "0 TRLR"]);

    // Re-parsing lifts it onto that event's place, and the row is done — the
    // Kranj house is gone from the list, while the untouched ones remain (the
    // Vienna address among them: still unplaced, register or no register).
    const again = build(out);
    const resi = again.individuals.get("@I1@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.place?.coord?.lat).toBeCloseTo(HOUSE.lat, 5);
    expect(scanAddresses(again).map((r) => r.address)).toEqual(["Šentvid pri Stični 23", "Ringstrasse 1"]);
  });

  it("leaves the health check quiet: same settlement, different addresses", () => {
    // The two Kranj addresses now hold different coordinates, which is correct
    // and must not be reported — that is why the check groups by place+address.
    const ds = build(FILE);
    applyAddressCoords(ds, new Map([[placeAddrKey("Kranj, Slovenija", "Kidričeva cesta 38"), HOUSE]]));
    const { fills, conflicts } = scanPlaceCoords(ds);
    expect(conflicts).toEqual([]);
    // The pair is fully covered (both its events written), so nothing to fill.
    expect(fills.filter((f) => f.address === "Kidričeva cesta 38")).toEqual([]);
  });

  it("is a no-op for an unmatched assignment", () => {
    const ds = build(FILE);
    expect(applyAddressCoords(ds, new Map([[placeAddrKey("Bled", "Bled 1"), HOUSE]]))).toEqual([]);
  });
});

describe("scanAddresses ordering", () => {
  it("orders equally-used addresses by house number, not as text", () => {
    const events = [4, 49, 6, 57, 32, 7]
      .map((n) => `1 RESI\n2 PLAC Srednje Bitnje, Kranj, Slovenija\n2 ADDR Srednje Bitnje ${n}`)
      .join("\n");
    const rows = scanAddresses(build(`0 HEAD\n1 GEDC\n2 VERS 5.5.1\n0 @I1@ INDI\n${events}\n0 TRLR`));
    expect(rows.map((r) => r.address)).toEqual([
      "Srednje Bitnje 4",
      "Srednje Bitnje 6",
      "Srednje Bitnje 7",
      "Srednje Bitnje 32",
      "Srednje Bitnje 49",
      "Srednje Bitnje 57",
    ]);
  });
});

describe("replaceLocality", () => {
  it("swaps the settlement and keeps the file's own outer levels", () => {
    expect(replaceLocality("Gradac, Metlika, Slovenia", "Klošter")).toBe("Klošter, Metlika, Slovenia");
    expect(replaceLocality("Gradac,Metlika,Slovenija", "Klošter")).toBe("Klošter,Metlika,Slovenija");
  });

  it("declines what it cannot substitute safely", () => {
    // Already there.
    expect(replaceLocality("Klošter, Metlika, Slovenia", "Klošter")).toBeUndefined();
    // Packed form: the leading segment is not the bare settlement.
    expect(replaceLocality("Kranj (Slovenija), Kidričeva 38", "Klošter")).toBeUndefined();
    expect(replaceLocality("Gradac, Metlika", "  ")).toBeUndefined();
  });
});

describe("suggestMovedPlace", () => {
  it("reads a house number hanging off a name that is not the settlement", () => {
    expect(suggestMovedPlace("Gradac, Metlika, Slovenia", "Klošter 12")).toBe("Klošter, Metlika, Slovenia");
  });

  it("stays quiet when the address is an ordinary street or the place itself", () => {
    // A street word: "Kidričeva cesta" is a street in Kranj, not a settlement.
    expect(suggestMovedPlace("Kranj, Slovenija", "Kidričeva cesta 38")).toBeUndefined();
    // Village numbering — the number already hangs off the place named.
    expect(suggestMovedPlace("Gradac, Metlika, Slovenia", "Gradac 12")).toBeUndefined();
    // No house number at all.
    expect(suggestMovedPlace("Gradac, Metlika, Slovenia", "Klošter")).toBeUndefined();
  });
});

describe("scanAddresses and existing coordinates", () => {
  /** One person, two Kranj addresses, both already carrying `coord`. */
  const withCoords = (coordA: string, coordB: string) => `0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 RESI
2 PLAC Kranj, Slovenija
3 MAP
4 LATI ${coordA}
4 LONG E14.35561
2 ADDR Kidričeva cesta 38
1 CENS
2 PLAC Kranj, Slovenija
3 MAP
4 LATI ${coordB}
4 LONG E14.35561
2 ADDR Koroška cesta 1
0 TRLR`;

  it("still offers an address whose coordinate is only the settlement's", () => {
    // Both addresses share one coordinate, so it cannot be either house — it is
    // the settlement's (a gazetteer fill). Both remain worth sharpening, even
    // though no address-less event exists to reveal the settlement value.
    const rows = scanAddresses(build(withCoords("N46.23887", "N46.23887")));
    expect(rows.map((r) => r.address).sort()).toEqual(["Kidričeva cesta 38", "Koroška cesta 1"]);
    expect(rows.every((r) => r.covered === 1)).toBe(true);
    // The coordinate rides along so the group's map has something to draw
    // before any register lookup has run.
    expect(rows.every((r) => r.coord?.lat === 46.23887)).toBe(true);
  });

  it("leaves an address alone once it has its own house coordinate", () => {
    // Distinct coordinates per address: each is house-precise, nothing to do.
    expect(scanAddresses(build(withCoords("N46.24137", "N46.23887")))).toEqual([]);
  });
});

describe("renameAddress", () => {
  const HOUSES = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Ana /Kos/
1 BIRT
2 PLAC Kranj, Slovenija
2 ADDR Hafnarjeva pot 21
1 RESI
2 PLAC Kranj (Slovenija), Hafnarjeva pot 21a - župnija Šmartin
1 DEAT
2 PLAC Kranj, Slovenija
2 ADDR Hafnarjeva pot 21a
0 TRLR`;

  it("rewrites the ADDR line and the packed place value alike", () => {
    const ds = build(HOUSES);
    const rows = scanAddresses(ds);
    const packed = rows.find((r) => r.address === "Hafnarjeva pot 21a")!;
    const patches = renameAddress(ds, packed.rawKeys, packed.address, "Hafnarjeva pot 53");
    expect(patches.length).toBeGreaterThan(0);
    const text = serializeGedcom(ds.records);
    // The packed value keeps its annotations; only the address text changed.
    expect(text).toContain("2 PLAC Kranj (Slovenija), Hafnarjeva pot 53 - župnija Šmartin");
    expect(text).toContain("2 ADDR Hafnarjeva pot 53");
    // The other house is untouched.
    expect(text).toContain("2 ADDR Hafnarjeva pot 21\n");
  });

  it("renaming onto another row's address merges the two rows", () => {
    const ds = build(HOUSES);
    const rows = scanAddresses(ds);
    const a21a = rows.find((r) => r.address === "Hafnarjeva pot 21a")!;
    renameAddress(ds, a21a.rawKeys, a21a.address, "Hafnarjeva pot 21");
    const after = scanAddresses(ds);
    expect(after).toHaveLength(1);
    expect(after[0].address).toBe("Hafnarjeva pot 21");
    expect(after[0].count).toBe(3);
  });

  it("is a no-op for an empty or unchanged target", () => {
    const ds = build(HOUSES);
    const rows = scanAddresses(ds);
    const row = rows[0];
    expect(renameAddress(ds, row.rawKeys, row.address, row.address)).toHaveLength(0);
    expect(renameAddress(ds, row.rawKeys, row.address, "  ")).toHaveLength(0);
  });
});

describe("addressesByPlace", () => {
  it("collects every house of a place, however the file writes it", () => {
    const map = addressesByPlace(build(FILE));
    expect(map.get("Kranj, Slovenija")).toEqual(["Kidričeva cesta 38"]);
    // Read out of the place value, so filed under the settlement left behind.
    expect(map.get("Šentvid pri Stični, Slovenija")).toEqual(["Šentvid pri Stični 23"]);
    // Beyond the register's reach, but still a spelling this place has.
    expect(map.get("Wien, Austria")).toEqual(["Ringstrasse 1"]);
  });

  it("keeps a house the geocoding rows have dropped", () => {
    const ds = build(`0 HEAD
1 GEDC
2 VERS 5.5.1
0 @I1@ INDI
1 BIRT
2 PLAC Črni vrh 35
1 RESI
2 PLAC Črni vrh 46
0 TRLR`);
    const placed = scanAddresses(ds).find((r) => r.address === "Črni vrh 35")!;
    applyAddressCoords(ds, new Map(placed.rawKeys.map((k) => [k, { lat: 46.10101, lon: 14.20202 }])));
    const after = build(serializeGedcom(ds.records));
    // Nothing left to look up for 35 — but it is still the spelling 46 could be
    // renamed onto, so the rename's list must keep offering it.
    expect(scanAddresses(after).map((r) => r.address)).toEqual(["Črni vrh 46"]);
    expect(addressesByPlace(after).get("Črni vrh")).toEqual(["Črni vrh 35", "Črni vrh 46"]);
  });
});

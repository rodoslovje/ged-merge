import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { addressKey, applyAddressCoords, scanAddresses } from "./addresses";

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
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ place: "Kranj, Slovenija", address: "Kidričeva cesta 38", count: 2 });
    expect(rows[0].query).toEqual({ settlement: "Kranj", street: "Kidričeva cesta", number: 38 });
    expect(rows[0].people).toEqual(["@I1@"]);
  });

  it("skips what belongs elsewhere or cannot be looked up", () => {
    const keys = rows.map((r) => r.key);
    // PLAC already names the house — the Geocode-places row resolves that one
    // against the register itself, so listing it here would duplicate the ask.
    expect(keys).not.toContain(addressKey("Šentvid pri Stični 23, Slovenija", "Šentvid pri Stični 23"));
    // Not Slovenia: the register does not cover it.
    expect(keys).not.toContain(addressKey("Wien, Austria", "Ringstrasse 1"));
    // No ADDR at all.
    expect(rows.some((r) => r.address === "")).toBe(false);
  });
});

describe("applyAddressCoords", () => {
  const HOUSE = { lat: 46.241374, lon: 14.355805 };

  it("writes _MAP on every event at the pair and leaves the shared place alone", () => {
    const ds = build(FILE);
    const patches = applyAddressCoords(ds, new Map([[addressKey("Kranj, Slovenija", "Kidričeva cesta 38"), HOUSE]]));
    expect(patches).toHaveLength(1);
    expect(patches[0].type).toBe("individual");

    const lines = serializeGedcom(ds.records).split("\n");
    // Both events at that house got the coordinate.
    expect(lines.filter((l) => l === "3 _MAP")).toHaveLength(2);
    expect(lines.filter((l) => l === "4 LATI N46.24137")).toHaveLength(2);
    // The settlement string, shared with the OCCU event, gained nothing —
    // otherwise scanSplitCoordPlaces would spread this house across Kranj.
    expect(lines.some((l) => l.trim() === "3 MAP")).toBe(false);

    // Re-parsing lifts it back onto the address, and the row is now done.
    const again = build(serializeGedcom(ds.records));
    const resi = again.individuals.get("@I1@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.address?.coord?.lat).toBeCloseTo(HOUSE.lat, 5);
    expect(scanAddresses(again)).toEqual([]);
  });

  it("is a no-op for an unmatched assignment", () => {
    const ds = build(FILE);
    expect(applyAddressCoords(ds, new Map([[addressKey("Bled", "Bled 1"), HOUSE]]))).toEqual([]);
  });
});

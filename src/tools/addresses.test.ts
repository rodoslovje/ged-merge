import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { applyAddressCoords, replaceLocality, scanAddresses, suggestMovedPlace } from "./addresses";
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
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ place: "Kranj, Slovenija", address: "Kidričeva cesta 38", count: 2 });
    expect(rows[0].queries).toEqual([{ settlement: "Kranj", street: "Kidričeva cesta", number: 38 }]);
    expect(rows[0].people).toEqual(["@I1@"]);
  });

  it("skips what belongs elsewhere or cannot be looked up", () => {
    const keys = rows.map((r) => r.key);
    // PLAC already names the house — the Geocode-places row resolves that one
    // against the register itself, so listing it here would duplicate the ask.
    expect(keys).not.toContain(placeAddrKey("Šentvid pri Stični 23, Slovenija", "Šentvid pri Stični 23"));
    // Not Slovenia: the register does not cover it.
    expect(keys).not.toContain(placeAddrKey("Wien, Austria", "Ringstrasse 1"));
    // No ADDR at all.
    expect(rows.some((r) => r.address === "")).toBe(false);
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

    // Re-parsing lifts it onto that event's place, and the row is done.
    const again = build(out);
    const resi = again.individuals.get("@I1@")!.events.find((e) => e.tag === "RESI")!;
    expect(resi.place?.coord?.lat).toBeCloseTo(HOUSE.lat, 5);
    expect(scanAddresses(again)).toEqual([]);
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
  });

  it("leaves an address alone once it has its own house coordinate", () => {
    // Distinct coordinates per address: each is house-precise, nothing to do.
    expect(scanAddresses(build(withCoords("N46.24137", "N46.23887")))).toEqual([]);
  });
});

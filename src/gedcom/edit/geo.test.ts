import { describe, expect, it } from "vitest";
import { buildDataset } from "../builder";
import { parseGedcom } from "../parser";
import { serializeGedcom } from "../serialize";
import { setAddressCoord } from "./geo";

function build(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const HEAD = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
const TRAILER = "0 TRLR";

/** A file with one RESI event, given the PLAC/ADDR lines to put under it. */
function file(...eventLines: string[]) {
  return [...HEAD, "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 RESI", ...eventLines, TRAILER].join("\n");
}

const HOUSE = { lat: 45.949786, lon: 14.833745 };

describe("setAddressCoord", () => {
  it("uses the standard PLAC MAP when the place string names the house", () => {
    // "Šentvid pri Stični 23" identifies the house, so every occurrence of that
    // place string legitimately shares this coordinate — no custom tag needed.
    const ds = build(file("2 PLAC Šentvid pri Stični 23, Slovenija"));
    const event = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "RESI")!;
    expect(setAddressCoord(event, HOUSE, true)).toBe("PLAC");

    const out = serializeGedcom(ds.records);
    expect(out).toContain("3 MAP");
    expect(out).toContain("4 LATI N45.94979");
    expect(out).toContain("4 LONG E14.83375");
    expect(out).not.toContain("_MAP");
  });

  it("uses _MAP under ADDR when PLAC names only the shared settlement", () => {
    // Putting a house coordinate on "Kranj" would let scanSplitCoordPlaces copy
    // it onto every other Kranj event, at other addresses.
    const ds = build(file("2 PLAC Kranj, Slovenija", "2 ADDR Kidričeva cesta 38"));
    const event = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "RESI")!;
    expect(setAddressCoord(event, HOUSE, false)).toBe("_MAP");

    const lines = serializeGedcom(ds.records).split("\n");
    const at = lines.findIndex((l) => l.startsWith("2 ADDR"));
    expect(lines.slice(at, at + 4)).toEqual([
      "2 ADDR Kidričeva cesta 38",
      "3 _MAP",
      "4 LATI N45.94979",
      "4 LONG E14.83375",
    ]);
    // The shared place keeps whatever it had — here, nothing.
    expect(lines.find((l) => l.startsWith("2 PLAC"))).toBe("2 PLAC Kranj, Slovenija");
    expect(lines.filter((l) => l.trim() === "3 MAP")).toEqual([]);
  });

  it("round-trips an address coordinate back into the model", () => {
    const ds = build(file("2 PLAC Kranj, Slovenija", "2 ADDR Kidričeva cesta 38"));
    const event = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "RESI")!;
    setAddressCoord(event, HOUSE, false);

    // Re-parse the serialized file: the coordinate must come back on the
    // address, and must not leak onto the place.
    const again = build(serializeGedcom(ds.records));
    const ev = again.individuals.get("@I1@")!.events.find((e) => e.tag === "RESI")!;
    expect(ev.address?.coord?.lat).toBeCloseTo(HOUSE.lat, 5);
    expect(ev.address?.coord?.lon).toBeCloseTo(HOUSE.lon, 5);
    expect(ev.place?.coord).toBeUndefined();
  });

  it("rewrites an existing _MAP in place rather than adding a second", () => {
    const ds = build(file("2 PLAC Kranj, Slovenija", "2 ADDR Kidričeva cesta 38"));
    const event = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "RESI")!;
    setAddressCoord(event, HOUSE, false);
    setAddressCoord(event, { lat: 46.241374, lon: 14.355805 }, false);

    const out = serializeGedcom(ds.records);
    expect(out.match(/_MAP/g)).toHaveLength(1);
    expect(out).toContain("4 LATI N46.24137");
    expect(out).not.toContain("N45.94979");
  });

  it("falls back to PLAC when there is no ADDR to hang the coordinate on", () => {
    const ds = build(file("2 PLAC Kranj, Slovenija"));
    const event = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "RESI")!;
    expect(setAddressCoord(event, HOUSE, false)).toBe("PLAC");
    expect(serializeGedcom(ds.records)).toContain("3 MAP");
  });

  it("reports nothing written when the event has neither PLAC nor ADDR", () => {
    const ds = build(file("2 DATE 1890"));
    const event = ds.individuals.get("@I1@")!.raw.children.find((c) => c.tag === "RESI")!;
    expect(setAddressCoord(event, HOUSE, false)).toBeUndefined();
  });
});

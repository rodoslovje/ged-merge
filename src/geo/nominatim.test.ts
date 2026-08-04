import { describe, expect, it } from "vitest";
import { osmKindLabel, parseNominatimResponse } from "./nominatim";

describe("parseNominatimResponse", () => {
  it("maps jsonv2 rows to coordinates with short and full labels", () => {
    const rows = [
      { lat: "46.2389", lon: "14.3556", name: "Kranj", display_name: "Kranj, Gorenjska, Slovenija", type: "town" },
      { lat: "46.0511", lon: "14.5051", name: "", display_name: "Cesta 1, Ljubljana, Slovenija", type: "house" },
    ];
    expect(parseNominatimResponse(rows)).toEqual([
      // The chain's next level up rides along, so the row can show "Kranj
      // (Gorenjska)" rather than the whole line.
      { coord: { lat: 46.2389, lon: 14.3556 }, name: "Kranj", label: "Kranj, Gorenjska, Slovenija", admin: "Gorenjska", kind: "town" },
      // No own name: the display name's head becomes the pick label.
      { coord: { lat: 46.0511, lon: 14.5051 }, name: "Cesta 1", label: "Cesta 1, Ljubljana, Slovenija", admin: "Ljubljana", kind: "house" },
    ]);
  });

  it("leaves the parent off when there is none, or it repeats the name", () => {
    const rows = [
      { lat: "46", lon: "14", name: "Slovenija", display_name: "Slovenija" },
      { lat: "46", lon: "14", name: "Kranj", display_name: "Kranj, Kranj, Slovenija" },
    ];
    expect(parseNominatimResponse(rows).map((r) => r.admin)).toEqual([undefined, undefined]);
  });

  it("reads the structured address parts when the row carries them", () => {
    const rows = [
      {
        lat: "46.2456",
        lon: "14.3312",
        name: "21",
        display_name: "21, Hafnarjeva pot, Stražišče, Kranj, 4000 Kranj, Slovenija",
        type: "house",
        address: {
          house_number: "21",
          road: "Hafnarjeva pot",
          village: "Stražišče",
          municipality: "Kranj",
          postcode: "4000",
          country: "Slovenija",
          country_code: "si",
        },
      },
    ];
    expect(parseNominatimResponse(rows)[0].parts).toEqual({
      house: "21",
      road: "Hafnarjeva pot",
      locality: "Stražišče",
      admin: "Kranj",
      country: "Slovenija",
    });
  });

  it("leaves the parts off entirely when the row has no address block", () => {
    const rows = [{ lat: "46", lon: "14", name: "Kranj", display_name: "Kranj, Slovenija" }];
    expect(parseNominatimResponse(rows)[0].parts).toBeUndefined();
  });

  it("drops malformed rows and tolerates a non-array body", () => {
    expect(
      parseNominatimResponse([
        { lat: "not-a-number", lon: "14", display_name: "X" },
        { lat: "46", lon: "14", display_name: "" },
      ]),
    ).toEqual([]);
    expect(parseNominatimResponse({ error: "Unable to geocode" })).toEqual([]);
    expect(parseNominatimResponse(undefined)).toEqual([]);
  });
});

describe("osmKindLabel", () => {
  // The case this exists for: OpenStreetMap answers "Huje, Kranj" with the
  // suburb, the street named after it and a service road off that street —
  // three rows whose display lines are word for word identical.
  const raw = [
    { lat: "46.2424", lon: "14.3614", name: "Huje", display_name: "Huje, Kranj, 4000, Slovenija", category: "place", type: "suburb" },
    { lat: "46.2408", lon: "14.3591", name: "Huje", display_name: "Huje, Kranj, 4000, Slovenija", category: "highway", type: "residential" },
    { lat: "46.2423", lon: "14.3597", name: "Huje", display_name: "Huje, Kranj, 4000, Slovenija", category: "highway", type: "service" },
  ];
  // Stands in for i18next: the keys these entries would resolve, nothing else.
  const strings: Record<string, string> = {
    "osm.kind.suburb": "suburb",
    "osm.kind.highway.residential": "residential street",
    "osm.kind.highway.service": "service road",
  };
  const t = (key: string, opts?: Record<string, unknown>) =>
    strings[key] ?? (opts?.defaultValue as string) ?? key;

  it("names what each hit is, so identical display lines are told apart", () => {
    const results = parseNominatimResponse(raw);
    expect(results.map((r) => osmKindLabel(r, t))).toEqual(["suburb", "residential street", "service road"]);
  });

  it("falls back to OpenStreetMap's own words for a pair with no translation", () => {
    const [quarry] = parseNominatimResponse([
      { lat: "46", lon: "14", name: "X", display_name: "X", category: "landuse", type: "quarry" },
    ]);
    expect(osmKindLabel(quarry, t)).toBe("quarry");
    const [track] = parseNominatimResponse([
      { lat: "46", lon: "14", name: "Y", display_name: "Y", category: "highway", type: "byway" },
    ]);
    expect(osmKindLabel(track, t)).toBe("byway road");
    const [isolated] = parseNominatimResponse([
      { lat: "46", lon: "14", name: "Z", display_name: "Z", category: "place", type: "isolated_dwelling" },
    ]);
    expect(osmKindLabel(isolated, t)).toBe("isolated dwelling");
  });

  it("says nothing when the service gave no type", () => {
    const [bare] = parseNominatimResponse([{ lat: "46", lon: "14", name: "Q", display_name: "Q" }]);
    expect(osmKindLabel(bare, t)).toBe("");
  });
});

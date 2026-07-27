import { describe, expect, it } from "vitest";
import { parseNominatimResponse } from "./nominatim";

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

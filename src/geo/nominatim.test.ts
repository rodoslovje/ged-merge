import { describe, expect, it } from "vitest";
import { parseNominatimResponse } from "./nominatim";

describe("parseNominatimResponse", () => {
  it("maps jsonv2 rows to coordinates with short and full labels", () => {
    const rows = [
      { lat: "46.2389", lon: "14.3556", name: "Kranj", display_name: "Kranj, Gorenjska, Slovenija", type: "town" },
      { lat: "46.0511", lon: "14.5051", name: "", display_name: "Cesta 1, Ljubljana, Slovenija", type: "house" },
    ];
    expect(parseNominatimResponse(rows)).toEqual([
      { coord: { lat: 46.2389, lon: 14.3556 }, name: "Kranj", label: "Kranj, Gorenjska, Slovenija", kind: "town" },
      // No own name: the display name's head becomes the pick label.
      { coord: { lat: 46.0511, lon: 14.5051 }, name: "Cesta 1", label: "Cesta 1, Ljubljana, Slovenija", kind: "house" },
    ]);
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

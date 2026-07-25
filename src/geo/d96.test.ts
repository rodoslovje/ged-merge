import { describe, expect, it } from "vitest";
import { d96ToWgs84, isPlausibleD96 } from "./d96";

describe("d96ToWgs84", () => {
  // Reference pairs read straight from the GURS address register (the E/N
  // properties of real REGISTER_NASLOVOV features) with the expected WGS84
  // values from an independent inverse-TM implementation.
  const cases: [string, number, number, number, number][] = [
    ["Slovenska cesta 9, Ljubljana", 461390, 101020, 46.047891, 14.50109],
    ["Šentvid pri Stični 23", 487111, 90009, 45.949786, 14.833745],
    ["Bled, Na Plani 10", 431678, 136286, 46.362832, 14.112097],
    ["Kranj, Koroška cesta 1", 450321, 122605, 46.241374, 14.355805],
  ];

  for (const [name, e, n, lat, lon] of cases) {
    it(`projects ${name}`, () => {
      const out = d96ToWgs84(e, n);
      // 5 decimals ≈ 1 m, the precision the GEDCOM writer keeps.
      expect(out?.lat).toBeCloseTo(lat, 5);
      expect(out?.lon).toBeCloseTo(lon, 5);
    });
  }

  it("puts the central meridian at exactly 15°E", () => {
    // On the false easting the longitude must come back as lon0 with no drift.
    expect(d96ToWgs84(500000, 100000)?.lon).toBeCloseTo(15, 9);
  });

  it("rejects coordinates that cannot be Slovenian", () => {
    expect(d96ToWgs84(0, 0)).toBeUndefined();
    // A swapped E/N pair — northing-sized easting — must not silently project.
    expect(d96ToWgs84(101020, 461390)).toBeUndefined();
    expect(d96ToWgs84(Number.NaN, 100000)).toBeUndefined();
    expect(isPlausibleD96(461390, 101020)).toBe(true);
  });
});

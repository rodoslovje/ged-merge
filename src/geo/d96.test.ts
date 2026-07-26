import { describe, expect, it } from "vitest";
import { d96ToWgs84, isPlausibleD96, wgs84ToD96 } from "./d96";

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

describe("wgs84ToD96", () => {
  // Same reference pairs as above, read the other way.
  const cases: [string, number, number, number, number][] = [
    ["Slovenska cesta 9, Ljubljana", 461390, 101020, 46.047891, 14.50109],
    ["Šentvid pri Stični 23", 487111, 90009, 45.949786, 14.833745],
    ["Bled, Na Plani 10", 431678, 136286, 46.362832, 14.112097],
    ["Kranj, Koroška cesta 1", 450321, 122605, 46.241374, 14.355805],
  ];

  for (const [name, e, n, lat, lon] of cases) {
    it(`projects ${name}`, () => {
      const out = wgs84ToD96(lat, lon);
      // The reference WGS84 values are rounded to 6 decimals (~0.1 m), so the
      // grid metres come back within a decimetre of the register's own.
      expect(out?.easting).toBeCloseTo(e, 1);
      expect(out?.northing).toBeCloseTo(n, 1);
    });
  }

  it("puts 15°E on the false easting exactly", () => {
    expect(wgs84ToD96(46, 15)?.easting).toBeCloseTo(500000, 6);
  });

  it("round-trips through d96ToWgs84 to sub-millimetre", () => {
    // Corners and centre of the country — the map projects tile footprints
    // anywhere in this range, so the series must hold across the whole grid.
    for (const [e, n] of [
      [380000, 35000],
      [620000, 190000],
      [461390, 101020],
      [500000, 120000],
      [400000, 180000],
    ]) {
      const geo = d96ToWgs84(e, n)!;
      const back = wgs84ToD96(geo.lat, geo.lon)!;
      expect(back.easting).toBeCloseTo(e, 3);
      expect(back.northing).toBeCloseTo(n, 3);
    }
  });

  it("projects outside Slovenia rather than refusing", () => {
    // Tile corners straddle the border; the forward direction must not gate on
    // the national extent the way the inverse does.
    const out = wgs84ToD96(48.2, 16.37); // Vienna
    expect(out).toBeDefined();
    expect(isPlausibleD96(out!.easting, out!.northing)).toBe(false);
  });

  it("rejects values that are not a coordinate", () => {
    expect(wgs84ToD96(Number.NaN, 15)).toBeUndefined();
    expect(wgs84ToD96(46, Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(wgs84ToD96(90, 15)).toBeUndefined();
  });
});

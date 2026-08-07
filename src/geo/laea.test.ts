import { describe, expect, it } from "vitest";
import { isInCroatia, laea3035ToWgs84 } from "./laea";

describe("laea3035ToWgs84", () => {
  it("returns the projection origin for the false origin", () => {
    const c = laea3035ToWgs84(4321000, 3210000);
    expect(c?.lat).toBeCloseTo(52, 9);
    expect(c?.lon).toBeCloseTo(10, 9);
  });

  it("places a register address at its real coordinate", () => {
    // Brežna ulica 33, Andraševec (Oroslavje) — one row of the DGU address
    // register, whose position the register itself gives in EPSG:3035. Note the
    // register writes `<gml:pos>` in the CRS's own axis order, northing first;
    // this takes them the way every other projection here does.
    //
    // The DGU's *place* register puts Andraševec's centre at 46.00234 N,
    // 15.93684 E, so this house lands 900 m east of it — on the village's own
    // eastern edge, which is the check that matters: two independent DGU
    // services, one projection between them.
    const c = laea3035ToWgs84(4781765.61686003, 2561799.19395499);
    expect(c?.lat).toBeCloseTo(46.00325, 4);
    expect(c?.lon).toBeCloseTo(15.94829, 4);
    expect(isInCroatia(c)).toBe(true);
  });

  it("agrees with the EPSG test point", () => {
    // EPSG guidance note 7-2, example for method 9820: 50°N 5°E projects to
    // E = 3 962 799.45, N = 2 999 718.85.
    const c = laea3035ToWgs84(3962799.45, 2999718.85);
    expect(c?.lat).toBeCloseTo(50, 6);
    expect(c?.lon).toBeCloseTo(5, 6);
  });

  it("rejects values that are not coordinates", () => {
    expect(laea3035ToWgs84(Number.NaN, 3210000)).toBeUndefined();
    expect(laea3035ToWgs84(4321000, Number.POSITIVE_INFINITY)).toBeUndefined();
    // Beyond a quadrant from the origin — no European coordinate reaches this.
    expect(laea3035ToWgs84(4321000, 3210000 + 4e7)).toBeUndefined();
  });
});

describe("isInCroatia", () => {
  it("accepts a Croatian coordinate and rejects one far outside", () => {
    expect(isInCroatia({ lat: 45.81, lon: 15.98 })).toBe(true);
    expect(isInCroatia({ lat: 52, lon: 10 })).toBe(false);
    expect(isInCroatia(undefined)).toBe(false);
  });
});

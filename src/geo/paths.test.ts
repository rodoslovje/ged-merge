import { describe, expect, it } from "vitest";
import type { MapPoint } from "./points";
import { buildPersonPaths } from "./paths";

function pt(over: Partial<MapPoint> & { personIds: string[]; coord: MapPoint["coord"] }): MapPoint {
  return { tag: "RESI", kind: "residence", place: "x", ...over };
}

const KRANJ = { lat: 46.24, lon: 14.36 };
const LJUBLJANA = { lat: 46.05, lon: 14.51 };
const TRST = { lat: 45.64, lon: 13.77 };

describe("buildPersonPaths", () => {
  it("orders stops chronologically per person", () => {
    const points = [
      pt({ personIds: ["I1"], kind: "death", tag: "DEAT", year: 1950, coord: TRST }),
      pt({ personIds: ["I1"], kind: "birth", tag: "BIRT", year: 1880, coord: KRANJ }),
      pt({ personIds: ["I1"], year: 1920, coord: LJUBLJANA }),
    ];
    const paths = buildPersonPaths(points);
    expect(paths).toHaveLength(1);
    expect(paths[0].personId).toBe("I1");
    expect(paths[0].stops.map((s) => s.year)).toEqual([1880, 1920, 1950]);
  });

  it("breaks same-year ties by life stage: birth, middle events, death, burial", () => {
    const points = [
      pt({ personIds: ["I1"], kind: "burial", tag: "BURI", year: 1900, coord: TRST }),
      pt({ personIds: ["I1"], kind: "death", tag: "DEAT", year: 1900, coord: LJUBLJANA }),
      pt({ personIds: ["I1"], kind: "birth", tag: "BIRT", year: 1900, coord: KRANJ }),
    ];
    const [path] = buildPersonPaths(points);
    expect(path.stops.map((s) => s.kind)).toEqual(["birth", "death", "burial"]);
  });

  it("anchors undated births at the start and undated deaths at the end", () => {
    const points = [
      pt({ personIds: ["I1"], year: 1920, coord: LJUBLJANA }),
      pt({ personIds: ["I1"], kind: "birth", tag: "BIRT", coord: KRANJ }),
      pt({ personIds: ["I1"], kind: "death", tag: "DEAT", coord: TRST }),
    ];
    const [path] = buildPersonPaths(points);
    expect(path.stops.map((s) => s.kind)).toEqual(["birth", "residence", "death"]);
  });

  it("drops undated mid-life events that can't be placed in time", () => {
    const points = [
      pt({ personIds: ["I1"], kind: "birth", tag: "BIRT", year: 1880, coord: KRANJ }),
      pt({ personIds: ["I1"], coord: TRST }),
      pt({ personIds: ["I1"], kind: "death", tag: "DEAT", year: 1950, coord: LJUBLJANA }),
    ];
    const [path] = buildPersonPaths(points);
    expect(path.stops.map((s) => s.coord)).toEqual([KRANJ, LJUBLJANA]);
  });

  it("merges consecutive stops at the same coordinate", () => {
    const points = [
      pt({ personIds: ["I1"], kind: "birth", tag: "BIRT", year: 1880, coord: KRANJ }),
      pt({ personIds: ["I1"], kind: "marriage", tag: "MARR", year: 1905, coord: KRANJ }),
      pt({ personIds: ["I1"], kind: "death", tag: "DEAT", year: 1950, coord: LJUBLJANA }),
    ];
    const [path] = buildPersonPaths(points);
    expect(path.stops).toHaveLength(2);
    expect(path.stops[0].kind).toBe("birth");
  });

  it("omits persons who never move (single distinct coordinate)", () => {
    const points = [
      pt({ personIds: ["I1"], kind: "birth", tag: "BIRT", year: 1880, coord: KRANJ }),
      pt({ personIds: ["I1"], kind: "death", tag: "DEAT", year: 1950, coord: KRANJ }),
      pt({ personIds: ["I2"], kind: "birth", tag: "BIRT", year: 1900, coord: TRST }),
    ];
    expect(buildPersonPaths(points)).toHaveLength(0);
  });

  it("gives a family event to both spouses' paths", () => {
    const points = [
      pt({ personIds: ["I1"], kind: "birth", tag: "BIRT", year: 1880, coord: KRANJ }),
      pt({ personIds: ["I2"], kind: "birth", tag: "BIRT", year: 1885, coord: TRST }),
      pt({ personIds: ["I1", "I2"], kind: "marriage", tag: "MARR", year: 1905, coord: LJUBLJANA, familyId: "F1" }),
    ];
    const paths = buildPersonPaths(points);
    expect(paths.map((p) => p.personId).sort()).toEqual(["I1", "I2"]);
    for (const path of paths) expect(path.stops[1].coord).toEqual(LJUBLJANA);
  });
});

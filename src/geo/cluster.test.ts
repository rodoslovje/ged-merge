import { describe, expect, it } from "vitest";
import { clusterPoints, latToWorldY, lonToWorldX } from "./cluster";
import type { MapPoint } from "./points";

const at = (lat: number, lon: number): MapPoint => ({ coord: { lat, lon } }) as MapPoint;

describe("Web Mercator world-pixel projection", () => {
  it("maps the origin and the date line to the known pixel columns", () => {
    // Zoom 0 is one 256px tile: lon −180 → 0, 0 → 128, +180 → 256.
    expect(lonToWorldX(-180, 0)).toBe(0);
    expect(lonToWorldX(0, 0)).toBe(128);
    expect(lonToWorldX(180, 0)).toBe(256);
    expect(latToWorldY(0, 0)).toBeCloseTo(128, 6);
    // Each zoom step doubles the world.
    expect(lonToWorldX(0, 3)).toBe(128 * 8);
  });

  it("clamps latitude at the Mercator singularity", () => {
    expect(latToWorldY(89.9, 0)).toBe(latToWorldY(85.0511, 0));
    expect(latToWorldY(-89.9, 0)).toBe(latToWorldY(-85.0511, 0));
    expect(Number.isFinite(latToWorldY(90, 5))).toBe(true);
  });
});

describe("clusterPoints", () => {
  it("merges neighbours at low zoom and splits them when zoomed in", () => {
    // Kranj and Ljubljana, ~25 km apart: one cluster on a world view, two
    // separate markers at a city zoom.
    const points = [at(46.2389, 14.3556), at(46.0511, 14.5051)];
    const world = clusterPoints(points, 1);
    expect(world).toHaveLength(1);
    expect(world[0].points).toHaveLength(2);
    // The cluster sits at the members' mean position.
    expect(world[0].lat).toBeCloseTo((46.2389 + 46.0511) / 2, 6);
    expect(clusterPoints(points, 12)).toHaveLength(2);
  });

  it("keeps far-apart points separate at any zoom, and handles no points", () => {
    expect(clusterPoints([at(46.05, 14.51), at(41.05, -79.58)], 0)).toHaveLength(2);
    expect(clusterPoints([], 5)).toEqual([]);
  });
});

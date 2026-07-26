import { describe, expect, it } from "vitest";
import { wgs84ToD96 } from "../../geo/d96";
import {
  canReproject,
  imageTransform,
  planTile,
  pyramidTiles,
  type NativePyramid,
  type TileCorners,
} from "./tilePlan";

const SIZE = { x: 256, y: 256 };
/** GURS's published extent + coarsest usable scale for the TTN layer. */
const TTN = { nativeBounds: [373627, 28484, 625632, 193784] as const, maxScaleDenominator: 11000 };

/** WGS84 corner of a slippy tile, in the standard Web Mercator tiling. */
function tileCornerLatLon(z: number, x: number, y: number): { lat: number; lon: number } {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lat, lon };
}

/** The four corners of tile z/x/y projected into D96/TM, as the layer does. */
function cornersOf(z: number, x: number, y: number): TileCorners {
  const at = (dx: number, dy: number) => {
    const { lat, lon } = tileCornerLatLon(z, x + dx, y + dy);
    const p = wgs84ToD96(lat, lon)!;
    return { x: p.easting, y: p.northing };
  };
  return { nw: at(0, 0), ne: at(1, 0), sw: at(0, 1), se: at(1, 1) };
}

/** The tile containing a lat/lon at the given zoom. */
function tileAt(z: number, lat: number, lon: number): { x: number; y: number } {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
  };
}

/** Apply a canvas transform to an image pixel. */
function apply(t: readonly number[], u: number, v: number): { x: number; y: number } {
  return { x: t[0] * u + t[2] * v + t[4], y: t[1] * u + t[3] * v + t[5] };
}

// Ljubljana, on a tile well inside the coverage.
const LAT = 46.0569;
const LON = 14.5058;

describe("planTile", () => {
  it("paints the requested image back onto the tile it was requested for", () => {
    const z = 17;
    const { x, y } = tileAt(z, LAT, LON);
    const corners = cornersOf(z, x, y);
    const plan = planTile(corners, SIZE, TTN)!;
    expect(plan).toBeDefined();

    // Every tile corner must land back on its own pixel: take the corner's
    // native coordinates, find the pixel of the fetched image that carries
    // them, push it through the transform, and it should be the tile corner.
    const [minX, minY, maxX, maxY] = plan.bbox;
    const expected: [keyof TileCorners, number, number][] = [
      ["nw", 0, 0],
      ["ne", SIZE.x, 0],
      ["sw", 0, SIZE.y],
      ["se", SIZE.x, SIZE.y],
    ];
    for (const [corner, px, py] of expected) {
      const p = corners[corner];
      const u = ((p.x - minX) / (maxX - minX)) * plan.width;
      const v = ((maxY - p.y) / (maxY - minY)) * plan.height;
      const got = apply(plan.transform, u, v);
      // The fourth corner carries the affine fit's residual — the whole
      // accuracy claim of the layer is that it stays far below a pixel.
      expect(got.x).toBeCloseTo(px, 1);
      expect(got.y).toBeCloseTo(py, 1);
    }
  });

  it("keeps the affine residual on the unfitted corner under a tenth of a pixel", () => {
    // Nova Gorica: the western edge of the country, where the two grids'
    // meridian convergence — and so the tile's rotation — is largest.
    const z = 16;
    const { x, y } = tileAt(z, 45.955, 13.648);
    const c = cornersOf(z, x, y);
    const plan = planTile(c, SIZE, TTN)!;
    const [minX, minY, maxX, maxY] = plan.bbox;
    const u = ((c.se.x - minX) / (maxX - minX)) * plan.width;
    const v = ((maxY - c.se.y) / (maxY - minY)) * plan.height;
    const got = apply(plan.transform, u, v);
    expect(Math.hypot(got.x - SIZE.x, got.y - SIZE.y)).toBeLessThan(0.1);
  });

  it("requests a bbox that covers the tile with a small overdraw", () => {
    const z = 17;
    const { x, y } = tileAt(z, LAT, LON);
    const c = cornersOf(z, x, y);
    const plan = planTile(c, SIZE, TTN)!;
    const [minX, minY, maxX, maxY] = plan.bbox;
    for (const p of [c.nw, c.ne, c.sw, c.se]) {
      expect(p.x).toBeGreaterThan(minX);
      expect(p.x).toBeLessThan(maxX);
      expect(p.y).toBeGreaterThan(minY);
      expect(p.y).toBeLessThan(maxY);
    }
    // …but only just: the padded box stays within a few pixels of the tile.
    expect(maxX - minX).toBeLessThan(((maxX - minX) / plan.width) * (SIZE.x + 12));
  });

  it("asks for a bigger image when the tile would exceed the source's scale range", () => {
    // Zoom 15 lands at ~1:11 900, just past the layer's 1:11 000 limit, where
    // the service returns a blank image — the plan has to oversample.
    const z = 15;
    const { x, y } = tileAt(z, LAT, LON);
    const plan = planTile(cornersOf(z, x, y), SIZE, TTN)!;
    expect(plan).toBeDefined();
    expect(plan.width).toBeGreaterThan(SIZE.x);
    const denom = (plan.bbox[2] - plan.bbox[0]) / plan.width / 0.00028;
    expect(denom).toBeLessThan(TTN.maxScaleDenominator);
  });

  it("leaves the tile blank rather than oversampling without limit", () => {
    // Zoom 14 would need >2× the tile's pixels to get under the limit.
    const z = 14;
    const { x, y } = tileAt(z, LAT, LON);
    expect(planTile(cornersOf(z, x, y), SIZE, TTN)).toBeUndefined();
  });

  it("requests at native size when the tile is already inside the range", () => {
    const z = 17;
    const { x, y } = tileAt(z, LAT, LON);
    const plan = planTile(cornersOf(z, x, y), SIZE, TTN)!;
    // Tile size plus the edge padding, and no oversampling on top.
    expect(plan.width).toBeGreaterThanOrEqual(SIZE.x);
    expect(plan.width).toBeLessThanOrEqual(SIZE.x + 6);
  });

  it("skips tiles outside the layer's coverage", () => {
    const z = 16;
    const vienna = tileAt(z, 48.208, 16.373);
    expect(planTile(cornersOf(z, vienna.x, vienna.y), SIZE, TTN)).toBeUndefined();
    // Without a declared extent nothing is clipped.
    expect(planTile(cornersOf(z, vienna.x, vienna.y), SIZE, {})).toBeDefined();
  });

  it("refuses a tile too large for one affine fit", () => {
    // Zoom 6 over central Europe: a tile spanning several hundred kilometres,
    // where a single affine approximation no longer holds.
    const z = 6;
    const { x, y } = tileAt(z, LAT, LON);
    expect(planTile(cornersOf(z, x, y), SIZE, {})).toBeUndefined();
  });

  it("refuses degenerate footprints instead of dividing by zero", () => {
    const p = { x: 460000, y: 100000 };
    expect(planTile({ nw: p, ne: p, sw: p, se: p }, SIZE, {})).toBeUndefined();
    const nan = { x: Number.NaN, y: 100000 };
    expect(planTile({ nw: nan, ne: p, sw: p, se: p }, SIZE, {})).toBeUndefined();
  });
});

describe("pyramidTiles", () => {
  // GURS's Osnovna karta cache, as published in its WMTS capabilities.
  const OSK: NativePyramid = {
    layer: "SI.GURS.DK:OSK",
    tileMatrixSet: "EPSG:3794_ATL_OSK",
    scaleDenominators: [
      2500000, 1500000, 1000000, 750000, 500000, 350000, 250000, 175000, 100000, 50000, 40000, 25000, 10000, 5000, 2500,
    ],
    origin: [293225, 249475],
    tileSize: 256,
  };
  /** Native resolution (units/px) of a pyramid level. */
  const levelRes = (i: number) => OSK.scaleDenominators[i] * 0.00028;

  it("picks the level that is detailed enough without overshooting", () => {
    // Exactly a level's own resolution takes that level, not the one below.
    expect(pyramidTiles([462000, 101000, 462100, 101100], OSK, levelRes(13))[0].level).toBe("EPSG:3794_ATL_OSK:13");
    // Between two levels, take the finer one and downsample into the tile.
    const between = (levelRes(13) + levelRes(14)) / 2;
    expect(pyramidTiles([462000, 101000, 462100, 101100], OSK, between)[0].level).toBe("EPSG:3794_ATL_OSK:14");
  });

  it("clamps at the deepest level instead of running out", () => {
    // Zoomed past 1:2500 the source has nothing finer — magnify level 14.
    const tiles = pyramidTiles([462000, 101000, 462050, 101050], OSK, levelRes(14) / 8);
    expect(tiles[0].level).toBe("EPSG:3794_ATL_OSK:14");
  });

  it("covers the whole bbox with correctly placed tiles", () => {
    const bbox: [number, number, number, number] = [462000, 101000, 462400, 101400];
    const tiles = pyramidTiles(bbox, OSK, levelRes(14));
    expect(tiles.length).toBeGreaterThan(1);
    // The tiles' union must contain the bbox…
    expect(Math.min(...tiles.map((t) => t.bbox[0]))).toBeLessThanOrEqual(bbox[0]);
    expect(Math.min(...tiles.map((t) => t.bbox[1]))).toBeLessThanOrEqual(bbox[1]);
    expect(Math.max(...tiles.map((t) => t.bbox[2]))).toBeGreaterThanOrEqual(bbox[2]);
    expect(Math.max(...tiles.map((t) => t.bbox[3]))).toBeGreaterThanOrEqual(bbox[3]);
    // …and each tile's extent must match what its row/col addresses, or the
    // imagery would be painted in the wrong place.
    const span = OSK.tileSize * levelRes(14);
    for (const t of tiles) {
      expect(t.bbox[0]).toBeCloseTo(OSK.origin[0] + t.col * span, 6);
      expect(t.bbox[3]).toBeCloseTo(OSK.origin[1] - t.row * span, 6);
      expect(t.bbox[2] - t.bbox[0]).toBeCloseTo(span, 6);
      expect(t.bbox[3] - t.bbox[1]).toBeCloseTo(span, 6);
    }
  });

  it("asks for a handful of tiles, not a wall of them", () => {
    // A tile-sized footprint at a matched level is 1–4 source tiles.
    const span = OSK.tileSize * levelRes(14);
    const tiles = pyramidTiles([462000, 101000, 462000 + span, 101000 + span], OSK, levelRes(14));
    expect(tiles.length).toBeLessThanOrEqual(4);
  });

  it("places each pyramid tile's imagery where the grid says it belongs", () => {
    // The end-to-end check for the cached-pyramid path: compose a real output
    // tile's plan with each source tile's own extent, and every source pixel
    // must land where projecting its native coordinate directly would put it.
    const z = 17;
    const { x, y } = tileAt(z, LAT, LON);
    const plan = planTile(cornersOf(z, x, y), SIZE, { nativeBounds: TTN.nativeBounds })!;
    const tiles = pyramidTiles(plan.bbox, OSK, plan.resolution);
    expect(tiles.length).toBeGreaterThan(0);

    for (const tile of tiles) {
      const t = imageTransform(plan.nativeToTile, tile.bbox, OSK.tileSize, OSK.tileSize);
      const [a, b, c, d, tx, ty] = plan.nativeToTile;
      // Corners and centre of this source image, in its own pixel space.
      for (const [u, v] of [
        [0, 0],
        [OSK.tileSize, 0],
        [0, OSK.tileSize],
        [OSK.tileSize / 2, OSK.tileSize / 2],
      ]) {
        const got = apply(t, u, v);
        // The same pixel's native coordinate, projected straight to tile pixels.
        const nx = tile.bbox[0] + (u / OSK.tileSize) * (tile.bbox[2] - tile.bbox[0]);
        const ny = tile.bbox[3] - (v / OSK.tileSize) * (tile.bbox[3] - tile.bbox[1]);
        expect(got.x).toBeCloseTo(a * nx + b * ny + tx, 6);
        expect(got.y).toBeCloseTo(c * nx + d * ny + ty, 6);
      }
    }
  });

  it("refuses a footprint that would need an unreasonable number of tiles", () => {
    // A whole-country bbox at the deepest level: bail out rather than fire
    // thousands of requests.
    expect(pyramidTiles([373627, 28484, 625632, 193784], OSK, levelRes(14))).toEqual([]);
  });
});

describe("canReproject", () => {
  it("accepts the Slovenian grid and nothing else", () => {
    expect(canReproject("EPSG:3794")).toBe(true);
    expect(canReproject("EPSG:3857")).toBe(false);
    expect(canReproject(undefined)).toBe(false);
  });
});

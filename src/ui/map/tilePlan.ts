import { wgs84ToD96 } from "../../geo/d96";

// The geometry behind reprojectedWmsLayer: given a Web Mercator tile whose
// corners have been projected into a service's own grid, work out which image
// to ask that service for and how to paint it back onto the tile. Kept free of
// Leaflet (and of the DOM) so the arithmetic can be tested on its own.

/** OGC's standard pixel is 0.28 mm: a WMS derives the scale denominator of a
 *  request from its bbox, its image size and this constant. */
const OGC_PIXEL_M = 0.00028;

/** How much larger than the tile the request may get in order to drop under a
 *  layer's coarsest published scale (see `maxScaleDenominator`). 2× covers one
 *  zoom level of headroom; past that the source is far too detailed to read
 *  anyway, so the tile is left blank instead of hammering the service. */
const OVERSAMPLE_MAX = 2;

/** Ask for a hair finer than the published limit — a request that lands exactly
 *  on the boundary renders empty. */
const SCALE_MARGIN = 1.02;

/** Upper bound on a single GetMap image, so an oversampled large tile can't ask
 *  the service for something enormous. */
const MAX_REQUEST_PX = 2048;

/** Overdraw one tile-pixel of extra ground on every side: neighbouring tiles
 *  then overlap slightly, hiding the resampling seams that otherwise show as
 *  hairlines between canvases. */
const EDGE_PAD_PX = 1;

/** A tile wider than this (in native units) is left blank. One affine fit only
 *  holds over a limited span, and a national grid is meaningless a continent
 *  away — this keeps a zoomed-right-out map from asking for absurd extents. */
const MAX_TILE_SPAN = 300000;

/** Sanity cap on the source tiles composed into one output tile (a matched
 *  level normally needs 4, at most 9). */
const MAX_SOURCE_TILES = 25;

/** WGS84 → native grid, per supported CRS. Only the Slovenian grid is wired up;
 *  another national layer is one entry plus its projection in `src/geo`. */
const PROJECTORS: Record<string, (lat: number, lon: number) => { x: number; y: number } | undefined> = {
  "EPSG:3794": (lat, lon) => {
    const p = wgs84ToD96(lat, lon);
    return p && { x: p.easting, y: p.northing };
  },
};

/** True when a layer in this CRS can be reprojected in the browser — the Map
 *  chart falls back to a plain WMS layer when it can't. */
export function canReproject(crs: string | undefined): boolean {
  return !!crs && crs in PROJECTORS;
}

/** The WGS84 → native projection for a CRS, if one is bundled. */
export function nativeProjector(crs: string): ((lat: number, lon: number) => NativePoint | undefined) | undefined {
  return PROJECTORS[crs];
}

/** A pre-cut tile pyramid in the native grid — a WMTS tile-matrix set. Some
 *  layers are published only this way (a tile cache, no free-form GetMap), and
 *  a pyramid is the better source anyway: the tiles are already rendered and
 *  cached, and its levels span every scale in one layer. */
export interface NativePyramid {
  /** WMTS `LAYER`. */
  layer: string;
  /** WMTS `TILEMATRIXSET`. Level ids are `${tileMatrixSet}:${index}`, which is
   *  how this service names them — index into {@link scaleDenominators}. */
  tileMatrixSet: string;
  /** Each level's scale denominator, coarsest first. */
  scaleDenominators: number[];
  /** The grid's top-left corner in native units, `[x, y]`. */
  origin: [number, number];
  /** Tile edge in pixels (square). */
  tileSize: number;
  /** Image format to request (default `image/png`). */
  format?: string;
}

/** One source tile to fetch and where it sits in the native grid. */
export interface PyramidTile {
  level: string;
  col: number;
  row: number;
  bbox: [number, number, number, number];
}

/**
 * The pyramid tiles covering a native bbox, at the level closest to (and no
 * coarser than) the resolution asked for — so imagery is downsampled into the
 * map rather than blown up. Past the pyramid's deepest level it clamps there
 * and the tiles are magnified, which is what the source's own viewer does.
 */
export function pyramidTiles(
  bbox: readonly [number, number, number, number],
  grid: NativePyramid,
  targetRes: number,
): PyramidTile[] {
  const [minX, minY, maxX, maxY] = bbox;
  let index = grid.scaleDenominators.findIndex((sd) => sd * OGC_PIXEL_M <= targetRes);
  if (index < 0) index = grid.scaleDenominators.length - 1;
  const res = grid.scaleDenominators[index] * OGC_PIXEL_M;
  if (!(res > 0)) return [];
  const span = grid.tileSize * res;
  const [ox, oy] = grid.origin;

  const colFrom = Math.floor((minX - ox) / span);
  const colTo = Math.floor((maxX - ox) / span);
  // Rows run south from the grid's top-left corner.
  const rowFrom = Math.floor((oy - maxY) / span);
  const rowTo = Math.floor((oy - minY) / span);
  if (!Number.isFinite(colFrom) || !Number.isFinite(rowFrom)) return [];

  const out: PyramidTile[] = [];
  for (let col = colFrom; col <= colTo; col++) {
    for (let row = rowFrom; row <= rowTo; row++) {
      if (col < 0 || row < 0) continue;
      const x0 = ox + col * span;
      const y1 = oy - row * span;
      out.push({
        level: `${grid.tileMatrixSet}:${index}`,
        col,
        row,
        bbox: [x0, y1 - span, x0 + span, y1],
      });
      // A single output tile should never need a wall of source tiles; if the
      // arithmetic ever says so, something is wrong upstream — bail out rather
      // than firing hundreds of requests.
      if (out.length > MAX_SOURCE_TILES) return [];
    }
  }
  return out;
}

/** A point in the native grid. */
export interface NativePoint {
  x: number;
  y: number;
}

/** The tile's four corners in the native grid, in tile-pixel order. */
export interface TileCorners {
  nw: NativePoint;
  ne: NativePoint;
  sw: NativePoint;
  se: NativePoint;
}

/** What one tile needs: the image to fetch and how to paint it. */
export interface TilePlan {
  /** GetMap bbox in native units, `[minX, minY, maxX, maxY]`. */
  bbox: [number, number, number, number];
  width: number;
  height: number;
  /** Native resolution the output tile wants, in units per pixel — what a
   *  pyramid level is matched against. */
  resolution: number;
  /** Canvas transform mapping the fetched image's pixels onto the tile. */
  transform: [number, number, number, number, number, number];
  /** The affine taking native coordinates to tile pixels, `[a, b, c, d, tx,
   *  ty]` — compose it with any source image's own extent via
   *  {@link imageTransform}. */
  nativeToTile: [number, number, number, number, number, number];
}

/**
 * The canvas transform that paints one source image onto the tile: the
 * native→tile affine composed with that image's own extent. Lets a tile be
 * assembled from several source images (pyramid tiles) as easily as from one.
 */
export function imageTransform(
  nativeToTile: readonly [number, number, number, number, number, number],
  bbox: readonly [number, number, number, number],
  width: number,
  height: number,
): [number, number, number, number, number, number] {
  const [a, b, c, d, tx, ty] = nativeToTile;
  const [minX, minY, maxX, maxY] = bbox;
  // Image pixel → native (rows run north to south), then native → tile.
  const sx = (maxX - minX) / width;
  const sy = (maxY - minY) / height;
  return [a * sx, c * sx, -b * sy, -d * sy, a * minX + b * maxY + tx, c * minX + d * maxY + ty];
}

/**
 * Work out the request that covers a tile and the transform that paints it —
 * the whole geometry of the layer, kept pure so it can be tested without a map.
 *
 * Returns undefined when the tile should stay blank: outside the coverage, or
 * so coarse that even the largest allowed request would exceed the source's
 * published scale range.
 */
export function planTile(
  corners: TileCorners,
  size: { x: number; y: number },
  opts: {
    nativeBounds?: readonly [number, number, number, number];
    maxScaleDenominator?: number;
  } = {},
): TilePlan | undefined {
  const { nw, ne, sw, se } = corners;
  if (![nw, ne, sw, se].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return undefined;

  // The tile is a rotated quadrilateral in the native grid (the two grids'
  // meridian convergence differs); request its bounding box.
  let minX = Math.min(nw.x, ne.x, sw.x, se.x);
  let maxX = Math.max(nw.x, ne.x, sw.x, se.x);
  let minY = Math.min(nw.y, ne.y, sw.y, se.y);
  let maxY = Math.max(nw.y, ne.y, sw.y, se.y);

  const b = opts.nativeBounds;
  if (b && (maxX < b[0] || minX > b[2] || maxY < b[1] || minY > b[3])) return undefined;
  if (maxX - minX > MAX_TILE_SPAN || maxY - minY > MAX_TILE_SPAN) return undefined;

  // Native units per tile pixel, before any oversampling.
  let res = Math.max((maxX - minX) / size.x, (maxY - minY) / size.y);
  if (!(res > 0)) return undefined;

  const pad = res * EDGE_PAD_PX;
  minX -= pad;
  maxX += pad;
  minY -= pad;
  maxY += pad;

  // Stay inside the source's published scale range: asking for more pixels over
  // the same ground lowers the denominator the server computes.
  if (opts.maxScaleDenominator) {
    const denom = res / OGC_PIXEL_M;
    if (denom > opts.maxScaleDenominator) {
      const oversample = (denom / opts.maxScaleDenominator) * SCALE_MARGIN;
      if (oversample > OVERSAMPLE_MAX) return undefined;
      res /= oversample;
    }
  }

  const width = Math.min(MAX_REQUEST_PX, Math.max(1, Math.round((maxX - minX) / res)));
  const height = Math.min(MAX_REQUEST_PX, Math.max(1, Math.round((maxY - minY) / res)));

  // Affine fit from native coordinates to tile pixels, exact on the top-left,
  // top-right and bottom-left corners. Across one tile the residual on the
  // fourth corner is far below a pixel.
  const de1 = ne.x - nw.x;
  const dn1 = ne.y - nw.y;
  const de2 = sw.x - nw.x;
  const dn2 = sw.y - nw.y;
  const det = de1 * dn2 - de2 * dn1;
  if (!det) return undefined;
  const a = (size.x * dn2) / det;
  const bb = (-size.x * de2) / det;
  const c = (-size.y * dn1) / det;
  const d = (size.y * de1) / det;
  const tx = -(a * nw.x + bb * nw.y);
  const ty = -(c * nw.x + d * nw.y);

  const nativeToTile: [number, number, number, number, number, number] = [a, bb, c, d, tx, ty];
  const bbox: [number, number, number, number] = [minX, minY, maxX, maxY];
  return {
    bbox,
    width,
    height,
    resolution: res,
    nativeToTile,
    transform: imageTransform(nativeToTile, bbox, width, height),
  };
}

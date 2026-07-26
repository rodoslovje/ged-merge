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

/** One zoom band of a multi-scale overlay: which WMS layer to draw from the
 *  given zoom inwards. Lets a single overlay follow the map's scale the way a
 *  paper atlas changes sheet — e.g. a 1:50 000 map when zoomed out and a
 *  1:5000 plan once close enough for it to be legible. */
export interface ZoomBand {
  /** Lowest zoom this band covers; the deepest matching band wins. */
  minZoom: number;
  /** Comma-separated WMS layer name(s) for this band. */
  layers: string;
  /** The band's coarsest usable scale, if its source publishes one. */
  maxScaleDenominator?: number;
}

/** The band to draw at a zoom — the deepest one the view has reached — or
 *  undefined when no band covers it (the tile stays blank). */
export function pickZoomBand(bands: readonly ZoomBand[] | undefined, zoom: number): ZoomBand | undefined {
  let best: ZoomBand | undefined;
  for (const band of bands ?? []) {
    if (band.minZoom <= zoom && (!best || band.minZoom > best.minZoom)) best = band;
  }
  return best;
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
  /** Canvas transform mapping the fetched image's pixels onto the tile. */
  transform: [number, number, number, number, number, number];
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

  // …composed with image pixel → native (the image spans the padded bbox, with
  // its rows running north to south).
  const sx = (maxX - minX) / width;
  const sy = (maxY - minY) / height;
  return {
    bbox: [minX, minY, maxX, maxY],
    width,
    height,
    transform: [
      a * sx,
      c * sx,
      -bb * sy,
      -d * sy,
      a * minX + bb * maxY + tx,
      c * minX + d * maxY + ty,
    ],
  };
}

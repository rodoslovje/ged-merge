import L from "leaflet";
import {
  imageTransform,
  nativeProjector,
  planTile,
  pyramidTiles,
  type NativePyramid,
} from "./tilePlan";

/** One source image composed into an output tile. */
interface TileSource {
  url: string;
  transform: [number, number, number, number, number, number];
}

// A WMS overlay for layers the server will only draw in its own national grid.
//
// Leaflet's `L.tileLayer.wms` asks for tiles in the map's CRS (Web Mercator).
// That works for most services, but some publish a coverage they cannot
// reproject — GURS's Temeljni topografski načrt 1:5000 is the case this was
// written for: it advertises only EPSG:3794 (D96/TM), and an EPSG:3857 GetMap
// comes back an empty tile while the identical request in D96 draws fine.
//
// So this layer does the reprojection client-side. For each Web Mercator tile
// it projects the tile's four corners into the native grid, requests that
// footprint from the server in the native CRS, and paints the returned image
// into a canvas tile through an affine transform. Over one tile the difference
// between the true projection and an affine fit is far below a pixel (the
// Mercator scale factor changes by ~1e-4 across a zoom-16 tile), so the result
// is indistinguishable from a server-side warp — what it does cost is one
// canvas per tile instead of a plain <img>.

export interface ReprojectedWmsOptions extends L.GridLayerOptions {
  /** Comma-separated WMS layer name(s), for a free-form GetMap source.
   *  Ignored when {@link pyramid} is set. */
  layers: string;
  /** Take the imagery from a pre-cut WMTS pyramid instead of GetMap — for
   *  layers published only through a tile cache. */
  pyramid?: NativePyramid;
  /** Comma-separated `STYLES`, aligned 1:1 with {@link layers}. */
  styles?: string;
  /** The CRS to request in — one {@link nativeProjector} knows. */
  nativeCrs: string;
  /** Extra GetMap params (e.g. `TIME`), already parsed out of the raw string. */
  extraParams?: Record<string, string>;
  /** The layer's own extent in native units, `[minX, minY, maxX, maxY]`. Tiles
   *  that miss it are skipped rather than requested. */
  nativeBounds?: readonly [number, number, number, number];
  /** The layer's coarsest usable scale (its WMS `MaxScaleDenominator`).
   *  Requests above it return blank, so the layer oversamples to get under. */
  maxScaleDenominator?: number;
  /** Required by Layer's typings for the attribution control. */
  attribution?: string;
}

const ReprojectedWmsLayer = L.GridLayer.extend({
  initialize(this: L.GridLayer, url: string, options: ReprojectedWmsOptions) {
    (this as unknown as { _wmsUrl: string })._wmsUrl = url;
    L.Util.setOptions(this, options);
  },

  createTile(this: L.GridLayer, coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const size = this.getTileSize();
    const canvas = document.createElement("canvas");
    canvas.width = size.x;
    canvas.height = size.y;

    const sources = (this as unknown as { _planTile(c: L.Coords, s: L.Point): TileSource[] })._planTile(coords, size);
    if (!sources.length) {
      // Outside the coverage, or too coarse for the source to draw: an empty
      // tile, reported ready so Leaflet stops waiting on it.
      L.Util.requestAnimFrame(() => done(undefined, canvas));
      return canvas;
    }

    // One output tile may be assembled from several cached source tiles; it is
    // ready once they all are, and a single failure only costs its own patch.
    let pending = sources.length;
    let failed = false;
    const finish = () => {
      if (--pending > 0) return;
      done(failed && !canvas.dataset.drawn ? new Error("tile request failed") : undefined, canvas);
    };
    for (const source of sources) {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(...source.transform);
          try {
            ctx.drawImage(img, 0, 0);
            canvas.dataset.drawn = "1";
          } catch {
            // A decode failure leaves this patch blank rather than breaking the map.
          }
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        finish();
      };
      img.onerror = () => {
        failed = true;
        finish();
      };
      img.src = source.url;
    }
    return canvas;
  },

  /** Project the tile's footprint into the native grid and work out the source
   *  images that cover it — empty when the tile should stay blank. */
  _planTile(this: L.GridLayer, coords: L.Coords, size: L.Point): TileSource[] {
    const map = this._map;
    const opts = this.options as ReprojectedWmsOptions;
    const project = nativeProjector(opts.nativeCrs);
    if (!map || !project) return [];

    // Tile corners: Web Mercator pixel space → WGS84 → the native grid.
    const corner = (dx: number, dy: number) => {
      const pt = L.point((coords.x + dx) * size.x, (coords.y + dy) * size.y);
      const ll = map.unproject(pt, coords.z);
      return project(ll.lat, ll.lng);
    };
    const nw = corner(0, 0);
    const ne = corner(1, 0);
    const sw = corner(0, 1);
    const se = corner(1, 1);
    if (!nw || !ne || !sw || !se) return [];

    const plan = planTile({ nw, ne, sw, se }, size, opts);
    if (!plan) return [];
    const base = (this as unknown as { _wmsUrl: string })._wmsUrl;
    const join = (params: Record<string, string>) =>
      `${base}${base.includes("?") ? "&" : "?"}${new URLSearchParams(params)}`;

    // A pre-cut pyramid: fetch the cached tiles covering the footprint, each
    // painted through its own extent.
    if (opts.pyramid) {
      const grid = opts.pyramid;
      return pyramidTiles(plan.bbox, grid, plan.resolution).map((tile) => ({
        url: join({
          ...opts.extraParams,
          SERVICE: "WMTS",
          VERSION: "1.0.0",
          REQUEST: "GetTile",
          LAYER: grid.layer,
          STYLE: opts.styles ?? "",
          TILEMATRIXSET: grid.tileMatrixSet,
          TILEMATRIX: tile.level,
          TILEROW: String(tile.row),
          TILECOL: String(tile.col),
          FORMAT: grid.format ?? "image/png",
        }),
        transform: imageTransform(plan.nativeToTile, tile.bbox, grid.tileSize, grid.tileSize),
      }));
    }

    return [
      {
        url: join({
          // Extra params first so the fixed ones below can't be overridden.
          ...opts.extraParams,
          SERVICE: "WMS",
          // 1.1.1 on purpose: its BBOX is always x,y, sidestepping the axis-order
          // ambiguity 1.3.0 introduced for projected CRSs like this one.
          VERSION: "1.1.1",
          REQUEST: "GetMap",
          LAYERS: opts.layers,
          STYLES: opts.styles ?? "",
          SRS: opts.nativeCrs,
          BBOX: plan.bbox.join(","),
          WIDTH: String(plan.width),
          HEIGHT: String(plan.height),
          FORMAT: "image/png",
          TRANSPARENT: "true",
        }),
        transform: plan.transform,
      },
    ];
  },
});

/** Create a WMS overlay that is fetched in `nativeCrs` and warped into the
 *  map's Web Mercator tiles. */
export function reprojectedWmsLayer(url: string, options: ReprojectedWmsOptions): L.GridLayer {
  return new (ReprojectedWmsLayer as unknown as new (u: string, o: ReprojectedWmsOptions) => L.GridLayer)(url, options);
}

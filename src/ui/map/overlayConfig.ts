import type { MapOverlay } from "../SettingsContext";

// How an overlay definition turns into a tile request — the parts that are
// plain data. Kept free of Leaflet (and of the DOM) so they can be tested on
// their own; the layer construction itself lives in overlayLayer.ts.

/** Historical overlays start at this opacity; the Map chart's slider adjusts. */
export const OVERLAY_DEFAULT_OPACITY = 0.7;

/** Leaflet z-index of the bottom-most overlay tile layer — above the base (1).
 *  Layers stack from here in list order (see {@link overlayZIndex}). */
export const OVERLAY_Z = 5;

/** Where an overlay sits in the stack: the list order is the stacking order,
 *  first listed on top — so a thin reference layer (house numbers, parcels)
 *  kept at the top of the list stays readable over a full-page historical
 *  scan below it, instead of the two fighting over an equal z-index. */
export function overlayZIndex(index: number, count: number): number {
  return OVERLAY_Z + Math.max(0, count - 1 - index);
}

/** Parse a WMS overlay's raw `KEY=value&KEY=value` extra-params string into an
 *  object Leaflet folds into the GetMap query (e.g. a time-enabled layer's
 *  `TIME`, or a `CQL_FILTER`). Malformed pairs are skipped. */
export function parseWmsParams(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim();
    if (key) out[key] = pair.slice(eq + 1).trim();
  }
  return out;
}

/** The overlay's tile-request identity: everything that decides what is
 *  fetched and how it is drawn (opacity excluded — that is adjusted in place).
 *  A changed signature means the live layer must be rebuilt; a rename or a
 *  flipped "show by default" must not touch it. */
export function overlaySignature(o: MapOverlay): string {
  return JSON.stringify([
    o.url,
    o.minZoom,
    o.maxZoom,
    o.attribution,
    !!o.wms,
    o.layers,
    o.styles,
    o.tileSize,
    o.params,
    o.nativeCrs,
    o.nativeBounds,
    o.maxScaleDenominator,
    o.pyramid,
  ]);
}

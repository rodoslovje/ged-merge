import L from "leaflet";
import type { MapOverlay } from "../SettingsContext";
import { OVERLAY_DEFAULT_OPACITY, OVERLAY_Z, overlaySignature, overlayZIndex, parseWmsParams } from "./overlayConfig";
import { reprojectedWmsLayer } from "./reprojectedWmsLayer";
import { canReproject } from "./tilePlan";

// Building a historical overlay's Leaflet layer, shared by every map that can
// draw one: the full Map chart (picker-driven) and the small place maps (which
// draw the layers flagged "show by default" in Settings). Keeping it here means
// one definition of how an XYZ / WMS / reprojected-WMS overlay is requested.

/** The Leaflet layer for one overlay definition, at `opacity` and `zIndex`. */
export function createOverlayLayer(o: MapOverlay, opacity: number, zIndex: number = OVERLAY_Z): L.GridLayer {
  if (o.wms && canReproject(o.nativeCrs)) {
    // A service that won't reproject this layer itself: fetch it in its own
    // CRS and warp each tile in the browser.
    return reprojectedWmsLayer(o.url, {
      layers: o.layers ?? "",
      styles: o.styles ?? "",
      nativeCrs: o.nativeCrs!,
      pyramid: o.pyramid,
      extraParams: parseWmsParams(o.params),
      nativeBounds: o.nativeBounds,
      maxScaleDenominator: o.maxScaleDenominator,
      opacity,
      attribution: o.attribution ?? "",
      minZoom: o.minZoom ?? 0,
      maxZoom: 18,
      tileSize: o.tileSize ?? 256,
      zIndex,
    });
  }
  if (o.wms) {
    return L.tileLayer.wms(o.url, {
      // Extra params first so the fixed ones below can't be overridden.
      ...parseWmsParams(o.params),
      layers: o.layers ?? "",
      styles: o.styles ?? "",
      format: "image/png",
      transparent: true,
      opacity,
      attribution: o.attribution ?? "",
      crossOrigin: "anonymous",
      minZoom: o.minZoom ?? 0,
      // WMS renders any bbox on demand, so it scales to any zoom itself.
      maxZoom: 18,
      // Label styles clip at tile seams — a large tile keeps them whole.
      tileSize: o.tileSize ?? 256,
      zIndex,
    });
  }
  return L.tileLayer(o.url, {
    opacity,
    attribution: o.attribution ?? "",
    crossOrigin: "anonymous",
    minZoom: o.minZoom ?? 0,
    maxZoom: 18,
    // Sources that stop at a lower zoom get their deepest tiles scaled.
    maxNativeZoom: o.maxZoom ?? 18,
    zIndex,
  });
}

/** Live overlay layers on one map, keyed by overlay id, each remembering the
 *  signature it was built from. Owned by the map component (a ref). */
export type LiveOverlays = Map<string, { layer: L.GridLayer; sig: string }>;

/** Bring `live` in line with the overlays that should be shown: drop layers
 *  that are off, gone or rebuilt-worthy, adjust opacity on the survivors, and
 *  add what is missing. `enabled` false (remote tiles not allowed) clears all. */
export function syncOverlayLayers(
  map: L.Map,
  live: LiveOverlays,
  overlays: readonly MapOverlay[],
  opts: {
    enabled: boolean;
    isOn: (o: MapOverlay) => boolean;
    opacityOf?: (o: MapOverlay) => number;
  },
): void {
  // The z-index comes from the layer's place in the configured list, not from
  // the order it happened to be switched on in.
  const wanted = new Map(
    (opts.enabled ? overlays : [])
      .map((o, i) => [o, overlayZIndex(i, overlays.length)] as const)
      .filter(([o]) => o.url && opts.isOn(o))
      .map(([o, z]) => [o.id, { o, z }] as const),
  );
  for (const [id, entry] of [...live]) {
    const want = wanted.get(id);
    if (!want || overlaySignature(want.o) !== entry.sig) {
      entry.layer.remove();
      live.delete(id);
    }
  }
  for (const [id, { o, z }] of wanted) {
    const opacity = opts.opacityOf?.(o) ?? OVERLAY_DEFAULT_OPACITY;
    const entry = live.get(id);
    if (entry) {
      entry.layer.setOpacity(opacity);
      // A layer added or removed in Settings shifts everyone else's place.
      entry.layer.setZIndex(z);
      continue;
    }
    const layer = createOverlayLayer(o, opacity, z);
    layer.addTo(map);
    live.set(id, { layer, sig: overlaySignature(o) });
  }
}

import L from "leaflet";
import worldOutline from "../../geo/world110m.json";
import { activeBasemap, basemapUrl } from "./basemapPresets";

// Shared Leaflet base layer, used by the full Map chart and the geocode
// mini map: opt-in provider tiles (requests reveal the viewed region), else
// the bundled offline world outline. Which provider is drawn comes from
// BASEMAPS in ./basemapPresets.

/** Build the base layer for the current settings/theme (not yet added to a
 *  map). SVG presentation attributes don't resolve var(), so the outline
 *  colours are read from the design tokens at call time — call again on
 *  theme change. */
export function createBaseLayer(
  allowTiles: boolean,
  basemap: string,
  customUrl: string | undefined,
  theme: "light" | "dark",
): L.Layer {
  if (allowTiles) {
    const preset = activeBasemap(basemap, customUrl);
    // No preset means the user's own tile URL: we know neither its shards nor
    // its terms, so Leaflet's defaults stand and no attribution is asserted.
    if (!preset)
      return L.tileLayer((customUrl ?? "").trim(), { attribution: "", crossOrigin: "anonymous", maxZoom: 18 });
    return L.tileLayer(basemapUrl(preset, theme), {
      attribution: preset.attribution,
      crossOrigin: "anonymous",
      ...(preset.subdomains ? { subdomains: preset.subdomains } : {}),
      maxZoom: 18,
      maxNativeZoom: preset.maxNativeZoom,
    });
  }
  const styles = getComputedStyle(document.documentElement);
  return L.geoJSON(worldOutline as GeoJSON.GeoJsonObject, {
    interactive: false,
    style: {
      fillColor: styles.getPropertyValue("--map-land").trim(),
      fillOpacity: 1,
      color: styles.getPropertyValue("--border-2").trim(),
      weight: 0.6,
    },
  });
}

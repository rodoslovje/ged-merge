import L from "leaflet";
import worldOutline from "../../geo/world110m.json";

// Shared Leaflet base layer, used by the full Map chart and the geocode
// mini map: opt-in provider tiles (requests reveal the viewed region), else
// the bundled offline world outline.

export const LIGHT_TILES = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
export const DARK_TILES = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

/** Build the base layer for the current settings/theme (not yet added to a
 *  map). SVG presentation attributes don't resolve var(), so the outline
 *  colours are read from the design tokens at call time — call again on
 *  theme change. */
export function createBaseLayer(allowTiles: boolean, customUrl: string | undefined, theme: "light" | "dark"): L.Layer {
  if (allowTiles) {
    const custom = customUrl;
    return L.tileLayer(custom || (theme === "dark" ? DARK_TILES : LIGHT_TILES), {
      attribution: custom ? "" : TILE_ATTRIBUTION,
      crossOrigin: "anonymous",
      // The CARTO default uses a–d shards; a custom URL keeps Leaflet's own default.
      ...(custom ? {} : { subdomains: "abcd" }),
      maxZoom: 18,
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

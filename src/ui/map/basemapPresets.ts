// Selectable base maps for the Map chart and the mini maps. Every preset here
// serves plain XYZ tiles without an API key or a registered domain, so the app
// stays backend-free and key-free; each carries the credit its provider asks
// for. Leaflet is deliberately a lazy chunk, so this module stays free of it —
// Settings imports the table to build the picker.

/** Shared OSM data credit: the tiles below are all rendered from OSM data,
 *  except Esri's imagery. */
const OSM_CREDIT = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** The id stored when the user supplies their own tile URL instead. */
export const CUSTOM_BASEMAP = "custom";

export interface BasemapPreset {
  /** Stored in `settings.mapBasemap`; the default base map's id is "". */
  id: string;
  /** i18n key for the localized display name, resolved with `t()` at render
   *  time so the picker follows the language (as overlay presets do). */
  key: string;
  /** One tile template, or a light/dark pair where the provider publishes
   *  cartography for both themes. */
  url: string | { light: string; dark: string };
  /** Attribution HTML for Leaflet's control; {@link basemapCredit} flattens it
   *  for the PNG export. */
  attribution: string;
  /** Deepest zoom the provider actually serves — beyond it Leaflet upscales
   *  the last real tiles instead of drawing blanks. */
  maxNativeZoom: number;
  /** Sharding placeholder values for a `{s}` template. */
  subdomains?: string;
}

export const BASEMAPS: readonly BasemapPreset[] = [
  {
    id: "",
    key: "basemap.carto",
    url: {
      light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    },
    attribution: `${OSM_CREDIT} © <a href="https://carto.com/attributions">CARTO</a>`,
    maxNativeZoom: 19,
    subdomains: "abcd",
  },
  {
    // The standard OSM rendering: the densest place names of the lot — hamlets,
    // single farms, chapels and cemeteries that the quieter styles drop.
    id: "osm",
    key: "basemap.osm",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: OSM_CREDIT,
    maxNativeZoom: 19,
  },
  {
    // Contours + hillshade: shows which valley a family stayed in and which
    // ridge separated two parishes.
    id: "opentopo",
    key: "basemap.opentopo",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution: `${OSM_CREDIT}, SRTM — © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
    maxNativeZoom: 17,
    subdomains: "abc",
  },
  {
    // Esri's tile REST path is {z}/{y}/{x} — row before column, unlike XYZ.
    id: "esri-imagery",
    key: "basemap.esriImagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "Esri, Maxar, Earthstar Geographics, and the GIS User Community",
    maxNativeZoom: 19,
  },
  {
    id: "esri-topo",
    key: "basemap.esriTopo",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
    attribution: `Esri, HERE, Garmin, FAO, NOAA, USGS, ${OSM_CREDIT}`,
    maxNativeZoom: 19,
  },
];

const BY_ID = new Map(BASEMAPS.map((b) => [b.id, b]));

/** Whether a stored id still names something we can draw. */
export function isKnownBasemap(id: string): boolean {
  return id === CUSTOM_BASEMAP || BY_ID.has(id);
}

/** The preset in force for the given settings, or null when the user's own
 *  tile URL takes over. "Custom" with no URL yet falls back to the default
 *  rather than leaving the map blank. */
export function activeBasemap(basemap: string, customUrl: string | undefined): BasemapPreset | null {
  if (basemap === CUSTOM_BASEMAP && (customUrl ?? "").trim()) return null;
  return BY_ID.get(basemap) ?? BASEMAPS[0];
}

/** The tile template for a preset under the current theme. */
export function basemapUrl(preset: BasemapPreset, theme: "light" | "dark"): string {
  return typeof preset.url === "string" ? preset.url : preset.url[theme];
}

/** The active credit as plain text, for the caption burned into exported
 *  PNGs. A custom URL has no known terms, so it credits nothing. */
export function basemapCredit(basemap: string, customUrl: string | undefined): string {
  const preset = activeBasemap(basemap, customUrl);
  if (!preset) return "";
  // The attributions above carry links but no character entities, so dropping
  // the tags leaves readable text.
  return preset.attribution
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

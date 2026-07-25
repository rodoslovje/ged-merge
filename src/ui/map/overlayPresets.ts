import type { MapOverlay } from "../SettingsContext";

// One-click map-overlay presets, shared by the Settings editor (which offers
// them and instantiates one on add) and the Map chart (which resolves an
// added layer's live config from here). A preset-added layer stores only its
// `presetKey` + user overrides; {@link resolveOverlay} folds the current preset
// definition back on top, so improving a preset here updates every layer that
// was added from it — no need to remove and re-add.

/** GURS asks for the source credit "Geodetska uprava Republike Slovenije, …"
 *  under CC BY 4.0 — shared by every GURS preset below and shown on the map +
 *  burned into PNG exports. */
const GURS_ATTRIBUTION = "© Geodetska uprava Republike Slovenije (GURS), CC BY 4.0";

/** A preset carries an i18n `key` for its localized name instead of a literal;
 *  the component resolves it with `t()` and stores it as the layer's presetKey
 *  so added layers stay localized (until manually renamed). */
export type OverlayPreset = Omit<MapOverlay, "id" | "name"> & { key: string };

/** Verified free overlay sources offered as one-click presets: open license,
 *  no API key, CORS-enabled (historical sources checked live 2026-07-18; GURS
 *  WMS 2026-07-25). Subscription/keyed sources (Arcanum, David Rumsey, NLS…)
 *  are deliberately not bundled — their per-account tile URLs paste into a
 *  custom layer. */
export const OVERLAY_PRESETS: OverlayPreset[] = [
  {
    // Self-hosted pyramid (deploy/tiles.gedmerge.com.caddy): 165 PD/CC0
    // Third-Military-Survey sheets (dLib.si + NYPL + IOS/GeoPortOst scans)
    // covering Slovenia, Croatia, Bosnia-Herzegovina, coastal Montenegro and
    // the southern Austrian / SW Hungarian border, built with
    // scripts/overlay-tiles.py.
    key: "settings.map.overlays.preset.spezialkarte",
    url: "https://tiles.gedmerge.com/spezialkarte-se-europe/{z}/{x}/{y}.png",
    yearFrom: 1877,
    yearTo: 1918,
    attribution: "Spezialkarte 1:75.000 · public domain / CC0 (dLib.si, NYPL, IOS)",
    maxZoom: 14,
  },
  {
    key: "settings.map.overlays.preset.france.etatmajor",
    url: "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=GEOGRAPHICALGRIDSYSTEMS.ETATMAJOR40&STYLE=normal&FORMAT=image/jpeg&TILEMATRIXSET=PM&TILEMATRIX={z}&TILECOL={x}&TILEROW={y}",
    yearFrom: 1820,
    yearTo: 1866,
    attribution: "© IGN, Licence Ouverte 2.0 (Etalab)",
    maxZoom: 15,
  },
  {
    key: "settings.map.overlays.preset.swiss.dufour",
    url: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.hiks-dufour/default/current/3857/{z}/{x}/{y}.png",
    yearFrom: 1845,
    yearTo: 1865,
    attribution: "© swisstopo",
    maxZoom: 14,
  },
  {
    key: "settings.map.overlays.preset.swiss.siegfried",
    url: "https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.hiks-siegfried/default/current/3857/{z}/{x}/{y}.png",
    yearFrom: 1870,
    yearTo: 1926,
    attribution: "© swisstopo",
    maxZoom: 13,
  },
  // Slovenia · GURS public WMS (Geodetska uprava RS), CC BY 4.0, CORS-enabled,
  // served in Web Mercator on demand. Reference (present-day) layers useful for
  // locating an ancestral place; no validity period, so never era-suggested.
  {
    // Time-enabled layer: DOF5 historical aerial survey. TIME picks the year
    // (1990–2025 available); coverage is patchy per year since the survey is
    // cyclic — change the year on the layer in Settings if a spot is blank.
    key: "settings.map.overlays.preset.gurs.orthoHist",
    wms: true,
    url: "https://ipi.eprostor.gov.si/wms-si-gurs-dts/wms",
    layers: "SI.GURS.ZPDZ:DOF050_Z",
    params: "TIME=2011-01-01T00:00:00.000Z",
    attribution: GURS_ATTRIBUTION,
  },
  {
    key: "settings.map.overlays.preset.gurs.ortho",
    wms: true,
    url: "https://ipi.eprostor.gov.si/wms-si-gurs-dts/wms",
    layers: "SI.GURS.ZPDZ:DOF025",
    attribution: GURS_ATTRIBUTION,
  },
  {
    key: "settings.map.overlays.preset.gurs.topo50",
    wms: true,
    url: "https://ipi.eprostor.gov.si/wms-si-gurs-dts/wms",
    layers: "SI.GURS.DK:DTK50",
    attribution: GURS_ATTRIBUTION,
  },
  {
    key: "settings.map.overlays.preset.gurs.parcels",
    wms: true,
    url: "https://ipi.eprostor.gov.si/wms-si-gurs-kn/wms",
    layers: "SI.GURS.KN:PARCELE",
    attribution: GURS_ATTRIBUTION,
  },
  {
    key: "settings.map.overlays.preset.gurs.houseNumbers",
    wms: true,
    url: "https://ipi.eprostor.gov.si/wms-si-gurs-kn/wms",
    layers: "SI.GURS.KN:HISNE_STEVILKE",
    // Display the number symbols, but query the address layer on click so the
    // popup can show the full street/number/settlement instead of raw IDs.
    queryLayers: "SI.GURS.KN:NASLOVI_HS",
    attribution: GURS_ATTRIBUTION,
  },
  {
    key: "settings.map.overlays.preset.gurs.settlements",
    wms: true,
    url: "https://ipi.eprostor.gov.si/wms-si-gurs-rpe/wms",
    // Boundaries + the name-label style, so settlement names show on the areas.
    // A large tile keeps labels from clipping at tile seams.
    layers: "SI.GURS.RPE:NASELJA,SI.GURS.RPE:NASELJA",
    styles: "nep_rpe_na,nep_rpe_na_lbl",
    tileSize: 1024,
    attribution: GURS_ATTRIBUTION,
  },
  {
    key: "settings.map.overlays.preset.gurs.municipalities",
    wms: true,
    url: "https://ipi.eprostor.gov.si/wms-si-gurs-rpe/wms",
    layers: "SI.GURS.RPE:OBCINE,SI.GURS.RPE:OBCINE",
    styles: "nep_rpe_obcine,nep_rpe_obcine_lbl",
    tileSize: 1024,
    attribution: GURS_ATTRIBUTION,
  },
];

const PRESET_BY_KEY = new Map(OVERLAY_PRESETS.map((p) => [p.key, p]));

/** Fold the current preset definition onto a preset-added layer, keeping the
 *  layer's identity, presetKey and (name) override. Non-preset layers, and
 *  layers whose preset no longer exists, are returned unchanged — so a manual
 *  edit that clears `presetKey` (see the Settings editor) detaches the layer
 *  and its stored config wins from then on. */
export function resolveOverlay(o: MapOverlay): MapOverlay {
  if (!o.presetKey) return o;
  const preset = PRESET_BY_KEY.get(o.presetKey);
  if (!preset) return o;
  const { key: _key, ...tech } = preset;
  void _key;
  return { ...tech, id: o.id, name: o.name, presetKey: o.presetKey };
}

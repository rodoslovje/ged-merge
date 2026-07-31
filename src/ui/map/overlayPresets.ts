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
    // Self-hosted pyramid (deploy/tiles.gedmerge.com.caddy): the complete
    // Third Military Survey, all 805 sheets of the 1:75 000 Spezialkarte, from
    // Saxony to Montenegro and from Tyrol to Bukovina. Resolved from the
    // Mapster catalogue and built with scripts/spezialkarte-sheets.py +
    // scripts/overlay-tiles.py; see scripts/manifests/README.md.
    key: "settings.map.overlays.preset.spezialkarte",
    url: "https://tiles.gedmerge.com/spezialkarte-monarchy/{z}/{x}/{y}.webp",
    yearFrom: 1877,
    yearTo: 1918,
    attribution: "Spezialkarte 1:75.000 (k.u.k. Militärgeographisches Institut) · "
      + "public domain, scans via Mapster / mapywig.org",
    maxZoom: 14,
  },
  {
    // Self-hosted pyramid: Schraembl's Neueste Generalkarte von Deutschland
    // (Vienna 1797), the Holy Roman Empire's last years, built from the David
    // Rumsey composite scan with scripts/overlay-tiles.py. Placed by the map's
    // own printed graticule (an equidistant conic, longitudes east of Paris),
    // so it sits ~6 km rms from modern coordinates — that residual is the
    // engraver's compilation error, not the registration's, and is deliberately
    // not rubber-sheeted away. Reads as period context (territories, borders,
    // German place spellings), not as a survey: base zoom 11 is the scan's own
    // resolution, so deeper zooms only enlarge it.
    key: "settings.map.overlays.preset.schraembl",
    url: "https://tiles.gedmerge.com/schraembl-1797/{z}/{x}/{y}.png",
    yearFrom: 1797,
    yearTo: 1806,
    attribution: "David Rumsey Map Collection, Stanford Libraries · CC BY-NC-SA 3.0",
    maxZoom: 11,
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
  // No preset for SI.GURS.ZPDZ:DOF050: it is the same survey as DOF025 at half
  // the source resolution — same coverage, same scale range, visibly softer.
  // Where one is blank so is the other, so it makes no fallback (2026-07-25).
  {
    // Osnovna karta — the colour base map GURS's own Javni vpogled viewer
    // draws, and the one topographic layer worth having: a single cached
    // pyramid whose fifteen levels run from 1:2 500 000 down to 1:2500, so it
    // stays legible at every zoom and ends up finer than any other GURS map.
    // At the deep end it shows individual buildings, contours, field
    // boundaries, paths and toponyms — usually what settles which house an
    // ancestor lived in.
    //
    // It exists only as a tile cache in EPSG:3794 (the plain WMS endpoint does
    // not publish it, and the cache has no Web Mercator grid), so the tiles are
    // warped per output tile in the browser — see reprojectedWmsLayer.
    key: "settings.map.overlays.preset.gurs.topo",
    wms: true,
    url: "https://ipi.eprostor.gov.si/gwc-si-gurs-dts/service/wmts",
    layers: "SI.GURS.DK:OSK",
    nativeCrs: "EPSG:3794",
    pyramid: {
      layer: "SI.GURS.DK:OSK",
      tileMatrixSet: "EPSG:3794_ATL_OSK",
      // The cache's published levels, coarsest first (GetCapabilities). Level
      // 15 (1:1000) is advertised but errors, so the pyramid stops at 1:2500.
      scaleDenominators: [
        2500000, 1500000, 1000000, 750000, 500000, 350000, 250000, 175000, 100000, 50000, 40000, 25000, 10000, 5000,
        2500,
      ],
      origin: [293225, 249475],
      tileSize: 256,
    },
    nativeBounds: [373627, 28484, 625632, 193784],
    // Reprojection fits one affine per tile, so it needs tiles that aren't
    // continent-sized; below this the country is a speck anyway.
    minZoom: 9,
    attribution: GURS_ATTRIBUTION,
  },
  {
    // Temeljni topografski načrt 1:5000/1:10000 — the older black-and-white
    // survey drawing. Superseded by the colour Osnovna karta above for finding
    // a place, but kept because it is a different document: it records the
    // building footprints, field patterns and paths of its own survey period.
    //
    // GURS cannot reproject this coverage to Web Mercator (an EPSG:3857 GetMap
    // comes back empty; it used to throw), so it is fetched in native EPSG:3794
    // per tile. Its published MaxScaleDenominator is 11 000 — above that the
    // service returns a blank image, so the layer oversamples the request to
    // get under the limit, which stretches to zoom 15 but no further.
    key: "settings.map.overlays.preset.gurs.ttn",
    wms: true,
    url: "https://ipi.eprostor.gov.si/wms-si-gurs-dts/wms",
    layers: "SI.GURS.DK:TTN5_TTN10",
    nativeCrs: "EPSG:3794",
    nativeBounds: [373627, 28484, 625632, 193784],
    maxScaleDenominator: 11000,
    minZoom: 15,
    attribution: GURS_ATTRIBUTION,
  },
  {
    key: "settings.map.overlays.preset.gurs.parcels",
    wms: true,
    url: "https://ipi.eprostor.gov.si/wms-si-gurs-kn/wms",
    layers: "SI.GURS.KN:PARCELE",
    // Click a parcel for its number, cadastral municipality and area — the
    // parcel labels are only drawn at the very closest zooms, so the popup is
    // how you read the id most of the time.
    queryLayers: "SI.GURS.KN:PARCELE",
    attribution: GURS_ATTRIBUTION,
  },
  {
    // Cadastral municipality (katastrska občina) boundaries + names. Parish and
    // land records are filed by k.o., so a click — which reports the name and
    // its number — turns a place into the unit an archive index is keyed on.
    key: "settings.map.overlays.preset.gurs.cadastralMunicipalities",
    wms: true,
    url: "https://ipi.eprostor.gov.si/wms-si-gurs-kn/wms",
    layers: "SI.GURS.KN:KATASTRSKE_OBCINE,SI.GURS.KN:KATASTRSKE_OBCINE",
    styles: "nep_kn_katastrske_obcine,nep_kn_katastrske_obcine_lbl",
    queryLayers: "SI.GURS.KN:KATASTRSKE_OBCINE",
    tileSize: 1024,
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
 *  layer's identity, presetKey and the user's own choices (name override,
 *  show-by-default flag) — those are preferences, not config. Non-preset layers, and
 *  layers whose preset no longer exists, are returned unchanged — so a manual
 *  edit that clears `presetKey` (see the Settings editor) detaches the layer
 *  and its stored config wins from then on. */
export function resolveOverlay(o: MapOverlay): MapOverlay {
  if (!o.presetKey) return o;
  const preset = PRESET_BY_KEY.get(o.presetKey);
  if (!preset) return o;
  const { key: _key, ...tech } = preset;
  void _key;
  return { ...tech, id: o.id, name: o.name, presetKey: o.presetKey, defaultOn: o.defaultOn };
}

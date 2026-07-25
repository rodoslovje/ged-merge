import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { Dataset } from "../../gedcom/types";
import { isPresumedLiving, lifespanOf } from "../../gedcom/lifespan";
import { lifespanAge } from "../../gedcom/age";
import { lifespanLine } from "../../chart/nodeDisplay";
import { createKinshipResolver, lineageClass } from "../../match/kinship";
import type { TreeMode } from "../../chart/personTree";
import {
  branchIds,
  filterPoints,
  MAP_EVENT_KINDS,
  projectPoints,
  yearRange,
  type MapEventKind,
  type MapPoint,
} from "../../geo/points";
import { clusterPoints, type MapCluster } from "../../geo/cluster";
import { buildPersonPaths } from "../../geo/paths";
import { ChartPage } from "../ChartPage";
import { ChartExportMenu } from "../ChartExportMenu";
import { PersonLink } from "../PersonLink";
import { useChartSettings } from "../ChartSettingsContext";
import { overlayDisplayName, useNameOf, useSettings } from "../SettingsContext";
import { resolveOverlay } from "./overlayPresets";
import { sexClass } from "../sex";
import { ChartRootTitle } from "../ChartRootTitle";
import { useChartShortcuts } from "../../keyboard/useChartShortcuts";
import { chartSlug } from "../exportSvg";
import { ImageIcon } from "../icons/FormatIcons";
import { exportMapPng } from "./exportMapPng";
import {
  ARROW_MAX_TOTAL,
  ARROW_MIN_SEG_PX,
  ARROW_MIN_SEG_SELECTED_PX,
  clusterColorVar,
  markerSize,
  PATH_STYLE,
  pathArrows,
} from "./markerStyle";
import { YearRangeSlider } from "./YearRangeSlider";
import { createBaseLayer } from "./baseLayer";
import { arrowMarker, pathLegNumbers } from "./pathStops";
import { useDocTheme } from "./useDocTheme";

// Full-page places Map: the events of the root person's branch — the shared
// hub Ancestors/Descendants choice, like the pedigree charts — as clustered
// markers on a Leaflet map, with event-kind / year filters. (A whole-file
// places view belongs to the Tools tab, not a per-person chart.) Base tiles
// are opt-in (requests reveal the viewed region to the provider); until
// enabled the map draws on the bundled offline world outline. Marker colour =
// event kind (see the --map-* tokens); clicking a cluster zooms in, or opens
// the event list panel once it's small or the map is deep enough.

/** Cluster click: zoom in while it still holds this many points and the map
 *  isn't already deep; otherwise open the event-list panel. */
const PANEL_MAX_POINTS = 30;
const PANEL_MIN_ZOOM = 13;

/** The panel lists at most this many events (the rest summarized). */
const PANEL_MAX_ROWS = 150;

/** At most this many life paths drawn at once (a selected one always is). */
const PATHS_MAX = 300;

/** Historical overlays start at this opacity; the picker's slider adjusts. */
const OVERLAY_DEFAULT_OPACITY = 0.7;

/** Leaflet z-index for overlay tile layers — above the base (1). */
const OVERLAY_Z = 5;

/** Parse a WMS overlay's raw `KEY=value&KEY=value` extra-params string into an
 *  object Leaflet folds into the GetMap query (e.g. a time-enabled layer's
 *  `TIME`, or a `CQL_FILTER`). Malformed pairs are skipped. */
function parseWmsParams(raw: string | undefined): Record<string, string> {
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

/** Escape a string for safe interpolation into a Leaflet popup's innerHTML. */
function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

const NULLISH = (v: unknown): v is null | undefined | "" => v == null || v === "" || v === "null";

/** Turn one GetFeatureInfo feature's properties into a popup HTML block. GURS
 *  address, parcel and cadastral-municipality features get a formatted line;
 *  anything else falls back to its readable fields (raw *_SIFRA / EID_ /
 *  geometry dropped). */
function formatFeatureInfo(
  props: Record<string, unknown> | undefined,
  layerName: string,
  translate: (key: string) => string,
): string {
  if (!props) return "";
  // Address / house-number feature (SI.GURS.KN:NASLOVI_HS et al.).
  if (!NULLISH(props.HS_STEVILKA) && (!NULLISH(props.ULICA_NAZIV) || !NULLISH(props.NASELJE_NAZIV))) {
    const num = `${props.HS_STEVILKA}${NULLISH(props.HS_DODATEK) ? "" : String(props.HS_DODATEK)}`;
    const street = NULLISH(props.ULICA_NAZIV) ? String(props.NASELJE_NAZIV) : String(props.ULICA_NAZIV);
    const town = NULLISH(props.POSTNI_OKOLIS_NAZIV) ? props.NASELJE_NAZIV : props.POSTNI_OKOLIS_NAZIV;
    const post = [props.POSTNI_OKOLIS_SIFRA, town].filter((v) => !NULLISH(v)).map(String).join(" ");
    return `<div class="map-info-block"><strong>${escHtml(`${street} ${num}`.trim())}</strong>${
      post ? `<br>${escHtml(post)}` : ""
    }</div>`;
  }
  // Cadastral parcel (SI.GURS.KN:PARCELE): the id a land record is filed under
  // is the parcel number plus its cadastral municipality — NAZIV already reads
  // "1791 ŽALNA", so it needs no assembling.
  if (!NULLISH(props.ST_PARCELE)) {
    const lines = [
      NULLISH(props.NAZIV) ? "" : `${translate("map.info.cadastralMunicipality")}: ${props.NAZIV}`,
      NULLISH(props.POVRSINA) ? "" : `${translate("map.info.area")}: ${props.POVRSINA} m²`,
    ].filter(Boolean);
    return `<div class="map-info-block"><strong>${escHtml(
      `${translate("map.info.parcel")} ${props.ST_PARCELE}`,
    )}</strong>${lines.map((l) => `<br>${escHtml(l)}`).join("")}</div>`;
  }
  // Cadastral municipality (SI.GURS.KN:KATASTRSKE_OBCINE) — number + name.
  if (!NULLISH(props.SIFKO) && !NULLISH(props.NAZIV)) {
    return `<div class="map-info-block"><strong>${escHtml(
      `${props.SIFKO} ${props.NAZIV}`,
    )}</strong><br>${escHtml(translate("map.info.cadastralMunicipality"))}</div>`;
  }
  // Generic fallback: a few readable attributes.
  const skip = (k: string) => /^EID_/.test(k) || /_SIFRA$/.test(k) || /_DJ$/.test(k) || k === "GEOM" || /^DATUM/.test(k);
  const rows = Object.entries(props)
    .filter(([k, v]) => !NULLISH(v) && !skip(k))
    .slice(0, 6)
    .map(([k, v]) => `<div>${escHtml(k)}: ${escHtml(String(v))}</div>`)
    .join("");
  return rows ? `<div class="map-info-block"><em>${escHtml(layerName)}</em>${rows}</div>` : "";
}

/** Stacked-layers glyph for the historical-overlays picker chip. */
function LayersIcon() {
  return (
    <svg className="map-layers-icon" viewBox="0 0 16 14" width="16" height="14" aria-hidden="true">
      <path d="M8 1 L15 4.5 L8 8 L1 4.5 Z" />
      <path d="M2.8 7.4 L1 8.3 L8 11.8 L15 8.3 L13.2 7.4 L8 10 Z" />
    </svg>
  );
}

/** The life-path squiggle-with-arrow, used by the toggle chip and the panel. */
function PathIcon() {
  return (
    <svg className="map-paths-icon" viewBox="0 0 16 12" width="16" height="12" aria-hidden="true">
      <path className="map-paths-icon-line" d="M1.5 10 C5 3, 8 10.5, 12 5.5" />
      <path className="map-paths-icon-head" d="M10.6 3.4 L15.2 4.2 L11.9 7.5 Z" />
    </svg>
  );
}

interface Props {
  mainDs: Dataset;
  rootId: string;
  /** The app-wide start person, for kinship labels (header + event panel). */
  startId?: string;
  backLabel: string;
  onBack: () => void;
  /** Jump to a person in Edit mode (closes the hub). */
  onNavigate: (id: string) => void;
  /** The Charts-hub kind switcher, rendered in the controls row. */
  kindSwitcher?: React.ReactNode;
  /** The hub-owned ancestors/descendants choice, shared with the pedigree
   *  charts and the report so it survives kind switches. */
  mode: TreeMode;
  onModeChange: (mode: TreeMode) => void;
}

export default function MapChart({ mainDs, rootId, startId, backLabel, onBack, onNavigate, kindSwitcher, mode, onModeChange }: Props) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const { settings } = useChartSettings();
  const { settings: appSettings, set: setAppSettings } = useSettings();
  const theme = useDocTheme();

  const [kinds, setKinds] = useState<ReadonlySet<MapEventKind>>(() => new Set(MAP_EVENT_KINDS));
  const [yearFrom, setYearFrom] = useState("");
  const [yearTo, setYearTo] = useState("");
  const [includeUndated, setIncludeUndated] = useState(true);
  const [showPaths, setShowPaths] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [panel, setPanel] = useState<MapCluster | null>(null);
  // Historical overlay layers (configured in Settings → Advanced): which are
  // shown and how opaque — session state; the layer definitions persist.
  // Preset-added overlays reflect the live preset definition; custom ones pass
  // through unchanged. Resolving here keeps the renderer/picker/click in sync.
  const overlays = useMemo(() => appSettings.mapOverlays.map(resolveOverlay), [appSettings.mapOverlays]);
  const [overlayOn, setOverlayOn] = useState<ReadonlySet<string>>(new Set());
  const [overlayOpacity, setOverlayOpacity] = useState<ReadonlyMap<string, number>>(new Map());
  const [overlaysOpen, setOverlaysOpen] = useState(false);
  // Bumped on every pan/zoom so the marker pass re-runs against the new view.
  const [viewGen, setViewGen] = useState(0);

  const allPoints = useMemo(() => projectPoints(mainDs), [mainDs]);
  const range = useMemo(() => yearRange(allPoints), [allPoints]);

  // Living-persons privacy: the shared chart toggle drops every point that
  // involves a presumed-living (or explicitly private) person.
  const excludeLiving = useMemo(() => {
    if (!settings.privacyLiving) return undefined;
    const ids = new Set<string>();
    for (const p of allPoints) {
      for (const id of p.personIds) {
        if (ids.has(id)) continue;
        const indi = mainDs.individuals.get(id);
        if (indi && (isPresumedLiving(indi, mainDs) || indi.private)) ids.add(id);
      }
    }
    return ids;
  }, [allPoints, mainDs, settings.privacyLiving]);

  // Both branch closures are computed so the A/D toggle can show its people
  // counts (the pedigree charts do the same); the active one scopes the map.
  const ancestorIds = useMemo(() => branchIds(mainDs, rootId, "ancestors"), [mainDs, rootId]);
  const descendantIds = useMemo(() => branchIds(mainDs, rootId, "descendants"), [mainDs, rootId]);
  const scopeIds = mode === "ancestors" ? ancestorIds : descendantIds;

  const filtered = useMemo(
    () =>
      filterPoints(allPoints, {
        kinds,
        yearFrom: yearFrom ? Number(yearFrom) : undefined,
        yearTo: yearTo ? Number(yearTo) : undefined,
        includeUndated,
        personIds: scopeIds,
        excludePersonIds: excludeLiving,
      }),
    [allPoints, kinds, yearFrom, yearTo, includeUndated, scopeIds, excludeLiving],
  );

  // Life paths over the filtered points — always computed (the event panel's
  // per-person path buttons need to know who has one), only drawn when the
  // Paths toggle is on. Drawing is capped, but a selected path always shows.
  const allPaths = useMemo(() => buildPersonPaths(filtered), [filtered]);
  const shownPaths = useMemo(() => {
    if (allPaths.length <= PATHS_MAX) return allPaths;
    const head = allPaths.slice(0, PATHS_MAX);
    if (selectedPath && !head.some((p) => p.personId === selectedPath)) {
      const sel = allPaths.find((p) => p.personId === selectedPath);
      if (sel) head.push(sel);
    }
    return head;
  }, [allPaths, selectedPath]);
  const pathPersonIds = useMemo(() => new Set(allPaths.map((p) => p.personId)), [allPaths]);
  useEffect(() => {
    if (selectedPath && !pathPersonIds.has(selectedPath)) setSelectedPath(null);
  }, [pathPersonIds, selectedPath]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.Layer | null>(null);
  /** Live overlay tile layers with the definition they were built from —
   *  a changed URL/zoom/attribution recreates, an opacity change adjusts. */
  const overlayLayersRef = useRef<
    Map<
      string,
      {
        layer: L.TileLayer;
        url: string;
        maxZoom?: number;
        attribution?: string;
        wms?: boolean;
        layers?: string;
        styles?: string;
        tileSize?: number;
        params?: string;
      }
    >
  >(new Map());
  const markersRef = useRef<L.LayerGroup | null>(null);
  const pathsRef = useRef<L.LayerGroup | null>(null);
  /** Bumped on each identify click so a slow GetFeatureInfo response that
   *  resolves after a newer click is ignored instead of clobbering the popup. */
  const infoSeqRef = useRef(0);
  const pathRendererRef = useRef<L.Renderer | null>(null);
  const clustersRef = useRef<MapCluster[]>([]);
  const didFitRef = useRef(false);

  // ── Map lifecycle ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = L.map(el, {
      minZoom: 2,
      maxZoom: 18,
      worldCopyJump: true,
      attributionControl: false,
    });
    L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);
    map.setView([46.1, 14.5], 5);
    // Paths render below the cluster markers, on a canvas with a click
    // tolerance so thin lines are still selectable.
    pathRendererRef.current = L.canvas({ tolerance: 8 });
    pathsRef.current = L.layerGroup().addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    const bump = () => setViewGen((g) => g + 1);
    map.on("moveend zoomend", bump);
    mapRef.current = map;
    const overlayLayers = overlayLayersRef.current;
    return () => {
      map.off("moveend zoomend", bump);
      map.remove();
      mapRef.current = null;
      baseLayerRef.current = null;
      overlayLayers.clear();
      markersRef.current = null;
      pathsRef.current = null;
      pathRendererRef.current = null;
    };
  }, []);

  // Base layer: opt-in provider tiles, else the bundled offline outline.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    baseLayerRef.current?.remove();
    baseLayerRef.current = createBaseLayer(appSettings.allowMapTiles, appSettings.mapTileUrl, theme).addTo(map);
  }, [appSettings.allowMapTiles, appSettings.mapTileUrl, theme]);

  // Historical overlays: keep the live tile layers in sync with the picker.
  // Overlay tiles are remote fetches like the base — the same opt-in gates
  // them (until then the picker isn't rendered either).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const live = overlayLayersRef.current;
    for (const [id, entry] of [...live]) {
      const o = overlays.find((ov) => ov.id === id);
      const stale =
        !appSettings.allowMapTiles ||
        !o ||
        !overlayOn.has(id) ||
        o.url !== entry.url ||
        o.maxZoom !== entry.maxZoom ||
        o.attribution !== entry.attribution ||
        !!o.wms !== !!entry.wms ||
        o.layers !== entry.layers ||
        o.styles !== entry.styles ||
        o.tileSize !== entry.tileSize ||
        o.params !== entry.params;
      if (stale) {
        entry.layer.remove();
        live.delete(id);
      }
    }
    if (!appSettings.allowMapTiles) return;
    for (const o of overlays) {
      if (!overlayOn.has(o.id) || !o.url) continue;
      const opacity = overlayOpacity.get(o.id) ?? OVERLAY_DEFAULT_OPACITY;
      const entry = live.get(o.id);
      if (entry) {
        entry.layer.setOpacity(opacity);
        continue;
      }
      const layer: L.TileLayer = o.wms
        ? L.tileLayer.wms(o.url, {
            // Extra params first so the fixed ones below can't be overridden.
            ...parseWmsParams(o.params),
            layers: o.layers ?? "",
            styles: o.styles ?? "",
            format: "image/png",
            transparent: true,
            opacity,
            attribution: o.attribution ?? "",
            crossOrigin: "anonymous",
            // WMS renders any bbox on demand, so it scales to any zoom itself.
            maxZoom: 18,
            // Label styles clip at tile seams — a large tile keeps them whole.
            tileSize: o.tileSize ?? 256,
            zIndex: OVERLAY_Z,
          })
        : L.tileLayer(o.url, {
            opacity,
            attribution: o.attribution ?? "",
            crossOrigin: "anonymous",
            maxZoom: 18,
            // Sources that stop at a lower zoom get their deepest tiles scaled.
            maxNativeZoom: o.maxZoom ?? 18,
            zIndex: OVERLAY_Z,
          });
      layer.addTo(map);
      live.set(o.id, {
        layer,
        url: o.url,
        maxZoom: o.maxZoom,
        attribution: o.attribution,
        wms: o.wms,
        layers: o.layers,
        styles: o.styles,
        tileSize: o.tileSize,
        params: o.params,
      });
    }
  }, [overlays, overlayOn, overlayOpacity, appSettings.allowMapTiles]);

  // Click-to-identify: with a queryable WMS overlay on, a map click fires a
  // WMS GetFeatureInfo for the clicked pixel and shows the attributes (for the
  // GURS address layer, a formatted street/number) in a popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const targets = appSettings.allowMapTiles
      ? overlays.filter((o) => o.wms && o.queryLayers && overlayOn.has(o.id))
      : [];
    if (!targets.length) return;

    const onClick = async (e: L.LeafletMouseEvent) => {
      const seq = ++infoSeqRef.current;
      const size = map.getSize();
      const b = map.getBounds();
      const sw = map.options.crs!.project(b.getSouthWest());
      const ne = map.options.crs!.project(b.getNorthEast());
      const pt = map.latLngToContainerPoint(e.latlng);
      const i = Math.max(0, Math.min(size.x - 1, Math.round(pt.x)));
      const j = Math.max(0, Math.min(size.y - 1, Math.round(pt.y)));

      const blocks: string[] = [];
      for (const o of targets) {
        const params = new URLSearchParams({
          SERVICE: "WMS",
          VERSION: "1.3.0",
          REQUEST: "GetFeatureInfo",
          // GeoServer requires QUERY_LAYERS ⊆ LAYERS, so query against the
          // info layer itself (which may differ from the drawn `layers`).
          LAYERS: o.queryLayers!,
          QUERY_LAYERS: o.queryLayers!,
          CRS: "EPSG:3857",
          BBOX: `${sw.x},${sw.y},${ne.x},${ne.y}`,
          WIDTH: String(size.x),
          HEIGHT: String(size.y),
          I: String(i),
          J: String(j),
          INFO_FORMAT: "application/json",
          FEATURE_COUNT: "5",
          // Pixel tolerance so a click near a point symbol still hits it.
          BUFFER: "12",
          ...parseWmsParams(o.params),
        });
        try {
          const res = await fetch(`${o.url}?${params.toString()}`);
          const data = (await res.json()) as { features?: { properties?: Record<string, unknown> }[] };
          for (const f of data.features ?? []) {
            const html = formatFeatureInfo(f.properties, overlayDisplayName(o, t), t);
            if (html) blocks.push(html);
          }
        } catch {
          // Network/parse failure — skip this layer; others may still answer.
        }
      }
      // A newer click superseded this one. Only pop up on an actual hit — a
      // click on empty ground (no house point under the cursor) stays silent.
      if (seq !== infoSeqRef.current || !blocks.length) return;
      L.popup({ className: "map-info-popup" })
        .setLatLng(e.latlng)
        .setContent(`<div class="map-info">${blocks.join("")}</div>`)
        .openOn(map);
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [overlays, overlayOn, appSettings.allowMapTiles, t]);

  // Era suggestion: overlays whose validity period intersects the selected
  // year window (layers with no period at all are never highlighted).
  const suggestedOverlays = useMemo(() => {
    const ids = new Set<string>();
    const winFrom = yearFrom ? Number(yearFrom) : range?.min;
    const winTo = yearTo ? Number(yearTo) : range?.max;
    if (winFrom === undefined || winTo === undefined) return ids;
    for (const o of overlays) {
      if (o.yearFrom === undefined && o.yearTo === undefined) continue;
      if ((o.yearFrom ?? -Infinity) <= winTo && (o.yearTo ?? Infinity) >= winFrom) ids.add(o.id);
    }
    return ids;
  }, [overlays, yearFrom, yearTo, range]);

  const toggleOverlay = (id: string) =>
    setOverlayOn((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Zoom to the data when it first shows up — and again after the branch
  // changes (new root or A/D flip), which can move the whole point cloud.
  useEffect(() => {
    didFitRef.current = false;
  }, [rootId, mode]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || didFitRef.current || !filtered.length) return;
    didFitRef.current = true;
    const bounds = L.latLngBounds(filtered.map((p) => [p.coord.lat, p.coord.lon] as [number, number]));
    map.fitBounds(bounds.pad(0.1), { maxZoom: 10 });
  }, [filtered]);

  const openCluster = useCallback((cluster: MapCluster) => {
    const map = mapRef.current;
    if (!map) return;
    if (cluster.points.length > PANEL_MAX_POINTS && map.getZoom() < PANEL_MIN_ZOOM) {
      map.setView([cluster.lat, cluster.lon], map.getZoom() + 2);
    } else {
      setPanel(cluster);
    }
  }, []);

  // ── Markers: cluster the filtered points for the current view ─────────────
  useEffect(() => {
    const map = mapRef.current;
    const layer = markersRef.current;
    if (!map || !layer) return;
    const zoom = map.getZoom();
    const view = map.getBounds().pad(0.3);
    const clusters = clusterPoints(filtered, zoom).filter((c) => view.contains([c.lat, c.lon]));
    clustersRef.current = clusters;
    layer.clearLayers();
    for (const cluster of clusters) {
      const count = cluster.points.length;
      const size = markerSize(count);
      const marker = L.marker([cluster.lat, cluster.lon], {
        icon: L.divIcon({
          className: "map-cluster",
          html: `<div class="map-cluster-dot" style="background:var(${clusterColorVar(cluster)});width:${size}px;height:${size}px">${count > 1 ? count : ""}</div>`,
          iconSize: [size, size],
        }),
        keyboard: false,
      });
      marker.on("click", () => openCluster(cluster));
      marker.bindTooltip(
        count === 1 ? cluster.points[0].place : t("map.clusterTooltip", { count }),
        { direction: "top", opacity: 0.9 },
      );
      layer.addLayer(marker);
    }
    // viewGen re-runs this pass after every pan/zoom.
  }, [filtered, viewGen, openCluster, t]);

  // ── Life paths: one direction-marked polyline per shown person ────────────
  useEffect(() => {
    const map = mapRef.current;
    const layer = pathsRef.current;
    const renderer = pathRendererRef.current;
    if (!map || !layer || !renderer) return;
    layer.clearLayers();
    if (!showPaths) return;
    // Canvas strokes can't use var() — resolve the token per theme, like the
    // offline outline does.
    const color = getComputedStyle(document.documentElement).getPropertyValue("--map-path").trim();
    const anySelected = selectedPath !== null;
    const view = map.getBounds().pad(0.5);
    let arrowBudget = ARROW_MAX_TOTAL;
    for (const path of shownPaths) {
      const isSel = path.personId === selectedPath;
      const latlngs = path.stops.map((s) => [s.coord.lat, s.coord.lon] as [number, number]);
      if (!isSel && !view.intersects(L.latLngBounds(latlngs))) continue;
      const weight = isSel ? PATH_STYLE.weightSelected : PATH_STYLE.weight;
      const opacity = anySelected
        ? isSel
          ? PATH_STYLE.opacitySelected
          : PATH_STYLE.opacityDimmed
        : PATH_STYLE.opacity;
      const line = L.polyline(latlngs, { renderer, color, weight, opacity, lineCap: "round", lineJoin: "round" });
      const indi = mainDs.individuals.get(path.personId);
      // Element content, not string: names must not be interpreted as HTML.
      const tip = document.createElement("span");
      tip.textContent = indi ? `${nameOf(indi)} · ${lifespanOf(indi)}` : path.personId;
      line.bindTooltip(tip, { sticky: true, direction: "top", opacity: 0.9 });
      line.on("click", () => setSelectedPath((prev) => (prev === path.personId ? null : path.personId)));
      line.on("mouseover", () => line.setStyle({ weight: weight + 1.5, opacity: 1 }));
      line.on("mouseout", () => line.setStyle({ weight, opacity }));
      layer.addLayer(line);
      // The singled-out path numbers its legs along the line.
      if (isSel) for (const m of pathLegNumbers(map, path.stops.map((s) => s.coord))) layer.addLayer(m);
      // Direction chevrons — on everything while nothing is selected, and on
      // the selected path alone once there is one (the rest are dimmed).
      if ((isSel || !anySelected) && arrowBudget > 0) {
        const pts = latlngs.map((ll) => map.latLngToContainerPoint(ll));
        for (const a of pathArrows(pts, isSel ? ARROW_MIN_SEG_SELECTED_PX : ARROW_MIN_SEG_PX)) {
          if (arrowBudget-- <= 0) break;
          layer.addLayer(arrowMarker(map, a));
        }
      }
    }
    // viewGen: arrows depend on screen-space segment lengths; theme: the
    // resolved stroke colour.
  }, [shownPaths, showPaths, selectedPath, viewGen, theme, mainDs, nameOf]);

  // Keep the panel in sync: filters changing under it would show stale rows.
  useEffect(() => setPanel(null), [filtered]);

  // Panel path button: turn paths on, single out this person, frame the path.
  const showPathFor = useCallback(
    (personId: string) => {
      setShowPaths(true);
      setSelectedPath(personId);
      setPanel(null);
      const path = allPaths.find((p) => p.personId === personId);
      const map = mapRef.current;
      if (path && map) {
        const bounds = L.latLngBounds(path.stops.map((s) => [s.coord.lat, s.coord.lon] as [number, number]));
        map.fitBounds(bounds.pad(0.25), { maxZoom: 11 });
      }
    },
    [allPaths],
  );

  // A / D switch the branch direction; Esc leaves (Leaflet owns +/− itself).
  useChartShortcuts({ onMode: onModeChange, onLeave: onBack });

  const toggleKind = (kind: MapEventKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const shownPersonIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of filtered) for (const id of p.personIds) ids.add(id);
    return [...ids];
  }, [filtered]);

  // Page kind with the branch direction spelled out, like the tree charts
  // ("Ancestors Places Map"); drives the header, export title and file names.
  const pageKind = `${t(mode === "ancestors" ? "tree.ancestors" : "tree.descendants")} ${t("map.pageTitle")}`;
  const eventLabel = (p: MapPoint) => t(`event.${p.tag}`, { defaultValue: p.tag });

  // Slider positions for the year window: unset bounds sit at the data range.
  const clampYear = (v: number) =>
    range ? Math.min(range.max, Math.max(range.min, Number.isFinite(v) ? v : range.min)) : v;

  const panelRows = useMemo(() => {
    if (!panel) return [];
    return [...panel.points].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999)).slice(0, PANEL_MAX_ROWS);
  }, [panel]);

  const root = mainDs.individuals.get(rootId);
  const selectedIndi = selectedPath ? mainDs.individuals.get(selectedPath) : undefined;
  // Header lifespan (+ age when the Age display toggle is on) and kinship
  // chip — the same conventions as every other chart header.
  const rootYears = root
    ? lifespanLine({ showLifespan: true, showAge: settings.showAge }, { years: lifespanOf(root), age: lifespanAge(root) })
    : undefined;
  // Export file base and PNG header line, matching the other charts.
  const slug = chartSlug(root ? nameOf(root) : undefined, pageKind);
  const exportTitle = [root && nameOf(root), rootYears, "—", pageKind].filter(Boolean).join(" ");
  const showKin = settings.showKinship && appSettings.showKinship && !!startId;
  const kinship = useMemo(
    () => (startId ? createKinshipResolver(mainDs, startId, t) : undefined),
    [mainDs, startId, t],
  );

  return (
    <ChartPage
      backLabel={backLabel}
      onBack={onBack}
      title={
        root ? (
          <ChartRootTitle
            name={nameOf(root)}
            sexCls={sexClass(root.sex)}
            years={rootYears}
            kinship={showKin ? kinship?.label(rootId) : undefined}
            lineage={kinship?.lineage(rootId)}
            kind={pageKind}
          />
        ) : (
          <span className="tree-title-kind">{pageKind}</span>
        )
      }
      actions={
        <ChartExportMenu
          disabled={!filtered.length}
          slug={slug}
          gedcom={{ ds: mainDs, personIds: shownPersonIds }}
          extraItems={[
            {
              key: "png",
              icon: <ImageIcon />,
              label: t("map.export.png"),
              title: t("map.export.png.tooltip"),
              onSelect: () => {
                const map = mapRef.current;
                const el = containerRef.current;
                const base = baseLayerRef.current;
                // Compose per layer (base, then overlays) so stacking and
                // opacity match the screen even after a base-layer rebuild.
                const baseEl = base instanceof L.TileLayer ? (base.getContainer() ?? null) : null;
                const overlayTiles = overlays
                  .filter((o) => overlayOn.has(o.id))
                  .flatMap((o) => {
                    const entry = overlayLayersRef.current.get(o.id);
                    const layerEl = entry?.layer.getContainer();
                    return layerEl ? [{ el: layerEl, opacity: overlayOpacity.get(o.id) ?? OVERLAY_DEFAULT_OPACITY }] : [];
                  });
                const baseAttribution = appSettings.allowMapTiles
                  ? appSettings.mapTileUrl
                    ? ""
                    : "© OpenStreetMap contributors © CARTO"
                  : "Natural Earth";
                const attribution = [
                  baseAttribution,
                  ...overlays.filter((o) => overlayOn.has(o.id) && o.attribution).map((o) => o.attribution!),
                ]
                  .filter(Boolean)
                  .join(" · ");
                if (map && el)
                  exportMapPng(
                    map,
                    el,
                    { base: baseEl, overlays: overlayTiles },
                    clustersRef.current,
                    showPaths ? shownPaths : [],
                    selectedPath,
                    exportTitle,
                    slug,
                    attribution,
                  );
              },
            },
          ]}
        />
      }
      controlsLeft={
        <>
          {kindSwitcher}
          <div className="tree-mode">
            <button className={mode === "ancestors" ? "active" : ""} onClick={() => onModeChange("ancestors")}>
              {t("tree.ancestors")}
              <span className="tree-mode-count">{ancestorIds.size}</span>
            </button>
            <button className={mode === "descendants" ? "active" : ""} onClick={() => onModeChange("descendants")}>
              {t("tree.descendants")}
              <span className="tree-mode-count">{descendantIds.size}</span>
            </button>
          </div>
        </>
      }
      controlsRight={
        <span className="map-count gm-data">
          {t("map.count", { shown: filtered.length, total: allPoints.length })}
          {showPaths &&
            ` · ${
              allPaths.length > PATHS_MAX
                ? t("map.pathCountOf", { shown: PATHS_MAX, total: allPaths.length })
                : t("map.pathCount", { count: allPaths.length })
            }`}
        </span>
      }
    >
      <div className="map-filters">
        <div className="map-kinds" role="group" aria-label={t("map.kinds.label")}>
          {MAP_EVENT_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`map-kind-chip${kinds.has(kind) ? " active" : ""}`}
              aria-pressed={kinds.has(kind)}
              onClick={() => toggleKind(kind)}
            >
              <span className="map-kind-dot" style={{ background: `var(--map-${kind})` }} />
              {t(`map.kind.${kind}`)}
            </button>
          ))}
        </div>
        <span className="map-years">
          <input
            type="number"
            className="map-year-input"
            value={yearFrom}
            placeholder={range ? String(range.min) : ""}
            onChange={(e) => setYearFrom(e.target.value)}
            aria-label={t("map.yearFrom")}
          />
          {range && range.min < range.max ? (
            <YearRangeSlider
              min={range.min}
              max={range.max}
              from={clampYear(yearFrom ? Number(yearFrom) : range.min)}
              to={clampYear(yearTo ? Number(yearTo) : range.max)}
              fromLabel={t("map.yearFrom")}
              toLabel={t("map.yearTo")}
              onChange={(from, to) => {
                // A thumb parked at the data edge means "unbounded" — the
                // inputs go back to showing the placeholder bound.
                setYearFrom(from <= range.min ? "" : String(from));
                setYearTo(to >= range.max ? "" : String(to));
              }}
            />
          ) : (
            "–"
          )}
          <input
            type="number"
            className="map-year-input"
            value={yearTo}
            placeholder={range ? String(range.max) : ""}
            onChange={(e) => setYearTo(e.target.value)}
            aria-label={t("map.yearTo")}
          />
        </span>
        <label className="map-undated">
          <input type="checkbox" checked={includeUndated} onChange={(e) => setIncludeUndated(e.target.checked)} />
          {t("map.undated")}
        </label>
        <button
          type="button"
          className={`map-kind-chip map-paths-chip${showPaths ? " active" : ""}`}
          aria-pressed={showPaths}
          title={t("map.paths.tooltip")}
          onClick={() => setShowPaths((v) => !v)}
        >
          <PathIcon />
          {t("map.paths")}
        </button>
        {appSettings.allowMapTiles && overlays.length > 0 && (
          <span className="map-overlays-wrap">
            <button
              type="button"
              className={`map-kind-chip map-overlays-chip${overlayOn.size ? " active" : ""}`}
              aria-pressed={overlaysOpen}
              aria-expanded={overlaysOpen}
              title={t("map.overlays.tooltip")}
              onClick={() => setOverlaysOpen((v) => !v)}
            >
              <LayersIcon />
              {t("map.overlays")}
              {overlayOn.size > 0 && <span className="tree-mode-count">{overlayOn.size}</span>}
            </button>
            {overlaysOpen && (
              <div className="map-overlays-panel">
                {overlays.map((o) => {
                  const on = overlayOn.has(o.id);
                  const suggested = suggestedOverlays.has(o.id);
                  const opacity = overlayOpacity.get(o.id) ?? OVERLAY_DEFAULT_OPACITY;
                  return (
                    <div
                      key={o.id}
                      className={`map-overlay-row${suggested ? " suggested" : ""}`}
                      title={suggested ? t("map.overlays.suggested") : undefined}
                    >
                      <label className="map-overlay-pick">
                        <input type="checkbox" checked={on} onChange={() => toggleOverlay(o.id)} />
                        <span className="map-overlay-name">{overlayDisplayName(o, t)}</span>
                        {(o.yearFrom !== undefined || o.yearTo !== undefined) && (
                          <span className="gm-data map-overlay-years">
                            {o.yearFrom ?? "…"}–{o.yearTo ?? "…"}
                          </span>
                        )}
                      </label>
                      {on && (
                        <input
                          type="range"
                          className="map-overlay-opacity"
                          min={10}
                          max={100}
                          value={Math.round(opacity * 100)}
                          aria-label={t("map.overlays.opacity")}
                          title={t("map.overlays.opacity")}
                          onChange={(e) =>
                            setOverlayOpacity((prev) => new Map(prev).set(o.id, Number(e.target.value) / 100))
                          }
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </span>
        )}
      </div>
      <div className="tree-canvas-wrap map-canvas-wrap">
        <div ref={containerRef} className="map-canvas" />
        {!appSettings.allowMapTiles && (
          <div className="map-tiles-notice">
            <span>{t("map.tilesNotice")}</span>
            <button type="button" onClick={() => setAppSettings({ allowMapTiles: true })}>
              {t("map.tilesEnable")}
            </button>
          </div>
        )}
        {showPaths && selectedPath && (
          <div className="map-path-selchip">
            <PathIcon />
            <span className="map-path-selchip-text">
              {t("map.pathOf")}: <b>{selectedIndi ? nameOf(selectedIndi) : selectedPath}</b>
              {selectedIndi && <span className="gm-data"> {lifespanOf(selectedIndi)}</span>}
            </span>
            <button
              className="modal-close"
              onClick={() => setSelectedPath(null)}
              title={t("help.close")}
              aria-label={t("help.close")}
            >
              ×
            </button>
          </div>
        )}
        {!allPoints.length && (
          <div className="map-empty">
            <p>{t("map.empty")}</p>
            <p className="map-empty-hint">{t("map.emptyHint")}</p>
          </div>
        )}
        {panel && (
          <div className="map-panel">
            <div className="map-panel-header">
              <span className="map-panel-title">
                {t("map.panelTitle", { count: panel.points.length })}
              </span>
              <button className="modal-close" onClick={() => setPanel(null)} title={t("help.close")} aria-label={t("help.close")}>
                ×
              </button>
            </div>
            <ul className="map-panel-list">
              {panelRows.map((p, i) => (
                <li key={i}>
                  <span className="map-panel-fact">
                    <span className="map-kind-dot" style={{ background: `var(--map-${p.kind})` }} />
                    {/* When the pin is the address's own coordinate, name the
                        address — that, not the settlement, is what was pinned. */}
                    <span className="gm-data">{p.year ?? "····"}</span> {eventLabel(p)} ·{" "}
                    {p.address ? `${p.address}, ${p.place}` : p.place}
                  </span>
                  <span className="map-panel-people">
                    {p.personIds.map((id) => {
                      const kin = showKin ? kinship?.label(id) : undefined;
                      return (
                        <span key={id} className="map-panel-person">
                          <PersonLink dataset={mainDs} id={id} fallback={id} onNavigate={onNavigate} />
                          {kin && <span className={`person-kinship ${lineageClass(kinship?.lineage(id))}`}>{kin}</span>}
                          {pathPersonIds.has(id) && (
                            <button
                              type="button"
                              className="map-panel-pathbtn"
                              title={t("map.showPath")}
                              aria-label={t("map.showPath")}
                              onClick={() => showPathFor(id)}
                            >
                              <PathIcon />
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </span>
                </li>
              ))}
              {panel.points.length > PANEL_MAX_ROWS && (
                <li className="map-panel-more">{t("map.panelMore", { count: panel.points.length - PANEL_MAX_ROWS })}</li>
              )}
            </ul>
          </div>
        )}
      </div>
    </ChartPage>
  );
}

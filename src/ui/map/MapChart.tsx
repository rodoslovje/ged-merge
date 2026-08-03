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
  branchDepth,
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
import { ChartSettings } from "../ChartSettings";
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
import { basemapCredit } from "./basemapPresets";
import { arrowMarker, pathLegNumbers } from "./pathStops";
import { addFitControl, boundsOfCoords } from "./fitControl";
import { OVERLAY_DEFAULT_OPACITY } from "./overlayConfig";
import { identifyAt, identifyPopupHtml, queryableOverlays } from "./overlayIdentify";
import { syncOverlayLayers, type LiveOverlays } from "./overlayLayer";
import { useDocTheme } from "./useDocTheme";
import { ChartFindBox } from "../ChartFindBox";
import { useChartFind } from "../useChartFind";
import type { FindSource } from "../chartFind";

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

/** Zoom the find box pulls in to, when the map is further out than this — close
 *  enough to tell neighbouring places apart. */
const FIND_ZOOM = 12;

/** At most this many place lines in a marker's tooltip. */
const TOOLTIP_MAX_PLACES = 4;

/** A marker's hover tooltip: the place(s) it stands for and, for a cluster,
 *  the event count. A single event also shows its street address — on a
 *  cluster the addresses would be a wall of text, so places alone. Built as
 *  DOM, not HTML: the labels are file data. */
function clusterTooltip(
  cluster: MapCluster,
  translate: (key: string, opts: { count: number }) => string,
): HTMLElement {
  const single = cluster.points.length === 1;
  const labels: { place: string; address?: string }[] = [];
  for (const p of cluster.points) {
    if (!p.place) continue;
    const address = single ? p.address : undefined;
    if (!labels.some((l) => l.place === p.place && l.address === address)) labels.push({ place: p.place, address });
  }
  const el = document.createElement("div");
  for (const label of labels.slice(0, TOOLTIP_MAX_PLACES)) {
    const row = document.createElement("div");
    row.textContent = label.place;
    // Place then address, styled like the place picker's suggestions.
    if (label.address) {
      const addr = document.createElement("span");
      addr.className = "place-suggestion-addr";
      addr.textContent = ` · ${label.address}`;
      row.appendChild(addr);
    }
    el.appendChild(row);
  }
  if (labels.length > TOOLTIP_MAX_PLACES) {
    const more = document.createElement("div");
    more.textContent = `… +${labels.length - TOOLTIP_MAX_PLACES}`;
    el.appendChild(more);
  }
  if (cluster.points.length > 1) {
    const count = document.createElement("div");
    count.className = "map-cluster-tip-count";
    count.textContent = translate("map.clusterTooltip", { count: cluster.points.length });
    el.appendChild(count);
  }
  return el;
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
  // Layers marked "show by default" in Settings start switched on; unticking
  // one here only affects this map's session.
  const [overlayOn, setOverlayOn] = useState<ReadonlySet<string>>(
    () => new Set(appSettings.mapOverlays.filter((o) => o.defaultOn).map((o) => o.id)),
  );
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
  // The shared generation limit cuts them the same way it cuts a chart.
  const limit = settings.maxGenerations ?? undefined;
  const ancestorIds = useMemo(() => branchIds(mainDs, rootId, "ancestors", limit), [mainDs, rootId, limit]);
  const descendantIds = useMemo(() => branchIds(mainDs, rootId, "descendants", limit), [mainDs, rootId, limit]);
  const scopeIds = mode === "ancestors" ? ancestorIds : descendantIds;
  // The full reach of the current direction, for the limit's "of N" readout.
  const availableGenerations = useMemo(() => branchDepth(mainDs, rootId, mode), [mainDs, rootId, mode]);

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

  // Find-in-map: one position per drawn point, searchable by the people it
  // belongs to *and* by its place and address — on a map "where is Kranj" is as
  // natural a question as "where is Marija". Keys index `filtered`.
  const findSources = useMemo<FindSource[]>(
    () =>
      filtered.map((p, i) => ({
        key: String(i),
        people: p.personIds.map((id) => mainDs.individuals.get(id)),
        text: [p.place, p.address].filter(Boolean).join(" "),
      })),
    [filtered, mainDs],
  );
  // Fly to the point and open its event panel, so the hit names itself instead
  // of leaving the user to guess which marker moved under the cursor.
  const revealPoint = useCallback((key: string) => {
    const map = mapRef.current;
    const point = latestFiltered.current[Number(key)];
    if (!map || !point) return;
    map.flyTo([point.coord.lat, point.coord.lon], Math.max(map.getZoom(), FIND_ZOOM), { duration: 0.6 });
    setPanel({ lat: point.coord.lat, lon: point.coord.lon, points: [point] });
  }, []);
  // No re-root offer: the map's root belongs to the hub, and a person may be
  // missing here simply because none of their events carry coordinates.
  const find = useChartFind(findSources, mainDs.individuals, revealPoint);
  useEffect(() => {
    if (selectedPath && !pathPersonIds.has(selectedPath)) setSelectedPath(null);
  }, [pathPersonIds, selectedPath]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.Layer | null>(null);
  /** Live overlay tile layers with the definition they were built from —
   *  a changed URL/zoom/attribution recreates, an opacity change adjusts. */
  const overlayLayersRef = useRef<LiveOverlays>(new Map());
  const markersRef = useRef<L.LayerGroup | null>(null);
  const pathsRef = useRef<L.LayerGroup | null>(null);
  /** Bumped on each identify click so a slow GetFeatureInfo response that
   *  resolves after a newer click is ignored instead of clobbering the popup. */
  const infoSeqRef = useRef(0);
  const pathRendererRef = useRef<L.Renderer | null>(null);
  const clustersRef = useRef<MapCluster[]>([]);
  const didFitRef = useRef(false);
  /** Latest filtered points / translator for the map-lifecycle effect, which
   *  runs once and must not be re-created when either changes. */
  const latestFiltered = useRef(filtered);
  latestFiltered.current = filtered;
  const tRef = useRef(t);
  tRef.current = t;

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
    // A cadastral overlay is read at a scale — "is this parcel 40 m or 400 m
    // across" — which zoom level alone does not answer, so the bar says what a
    // length on screen is on the ground. Metric only: every source here is.
    L.control.scale({ position: "bottomleft", metric: true, imperial: false, maxWidth: 130 }).addTo(map);
    // Automation hook: lets capture/e2e scripts set a precise view (the UI
    // offers no way to type a center/zoom).
    (el as HTMLDivElement & { _leafletMap?: L.Map })._leafletMap = map;
    map.setView([46.1, 14.5], 5);
    // Paths render below the cluster markers, on a canvas with a click
    // tolerance so thin lines are still selectable.
    pathRendererRef.current = L.canvas({ tolerance: 8 });
    pathsRef.current = L.layerGroup().addTo(map);
    markersRef.current = L.layerGroup().addTo(map);
    // Reads the filtered points at click time (see latestFiltered), so the
    // button always frames what the current filters draw.
    addFitControl(map, tRef.current("map.fit"), () => boundsOfCoords(latestFiltered.current.map((p) => p.coord)));
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
    baseLayerRef.current = createBaseLayer(
      appSettings.allowMapTiles,
      appSettings.mapBasemap,
      appSettings.mapTileUrl,
      theme,
    ).addTo(map);
  }, [appSettings.allowMapTiles, appSettings.mapBasemap, appSettings.mapTileUrl, theme]);

  // Historical overlays: keep the live tile layers in sync with the picker.
  // Overlay tiles are remote fetches like the base — the same opt-in gates
  // them (until then the picker isn't rendered either).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncOverlayLayers(map, overlayLayersRef.current, overlays, {
      enabled: appSettings.allowMapTiles,
      isOn: (o) => overlayOn.has(o.id),
      opacityOf: (o) => overlayOpacity.get(o.id) ?? OVERLAY_DEFAULT_OPACITY,
    });
  }, [overlays, overlayOn, overlayOpacity, appSettings.allowMapTiles]);

  // A layer newly marked "show by default" in Settings (reachable from the
  // chart) switches itself on here; one the user unticked in the picker stays
  // off — only the transition to default counts.
  const seenDefaultsRef = useRef<ReadonlySet<string>>(
    new Set(appSettings.mapOverlays.filter((o) => o.defaultOn).map((o) => o.id)),
  );
  useEffect(() => {
    const now = new Set(appSettings.mapOverlays.filter((o) => o.defaultOn).map((o) => o.id));
    const fresh = [...now].filter((id) => !seenDefaultsRef.current.has(id));
    seenDefaultsRef.current = now;
    if (fresh.length) setOverlayOn((prev) => new Set([...prev, ...fresh]));
  }, [appSettings.mapOverlays]);

  // Click-to-identify: with a queryable WMS overlay on, a map click fires a
  // WMS GetFeatureInfo for the clicked pixel and shows the attributes (for the
  // GURS address layer, a formatted street/number) in a popup.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const targets = appSettings.allowMapTiles
      ? queryableOverlays(overlays).filter((o) => overlayOn.has(o.id))
      : [];
    if (!targets.length) return;

    const onClick = async (e: L.LeafletMouseEvent) => {
      const seq = ++infoSeqRef.current;
      const blocks = await identifyAt(map, targets, e.latlng, (o) => overlayDisplayName(o, t), t);
      // A newer click superseded this one. Only pop up on an actual hit — a
      // click on empty ground (no house point under the cursor) stays silent.
      if (seq !== infoSeqRef.current || !blocks.length) return;
      L.popup({ className: "map-info-popup" }).setLatLng(e.latlng).setContent(identifyPopupHtml(blocks)).openOn(map);
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
      marker.bindTooltip(clusterTooltip(cluster, t), { direction: "top", opacity: 0.9 });
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
  const pageKind =
    `${t(mode === "ancestors" ? "tree.ancestors" : "tree.descendants")} ${t("map.pageTitle")}` +
    (limit !== undefined && limit < availableGenerations
      ? ` · ${t("tree.gen.shown", { n: limit, of: availableGenerations })}`
      : "");
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
        <>
        <ChartSettings lockedType="map" availableGenerations={availableGenerations} />
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
                // Painted bottom-up, so the list is walked in reverse: first
                // listed is topmost on screen (see overlayZIndex).
                const overlayTiles = [...overlays]
                  .reverse()
                  .filter((o) => overlayOn.has(o.id))
                  .flatMap((o) => {
                    const entry = overlayLayersRef.current.get(o.id);
                    const layerEl = entry?.layer.getContainer();
                    return layerEl ? [{ el: layerEl, opacity: overlayOpacity.get(o.id) ?? OVERLAY_DEFAULT_OPACITY }] : [];
                  });
                const baseAttribution = appSettings.allowMapTiles
                  ? basemapCredit(appSettings.mapBasemap, appSettings.mapTileUrl)
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
        </>
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
          {/* Reads with the controls it counts for, rather than pinned to the
              far right edge opposite them. */}
          <span className="map-count gm-data">
            {t("map.count", { shown: filtered.length, total: allPoints.length })}
            {showPaths &&
              ` · ${
                allPaths.length > PATHS_MAX
                  ? t("map.pathCountOf", { shown: PATHS_MAX, total: allPaths.length })
                  : t("map.pathCount", { count: allPaths.length })
              }`}
          </span>
        </>
      }
      controlsRight={<ChartFindBox find={find} scope="map" />}
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
          {/* Inside the group, not beside it: like the kind chips it picks what
              is drawn, and as a sibling of the whole box it was pushed onto a
              line of its own however much room the chips had left. */}
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
        </div>
        <div className="map-filters-right">
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
                    <span className="gm-data">{p.year ?? "····"}</span> {eventLabel(p)} · {p.place}
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

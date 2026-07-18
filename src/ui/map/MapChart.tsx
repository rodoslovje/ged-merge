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
import { useNameOf, useSettings } from "../SettingsContext";
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
import { pathLegNumbers } from "./pathStops";
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
  const markersRef = useRef<L.LayerGroup | null>(null);
  const pathsRef = useRef<L.LayerGroup | null>(null);
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
    return () => {
      map.off("moveend zoomend", bump);
      map.remove();
      mapRef.current = null;
      baseLayerRef.current = null;
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
          layer.addLayer(
            L.marker(map.containerPointToLatLng(L.point(a.x, a.y)), {
              icon: L.divIcon({
                className: "map-path-arrow-wrap",
                html: `<svg class="map-path-arrow" viewBox="0 0 10 10" style="transform:rotate(${Math.round(a.angleDeg)}deg)"><path d="M1 1 L9 5 L1 9 Z"/></svg>`,
                iconSize: [10, 10],
              }),
              interactive: false,
              keyboard: false,
              zIndexOffset: -1000,
            }),
          );
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
                const attribution = appSettings.allowMapTiles
                  ? appSettings.mapTileUrl
                    ? ""
                    : "© OpenStreetMap contributors © CARTO"
                  : "Natural Earth";
                if (map && el)
                  exportMapPng(
                    map,
                    el,
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

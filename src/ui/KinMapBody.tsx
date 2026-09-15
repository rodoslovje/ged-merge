import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { KinPerson } from "../chart/kinshipWheel";
import type { KinPlaced } from "../chart/kinMap";
import { clusterPoints, type MapCluster } from "../geo/cluster";
import type { MapPoint } from "../geo/points";
import { useSettings } from "./SettingsContext";
import { createBaseLayer } from "./map/baseLayer";
import { addFitControl, boundsOfCoords } from "./map/fitControl";
import { removeMap } from "./map/removeMap";
import { markerSize } from "./map/markerStyle";
import { resolveOverlay } from "./map/overlayPresets";
import { syncOverlayLayers, type LiveOverlays } from "./map/overlayLayer";
import { useDocTheme } from "./map/useDocTheme";

// The Contemporaries chart's Map layout: the wheel's dots on a Leaflet map,
// one per relative at their anchor place (see `src/chart/kinMap.ts`). Lazy,
// like the Places map, so Leaflet is only fetched once someone opens it.
//
// The dots are the chart's own: coloured by its colour axis, dimmed by its
// "Alive in" year, hidden by its colour key. Where several relatives share a
// spot at the current zoom they merge into one counted marker — the Places
// map's grid clustering, over people instead of events — whose click zooms in,
// or opens a list of who is there once the map is deep enough.

/** Cluster click: zoom in while it still holds this many people and the map
 *  isn't already deep; otherwise open the list. */
const PANEL_MAX_POINTS = 30;
const PANEL_MIN_ZOOM = 13;
/** Zoom the find box pulls in to, when the map is further out than this. */
const FIND_ZOOM = 12;
/** At most this many names in a marker's tooltip. */
const TOOLTIP_MAX_NAMES = 4;
/** At most this many place lines at the top of the list panel. */
const TOOLTIP_MAX_PLACES = 4;

interface Props {
  /** Everyone to draw — already filtered by the colour key, root excluded. */
  placed: KinPlaced[];
  /** The root's own anchor, drawn as the hub; absent when they have none. */
  rootPoint?: MapPoint;
  rootLabel: string;
  rootInitials: string;
  colorOf: (p: KinPerson) => string;
  /** The colour-key group a person belongs to — a cluster of one group takes
   *  that group's colour, a mixed one the neutral mixed token. */
  categoryOf: (p: KinPerson) => string;
  /** Alive in the scrubbed year (or the scrubber is off). */
  lit: (p: KinPerson) => boolean;
  nameFor: (p: KinPerson) => string;
  tooltipFor: (p: KinPerson) => string;
  selectedId: string | null;
  findHitId: string | null;
  onSelect: (id: string) => void;
  /** Re-frames the dots when it changes (a new root, scope or limit). */
  fitKey: string;
  /** Receives the find box's reveal: fly to a person's dot. */
  revealRef: React.MutableRefObject<((id: string) => void) | null>;
}

/** One place a marker stands at, with the house when there is exactly one. */
interface PlaceLine {
  place: string;
  address?: string;
}

/** The places a set of points stands at, each once. The house comes along only
 *  when the points name a single one there: a village of many houses reads as
 *  the village, not as a list of house numbers. */
function placeLines(points: readonly MapPoint[]): PlaceLine[] {
  const byPlace = new Map<string, Set<string>>();
  for (const p of points) {
    if (!p.place) continue;
    let addrs = byPlace.get(p.place);
    if (!addrs) byPlace.set(p.place, (addrs = new Set()));
    if (p.address) addrs.add(p.address);
  }
  return [...byPlace].map(([place, addrs]) => (addrs.size === 1 ? { place, address: [...addrs][0] } : { place }));
}

/** The place lines a tooltip opens with, capped like its names. */
function tooltipPlaces(points: readonly MapPoint[]): (string | PlaceLine)[] {
  const lines = placeLines(points);
  const shown: (string | PlaceLine)[] = lines.slice(0, TOOLTIP_MAX_PLACES);
  if (lines.length > TOOLTIP_MAX_PLACES) shown.push(`… +${lines.length - TOOLTIP_MAX_PLACES}`);
  return shown;
}

/** A marker's hover text as DOM (names and places are file data, never HTML).
 *  A place line writes its house after the name, muted like the place
 *  picker's suggestions. */
function tooltipEl(lines: (string | PlaceLine)[], more?: string): HTMLElement {
  const el = document.createElement("div");
  for (const line of lines) {
    const row = document.createElement("div");
    if (typeof line === "string") {
      row.textContent = line;
    } else {
      row.textContent = line.place;
      if (line.address) {
        const addr = document.createElement("span");
        addr.className = "place-suggestion-addr";
        addr.textContent = ` · ${line.address}`;
        row.appendChild(addr);
      }
    }
    el.appendChild(row);
  }
  if (more) {
    const row = document.createElement("div");
    row.className = "map-cluster-tip-count";
    row.textContent = more;
    el.appendChild(row);
  }
  return el;
}

export default function KinMapBody({
  placed,
  rootPoint,
  rootLabel,
  rootInitials,
  colorOf,
  categoryOf,
  lit,
  nameFor,
  tooltipFor,
  selectedId,
  findHitId,
  onSelect,
  fitKey,
  revealRef,
}: Props) {
  const { t } = useTranslation();
  const { settings: appSettings, set: setAppSettings } = useSettings();
  const theme = useDocTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.Layer | null>(null);
  const overlayLayersRef = useRef<LiveOverlays>(new Map());
  const markersRef = useRef<L.LayerGroup | null>(null);
  const didFitRef = useRef(false);
  const [viewGen, setViewGen] = useState(0);
  const [panel, setPanel] = useState<MapCluster | null>(null);

  const points = useMemo(() => placed.map((p) => p.point), [placed]);
  const byId = useMemo(() => new Map(placed.map((p) => [p.person.id, p])), [placed]);
  const latestPoints = useRef(points);
  latestPoints.current = points;
  const tRef = useRef(t);
  tRef.current = t;

  // ── Map lifecycle ──────────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = L.map(el, { minZoom: 2, maxZoom: 18, worldCopyJump: true, attributionControl: false });
    L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);
    L.control.scale({ position: "bottomleft", metric: true, imperial: false, maxWidth: 130 }).addTo(map);
    (el as HTMLDivElement & { _leafletMap?: L.Map })._leafletMap = map;
    map.setView([46.1, 14.5], 5);
    markersRef.current = L.layerGroup().addTo(map);
    addFitControl(map, tRef.current("map.fit"), () => boundsOfCoords(latestPoints.current.map((p) => p.coord)));
    const bump = () => setViewGen((g) => g + 1);
    map.on("moveend zoomend", bump);
    mapRef.current = map;
    const overlayLayers = overlayLayersRef.current;
    return () => {
      map.off("moveend zoomend", bump);
      removeMap(map);
      mapRef.current = null;
      baseLayerRef.current = null;
      overlayLayers.clear();
      markersRef.current = null;
    };
  }, []);

  // Base layer: opt-in provider tiles, else the bundled offline outline — and
  // the outline is a vector layer, so it goes under the markers already drawn.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    baseLayerRef.current?.remove();
    const base = createBaseLayer(appSettings.allowMapTiles, appSettings.mapBasemap, appSettings.mapTileUrl, theme).addTo(map);
    if (base instanceof L.GeoJSON) base.bringToBack();
    baseLayerRef.current = base;
  }, [appSettings.allowMapTiles, appSettings.mapBasemap, appSettings.mapTileUrl, theme]);

  // Historical overlays: no picker here — the layers marked "show by default"
  // in Settings, like the small place maps. Remote tiles, so the same opt-in.
  const defaultOverlays = useMemo(
    () => appSettings.mapOverlays.map(resolveOverlay).filter((o) => o.defaultOn),
    [appSettings.mapOverlays],
  );
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    syncOverlayLayers(map, overlayLayersRef.current, defaultOverlays, {
      enabled: appSettings.allowMapTiles,
      isOn: () => true,
    });
  }, [defaultOverlays, appSettings.allowMapTiles]);

  // Frame the dots once they are there, and again for a new subject.
  useEffect(() => {
    didFitRef.current = false;
  }, [fitKey]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || didFitRef.current) return;
    const coords = [...points.map((p) => p.coord), ...(rootPoint ? [rootPoint.coord] : [])];
    if (!coords.length) return;
    didFitRef.current = true;
    const bounds = boundsOfCoords(coords)!;
    map.fitBounds(bounds.pad(0.1), { maxZoom: 10, animate: false });
  }, [points, rootPoint]);

  // The find box: fly to the person and let the marker pass mark the hit.
  useEffect(() => {
    revealRef.current = (id: string) => {
      const map = mapRef.current;
      const hit = byId.get(id);
      if (!map || !hit) return;
      map.flyTo([hit.point.coord.lat, hit.point.coord.lon], Math.max(map.getZoom(), FIND_ZOOM), { duration: 0.6 });
    };
    return () => {
      revealRef.current = null;
    };
  }, [byId, revealRef]);

  const openCluster = useCallback((cluster: MapCluster) => {
    const map = mapRef.current;
    if (!map) return;
    if (cluster.points.length > PANEL_MAX_POINTS && map.getZoom() < PANEL_MIN_ZOOM) {
      map.setView([cluster.lat, cluster.lon], map.getZoom() + 2);
    } else {
      setPanel(cluster);
    }
  }, []);

  // ── Markers: cluster the dots for the current view ────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    const layer = markersRef.current;
    if (!map || !layer) return;
    const zoom = map.getZoom();
    const view = map.getBounds().pad(0.3);
    layer.clearLayers();
    const clusters = clusterPoints(points, zoom).filter((c) => view.contains([c.lat, c.lon]));
    for (const cluster of clusters) {
      const members = cluster.points.map((p) => byId.get(p.personIds[0])!).filter(Boolean);
      const count = members.length;
      const size = markerSize(count);
      const litMembers = members.filter((m) => lit(m.person));
      const groups = new Set(members.map((m) => categoryOf(m.person)));
      const colour = groups.size === 1 ? colorOf(members[0].person) : "var(--map-mixed)";
      const ids = members.map((m) => m.person.id);
      const cls = [
        "map-cluster-dot",
        "kin-map-dot",
        litMembers.length ? "" : "dim",
        selectedId && ids.includes(selectedId) ? "selected" : "",
        findHitId && ids.includes(findHitId) ? "find-hit" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const marker = L.marker([cluster.lat, cluster.lon], {
        icon: L.divIcon({
          className: "map-cluster",
          html: `<div class="${cls}" style="background:${colour};width:${size}px;height:${size}px">${count > 1 ? count : ""}</div>`,
          iconSize: [size, size],
        }),
        keyboard: false,
      });
      // Every tooltip opens with where the marker stands — the place is what a
      // map is read for — then who is there.
      if (count === 1) {
        const m = members[0];
        marker.on("click", () => onSelect(m.person.id));
        marker.bindTooltip(
          tooltipEl(
            [...tooltipPlaces([m.point]), tooltipFor(m.person)],
            t(`event.${m.point.tag}`, { defaultValue: m.point.tag }),
          ),
          { direction: "top", opacity: 0.9 },
        );
      } else {
        marker.on("click", () => openCluster(cluster));
        const names = members.slice(0, TOOLTIP_MAX_NAMES).map((m) => nameFor(m.person));
        if (count > TOOLTIP_MAX_NAMES) names.push(`… +${count - TOOLTIP_MAX_NAMES}`);
        marker.bindTooltip(
          tooltipEl([...tooltipPlaces(cluster.points), ...names], t("kin.map.clusterTooltip", { count })),
          { direction: "top", opacity: 0.9 },
        );
      }
      layer.addLayer(marker);
    }
    // The root's hub: a hollow ring around their place, with their initials on
    // its shoulder. Hollow and inert on purpose — the relatives born in the
    // same village sit inside it and stay clickable, where a solid disc on top
    // would hide them.
    if (rootPoint) {
      const hub = L.marker([rootPoint.coord.lat, rootPoint.coord.lon], {
        icon: L.divIcon({
          className: "map-cluster",
          html: `<div class="kin-map-hub" title=""><span class="kin-map-hub-initials"></span></div>`,
          // Wider than the largest cluster marker, so the ring shows around a
          // village of relatives rather than under it.
          iconSize: [50, 50],
        }),
        keyboard: false,
        interactive: false,
        zIndexOffset: 1000,
      });
      // Text goes in through the DOM, not the HTML string: the initials and
      // the name are file data.
      hub.on("add", () => {
        const root = hub.getElement()?.querySelector<HTMLElement>(".kin-map-hub");
        if (!root) return;
        root.title = rootLabel;
        const badge = root.querySelector(".kin-map-hub-initials");
        if (badge) badge.textContent = rootInitials;
      });
      layer.addLayer(hub);
    }
    // viewGen re-runs this pass after every pan/zoom.
  }, [points, byId, viewGen, lit, categoryOf, colorOf, selectedId, findHitId, onSelect, openCluster, nameFor, tooltipFor, rootPoint, rootLabel, rootInitials, t]);

  // The list would go stale under a changed set of dots.
  useEffect(() => setPanel(null), [points]);

  const panelRows = useMemo(() => {
    if (!panel) return [];
    return panel.points.map((p) => byId.get(p.personIds[0])!).filter(Boolean);
  }, [panel, byId]);
  /** The place(s) the listed relatives stand at — a marker merges a grid
   *  cell, so it can be several villages. */
  const panelPlaces = useMemo(() => (panel ? placeLines(panel.points) : []), [panel]);

  return (
    <>
      <div ref={containerRef} className="map-canvas" />
      {!appSettings.allowMapTiles && (
        <div className="map-tiles-notice">
          <span>{t("map.tilesNotice")}</span>
          <button type="button" onClick={() => setAppSettings({ allowMapTiles: true })}>
            {t("map.tilesEnable")}
          </button>
        </div>
      )}
      {panel && (
        <div className="map-panel">
          <div className="map-panel-header">
            <span className="map-panel-title">{t("kin.map.panelTitle", { count: panelRows.length })}</span>
            <button className="modal-close" onClick={() => setPanel(null)} title={t("help.close")} aria-label={t("help.close")}>
              ×
            </button>
          </div>
          {panelPlaces.length > 0 && (
            <div className="kin-map-places">
              {panelPlaces.slice(0, TOOLTIP_MAX_PLACES).map((l) => (
                <div key={`${l.place}\n${l.address ?? ""}`}>
                  {l.place}
                  {l.address && <span className="place-suggestion-addr"> · {l.address}</span>}
                </div>
              ))}
              {panelPlaces.length > TOOLTIP_MAX_PLACES && <div>… +{panelPlaces.length - TOOLTIP_MAX_PLACES}</div>}
            </div>
          )}
          <ul className="map-panel-list kin-map-list">
            {panelRows.map((m) => (
              <li key={m.person.id}>
                <button
                  type="button"
                  className={`kin-map-row${lit(m.person) ? "" : " dim"}`}
                  title={tooltipFor(m.person)}
                  onClick={() => {
                    onSelect(m.person.id);
                    setPanel(null);
                  }}
                >
                  <span className="map-kind-dot" style={{ background: colorOf(m.person) }} />
                  <span className="kin-map-row-name">{nameFor(m.person)}</span>
                  {m.person.years && <span className="gm-data kin-map-row-years">{m.person.years}</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

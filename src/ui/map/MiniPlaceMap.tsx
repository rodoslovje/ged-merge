import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoCoord } from "../../gedcom/types";
import { overlayDisplayName, useSettings } from "../SettingsContext";
import { createBaseLayer } from "./baseLayer";
import { addFitControl, boundsOfCoords } from "./fitControl";
import { removeMap } from "./removeMap";
import { ARROW_MIN_SEG_PX, PATH_STYLE, pathArrows } from "./markerStyle";
import { resolveOverlay, type CoverageBox } from "./overlayPresets";
import { syncOverlayLayers, type LiveOverlays } from "./overlayLayer";
import { identifyAt, identifyPopupHtml, queryableOverlays } from "./overlayIdentify";
import { arrowMarker, pathLegNumbers } from "./pathStops";
import { useDocTheme } from "./useDocTheme";

/** Draw the life path — polyline plus direction chevrons — into `layer`.
 *  The chevrons are screen-space (like the Map chart's), so this re-runs on
 *  zoom. */
function drawPath(map: L.Map, layer: L.LayerGroup | null, path: GeoCoord[] | undefined): void {
  if (!layer) return;
  layer.clearLayers();
  if (!path || path.length < 2) return;
  const color = getComputedStyle(document.documentElement).getPropertyValue("--map-path").trim();
  const latlngs = path.map((c) => [c.lat, c.lon] as [number, number]);
  layer.addLayer(
    L.polyline(latlngs, {
      color,
      weight: PATH_STYLE.weight,
      opacity: PATH_STYLE.opacitySelected,
      lineCap: "round",
      lineJoin: "round",
      interactive: false,
    }),
  );
  for (const m of pathLegNumbers(map, path)) layer.addLayer(m);
  const pts = latlngs.map((ll) => map.latLngToContainerPoint(ll));
  for (const a of pathArrows(pts, ARROW_MIN_SEG_PX)) layer.addLayer(arrowMarker(map, a));
}

/** Tooltip content as a DOM element — textContent, never HTML, because the
 *  labels carry file data (place names). The street address, when the events
 *  here name one, goes on its own row under the place, muted like the place
 *  picker's suggestions, and the coordinate closes the tooltip in the app's
 *  standing form: pinned, mono, five decimals. Caps the detail lines at 8. */
function tooltipEl(label: string, lines?: string[], sub?: string, coord?: GeoCoord): HTMLElement {
  const el = document.createElement("div");
  if (!lines?.length && !sub && !coord) {
    el.textContent = label;
    return el;
  }
  const head = document.createElement("div");
  head.className = "minimap-tip-title";
  head.textContent = label;
  el.appendChild(head);
  if (sub) {
    const addr = document.createElement("div");
    // Muted like an address anywhere else, but without the address pin: this
    // tooltip closes on the pin's own coordinate, and the two pins together
    // read as two positions where there is only one.
    addr.className = "minimap-tip-addr";
    addr.textContent = sub;
    el.appendChild(addr);
  }
  const shown = (lines ?? []).slice(0, 8);
  for (const line of shown) {
    const row = document.createElement("div");
    row.textContent = line;
    el.appendChild(row);
  }
  if ((lines?.length ?? 0) > shown.length) {
    const more = document.createElement("div");
    more.textContent = `… +${(lines?.length ?? 0) - shown.length}`;
    el.appendChild(more);
  }
  if (coord) {
    const at = document.createElement("div");
    at.className = "gm-data gm-coord gm-coord--set";
    at.textContent = `${coord.lat.toFixed(5)}, ${coord.lon.toFixed(5)}`;
    el.appendChild(at);
  }
  return el;
}

/** Bind a hover tooltip that flips below the marker when it sits in the top
 *  half of the map — a "top" tooltip there is clipped by the container's
 *  overflow:hidden (rounded corners), so pick the side with more room. */
function bindFlippingTooltip(map: L.Map, marker: L.CircleMarker | L.Marker, content: HTMLElement): void {
  marker.bindTooltip(content, { direction: "top", className: "minimap-tooltip" });
  // The container carries the map's own hint as a native `title`, and the
  // browser shows it for a hover anywhere inside — including on a pin, where it
  // lands beside the pin's tooltip as a second, vaguer label. The specific one
  // wins: the hint stands down while a pin tooltip is up and is put back after.
  // (React only re-applies `title` when the prop changes, so the restore has to
  // be ours.)
  let held = "";
  marker.on("tooltipopen", (e) => {
    const host = map.getContainer();
    if (host.title) {
      held = host.title;
      host.removeAttribute("title");
    }
    const dir = map.latLngToContainerPoint(marker.getLatLng()).y < map.getSize().y / 2 ? "bottom" : "top";
    if (e.tooltip.options.direction !== dir) {
      e.tooltip.options.direction = dir;
      e.tooltip.update();
    }
  });
  marker.on("tooltipclose", () => {
    if (!held) return;
    map.getContainer().title = held;
    held = "";
  });
}

// Small embedded map for the geocode review list: the row's candidate
// coordinates as clickable pins (click = pick that candidate), the currently
// chosen coordinate highlighted, and the file's already-known coordinates as
// faint context dots — the family cluster that tells "which Polica" apart.
// Lazy-loaded (with Leaflet) only when a row is expanded.

export interface MiniMapPin {
  coord: GeoCoord;
  /** Tooltip text (candidate name + score, or the chosen label) — the
   *  header line when `lines` follow. */
  label: string;
  /** Optional detail lines under the label (e.g. the events at this place),
   *  each rendered as its own row. */
  lines?: string[];
  /** Street address of the events pinned here, shown as a muted row directly
   *  under the label. */
  sub?: string;
  kind: "candidate" | "chosen";
  /** A count to draw inside the pin — how many events sit on this coordinate.
   *  Typed as a number so the marker's HTML can never carry injected markup. */
  badge?: number;
  /** CSS custom property naming this pin's colour (e.g. "--map-birth");
   *  defaults to the kind's standard colour. */
  colorVar?: string;
  /** This coordinate stands for a whole place, not a point on the ground (a
   *  settlement's own position among its houses). Drawn as a wide dashed ring
   *  so it reads as an area and does not compete with the house pins. */
  area?: boolean;
  /** Candidate pins: select this candidate for the row. */
  onPick?: () => void;
}

interface Props {
  pins: MiniMapPin[];
  /** Faint background dots: coordinates the file already carries, with the
   *  place name(s) written there as the hover tooltip. */
  context?: { coord: GeoCoord; name: string }[];
  /** Chronological stops of a life path, drawn as a direction-marked line
   *  under the pins (the Map chart's path style). */
  path?: GeoCoord[];
  /** Click on the map background: pick that point as a manual coordinate. */
  onPickCoord?: (coord: GeoCoord) => void;
  /** Tooltip for the map container (e.g. the click-to-pick hint). */
  title?: string;
  /** Identity of the shown subject (e.g. the Edit view's person id). When it
   *  changes the next pin pass re-fits the view — the map instance is reused
   *  across subjects instead of being remounted. */
  fitKey?: string;
  /** How far the automatic fit may zoom in. A lone pin has no extent of its
   *  own, so this alone decides what a single-coordinate map opens on: the
   *  default 11 frames the surrounding region, 13 the town. */
  fitMaxZoom?: number;
  /** What a map with nothing plotted on it should frame — the base-map sample
   *  in Settings. Changing it re-frames the map, and "Fit" restores it rather
   *  than doing nothing. Ignored as soon as there are pins or context dots.  */
  view?: MiniMapView;
}

/** An area to frame rather than a set of points. */
export interface MiniMapView {
  /** The ground to show, `[south, west, north, east]` in degrees. */
  box: CoverageBox;
  /** Never zoom out past this. A layer with a scale limit draws nothing at
   *  country zoom, so a wide box is shown at its centre at this zoom instead
   *  of being fitted whole — better a real sample than an empty one. */
  minZoom?: number;
  /** Never zoom in past this, however small the box. */
  maxZoom?: number;
  /** Bumped to re-apply a view the map is already framed on. The map follows
   *  changes of the view's *value*, so without this an asked-for reframe that
   *  lands on the same box and zoom as the last one is a no-op — and the user
   *  may have panned or zoomed away since. */
  nonce?: number;
}

/** Frame {@link MiniMapView.box}, within its zoom limits. Called again on
 *  resize because the fitting zoom depends on the container's size — which is
 *  0×0 while the map is still being laid out. */
function applyView(map: L.Map, view: MiniMapView): void {
  const bounds = L.latLngBounds([view.box[0], view.box[1]], [view.box[2], view.box[3]]);
  const fitted = map.getBoundsZoom(bounds);
  const zoom = Math.max(view.minZoom ?? 0, Math.min(view.maxZoom ?? map.getMaxZoom(), fitted));
  map.setView(bounds.getCenter(), zoom, { animate: false });
}

const NO_CONTEXT: NonNullable<Props["context"]> = [];

export default function MiniPlaceMap({
  pins,
  context = NO_CONTEXT,
  path,
  onPickCoord,
  title,
  fitKey,
  fitMaxZoom = 11,
  view,
}: Props) {
  const { settings: appSettings } = useSettings();
  const { t } = useTranslation();
  const theme = useDocTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.Layer | null>(null);
  /** Live overlay tile layers, keyed by overlay id (see syncOverlayLayers). */
  const overlayLayersRef = useRef<LiveOverlays>(new Map());
  /** Bumped on each identify click so a slow response that resolves after a
   *  newer click is ignored instead of clobbering the popup. */
  const infoSeqRef = useRef(0);
  const pinsLayerRef = useRef<L.LayerGroup | null>(null);
  const pathLayerRef = useRef<L.LayerGroup | null>(null);
  const didFitRef = useRef(false);
  /** The bounds of the last automatic fit, re-applied when the container
   *  resizes (or first gets its real size) until the user takes over. */
  const fitBoundsRef = useRef<L.LatLngBounds | null>(null);
  const userMovedRef = useRef(false);
  const latestPath = useRef(path);
  latestPath.current = path;
  // Latest pins/handler for the click handlers, so markers only rebuild when
  // the coordinates change, not on every parent render.
  const latestPins = useRef(pins);
  latestPins.current = pins;
  const latestPick = useRef(onPickCoord);
  latestPick.current = onPickCoord;
  const latestContext = useRef(context);
  latestContext.current = context;
  const latestFitMaxZoom = useRef(fitMaxZoom);
  latestFitMaxZoom.current = fitMaxZoom;
  const latestView = useRef(view);
  latestView.current = view;
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    // fadeAnimation off: the tile fade-in (and the programmatic fits below
    // being instant) keeps the little map from "performing" while it loads.
    const map = L.map(el, { minZoom: 2, maxZoom: 18, attributionControl: false, fadeAnimation: false });
    L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);
    map.setView([46.1, 14.5], 5);
    if (latestView.current) applyView(map, latestView.current);
    map.on("click", (e: L.LeafletMouseEvent) => {
      // wrap(): a click on a repeated world copy must not yield a longitude
      // outside ±180 — it would be written into the file as-is.
      const ll = e.latlng.wrap();
      latestPick.current?.({ lat: +ll.lat.toFixed(5), lon: +ll.lng.toFixed(5) });
    });
    // Framing what is plotted: the pins, or the context dots when a row has
    // none yet. Asked for at click time, so it follows the current subject.
    // With nothing plotted at all (the Settings sample) it puts the opening
    // view back, so the button is never dead.
    addFitControl(map, tRef.current("map.fit"), () => {
      const coords = latestPins.current.length
        ? latestPins.current.map((p) => p.coord)
        : latestContext.current.map((c) => c.coord);
      const framed = latestView.current;
      if (!coords.length && framed) {
        applyView(map, framed);
        return null;
      }
      return boundsOfCoords(coords);
    });
    pathLayerRef.current = L.layerGroup().addTo(map);
    pinsLayerRef.current = L.layerGroup().addTo(map);
    // The direction chevrons depend on on-screen segment lengths — redraw
    // the path when the zoom settles.
    const redraw = () => drawPath(map, pathLayerRef.current, latestPath.current);
    map.on("zoomend", redraw);
    // The container may not have its final size when Leaflet measures it
    // (lazy mount into a flowing layout) — the initial fitBounds then lands
    // on a wrong zoom. Re-measure and re-apply the fit on every container
    // size change until the user pans/zooms themselves.
    const markUser = () => {
      userMovedRef.current = true;
    };
    // Any pointer interaction (drag, double-click, the +/- zoom control) or
    // wheel zoom hands view control to the user — programmatic fits don't.
    el.addEventListener("pointerdown", markUser);
    el.addEventListener("wheel", markUser, { passive: true });
    const ro = new ResizeObserver(() => {
      map.invalidateSize();
      if (userMovedRef.current) return;
      // A framed view is re-fitted on every resize: its zoom is derived from
      // the container's size, and the first measurement is of a 0×0 box.
      if (latestView.current && !latestPins.current.length && !latestContext.current.length)
        applyView(map, latestView.current);
      else if (fitBoundsRef.current)
        map.fitBounds(fitBoundsRef.current, { maxZoom: latestFitMaxZoom.current, animate: false });
    });
    ro.observe(el);
    mapRef.current = map;
    const overlayLayers = overlayLayersRef.current;
    return () => {
      ro.disconnect();
      el.removeEventListener("pointerdown", markUser);
      el.removeEventListener("wheel", markUser);
      map.off("zoomend", redraw);
      removeMap(map);
      mapRef.current = null;
      baseLayerRef.current = null;
      overlayLayers.clear();
      pinsLayerRef.current = null;
      pathLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    baseLayerRef.current?.remove();
    const base = createBaseLayer(
      appSettings.allowMapTiles,
      appSettings.mapBasemap,
      appSettings.mapTileUrl,
      theme,
    ).addTo(map);
    // The offline outline is a vector layer added after the pins — push it
    // below them or its opaque land fill hides everything already drawn.
    if (base instanceof L.GeoJSON) base.bringToBack();
    baseLayerRef.current = base;
  }, [appSettings.allowMapTiles, appSettings.mapBasemap, appSettings.mapTileUrl, theme]);

  // Historical overlays: these small maps have no picker, so they draw exactly
  // the layers marked "show by default" in Settings, at the standard overlay
  // opacity. Remote tiles, so the same opt-in as the base gates them.
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

  // Click-to-identify, as on the full map: with a queryable overlay drawn (the
  // GURS house numbers, say), a click asks it what is at that pixel. It runs
  // alongside click-to-pick — the popup then names the point just picked.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const targets = appSettings.allowMapTiles ? queryableOverlays(defaultOverlays) : [];
    if (!targets.length) return;

    const onClick = async (e: L.LeafletMouseEvent) => {
      const seq = ++infoSeqRef.current;
      const blocks = await identifyAt(map, targets, e.latlng, (o) => overlayDisplayName(o, t), t);
      // A newer click superseded this one; a click on bare ground stays silent.
      if (seq !== infoSeqRef.current || !blocks.length) return;
      L.popup({ className: "map-info-popup" }).setLatLng(e.latlng).setContent(identifyPopupHtml(blocks)).openOn(map);
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [defaultOverlays, appSettings.allowMapTiles, t]);

  // A different area to frame (in Settings: a layer just switched on by
  // default, whose coverage is elsewhere) — go there, even if the user had
  // panned away, since asking for it is what changed the view.
  const viewKey = view ? [...view.box, view.minZoom, view.maxZoom, view.nonce].join(":") : "";
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !latestView.current || pins.length || context.length) return;
    userMovedRef.current = false;
    applyView(map, latestView.current);
  }, [viewKey, pins.length, context.length]);

  // A new subject on the same map instance: forget the previous fit and any
  // user pan/zoom so the next pin pass frames the new pins. Declared before
  // the pin effect — effects run in order.
  useEffect(() => {
    didFitRef.current = false;
    userMovedRef.current = false;
    fitBoundsRef.current = null;
  }, [fitKey]);

  // Positions/kinds as a value key: re-render markers only on real changes
  // (picking a candidate flips its kind to "chosen" — that is a real change).
  const pinsKey = pins
    .map((p) => `${p.coord.lat}:${p.coord.lon}:${p.kind}:${p.colorVar ?? ""}:${p.area ? "a" : ""}`)
    .join("|");
  const pathKey = (path ?? []).map((c) => `${c.lat}:${c.lon}`).join("|");
  // Value key, like pinsKey — a caller passing a fresh array identity per
  // render must not force a marker rebuild.
  const contextKey = context.map((c) => `${c.coord.lat}:${c.coord.lon}`).join("|");

  useEffect(() => {
    const map = mapRef.current;
    const group = pinsLayerRef.current;
    if (!map || !group) return;
    group.clearLayers();
    const styles = getComputedStyle(document.documentElement);
    const mutedColor = styles.getPropertyValue("--muted").trim();
    const candColor = styles.getPropertyValue("--accent").trim();
    const chosenColor = styles.getPropertyValue("--status-new").trim();
    for (const c of latestContext.current) {
      // Interactive for the name tooltip; clicks bubble on to the map, so
      // click-to-pick still works on top of a dot.
      const dot = L.circleMarker([c.coord.lat, c.coord.lon], {
        radius: 2.5,
        stroke: false,
        fillColor: mutedColor,
        fillOpacity: 0.4,
      });
      bindFlippingTooltip(map, dot, tooltipEl(c.name));
      dot.addTo(group);
    }
    latestPins.current.forEach((p, i) => {
      const chosen = p.kind === "chosen";
      const own = p.colorVar ? styles.getPropertyValue(p.colorVar).trim() : "";
      const color = own || (chosen ? chosenColor : candColor);
      // A badge pin is a real marker rather than a circle, so the number sits
      // inside it and a click on the digit still picks the pin.
      const marker =
        p.badge === undefined
          ? L.circleMarker([p.coord.lat, p.coord.lon], {
              // An area pin is wide and near-hollow: the houses drawn on top of
              // it stay readable, and its size is what says "the whole place".
              radius: p.area ? 17 : chosen ? 8 : 6.5,
              color,
              weight: 2,
              ...(p.area ? { dashArray: "5 4" } : {}),
              fillColor: color,
              fillOpacity: p.area ? 0.12 : chosen ? 0.85 : 0.45,
              // A pin click picks the pin — it must not double as a map click.
              bubblingMouseEvents: false,
            })
          : L.marker([p.coord.lat, p.coord.lon], {
              keyboard: false,
              icon: L.divIcon({
                className: "",
                html:
                  `<span class="mini-pin-badge${chosen ? " chosen" : ""}"` +
                  ` style="background:${color};border-color:${color}">${p.badge}</span>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12],
              }),
            });
      bindFlippingTooltip(map, marker, tooltipEl(p.label, p.lines, p.sub, p.coord));
      marker.on("click", () => latestPins.current[i]?.onPick?.());
      marker.addTo(group);
      // Whatever order the caller listed them in, the area ring belongs under
      // the houses standing on it.
      if (p.area && marker instanceof L.CircleMarker) marker.bringToBack();
    });
    // Zoom to the pins once (context dots frame themselves); later pin
    // changes (picking a candidate) keep the user's pan/zoom.
    if (!didFitRef.current) {
      const fitPts = latestPins.current.length
        ? latestPins.current.map((p) => p.coord)
        : latestContext.current.map((c) => c.coord);
      if (fitPts.length) {
        didFitRef.current = true;
        const bounds = L.latLngBounds(fitPts.map((c) => [c.lat, c.lon] as [number, number])).pad(0.3);
        fitBoundsRef.current = bounds;
        map.fitBounds(bounds, { maxZoom: latestFitMaxZoom.current, animate: false });
      }
    }
    drawPath(map, pathLayerRef.current, latestPath.current);
    // fitKey: two subjects with identical pins still re-fit (refs were reset).
  }, [pinsKey, pathKey, contextKey, theme, fitKey]);

  return (
    <div
      ref={containerRef}
      className={`tools-geo-minimap${onPickCoord ? " tools-geo-minimap--pick" : ""}`}
      title={title}
    />
  );
}

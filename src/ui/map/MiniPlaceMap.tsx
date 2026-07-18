import { useEffect, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeoCoord } from "../../gedcom/types";
import { useSettings } from "../SettingsContext";
import { createBaseLayer } from "./baseLayer";
import { ARROW_MIN_SEG_PX, PATH_STYLE, pathArrows } from "./markerStyle";
import { useDocTheme } from "./useDocTheme";

// Small embedded map for the geocode review list: the row's candidate
// coordinates as clickable pins (click = pick that candidate), the currently
// chosen coordinate highlighted, and the file's already-known coordinates as
// faint context dots — the family cluster that tells "which Polica" apart.
// Lazy-loaded (with Leaflet) only when a row is expanded.

export interface MiniMapPin {
  coord: GeoCoord;
  /** Tooltip text (candidate name + score, or the chosen label). */
  label: string;
  kind: "candidate" | "chosen";
  /** CSS custom property naming this pin's colour (e.g. "--map-birth");
   *  defaults to the kind's standard colour. */
  colorVar?: string;
  /** Candidate pins: select this candidate for the row. */
  onPick?: () => void;
}

interface Props {
  pins: MiniMapPin[];
  /** Faint background dots: coordinates the file already carries, with the
   *  place name(s) written there as the hover tooltip. */
  context: { coord: GeoCoord; name: string }[];
  /** Chronological stops of a life path, drawn as a direction-marked line
   *  under the pins (the Map chart's path style). */
  path?: GeoCoord[];
  /** Click on the map background: pick that point as a manual coordinate. */
  onPickCoord?: (coord: GeoCoord) => void;
  /** Tooltip for the map container (e.g. the click-to-pick hint). */
  title?: string;
}

export default function MiniPlaceMap({ pins, context, path, onPickCoord, title }: Props) {
  const { settings: appSettings } = useSettings();
  const theme = useDocTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.Layer | null>(null);
  const pinsLayerRef = useRef<L.LayerGroup | null>(null);
  const didFitRef = useRef(false);
  // Latest pins/handler for the click handlers, so markers only rebuild when
  // the coordinates change, not on every parent render.
  const latestPins = useRef(pins);
  latestPins.current = pins;
  const latestPick = useRef(onPickCoord);
  latestPick.current = onPickCoord;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || mapRef.current) return;
    const map = L.map(el, { minZoom: 2, maxZoom: 18, attributionControl: false });
    L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);
    map.setView([46.1, 14.5], 5);
    map.on("click", (e: L.LeafletMouseEvent) =>
      latestPick.current?.({ lat: +e.latlng.lat.toFixed(5), lon: +e.latlng.lng.toFixed(5) }),
    );
    pinsLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      baseLayerRef.current = null;
      pinsLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    baseLayerRef.current?.remove();
    baseLayerRef.current = createBaseLayer(appSettings.allowMapTiles, appSettings.mapTileUrl, theme).addTo(map);
  }, [appSettings.allowMapTiles, appSettings.mapTileUrl, theme]);

  // Positions/kinds as a value key: re-render markers only on real changes
  // (picking a candidate flips its kind to "chosen" — that is a real change).
  const pinsKey = pins.map((p) => `${p.coord.lat}:${p.coord.lon}:${p.kind}`).join("|");

  useEffect(() => {
    const map = mapRef.current;
    const group = pinsLayerRef.current;
    if (!map || !group) return;
    group.clearLayers();
    const styles = getComputedStyle(document.documentElement);
    const mutedColor = styles.getPropertyValue("--muted").trim();
    const candColor = styles.getPropertyValue("--accent").trim();
    const chosenColor = styles.getPropertyValue("--status-new").trim();
    for (const c of context) {
      // Interactive for the name tooltip; clicks bubble on to the map, so
      // click-to-pick still works on top of a dot.
      L.circleMarker([c.coord.lat, c.coord.lon], {
        radius: 2.5,
        stroke: false,
        fillColor: mutedColor,
        fillOpacity: 0.4,
      })
        .bindTooltip(c.name, { direction: "top" })
        .addTo(group);
    }
    latestPins.current.forEach((p, i) => {
      const chosen = p.kind === "chosen";
      const marker = L.circleMarker([p.coord.lat, p.coord.lon], {
        radius: chosen ? 8 : 6.5,
        color: chosen ? chosenColor : candColor,
        weight: 2,
        fillColor: chosen ? chosenColor : candColor,
        fillOpacity: chosen ? 0.85 : 0.45,
        // A pin click picks the pin — it must not double as a map click.
        bubblingMouseEvents: false,
      });
      marker.bindTooltip(p.label, { direction: "top" });
      marker.on("click", () => latestPins.current[i]?.onPick?.());
      marker.addTo(group);
    });
    // Zoom to the pins once (context dots frame themselves); later pin
    // changes (picking a candidate) keep the user's pan/zoom.
    if (!didFitRef.current) {
      const fitPts = latestPins.current.length ? latestPins.current.map((p) => p.coord) : context.map((c) => c.coord);
      if (fitPts.length) {
        didFitRef.current = true;
        map.fitBounds(L.latLngBounds(fitPts.map((c) => [c.lat, c.lon] as [number, number])).pad(0.3), { maxZoom: 11 });
      }
    }
  }, [pinsKey, context, theme]);

  return <div ref={containerRef} className="tools-geo-minimap" title={title} />;
}

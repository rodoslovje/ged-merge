import L from "leaflet";
import type { GeoCoord } from "../../gedcom/types";
import type { PathArrow } from "./markerStyle";

/** One direction chevron as a Leaflet marker — the shared renderer for the
 *  Map chart's paths and the mini map (same icon, same classes). */
export function arrowMarker(map: L.Map, a: PathArrow): L.Marker {
  return L.marker(map.containerPointToLatLng(L.point(a.x, a.y)), {
    interactive: false,
    keyboard: false,
    zIndexOffset: -1000,
    icon: L.divIcon({
      className: "map-path-arrow-wrap",
      html: `<svg class="map-path-arrow" viewBox="0 0 10 10" style="transform:rotate(${Math.round(a.angleDeg)}deg)"><path d="M1 1 L9 5 L1 9 Z"/></svg>`,
      iconSize: [10, 10],
      iconAnchor: [5, 5],
    }),
  });
}

/** Perpendicular offset of a leg number from the line, in screen px. */
const NUM_OFFSET_PX = 10;
/** Legs shorter than this on screen stay unlabelled (they reappear on zoom). */
const MIN_LEG_PX = 24;

/**
 * Journey-order numbers for a life path, drawn beside the line: each leg
 * (stop→stop segment) carries its number at the segment midpoint, offset to
 * the left of the travel direction — the node ends are crowded with markers
 * already. An A→B→A back-and-forth naturally puts the two numbers on
 * opposite sides of the shared line. Only for paths with more than two
 * stops; screen-space, so callers re-run this on zoom (both do already,
 * for the direction chevrons).
 * Used by the Edit-view mini map and the Map chart's selected path.
 */
export function pathLegNumbers(map: L.Map, stops: GeoCoord[]): L.Marker[] {
  if (stops.length <= 2) return [];
  const pts = stops.map((c) => map.latLngToContainerPoint([c.lat, c.lon]));
  const markers: L.Marker[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len = Math.hypot(vx, vy);
    if (len < MIN_LEG_PX) continue;
    const pos = map.containerPointToLatLng(
      L.point((a.x + b.x) / 2 + (-vy / len) * NUM_OFFSET_PX, (a.y + b.y) / 2 + (vx / len) * NUM_OFFSET_PX),
    );
    markers.push(
      L.marker(pos, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "map-path-legnum-wrap",
          html: `<span class="map-path-legnum">${i + 1}</span>`,
          iconSize: [0, 0],
        }),
      }),
    );
  }
  return markers;
}

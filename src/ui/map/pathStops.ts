import L from "leaflet";
import type { GeoCoord } from "../../gedcom/types";

/** Offset of the number chip from its stop, in screen px. */
const CHIP_OFFSET_PX = 16;

/**
 * Numbered order chips for a life path's stops — the line alone doesn't tell
 * a longer journey's order. Only for paths with more than two stops; a place
 * visited more than once joins its visit numbers in one chip ("2·5").
 *
 * Each chip is pushed a few screen px away from the path — along the bisector
 * pointing away from the adjacent segments — so it sits beside the line
 * rather than on the stop's marker. Screen-space, so callers re-run this on
 * zoom (both do already, for the direction chevrons).
 * Used by the Edit-view mini map and the Map chart's selected path.
 */
export function pathStopMarkers(map: L.Map, stops: GeoCoord[]): L.Marker[] {
  if (stops.length <= 2) return [];
  const pts = stops.map((c) => map.latLngToContainerPoint([c.lat, c.lon]));
  const byCoord = new Map<string, { i: number; nums: number[] }>();
  stops.forEach((c, i) => {
    const k = `${c.lat}:${c.lon}`;
    const hit = byCoord.get(k);
    if (hit) hit.nums.push(i + 1);
    else byCoord.set(k, { i, nums: [i + 1] });
  });
  const markers: L.Marker[] = [];
  for (const { i, nums } of byCoord.values()) {
    const p = pts[i];
    // Away-from-the-path direction: the inverted sum of the unit vectors to
    // the neighbouring stops (the outside of the bend).
    let dx = 0;
    let dy = 0;
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= pts.length) continue;
      const vx = pts[j].x - p.x;
      const vy = pts[j].y - p.y;
      const len = Math.hypot(vx, vy);
      if (len < 1) continue;
      dx -= vx / len;
      dy -= vy / len;
    }
    let len = Math.hypot(dx, dy);
    if (len < 0.3) {
      // The path runs straight through (or the stop is isolated): use the
      // perpendicular of the outgoing segment instead.
      const j = i + 1 < pts.length ? i + 1 : i - 1;
      const vx = pts[j].x - p.x;
      const vy = pts[j].y - p.y;
      const l = Math.hypot(vx, vy) || 1;
      dx = -vy / l;
      dy = vx / l;
      len = 1;
    }
    const pos = map.containerPointToLatLng(
      L.point(p.x + (dx / len) * CHIP_OFFSET_PX, p.y + (dy / len) * CHIP_OFFSET_PX),
    );
    markers.push(
      L.marker(pos, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "map-path-stopnum-wrap",
          html: `<span class="map-path-stopnum">${nums.join("·")}</span>`,
          iconSize: [0, 0],
        }),
      }),
    );
  }
  return markers;
}

import L from "leaflet";
import type { GeoCoord } from "../../gedcom/types";

/**
 * Numbered order chips for a life path's stops — the line alone doesn't tell
 * a longer journey's order. Only for paths with more than two stops; a place
 * visited more than once joins its visit numbers in one chip ("2·5").
 * Used by the Edit-view mini map and the Map chart's selected path.
 */
export function pathStopMarkers(stops: GeoCoord[]): L.Marker[] {
  if (stops.length <= 2) return [];
  const byCoord = new Map<string, { coord: GeoCoord; nums: number[] }>();
  stops.forEach((c, i) => {
    const k = `${c.lat}:${c.lon}`;
    const hit = byCoord.get(k);
    if (hit) hit.nums.push(i + 1);
    else byCoord.set(k, { coord: c, nums: [i + 1] });
  });
  return [...byCoord.values()].map(({ coord, nums }) =>
    L.marker([coord.lat, coord.lon], {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "map-path-stopnum-wrap",
        html: `<span class="map-path-stopnum">${nums.join("·")}</span>`,
        iconSize: [0, 0],
        // Nudged up-right so the chip sits beside the stop's pin.
        iconAnchor: [-7, 16],
      }),
    }),
  );
}

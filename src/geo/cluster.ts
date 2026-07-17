import type { MapPoint } from "./points";

// Grid-based point clustering in Web Mercator screen space: at a given zoom,
// points falling into the same fixed-size pixel cell merge into one cluster
// drawn at their mean position. Simple and fast enough for index-scale files
// (one pass, a Map of cells); no library needed.

/** Web Mercator projection to world pixels at a zoom level (256px tiles). */
export function lonToWorldX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 256 * 2 ** zoom;
}

export function latToWorldY(lat: number, zoom: number): number {
  // Clamp to the Mercator singularity like every web map does.
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * 2 ** zoom;
}

export interface MapCluster {
  /** Mean position of the member points. */
  lat: number;
  lon: number;
  points: MapPoint[];
}

/** Cell size in pixels — markers closer than this merge. */
const CELL_PX = 44;

/** Cluster the (already filtered) points for one zoom level. */
export function clusterPoints(points: MapPoint[], zoom: number): MapCluster[] {
  const cells = new Map<string, { sumLat: number; sumLon: number; points: MapPoint[] }>();
  for (const p of points) {
    const cx = Math.floor(lonToWorldX(p.coord.lon, zoom) / CELL_PX);
    const cy = Math.floor(latToWorldY(p.coord.lat, zoom) / CELL_PX);
    const key = `${cx}:${cy}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { sumLat: 0, sumLon: 0, points: [] };
      cells.set(key, cell);
    }
    cell.sumLat += p.coord.lat;
    cell.sumLon += p.coord.lon;
    cell.points.push(p);
  }
  return [...cells.values()].map((c) => ({
    lat: c.sumLat / c.points.length,
    lon: c.sumLon / c.points.length,
    points: c.points,
  }));
}

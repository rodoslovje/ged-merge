import type { MapCluster } from "../../geo/cluster";

// Shared marker presentation rules — the live DivIcon markers and the PNG
// export draw the same circles from the same data.

/** Marker diameter in px for a cluster of `count` points. */
export function markerSize(count: number): number {
  return count === 1 ? 12 : Math.min(42, Math.round(16 + 7 * Math.log10(count)));
}

/** The cluster's colour token: its single kind, or the mixed token. */
export function clusterColorVar(c: MapCluster): string {
  const kind = c.points[0].kind;
  return c.points.every((p) => p.kind === kind) ? `--map-${kind}` : "--map-mixed";
}

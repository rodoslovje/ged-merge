import type { MapCluster } from "../../geo/cluster";

// Shared marker presentation rules — the live DivIcon markers and the PNG
// export draw the same circles from the same data.

/** Marker diameter in px for a cluster of `count` points. */
export function markerSize(count: number): number {
  return count === 1 ? 12 : Math.min(42, Math.round(16 + 7 * Math.log10(count)));
}

/** The colour token for a set of event kinds: the single kind's token, or
 *  the mixed token — shared by the cluster markers and the Edit mini map. */
export function kindsColorVar(kinds: ReadonlySet<string>): string {
  return kinds.size === 1 ? `--map-${[...kinds][0]}` : "--map-mixed";
}

/** The cluster's colour token: its single kind, or the mixed token. */
export function clusterColorVar(c: MapCluster): string {
  return kindsColorVar(new Set(c.points.map((p) => p.kind)));
}

// ── Life-path presentation (same rules live + PNG export) ──────────────────

export const PATH_STYLE = {
  weight: 2,
  weightSelected: 3.5,
  opacity: 0.6,
  opacitySelected: 0.95,
  /** Other paths fade to this while one is selected. */
  opacityDimmed: 0.15,
} as const;

/** Direction chevrons: skip segments shorter than this on screen (px). */
export const ARROW_MIN_SEG_PX = 56;
/** …but a selected path shows direction even on short hops. */
export const ARROW_MIN_SEG_SELECTED_PX = 28;
/** Total chevron budget per rendered view, against divIcon clutter/cost. */
export const ARROW_MAX_TOTAL = 240;

export interface PathArrow {
  x: number;
  y: number;
  angleDeg: number;
}

/** Midpoint + bearing of each screen segment at least `minSegPx` long. */
export function pathArrows(pts: { x: number; y: number }[], minSegPx: number): PathArrow[] {
  const arrows: PathArrow[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    if (Math.hypot(dx, dy) < minSegPx) continue;
    arrows.push({
      x: (pts[i - 1].x + pts[i].x) / 2,
      y: (pts[i - 1].y + pts[i].y) / 2,
      angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
    });
  }
  return arrows;
}

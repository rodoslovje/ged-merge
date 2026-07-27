import { sameCoord, type MapEventKind, type MapPoint } from "./points";

// Life paths for the map: per person, the chronological sequence of their
// (already filtered) event points — birth → residences/marriages → death —
// ready to draw as a direction-marked polyline. Pure data like the rest of
// src/geo/; the React layer owns rendering and selection.

export interface PersonPath {
  personId: string;
  /** Chronological stops; consecutive events at the same coordinate merged. */
  stops: MapPoint[];
}

/** Life-stage rank breaking same-year ties: born before wed before buried. */
const STAGE_RANK: Record<MapEventKind, number> = {
  birth: 0,
  residence: 1,
  marriage: 1,
  other: 1,
  death: 2,
  burial: 3,
};

/**
 * Sort key for a stop: the event year, with undated life-boundary events
 * anchored to the ends (a birth with no date still starts the path, an
 * undated death/burial still ends it). Other undated events can't be placed
 * on the timeline and are left out (NaN).
 */
function stopYear(p: MapPoint): number {
  if (p.year !== undefined) return p.year;
  if (p.kind === "birth") return -Infinity;
  if (p.kind === "death" || p.kind === "burial") return Infinity;
  return NaN;
}

/**
 * Group the points by person and order each person's stops chronologically:
 * by year, then by life stage, then by the full date within the year (so two
 * residences in one year follow their months and days). Stable, so events that
 * stay tied keep their file order. Only persons whose path actually moves — at
 * least two stops at distinct coordinates — get a path; a family event
 * contributes a stop to both spouses' paths.
 */
export function buildPersonPaths(points: MapPoint[]): PersonPath[] {
  const byPerson = new Map<string, MapPoint[]>();
  for (const p of points) {
    if (Number.isNaN(stopYear(p))) continue;
    for (const id of p.personIds) {
      const list = byPerson.get(id);
      if (list) list.push(p);
      else byPerson.set(id, [p]);
    }
  }
  const paths: PersonPath[] = [];
  for (const [personId, list] of byPerson) {
    const sorted = [...list].sort((a, b) => {
      const ya = stopYear(a);
      const yb = stopYear(b);
      if (ya !== yb) return ya < yb ? -1 : 1;
      // Same year: the life stage still leads (a birth opens the year, a burial
      // closes it, whatever their precision), then the month/day inside it.
      // Sort is stable, so events tied on all three keep their file order.
      if (STAGE_RANK[a.kind] !== STAGE_RANK[b.kind]) return STAGE_RANK[a.kind] - STAGE_RANK[b.kind];
      return (a.dateKey ?? 0) - (b.dateKey ?? 0);
    });
    const stops: MapPoint[] = [];
    for (const p of sorted) {
      if (stops.length && sameCoord(stops[stops.length - 1].coord, p.coord)) continue;
      stops.push(p);
    }
    if (stops.length >= 2) paths.push({ personId, stops });
  }
  return paths;
}

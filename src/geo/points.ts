import type { Dataset, GedEvent, GeoCoord } from "../gedcom/types";

// The map's data layer: one pass over the dataset projecting every event that
// carries coordinates (PLAC.MAP lifted into GedPlace.coord by the builder)
// into flat MapPoint rows. Pure data — the React/Leaflet layer, the filters
// and the clustering all consume these rows.

/** Marker/filter grouping of event tags — one color per kind on the map. */
export type MapEventKind = "birth" | "marriage" | "death" | "burial" | "residence" | "other";

export const MAP_EVENT_KINDS: MapEventKind[] = ["birth", "marriage", "death", "burial", "residence", "other"];

const KIND_BY_TAG: Record<string, MapEventKind> = {
  BIRT: "birth",
  CHR: "birth",
  BAPM: "birth",
  MARR: "marriage",
  MARB: "marriage",
  ENGA: "marriage",
  DEAT: "death",
  BURI: "burial",
  CREM: "burial",
  _INTE: "burial",
  _FNRL: "burial",
  RESI: "residence",
  CENS: "residence",
  EMIG: "residence",
  IMMI: "residence",
};

/** The map kind an event tag belongs to. */
export function eventKindOf(tag: string): MapEventKind {
  return KIND_BY_TAG[tag] ?? "other";
}

/** Exact coordinate equality (the review UIs' "is this the chosen pin" test);
 *  tolerant of either side missing. */
export function sameCoord(a: GeoCoord | undefined, b: GeoCoord | undefined): boolean {
  return !!a && !!b && a.lat === b.lat && a.lon === b.lon;
}

/** One plottable event occurrence. */
export interface MapPoint {
  /** Everyone the event belongs to — the individual, or both spouses of a
   *  family event. Scope filtering keeps the point when any of them is in
   *  scope; the popover lists them all. */
  personIds: string[];
  /** Set when the point comes from a family (FAM) event such as MARR. */
  familyId?: string;
  tag: string;
  kind: MapEventKind;
  /** Primary year of the event's date, when dated. */
  year?: number;
  /** Place display text (the raw PLAC value). */
  place: string;
  /** Raw ADDR value, set only when `coord` is the address's own house-precise
   *  coordinate rather than the place's — so the popup can show what was
   *  actually pinned. */
  address?: string;
  coord: GeoCoord;
}

function pointFrom(event: GedEvent, personIds: string[], familyId?: string): MapPoint | undefined {
  // The address coordinate wins where there is one: it locates the actual house
  // (from the address register), while the place coordinate is the settlement it
  // stands in. The place remains the fallback, and stays the display text.
  const coord = event.address?.coord ?? event.place?.coord;
  if (!coord) return undefined;
  const point: MapPoint = {
    personIds,
    tag: event.tag,
    kind: eventKindOf(event.tag),
    place: event.place?.raw ?? event.address!.raw,
    coord,
  };
  if (event.address?.coord) point.address = event.address.raw;
  if (familyId) point.familyId = familyId;
  if (event.date?.year !== undefined) point.year = event.date.year;
  return point;
}

/**
 * Project every coordinate-carrying event of the dataset into MapPoint rows —
 * individuals' events first, then family events (attributed to both spouses).
 */
export function projectPoints(ds: Dataset): MapPoint[] {
  const points: MapPoint[] = [];
  for (const indi of ds.individuals.values()) {
    for (const event of indi.events) {
      const p = pointFrom(event, [indi.id]);
      if (p) points.push(p);
    }
  }
  for (const fam of ds.families.values()) {
    const spouses = [fam.husband, fam.wife].filter((id): id is string => !!id);
    if (!spouses.length) continue;
    for (const event of fam.events) {
      const p = pointFrom(event, spouses, fam.id);
      if (p) points.push(p);
    }
  }
  return points;
}

/** One person's coordinate-carrying events — their own plus the events of
 *  every family they are a spouse in (marriages etc.), for the Edit-page
 *  mini map. Same shape the full map's projector produces. */
export function personPoints(ds: Dataset, personId: string): MapPoint[] {
  const indi = ds.individuals.get(personId);
  if (!indi) return [];
  const points: MapPoint[] = [];
  for (const event of indi.events) {
    const p = pointFrom(event, [indi.id]);
    if (p) points.push(p);
  }
  for (const famId of indi.spouseOf) {
    const fam = ds.families.get(famId);
    if (!fam) continue;
    const spouses = [fam.husband, fam.wife].filter((id): id is string => !!id);
    for (const event of fam.events) {
      const p = pointFrom(event, spouses.length ? spouses : [personId], famId);
      if (p) points.push(p);
    }
  }
  return points;
}

/** The dated year range covered by the points, for seeding the year filter. */
export function yearRange(points: MapPoint[]): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.year === undefined) continue;
    if (p.year < min) min = p.year;
    if (p.year > max) max = p.year;
  }
  return min <= max ? { min, max } : undefined;
}

export interface MapPointFilter {
  /** Kinds to keep. */
  kinds: ReadonlySet<MapEventKind>;
  /** Inclusive year bounds; undefined end = unbounded. */
  yearFrom?: number;
  yearTo?: number;
  /** Keep events with no date at all. */
  includeUndated: boolean;
  /** When set, keep only points involving one of these persons. */
  personIds?: ReadonlySet<string>;
  /** When set, drop any point involving one of these persons (living-privacy). */
  excludePersonIds?: ReadonlySet<string>;
}

/** Apply the map's filters to the projected points. */
export function filterPoints(points: MapPoint[], f: MapPointFilter): MapPoint[] {
  return points.filter((p) => {
    if (!f.kinds.has(p.kind)) return false;
    if (p.year === undefined) {
      if (!f.includeUndated) return false;
    } else {
      if (f.yearFrom !== undefined && p.year < f.yearFrom) return false;
      if (f.yearTo !== undefined && p.year > f.yearTo) return false;
    }
    if (f.personIds && !p.personIds.some((id) => f.personIds!.has(id))) return false;
    if (f.excludePersonIds && p.personIds.some((id) => f.excludePersonIds!.has(id))) return false;
    return true;
  });
}

/**
 * The ancestor closure of a person (via FAMC → parents), or the descendant
 * closure (via FAMS → children), root included — the map's branch scopes.
 */
export function branchIds(ds: Dataset, rootId: string, mode: "ancestors" | "descendants"): Set<string> {
  const out = new Set<string>();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.pop()!;
    if (out.has(id)) continue;
    const indi = ds.individuals.get(id);
    if (!indi) continue;
    out.add(id);
    if (mode === "ancestors") {
      for (const famId of indi.childOf) {
        const fam = ds.families.get(famId);
        if (fam?.husband) queue.push(fam.husband);
        if (fam?.wife) queue.push(fam.wife);
      }
    } else {
      for (const famId of indi.spouseOf) {
        const fam = ds.families.get(famId);
        if (fam) queue.push(...fam.children);
      }
    }
  }
  return out;
}

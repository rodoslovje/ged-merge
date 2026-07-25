import type { Dataset, GedNode, GeoCoord } from "../gedcom/types";
import type { RecordPatch } from "../ui/historyTypes";
import { applyGeocodeByAddress, coordOf, placeAddrKey, walkPlaceAddr, type GeoAssignment } from "./geocode";

// Health-check for places geocoded inconsistently. Two findings, both grouped by
// the place *and* the event's address:
//
//  - **Fillable**: the pair carries a coordinate on some events and not others.
//    Happens naturally when an event is added or re-typed after the file was
//    geocoded (GEDCOM 5.5.1 has no shared place record, so every PLAC keeps its
//    own MAP). Safe to fix without a lookup — copy the one it already has.
//  - **Conflicting**: the pair carries two *different* coordinates. Same place,
//    same address, so they describe one location and cannot both be right. No
//    automatic fix: which is correct is a judgement only the researcher can make.
//
// Grouping by the pair is what makes both precise. A place value alone is shared
// by every event naming it, but two events in "Kranj" at different addresses are
// different locations and *should* hold different coordinates — grouping by place
// alone would call that an inconsistency and, worse, offer to "fix" it by copying
// one house's position across the settlement. Same pair, differing coordinates is
// the genuine error, and that is exactly what the conflict finding reports.

/** A place+address pair coordinated on some occurrences but not others. */
export interface SplitCoordPlace {
  /** The exact raw PLAC value. */
  value: string;
  /** The event's raw ADDR value ("" when it has none). */
  address: string;
  /** The coordinate to copy — the most frequent one the pair already carries. */
  coord: GeoCoord;
  /** Occurrences that already carry a coordinate. */
  covered: number;
  /** Occurrences missing one (what the fix fills in). */
  missing: number;
}

/** A place+address pair carrying two or more different coordinates. */
export interface CoordConflict {
  /** The exact raw PLAC value. */
  value: string;
  /** The event's raw ADDR value ("" when it has none). */
  address: string;
  /** The distinct coordinates found, most frequent first, with their counts. */
  coords: { coord: GeoCoord; n: number }[];
}

export interface PlaceCoordReport {
  /** Pairs whose missing coordinates can be filled from the file. */
  fills: SplitCoordPlace[];
  /** Pairs that disagree with themselves. */
  conflicts: CoordConflict[];
}

/** Coordinates within this many degrees (~55 m) describe the same spot. Files
 *  accumulate harmless variants — different rounding, a re-geocode a few metres
 *  off — and calling those a contradiction would bury the real ones. */
const SAME_SPOT_DEG = 0.0005;

/** Group distinct coordinates into clusters of "the same spot", most-used first.
 *  One cluster ⇒ the pair agrees with itself; more ⇒ a genuine conflict. */
function clusterCoords(coords: { coord: GeoCoord; n: number }[]): { coord: GeoCoord; n: number }[][] {
  const clusters: { coord: GeoCoord; n: number }[][] = [];
  for (const entry of [...coords].sort((a, b) => b.n - a.n)) {
    const near = clusters.find((cluster) =>
      cluster.some(
        (c) =>
          Math.abs(c.coord.lat - entry.coord.lat) < SAME_SPOT_DEG &&
          Math.abs(c.coord.lon - entry.coord.lon) < SAME_SPOT_DEG,
      ),
    );
    if (near) near.push(entry);
    else clusters.push([entry]);
  }
  return clusters;
}

interface Group {
  value: string;
  address: string;
  coords: Map<string, { coord: GeoCoord; n: number }>;
  covered: number;
  missing: number;
}

/** Group every PLAC occurrence by (place value, event address). */
function groupByPair(dataset: Dataset): Map<string, Group> {
  const groups = new Map<string, Group>();
  const visit = (raw: GedNode) =>
    walkPlaceAddr(raw, (plac, address) => {
      const value = plac.value!.trim();
      const key = placeAddrKey(value, address);
      let g = groups.get(key);
      if (!g) {
        g = { value, address, coords: new Map(), covered: 0, missing: 0 };
        groups.set(key, g);
      }
      const coord = coordOf(plac);
      if (!coord) {
        g.missing++;
      } else {
        g.covered++;
        const ck = `${coord.lat}:${coord.lon}`;
        const hit = g.coords.get(ck);
        if (hit) hit.n++;
        else g.coords.set(ck, { coord, n: 1 });
      }
    });
  for (const indi of dataset.individuals.values()) visit(indi.raw);
  for (const fam of dataset.families.values()) visit(fam.raw);
  return groups;
}

/**
 * Scan for both coordinate problems. Fills are sorted by how many occurrences
 * each would complete; conflicts by how many occurrences are involved.
 */
export function scanPlaceCoords(dataset: Dataset): PlaceCoordReport {
  const fills: SplitCoordPlace[] = [];
  const conflicts: CoordConflict[] = [];
  for (const g of groupByPair(dataset).values()) {
    if (!g.coords.size) continue;
    const clusters = clusterCoords([...g.coords.values()]);
    if (clusters.length > 1) {
      // Disagrees with itself: report, and do not also offer to fill from it —
      // which coordinate to copy is precisely what is unresolved.
      conflicts.push({ value: g.value, address: g.address, coords: clusters.map((c) => c[0]) });
      continue;
    }
    // One spot, possibly recorded with harmless rounding variants: fill the
    // occurrences that have none from the most frequently used exact value.
    if (g.missing > 0) {
      fills.push({ value: g.value, address: g.address, coord: clusters[0][0].coord, covered: g.covered, missing: g.missing });
    }
  }
  fills.sort((a, b) => b.missing - a.missing || a.value.localeCompare(b.value));
  conflicts.sort((a, b) => {
    const an = a.coords.reduce((s, c) => s + c.n, 0);
    const bn = b.coords.reduce((s, c) => s + c.n, 0);
    return bn - an || a.value.localeCompare(b.value);
  });
  return { fills, conflicts };
}

/** Total occurrences the fix would fill (sum of `missing` across findings). */
export function countSplitCoordFills(places: SplitCoordPlace[]): number {
  return places.reduce((sum, p) => sum + p.missing, 0);
}

/**
 * Copy each pair's file coordinate onto its coordinate-less occurrences, through
 * the pair-keyed geocode write-back (standard `MAP`/`LATI`/`LONG`, undoable), so
 * a coordinate never crosses from one address to another. Mutates the dataset in
 * place and returns the RecordPatch[] for the undo stack.
 */
export function fillPlaceCoordsFromFile(dataset: Dataset): RecordPatch[] {
  const assignments = new Map<string, GeoAssignment>();
  for (const p of scanPlaceCoords(dataset).fills) assignments.set(placeAddrKey(p.value, p.address), { coord: p.coord });
  return applyGeocodeByAddress(dataset, assignments);
}

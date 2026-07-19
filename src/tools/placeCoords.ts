import type { Dataset, GedNode, GeoCoord } from "../gedcom/types";
import type { RecordPatch } from "../ui/historyTypes";
import { applyGeocode, coordOf, walkPlacNodes, type GeoAssignment } from "./geocode";

// Health-check for places geocoded inconsistently: a place string that carries
// a coordinate on some occurrences but not on others. This happens naturally
// when an event is added or re-typed after the rest of the file was geocoded
// (GEDCOM 5.5.1 has no shared place record, so every PLAC keeps its own MAP).
// The fix is safe and needs no lookup — copy the coordinate the value already
// carries elsewhere onto the occurrences that lack one (the same "from this
// file" proposal the Geocode-places tool makes), through the edit/undo pipeline.

/** One place value coordinated on some occurrences but not others. */
export interface SplitCoordPlace {
  /** The exact raw PLAC value. */
  value: string;
  /** The coordinate to copy — the most frequent one the value already carries. */
  coord: GeoCoord;
  /** Occurrences that already carry a coordinate. */
  covered: number;
  /** Occurrences missing one (what the fix fills in). */
  missing: number;
}

/**
 * Find every place value that is coordinated on some occurrences and not on
 * others, with the coordinate to copy onto the missing ones. Values that are
 * fully coordinated, or that carry no coordinate anywhere (nothing to copy),
 * are not reported — the latter belong to the Geocode-places tool, which looks
 * coordinates up. Sorted by how many occurrences the fix would fill.
 */
export function scanSplitCoordPlaces(dataset: Dataset): SplitCoordPlace[] {
  const groups = new Map<string, { coords: Map<string, { coord: GeoCoord; n: number }>; covered: number; missing: number }>();
  const visit = (raw: GedNode) =>
    walkPlacNodes(raw, (plac) => {
      const key = plac.value!.trim();
      let g = groups.get(key);
      if (!g) {
        g = { coords: new Map(), covered: 0, missing: 0 };
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

  const out: SplitCoordPlace[] = [];
  for (const [value, g] of groups) {
    if (g.missing === 0 || g.coords.size === 0) continue;
    const coord = [...g.coords.values()].sort((a, b) => b.n - a.n)[0].coord;
    out.push({ value, coord, covered: g.covered, missing: g.missing });
  }
  out.sort((a, b) => b.missing - a.missing || a.value.localeCompare(b.value));
  return out;
}

/** Total occurrences the fix would fill (sum of `missing` across findings). */
export function countSplitCoordFills(places: SplitCoordPlace[]): number {
  return places.reduce((sum, p) => sum + p.missing, 0);
}

/**
 * Copy each split value's file coordinate onto its coordinate-less occurrences,
 * through the shared geocode write-back (standard `MAP`/`LATI`/`LONG`, undoable).
 * Mutates the dataset in place and returns the RecordPatch[] for the undo stack.
 */
export function fillPlaceCoordsFromFile(dataset: Dataset): RecordPatch[] {
  const assignments = new Map<string, GeoAssignment>();
  for (const p of scanSplitCoordPlaces(dataset)) assignments.set(p.value, { coord: p.coord });
  return applyGeocode(dataset, assignments);
}

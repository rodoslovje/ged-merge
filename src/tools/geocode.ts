import type { Dataset, GedNode, GeoCoord } from "../gedcom/types";
import { firstChild } from "../gedcom/node";
import { parseCoordPair } from "../gedcom/place";
import { rebuildFamily, rebuildIndividual, setPlaceCoord } from "../gedcom/edit";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";
import { HIGH_CONFIDENCE, lookupPlace, type GazCandidate, type GazetteerIndex } from "../geo/gazetteer";
import type { GeocodeDecision } from "../persist/geoDb";

// The Geocode-places tool (MAPVIEW.md phase 2): scan the file's distinct
// PLAC strings, propose gazetteer candidates for the ones without
// coordinates, and — after explicit user review — write accepted coordinates
// back as standard MAP/LATI/LONG through the edit pipeline (mirroring
// applyPlaceRename), so they land in the saved file and on the Map chart.
// "No match" decisions live only in the IndexedDB cache, never in the file.

/** One distinct raw PLAC value and its geocode status. */
export interface GeocodeRow {
  /** The exact raw PLAC value (grouping key and write-back matcher). */
  key: string;
  /** Total PLAC occurrences of this value. */
  count: number;
  /** Occurrences still lacking a parseable MAP coordinate. */
  missing: number;
  /** Gazetteer proposals for the missing ones, best first. */
  candidates: GazCandidate[];
  /** True when the best candidate is safe for bulk-accept: confident score
   *  and not ambiguous (no runner-up within a hair of it). */
  confident: boolean;
  /** Cached decision from an earlier session/file, when one exists. */
  cached?: GeocodeDecision;
}

export interface GeocodeScan {
  /** Rows that still need coordinates, candidates first, by usage. */
  rows: GeocodeRow[];
  /** Distinct place strings that already have coordinates everywhere. */
  coveredDistinct: number;
  /** Total PLAC occurrences in the file / occurrences already carrying coordinates. */
  totalOccurrences: number;
  coveredOccurrences: number;
}

/** A PLAC node has a usable coordinate when MAP → LATI/LONG parses. */
function hasCoord(plac: GedNode): boolean {
  const map = firstChild(plac, "MAP");
  const lati = map && firstChild(map, "LATI")?.value;
  const long = map && firstChild(map, "LONG")?.value;
  return !!(lati && long && parseCoordPair(lati, long));
}

function walkPlacNodes(node: GedNode, visit: (plac: GedNode) => void): void {
  for (const child of node.children) {
    if (child.tag === "PLAC" && child.value?.trim()) visit(child);
    walkPlacNodes(child, visit);
  }
}

/** Ambiguity guard for bulk accept: runner-up must trail the best clearly. */
const AMBIGUITY_GAP = 0.05;

/**
 * Scan every PLAC value in the file, group by exact raw value, and propose
 * candidates (when a gazetteer is loaded) for the values missing coordinates.
 */
export function scanGeocode(
  dataset: Dataset,
  index: GazetteerIndex | undefined,
  decisions: ReadonlyMap<string, GeocodeDecision>,
): GeocodeScan {
  const groups = new Map<string, { count: number; missing: number }>();
  const visit = (plac: GedNode) => {
    const key = plac.value!.trim();
    let g = groups.get(key);
    if (!g) {
      g = { count: 0, missing: 0 };
      groups.set(key, g);
    }
    g.count++;
    if (!hasCoord(plac)) g.missing++;
  };
  for (const indi of dataset.individuals.values()) walkPlacNodes(indi.raw, visit);
  for (const fam of dataset.families.values()) walkPlacNodes(fam.raw, visit);

  const rows: GeocodeRow[] = [];
  let coveredDistinct = 0;
  let totalOccurrences = 0;
  let coveredOccurrences = 0;
  for (const [key, g] of groups) {
    totalOccurrences += g.count;
    coveredOccurrences += g.count - g.missing;
    if (!g.missing) {
      coveredDistinct++;
      continue;
    }
    const candidates = index ? lookupPlace(index, key) : [];
    const best = candidates[0];
    const confident =
      !!best &&
      best.score >= HIGH_CONFIDENCE &&
      (candidates.length < 2 || candidates[1].score <= best.score - AMBIGUITY_GAP);
    const row: GeocodeRow = { key, count: g.count, missing: g.missing, candidates, confident };
    const cached = decisions.get(key);
    if (cached) row.cached = cached;
    rows.push(row);
  }
  rows.sort((a, b) => {
    const aHas = a.candidates.length || a.cached?.status === "accepted" ? 1 : 0;
    const bHas = b.candidates.length || b.cached?.status === "accepted" ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return b.missing - a.missing || a.key.localeCompare(b.key);
  });
  return { rows, coveredDistinct, totalOccurrences, coveredOccurrences };
}

/**
 * Write accepted coordinates into every PLAC node whose exact value matches
 * an assignment and that still lacks a coordinate. Mutates the dataset in
 * place and returns RecordPatch[] for the unified undo stack.
 */
export function applyGeocode(dataset: Dataset, assignments: ReadonlyMap<string, GeoCoord>): RecordPatch[] {
  const patches: RecordPatch[] = [];
  const applyToRecord = (raw: GedNode): boolean => {
    let changed = false;
    walkPlacNodes(raw, (plac) => {
      const coord = assignments.get(plac.value!.trim());
      if (!coord || hasCoord(plac)) return;
      setPlaceCoord(plac, coord);
      changed = true;
    });
    return changed;
  };
  for (const indi of dataset.individuals.values()) {
    const before = cloneRaw(indi.raw);
    if (applyToRecord(indi.raw)) {
      rebuildIndividual(dataset, indi);
      patches.push({ type: "individual", id: indi.id, before, after: cloneRaw(indi.raw) });
    }
  }
  for (const fam of dataset.families.values()) {
    const before = cloneRaw(fam.raw);
    if (applyToRecord(fam.raw)) {
      rebuildFamily(dataset, fam);
      patches.push({ type: "family", id: fam.id, before, after: cloneRaw(fam.raw) });
    }
  }
  return patches;
}

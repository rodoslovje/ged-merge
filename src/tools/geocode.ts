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
  /** The coordinate other occurrences of this exact value already carry in
   *  the file (the most frequent one, when several disagree) — the strongest
   *  possible proposal: same file, same spelling, someone already placed it. */
  fileCoord?: GeoCoord;
  /** Gazetteer proposals for the missing ones, best first. */
  candidates: GazCandidate[];
  /** True when the proposal is safe for bulk-accept: the file's own
   *  coordinate, or a confident unambiguous gazetteer match. */
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

/** The PLAC node's usable coordinate (MAP → LATI/LONG), when it parses. */
function coordOf(plac: GedNode): GeoCoord | undefined {
  const map = firstChild(plac, "MAP");
  const lati = map && firstChild(map, "LATI")?.value;
  const long = map && firstChild(map, "LONG")?.value;
  return lati && long ? parseCoordPair(lati, long) : undefined;
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
  const groups = new Map<string, { count: number; missing: number; coords: Map<string, { coord: GeoCoord; n: number }> }>();
  const visit = (plac: GedNode) => {
    const key = plac.value!.trim();
    let g = groups.get(key);
    if (!g) {
      g = { count: 0, missing: 0, coords: new Map() };
      groups.set(key, g);
    }
    g.count++;
    const coord = coordOf(plac);
    if (!coord) g.missing++;
    else {
      const ck = `${coord.lat}:${coord.lon}`;
      const hit = g.coords.get(ck);
      if (hit) hit.n++;
      else g.coords.set(ck, { coord, n: 1 });
    }
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
    // The most frequent coordinate other occurrences of this value carry.
    const fileCoord = [...g.coords.values()].sort((a, b) => b.n - a.n)[0]?.coord;
    const confident =
      !!fileCoord ||
      (!!best &&
        best.score >= HIGH_CONFIDENCE &&
        (candidates.length < 2 || candidates[1].score <= best.score - AMBIGUITY_GAP));
    const row: GeocodeRow = { key, count: g.count, missing: g.missing, candidates, confident };
    if (fileCoord) row.fileCoord = fileCoord;
    const cached = decisions.get(key);
    if (cached) row.cached = cached;
    rows.push(row);
  }
  rows.sort((a, b) => {
    const aHas = a.fileCoord || a.candidates.length || a.cached?.status === "accepted" ? 1 : 0;
    const bHas = b.fileCoord || b.candidates.length || b.cached?.status === "accepted" ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return b.missing - a.missing || a.key.localeCompare(b.key);
  });
  return { rows, coveredDistinct, totalOccurrences, coveredOccurrences };
}

/** Cheap count of distinct PLAC values still missing coordinates — the
 *  Places-panel chip badge (equals the review list's row count). */
export function countGeocodePending(dataset: Dataset): number {
  const missing = new Set<string>();
  const visit = (plac: GedNode) => {
    if (!coordOf(plac)) missing.add(plac.value!.trim());
  };
  for (const indi of dataset.individuals.values()) walkPlacNodes(indi.raw, visit);
  for (const fam of dataset.families.values()) walkPlacNodes(fam.raw, visit);
  return missing.size;
}

/** A coordinate the file already carries, with the place name(s) written at
 *  it — context dots (and their tooltips) for the geocode mini map. */
export interface FileCoord {
  coord: GeoCoord;
  /** Up to three distinct PLAC values seen at this coordinate. */
  name: string;
}

/** Distinct coordinates the file already carries — context dots for the
 *  geocode mini map (the family cluster that tells same-named places apart).
 *  Deduplicated on ~100 m so dense reuse of one place stays one dot. */
export function collectFileCoords(dataset: Dataset): FileCoord[] {
  const seen = new Map<string, { coord: GeoCoord; names: Set<string> }>();
  const visit = (plac: GedNode) => {
    const c = coordOf(plac);
    if (!c) return;
    const key = `${c.lat.toFixed(3)}:${c.lon.toFixed(3)}`;
    const hit = seen.get(key);
    if (hit) hit.names.add(plac.value!.trim());
    else seen.set(key, { coord: c, names: new Set([plac.value!.trim()]) });
  };
  for (const indi of dataset.individuals.values()) walkPlacNodes(indi.raw, visit);
  for (const fam of dataset.families.values()) walkPlacNodes(fam.raw, visit);
  return [...seen.values()].map(({ coord, names }) => ({
    coord,
    name: [...names].slice(0, 3).join(" · ") + (names.size > 3 ? " …" : ""),
  }));
}

/**
 * Rename every PLAC node carrying exactly `from` (trimmed) to `to` — the
 * whole raw value, unlike the segment-based {@link applyPlaceRename}. Used
 * from the geocode review list, where each row IS one exact raw value (fix a
 * typo so the gazetteer can match it). With `addr`, the value is split:
 * PLAC becomes `to` and `addr` is written as an ADDR sibling on the parent
 * event (an ADDR already carrying a value is left untouched). Mutates the
 * dataset in place and returns RecordPatch[] for the unified undo stack.
 */
export function renamePlaceValue(dataset: Dataset, from: string, to: string, addr?: string): RecordPatch[] {
  const target = to.trim();
  const addrTarget = addr?.trim() ?? "";
  if (!target || (target === from && !addrTarget)) return [];
  const patches: RecordPatch[] = [];
  const applyToRecord = (raw: GedNode): boolean => {
    let changed = false;
    // Parent-aware walk: the ADDR sibling lives on the PLAC's parent event.
    const walk = (node: GedNode) => {
      for (const child of node.children) {
        if (child.tag === "PLAC" && child.value?.trim() === from) {
          child.value = target;
          if (addrTarget) {
            const existing = node.children.find((c) => c.tag === "ADDR");
            if (!existing) {
              const at = node.children.indexOf(child) + 1;
              node.children.splice(at, 0, { level: child.level, tag: "ADDR", value: addrTarget, children: [] });
            } else if (!existing.value?.trim()) {
              existing.value = addrTarget;
            }
          }
          changed = true;
        }
        walk(child);
      }
    };
    walk(raw);
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
      if (!coord || coordOf(plac)) return;
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

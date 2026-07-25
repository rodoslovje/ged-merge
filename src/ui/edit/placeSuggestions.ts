import type { Dataset, GeoCoord } from "../../gedcom/types";

export interface PlaceSuggestions {
  placeSuggestions: string[];
  /** Canonical place key → sorted unique address strings seen at that place. */
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  /**
   * The coordinate the file already uses for a place, keyed by {@link placeKey}
   * (the most frequent one when occurrences disagree). Only coordinates from
   * events with *no* address count, so this is the settlement's position rather
   * than one particular house's — picking a place from the suggestions should
   * not inherit a neighbour's front door.
   */
  placeCoords: Map<string, GeoCoord>;
  /**
   * The coordinate for a specific place+address pair, keyed
   * `placeKey(place) + NUL + lowercased address` — the house itself, used when a
   * combo pick supplies both fields at once.
   */
  pairCoords: Map<string, GeoCoord>;
}

/** Key for the {@link PlaceSuggestions.pairCoords} map. */
export function placeAddrCoordKey(place: string, addr: string): string {
  return `${placeKey(place)} ${addr.trim().toLowerCase()}`;
}

export function placeKey(raw: string): string {
  return raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
}

/** Collect all unique PLAC and ADDR values from a dataset and build canonical
 * maps (most-frequent casing wins) for normalize-on-blur. */
export function buildPlaceSuggestions(dataset: Dataset): PlaceSuggestions {
  const placeForms = new Map<string, Map<string, number>>();
  const addrForms = new Map<string, Map<string, number>>();
  // placeKey → addrRaw → count
  const placeAddrForms = new Map<string, Map<string, number>>();
  // Coordinate tallies, so the most frequently used wins when they disagree.
  const placeCoordCounts = new Map<string, Map<string, { coord: GeoCoord; n: number }>>();
  const pairCoordCounts = new Map<string, Map<string, { coord: GeoCoord; n: number }>>();

  function addCoord(counts: Map<string, Map<string, { coord: GeoCoord; n: number }>>, key: string, coord: GeoCoord) {
    const ck = `${coord.lat}:${coord.lon}`;
    const m = counts.get(key) ?? new Map<string, { coord: GeoCoord; n: number }>();
    const hit = m.get(ck);
    if (hit) hit.n++;
    else m.set(ck, { coord, n: 1 });
    counts.set(key, m);
  }

  function addValue(forms: Map<string, Map<string, number>>, raw: string) {
    const r = raw.trim();
    if (!r) return;
    const key = placeKey(r);
    const m = forms.get(key) ?? new Map<string, number>();
    m.set(r, (m.get(r) ?? 0) + 1);
    forms.set(key, m);
  }

  function addEventValues(placeRaw: string | undefined, addrRaw: string | undefined, coord?: GeoCoord) {
    if (placeRaw && coord) {
      const ar = addrRaw?.trim();
      // With an address the coordinate describes that house; without one it is
      // the place's own position. Only the latter is offered for a place pick.
      if (ar) addCoord(pairCoordCounts, placeAddrCoordKey(placeRaw, ar), coord);
      else addCoord(placeCoordCounts, placeKey(placeRaw), coord);
    }
    if (placeRaw) addValue(placeForms, placeRaw);
    if (addrRaw) addValue(addrForms, addrRaw);
    if (placeRaw && addrRaw) {
      const pk = placeKey(placeRaw);
      const ar = addrRaw.trim();
      if (ar) {
        const m = placeAddrForms.get(pk) ?? new Map<string, number>();
        m.set(ar, (m.get(ar) ?? 0) + 1);
        placeAddrForms.set(pk, m);
      }
    }
  }

  for (const indi of dataset.individuals.values()) {
    for (const ev of indi.events) addEventValues(ev.place?.raw, ev.address?.raw, ev.place?.coord);
  }
  for (const fam of dataset.families.values()) {
    for (const ev of fam.events) addEventValues(ev.place?.raw, ev.address?.raw, ev.place?.coord);
  }

  function build(forms: Map<string, Map<string, number>>): { suggestions: string[]; canonical: Map<string, string> } {
    const canonical = new Map<string, string>();
    const suggestions: string[] = [];
    for (const [key, m] of forms) {
      let best = "";
      let bestCount = 0;
      for (const [form, count] of m) {
        if (count > bestCount) { best = form; bestCount = count; }
      }
      canonical.set(key, best);
      suggestions.push(best);
    }
    suggestions.sort();
    return { suggestions, canonical };
  }

  const place = build(placeForms);
  const addr = build(addrForms);

  const placeToAddrs = new Map<string, string[]>();
  for (const [pk, m] of placeAddrForms) {
    placeToAddrs.set(pk, [...m.keys()].sort());
  }

  /** Most frequently used coordinate per key. */
  function pickCoords(counts: Map<string, Map<string, { coord: GeoCoord; n: number }>>): Map<string, GeoCoord> {
    const out = new Map<string, GeoCoord>();
    for (const [key, m] of counts) {
      const best = [...m.values()].sort((a, b) => b.n - a.n)[0];
      if (best) out.set(key, best.coord);
    }
    return out;
  }

  return {
    placeSuggestions: place.suggestions,
    placeToAddrs,
    placeCanonical: place.canonical,
    addrCanonical: addr.canonical,
    placeCoords: pickCoords(placeCoordCounts),
    pairCoords: pickCoords(pairCoordCounts),
  };
}

/** Every known place+address pair, flattened for the place autocomplete's
 * combo suggestions ("place · address" fills both fields in one go).
 * Cached per placeToAddrs map — every event row of a person asks for the
 * same flattening, so one build serves them all until the maps rebuild. */
const combosCache = new WeakMap<Map<string, string[]>, { place: string; addr: string }[]>();
export function placeCombosOf(
  placeToAddrs: Map<string, string[]>,
  placeCanonical: Map<string, string>,
): { place: string; addr: string }[] {
  const hit = combosCache.get(placeToAddrs);
  if (hit) return hit;
  const out: { place: string; addr: string }[] = [];
  for (const [key, addrs] of placeToAddrs) {
    const place = placeCanonical.get(key);
    if (!place) continue;
    for (const addr of addrs) out.push({ place, addr });
  }
  combosCache.set(placeToAddrs, out);
  return out;
}

/** Canonical lookup: given raw user input, return the canonical casing form if
 * it matches an existing entry in the map, otherwise return the input trimmed. */
export function applyCanonical(raw: string, canonical: Map<string, string>): string {
  const key = raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
  return canonical.get(key) ?? raw.trim();
}

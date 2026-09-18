import type { Dataset, GedEvent, GeoCoord } from "../../gedcom/types";
import { placeCollator } from "../../gedcom/place";
import { matchesTerms, queryTerms } from "../globalSearch";

/** One field's completion list: the values themselves, and the canonical
 *  casing per {@link placeKey}, so a retyped value snaps to the spelling the
 *  file writes most. */
export interface Suggestions {
  suggestions: string[];
  canonical: Map<string, string>;
}

/**
 * Completion for the two fields whose values mean nothing outside their own
 * tag: an occupation completes from the file's occupations, never from its
 * religions, and a marriage's type from the words other marriages use. Keyed
 * by event tag — a tag the file never writes is simply absent.
 */
export interface TagSuggestions {
  /** Event tag → the values its events carry on the tag line itself
   *  (`1 OCCU Farmer`), most used first. */
  values: Map<string, Suggestions>;
  /** Event tag → the `TYPE` values its events carry, most used first. */
  types: Map<string, Suggestions>;
}

/** Value-bearing tags that complete from nothing: a reference number belongs
 *  to one person and a child count is a number, so a list of the file's other
 *  answers would offer a wrong one rather than a shortcut. */
const NO_VALUE_COMPLETION = new Set(["REFN", "NCHI"]);

export interface PlaceSuggestions {
  placeSuggestions: string[];
  /** Canonical place key → sorted unique address strings seen at that place. */
  placeToAddrs: Map<string, string[]>;
  placeCanonical: Map<string, string>;
  addrCanonical: Map<string, string>;
  /**
   * Every agency the file's events already name — the parish that kept the
   * register, the hospital, the office. A file uses a handful of them over and
   * over, so the field completes from what is already there rather than asking
   * the reader to spell "župnija Kranj - Šmartin" out again on every event.
   */
  agencySuggestions: string[];
  agencyCanonical: Map<string, string>;
  /**
   * Every cause the file's events already name, most used first. A handful of
   * causes of death carry a whole parish register — the same pneumonia, the
   * same old age — so the field completes from them instead of asking for the
   * word again, and offers them before anything is typed.
   */
  causeSuggestions: string[];
  causeCanonical: Map<string, string>;
  /** Per-tag completion for the value and type fields (see {@link TagSuggestions}). */
  tagSuggestions: TagSuggestions;
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
  /**
   * The `FORM` the file already writes for a place, keyed by {@link placeKey}
   * (the most frequent one when occurrences disagree). Picking a place the file
   * already has brings its schema along the way {@link placeCoords} brings its
   * position — this is the file's own attested label for that exact place, not
   * a guess about what a typed value's parts might be.
   */
  placeForms: Map<string, string>;
}

/** Key for the {@link PlaceSuggestions.pairCoords} map. */
export function placeAddrCoordKey(place: string, addr: string): string {
  return `${placeKey(place)} ${addr.trim().toLowerCase()}`;
}

export function placeKey(raw: string): string {
  return raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
}

/** Collect all unique PLAC, ADDR, AGNC and CAUS values from a dataset and build
 * canonical maps (most-frequent casing wins) for normalize-on-blur. */
export function buildPlaceSuggestions(dataset: Dataset): PlaceSuggestions {
  const placeForms = new Map<string, Map<string, number>>();
  const addrForms = new Map<string, Map<string, number>>();
  const agencyForms = new Map<string, Map<string, number>>();
  const causeForms = new Map<string, Map<string, number>>();
  // tag → value key → form → count, for the two per-tag fields.
  const valueForms = new Map<string, Map<string, Map<string, number>>>();
  const typeForms = new Map<string, Map<string, Map<string, number>>>();
  // placeKey → addrRaw → count
  const placeAddrForms = new Map<string, Map<string, number>>();
  // Coordinate tallies, so the most frequently used wins when they disagree.
  const placeCoordCounts = new Map<string, Map<string, { coord: GeoCoord; n: number }>>();
  const pairCoordCounts = new Map<string, Map<string, { coord: GeoCoord; n: number }>>();
  // placeKey → FORM → count.
  const placeFormCounts = new Map<string, Map<string, number>>();

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

  function addTagValue(per: Map<string, Map<string, Map<string, number>>>, tag: string, raw: string) {
    const forms = per.get(tag) ?? new Map<string, Map<string, number>>();
    addValue(forms, raw);
    per.set(tag, forms);
  }

  function addEventValues(ev: GedEvent) {
    const placeRaw = ev.place?.raw;
    const addrRaw = ev.address?.raw;
    const coord = ev.place?.coord;
    const form = ev.place?.form;
    if (ev.agency) addValue(agencyForms, ev.agency);
    if (ev.cause) addValue(causeForms, ev.cause);
    if (ev.value && !NO_VALUE_COMPLETION.has(ev.tag)) addTagValue(valueForms, ev.tag, ev.value);
    if (ev.type) addTagValue(typeForms, ev.tag, ev.type);
    // A FORM only describes the place it sits on if it labels every part of it;
    // one that doesn't is this file's own mistake, not a schema to spread.
    if (placeRaw && form && form.split(",").length === placeRaw.split(",").length) {
      const key = placeKey(placeRaw);
      const m = placeFormCounts.get(key) ?? new Map<string, number>();
      m.set(form, (m.get(form) ?? 0) + 1);
      placeFormCounts.set(key, m);
    }
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
    for (const ev of indi.events) addEventValues(ev);
  }
  for (const fam of dataset.families.values()) {
    for (const ev of fam.events) addEventValues(ev);
  }

  /** `order: "frequency"` lists the most used value first instead of sorting
   *  the texts — for a field whose dropdown opens before anything is typed, so
   *  the few values that carry the file stand at the top of it. */
  function build(
    forms: Map<string, Map<string, number>>,
    order: "text" | "frequency" = "text",
  ): Suggestions {
    const canonical = new Map<string, string>();
    const suggestions: { text: string; uses: number }[] = [];
    for (const [key, m] of forms) {
      let best = "";
      let bestCount = 0;
      let uses = 0;
      for (const [form, count] of m) {
        uses += count;
        if (count > bestCount) { best = form; bestCount = count; }
      }
      canonical.set(key, best);
      suggestions.push({ text: best, uses });
    }
    // Numeric-aware, because these are places and addresses: a plain sort put
    // "Metlika 107" above "Metlika 70" in every completion dropdown.
    suggestions.sort((a, b) =>
      (order === "frequency" ? b.uses - a.uses : 0) || placeCollator.compare(a.text, b.text),
    );
    return { suggestions: suggestions.map((s) => s.text), canonical };
  }

  const place = build(placeForms);
  const addr = build(addrForms);
  const agency = build(agencyForms);
  const cause = build(causeForms, "frequency");

  /** Every tag's own list, built like the cause's — these dropdowns open
   *  before anything is typed too. */
  function buildPerTag(per: Map<string, Map<string, Map<string, number>>>): Map<string, Suggestions> {
    const out = new Map<string, Suggestions>();
    for (const [tag, forms] of per) out.set(tag, build(forms, "frequency"));
    return out;
  }

  const placeToAddrs = new Map<string, string[]>();
  for (const [pk, m] of placeAddrForms) {
    // Numeric house-number order (Breg 2 before Breg 11), matching the
    // geocoding lists — this feeds the address autocomplete and combos.
    placeToAddrs.set(pk, [...m.keys()].sort((a, b) => placeCollator.compare(a, b)));
  }

  /** Most frequently used value per key. */
  function pickMostFrequent(counts: Map<string, Map<string, number>>): Map<string, string> {
    const out = new Map<string, string>();
    for (const [key, m] of counts) {
      const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best) out.set(key, best[0]);
    }
    return out;
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
    agencySuggestions: agency.suggestions,
    agencyCanonical: agency.canonical,
    causeSuggestions: cause.suggestions,
    causeCanonical: cause.canonical,
    tagSuggestions: { values: buildPerTag(valueForms), types: buildPerTag(typeForms) },
    placeCoords: pickCoords(placeCoordCounts),
    pairCoords: pickCoords(pairCoordCounts),
    placeForms: pickMostFrequent(placeFormCounts),
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

/**
 * How the place and address dropdown reads what was typed: the same folded,
 * independent terms every name box uses (`queryTerms`), so a part of each word
 * is enough, in any order and without accents — "Zg Bitnj" finds Zgornje Bitnje
 * and "pok Zg" finds Pokopališče Zgornje Bitnje. Both tests take text already
 * run through `foldSearch`; `leads` marks a text that opens with the first term
 * typed, which the dropdown lists ahead of the hits buried inside a longer name.
 */
export interface PlaceQuery {
  terms: string[];
  hits(folded: string): boolean;
  leads(folded: string): boolean;
}
export function placeQuery(raw: string): PlaceQuery {
  const terms = queryTerms(raw);
  return {
    terms,
    hits: (folded) => matchesTerms(folded, terms),
    leads: (folded) => terms.length > 0 && folded.startsWith(terms[0]),
  };
}

/** Canonical lookup: given raw user input, return the canonical casing form if
 * it matches an existing entry in the map, otherwise return the input trimmed. */
export function applyCanonical(raw: string, canonical: Map<string, string>): string {
  const key = raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
  return canonical.get(key) ?? raw.trim();
}

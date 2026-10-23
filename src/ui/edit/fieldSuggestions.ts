import type { Dataset, Family, GedEvent, GeoCoord, Individual } from "../../gedcom/types";
import type { ChangeJournal, SyncMark } from "../../state/mainSync";
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

/** Value-bearing tags that complete from nothing: a reference or identity
 *  number belongs to one person and a child or marriage count is a number, so
 *  a list of the file's other answers would offer a wrong one rather than a
 *  shortcut. */
const NO_VALUE_COMPLETION = new Set(["REFN", "IDNO", "SSN", "NCHI", "NMR"]);

export interface FieldSuggestions {
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

/** Key for the {@link FieldSuggestions.pairCoords} map. */
export function placeAddrCoordKey(place: string, addr: string): string {
  return `${placeKey(place)} ${addr.trim().toLowerCase()}`;
}

export function placeKey(raw: string): string {
  return raw.trim().split(",").map((p) => p.trim().toLowerCase()).join("|");
}

/** Value key → each spelling of it → how many times the file writes it. */
type Forms = Map<string, Map<string, number>>;
/** Key → each coordinate (by "lat:lon") → the coordinate and its uses. */
type CoordCounts = Map<string, Map<string, { coord: GeoCoord; n: number }>>;

/**
 * The counts every suggestion list is read from, with the keys each list has
 * had counted since the last read — so a list can be brought up to date by
 * the keys an edit touched instead of rebuilt from every event in the file.
 *
 * A count that drops to zero stays in its map (and reads as absent): the
 * spelling keeps its place, so a record taken out and put back in the same
 * edit breaks a tie between equally used spellings as it did before.
 */
class Tally {
  readonly place: Forms = new Map();
  readonly addr: Forms = new Map();
  readonly agency: Forms = new Map();
  readonly cause: Forms = new Map();
  /** Event tag → its value (resp. TYPE) forms, for the two per-tag fields. */
  readonly values = new Map<string, Forms>();
  readonly types = new Map<string, Forms>();
  /** placeKey → address → count. */
  readonly placeAddr: Forms = new Map();
  readonly placeCoord: CoordCounts = new Map();
  readonly pairCoord: CoordCounts = new Map();
  /** placeKey → FORM → count. */
  readonly placeForm: Forms = new Map();
  /** The keys counted since {@link takeTouched}, per list. */
  touched = emptyTouched();

  takeTouched() {
    const t = this.touched;
    this.touched = emptyTouched();
    return t;
  }

  /** Count (`sign` 1) or uncount (-1) what one event contributes. */
  event(ev: GedEvent, sign: 1 | -1): void {
    const placeRaw = ev.place?.raw;
    const addrRaw = ev.address?.raw;
    const coord = ev.place?.coord;
    const form = ev.place?.form;
    const t = this.touched;
    if (ev.agency) countValue(this.agency, ev.agency, sign, t.agency);
    if (ev.cause) countValue(this.cause, ev.cause, sign, t.cause);
    if (ev.value && !NO_VALUE_COMPLETION.has(ev.tag)) {
      if (countValue(perTag(this.values, ev.tag), ev.value, sign)) t.values.add(ev.tag);
    }
    if (ev.type && countValue(perTag(this.types, ev.tag), ev.type, sign)) t.types.add(ev.tag);
    // A FORM only describes the place it sits on if it labels every part of it;
    // one that doesn't is this file's own mistake, not a schema to spread.
    if (placeRaw && form && form.split(",").length === placeRaw.split(",").length) {
      count(this.placeForm, placeKey(placeRaw), form, sign, t.placeForm);
    }
    if (placeRaw && coord) {
      const ar = addrRaw?.trim();
      // With an address the coordinate describes that house; without one it is
      // the place's own position. Only the latter is offered for a place pick.
      if (ar) countCoord(this.pairCoord, placeAddrCoordKey(placeRaw, ar), coord, sign, t.pairCoord);
      else countCoord(this.placeCoord, placeKey(placeRaw), coord, sign, t.placeCoord);
    }
    if (placeRaw) countValue(this.place, placeRaw, sign, t.place);
    if (addrRaw) countValue(this.addr, addrRaw, sign, t.addr);
    if (placeRaw && addrRaw) {
      const ar = addrRaw.trim();
      if (ar) count(this.placeAddr, placeKey(placeRaw), ar, sign, t.placeAddr);
    }
  }
}

function emptyTouched() {
  return {
    place: new Set<string>(),
    addr: new Set<string>(),
    agency: new Set<string>(),
    cause: new Set<string>(),
    values: new Set<string>(),
    types: new Set<string>(),
    placeAddr: new Set<string>(),
    placeCoord: new Set<string>(),
    pairCoord: new Set<string>(),
    placeForm: new Set<string>(),
  };
}

function perTag(per: Map<string, Forms>, tag: string): Forms {
  let forms = per.get(tag);
  if (!forms) per.set(tag, (forms = new Map()));
  return forms;
}

function count(forms: Forms, key: string, form: string, sign: 1 | -1, touched?: Set<string>): void {
  let m = forms.get(key);
  if (!m) forms.set(key, (m = new Map()));
  m.set(form, (m.get(form) ?? 0) + sign);
  touched?.add(key);
}

/** Count a trimmed value under its {@link placeKey}; false for a blank one. */
function countValue(forms: Forms, raw: string, sign: 1 | -1, touched?: Set<string>): boolean {
  const r = raw.trim();
  if (!r) return false;
  count(forms, placeKey(r), r, sign, touched);
  return true;
}

function countCoord(counts: CoordCounts, key: string, coord: GeoCoord, sign: 1 | -1, touched: Set<string>): void {
  const ck = `${coord.lat}:${coord.lon}`;
  let m = counts.get(key);
  if (!m) counts.set(key, (m = new Map()));
  const hit = m.get(ck);
  if (hit) hit.n += sign;
  else m.set(ck, { coord, n: sign });
  touched.add(key);
}

/** The most used spelling of a key and the key's total uses; the first one
 *  counted wins a tie. Undefined for a key no event writes any more. */
function bestForm(m: Map<string, number> | undefined): { text: string; uses: number } | undefined {
  if (!m) return undefined;
  let text = "";
  let best = 0;
  let uses = 0;
  for (const [form, n] of m) {
    uses += n;
    if (n > best) {
      text = form;
      best = n;
    }
  }
  return uses > 0 ? { text, uses } : undefined;
}

/** `order: "frequency"` lists the most used value first instead of sorting
 *  the texts — for a field whose dropdown opens before anything is typed, so
 *  the few values that carry the file stand at the top of it. */
function build(forms: Forms, order: "text" | "frequency" = "text"): Suggestions {
  const canonical = new Map<string, string>();
  const suggestions: { text: string; uses: number }[] = [];
  for (const [key, m] of forms) {
    const best = bestForm(m);
    if (!best) continue;
    canonical.set(key, best.text);
    suggestions.push(best);
  }
  // Numeric-aware, because these are places and addresses: a plain sort put
  // "Metlika 107" above "Metlika 70" in every completion dropdown.
  suggestions.sort((a, b) =>
    (order === "frequency" ? b.uses - a.uses : 0) || placeCollator.compare(a.text, b.text),
  );
  return { suggestions: suggestions.map((s) => s.text), canonical };
}

/** A text-ordered list brought up to date by the keys touched: each one whose
 *  canonical spelling changed leaves its old place and takes its new one. A
 *  `prev` without a list (the addresses offer none) updates the spellings. */
function update<S extends { suggestions?: string[]; canonical: Map<string, string> }>(forms: Forms, touched: Set<string>, prev: S): S {
  let canonical: Map<string, string> | undefined;
  let suggestions: string[] | undefined;
  for (const key of touched) {
    const before = prev.canonical.get(key);
    const after = bestForm(forms.get(key))?.text;
    if (before === after) continue;
    canonical ??= new Map(prev.canonical);
    if (prev.suggestions) suggestions ??= prev.suggestions.slice();
    if (before !== undefined && suggestions) {
      const at = sortedIndex(suggestions, before);
      suggestions.splice(suggestions[at] === before ? at : suggestions.indexOf(before), 1);
    }
    if (after === undefined) canonical.delete(key);
    else {
      canonical.set(key, after);
      suggestions?.splice(sortedIndex(suggestions, after), 0, after);
    }
  }
  return canonical ? { ...prev, canonical, ...(suggestions ? { suggestions } : {}) } : prev;
}

/** Where `text` stands, or would, in a list sorted by `placeCollator`. */
function sortedIndex(list: string[], text: string): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (placeCollator.compare(list[mid], text) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * `prev` with each of `keys` set to `compute(key)` (removed where undefined),
 * or `prev` itself when none of them changed — so a list an edit left as it
 * was keeps its identity, and whatever is memoized on it stays.
 */
function patchMap<V>(
  prev: Map<string, V>,
  keys: Set<string>,
  compute: (key: string) => V | undefined,
  same: (a: V, b: V) => boolean,
): Map<string, V> {
  let out: Map<string, V> | undefined;
  for (const key of keys) {
    const next = compute(key);
    const before = prev.get(key);
    if (next === undefined ? before === undefined : before !== undefined && same(before, next)) continue;
    out ??= new Map(prev);
    if (next === undefined) out.delete(key);
    else out.set(key, next);
  }
  return out ?? prev;
}

/** Every key's value, for a fresh build. */
function fullMap<V>(keys: Iterable<string>, compute: (key: string) => V | undefined): Map<string, V> {
  const out = new Map<string, V>();
  for (const key of keys) {
    const v = compute(key);
    if (v !== undefined) out.set(key, v);
  }
  return out;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSuggestions = (a: Suggestions, b: Suggestions) =>
  sameList(a.suggestions, b.suggestions) && a.canonical.size === b.canonical.size &&
  [...a.canonical].every(([k, v]) => b.canonical.get(k) === v);
const sameCoord = (a: GeoCoord, b: GeoCoord) => a.lat === b.lat && a.lon === b.lon;

/** One tag's list, built like the cause's — these dropdowns open before
 *  anything is typed too. Undefined for a tag no event writes any more. */
function tagList(per: Map<string, Forms>, tag: string): Suggestions | undefined {
  const list = build(per.get(tag) ?? new Map(), "frequency");
  return list.suggestions.length ? list : undefined;
}

/** A place's addresses in numeric house-number order (Breg 2 before Breg 11),
 *  matching the geocoding lists — this feeds the address autocomplete and
 *  combos. */
function addrList(forms: Forms, pk: string): string[] | undefined {
  const addrs = [...(forms.get(pk) ?? [])].filter(([, n]) => n > 0).map(([a]) => a);
  return addrs.length ? addrs.sort((a, b) => placeCollator.compare(a, b)) : undefined;
}

/** The most used value of a key. */
function mostFrequent(counts: Forms, key: string): string | undefined {
  return [...(counts.get(key) ?? [])].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** The most used coordinate of a key. */
function mostUsedCoord(counts: CoordCounts, key: string): GeoCoord | undefined {
  return [...(counts.get(key)?.values() ?? [])].filter((c) => c.n > 0).sort((a, b) => b.n - a.n)[0]?.coord;
}

function finish(tally: Tally): FieldSuggestions {
  tally.takeTouched();
  const place = build(tally.place);
  const addr = build(tally.addr);
  const agency = build(tally.agency);
  const cause = build(tally.cause, "frequency");
  return {
    placeSuggestions: place.suggestions,
    placeToAddrs: fullMap(tally.placeAddr.keys(), (pk) => addrList(tally.placeAddr, pk)),
    placeCanonical: place.canonical,
    addrCanonical: addr.canonical,
    agencySuggestions: agency.suggestions,
    agencyCanonical: agency.canonical,
    causeSuggestions: cause.suggestions,
    causeCanonical: cause.canonical,
    tagSuggestions: {
      values: fullMap(tally.values.keys(), (tag) => tagList(tally.values, tag)),
      types: fullMap(tally.types.keys(), (tag) => tagList(tally.types, tag)),
    },
    placeCoords: fullMap(tally.placeCoord.keys(), (key) => mostUsedCoord(tally.placeCoord, key)),
    pairCoords: fullMap(tally.pairCoord.keys(), (key) => mostUsedCoord(tally.pairCoord, key)),
    placeForms: fullMap(tally.placeForm.keys(), (key) => mostFrequent(tally.placeForm, key)),
  };
}

/** `prev` brought up to date by the keys counted since it was read. Every part
 *  the edit left as it was is `prev`'s own object — and `prev` itself is
 *  returned when that is all of them (a date edited, say). */
function finishUpdate(tally: Tally, prev: FieldSuggestions): FieldSuggestions {
  const t = tally.takeTouched();
  const place = update(tally.place, t.place, { suggestions: prev.placeSuggestions, canonical: prev.placeCanonical });
  const addr = update(tally.addr, t.addr, { canonical: prev.addrCanonical });
  const agency = update(tally.agency, t.agency, { suggestions: prev.agencySuggestions, canonical: prev.agencyCanonical });
  const prevCause = { suggestions: prev.causeSuggestions, canonical: prev.causeCanonical };
  const builtCause = t.cause.size ? build(tally.cause, "frequency") : prevCause;
  const cause = sameSuggestions(builtCause, prevCause) ? prevCause : builtCause;
  const values = patchMap(prev.tagSuggestions.values, t.values, (tag) => tagList(tally.values, tag), sameSuggestions);
  const types = patchMap(prev.tagSuggestions.types, t.types, (tag) => tagList(tally.types, tag), sameSuggestions);
  const next: FieldSuggestions = {
    placeSuggestions: place.suggestions,
    placeToAddrs: patchMap(prev.placeToAddrs, t.placeAddr, (pk) => addrList(tally.placeAddr, pk), sameList),
    placeCanonical: place.canonical,
    addrCanonical: addr.canonical,
    agencySuggestions: agency.suggestions,
    agencyCanonical: agency.canonical,
    causeSuggestions: cause.suggestions,
    causeCanonical: cause.canonical,
    tagSuggestions:
      values === prev.tagSuggestions.values && types === prev.tagSuggestions.types ? prev.tagSuggestions : { values, types },
    placeCoords: patchMap(prev.placeCoords, t.placeCoord, (key) => mostUsedCoord(tally.placeCoord, key), sameCoord),
    pairCoords: patchMap(prev.pairCoords, t.pairCoord, (key) => mostUsedCoord(tally.pairCoord, key), sameCoord),
    placeForms: patchMap(prev.placeForms, t.placeForm, (key) => mostFrequent(tally.placeForm, key), (a, b) => a === b),
  };
  const keys = Object.keys(next) as (keyof FieldSuggestions)[];
  return keys.every((k) => next[k] === prev[k]) ? prev : next;
}

/** Collect all unique PLAC, ADDR, AGNC and CAUS values from a dataset and build
 * canonical maps (most-frequent casing wins) for normalize-on-blur. */
export function buildFieldSuggestions(dataset: Dataset): FieldSuggestions {
  const tally = new Tally();
  for (const indi of dataset.individuals.values()) for (const ev of indi.events) tally.event(ev, 1);
  for (const fam of dataset.families.values()) for (const ev of fam.events) tally.event(ev, 1);
  return finish(tally);
}

/**
 * The field suggestions of one main dataset kept up to date across edits.
 *
 * Rebuilding them walks every event in the file — ~0.6 s on a 500k-person
 * file, after every commit. An edit, though, names the records it touched
 * (the change journal), and an edited person or family is re-derived into a
 * new typed object, leaving the old one as it was: so the old record's events
 * are uncounted, the new one's counted, and only the lists those values
 * reach are brought up to date. A journal that cannot say what changed, a
 * record changed in place under the same object, or another dataset, builds
 * them all again.
 */
export class FieldSuggestionIndex {
  private dataset: Dataset | undefined;
  private mark: SyncMark | undefined;
  private tally = new Tally();
  /** The typed record each id was counted from. */
  private counted = new Map<string, Individual | Family>();
  private result: FieldSuggestions | undefined;

  /** The suggestions of `dataset` as it is now, at edit `version`. */
  get(dataset: Dataset, journal: ChangeJournal, version: number): FieldSuggestions {
    const changed = dataset === this.dataset && this.result ? journal.since(this.mark) : null;
    if (!changed || !this.recount(dataset, changed)) this.rebuild(dataset);
    else if (changed.size) this.result = finishUpdate(this.tally, this.result!);
    this.dataset = dataset;
    this.mark = journal.mark(version);
    return this.result!;
  }

  private rebuild(dataset: Dataset): void {
    this.tally = new Tally();
    this.counted = new Map();
    for (const [id, indi] of dataset.individuals) {
      for (const ev of indi.events) this.tally.event(ev, 1);
      this.counted.set(id, indi);
    }
    for (const [id, fam] of dataset.families) {
      for (const ev of fam.events) this.tally.event(ev, 1);
      this.counted.set(id, fam);
    }
    this.result = finish(this.tally);
  }

  /** Uncount and count the changed records; false when one of them cannot be
   *  told apart from what was counted (the tally is then rebuilt). */
  private recount(dataset: Dataset, changed: Set<string>): boolean {
    const pairs: [Individual | Family | undefined, Individual | Family | undefined][] = [];
    for (const id of changed) {
      const before = this.counted.get(id);
      const now = dataset.individuals.get(id) ?? dataset.families.get(id);
      if (before && before === now) return false;
      pairs.push([before, now]);
    }
    changed.forEach((id) => this.counted.delete(id));
    for (const [before, now] of pairs) {
      for (const ev of before?.events ?? []) this.tally.event(ev, -1);
      for (const ev of now?.events ?? []) this.tally.event(ev, 1);
      if (now) this.counted.set(now.id, now);
    }
    return true;
  }
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
export interface SuggestQuery {
  terms: string[];
  hits(folded: string): boolean;
  leads(folded: string): boolean;
}
export function suggestQuery(raw: string): SuggestQuery {
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

import type { Dataset, GedNode, GeoCoord } from "../gedcom/types";
import { firstChild } from "../gedcom/node";
import { decomposePlace, parseCoordPair, placeAddressDetail, placeCollator } from "../gedcom/place";
import { rnQueriesFrom } from "../geo/rn";
import { clearPlaceGov, rebuildFamily, rebuildIndividual, setPlaceCoord } from "../gedcom/edit";
import { reconcilePlaceForm, sameWrittenCoord } from "../gedcom/edit/geo";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";
import { HIGH_CONFIDENCE, lookupPlace, type GazCandidate, type GazetteerIndex } from "../geo/gazetteer";
import { placeCountryFacet } from "../geo/placeCountry";
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
  /** Remembered "no match" mark from an earlier session/file, when one
   *  exists — the only decision kind the cache still holds. */
  cached?: GeocodeDecision;
  /** Individuals whose events carry this value without coordinates — the
   *  event's person, or both spouses for a family event. For a placed row
   *  (nothing is missing) this lists everyone the value occurs on instead. */
  missingIn: string[];
  /** True for a row from `placed`: every occurrence already carries a
   *  coordinate, and accepting a different pick means overwriting it. */
  placed?: boolean;
}

export interface GeocodeScan {
  /** Rows that still need coordinates, candidates first, by usage. */
  rows: GeocodeRow[];
  /** Values whose every occurrence already carries a coordinate — finished
   *  work, listed only on request (re-check a position, or re-geocode it).
   *  No gazetteer lookup is run for these: the row's own coordinate is the
   *  standing answer, and a fully geocoded file has thousands of them. */
  placed: GeocodeRow[];
  /** Distinct place strings that already have coordinates everywhere. */
  coveredDistinct: number;
  /** Total PLAC occurrences in the file / occurrences already carrying coordinates. */
  totalOccurrences: number;
  coveredOccurrences: number;
}

/** The PLAC node's usable coordinate (MAP → LATI/LONG), when it parses. */
export function coordOf(plac: GedNode): GeoCoord | undefined {
  const map = firstChild(plac, "MAP");
  const lati = map && firstChild(map, "LATI")?.value;
  const long = map && firstChild(map, "LONG")?.value;
  return lati && long ? parseCoordPair(lati, long) : undefined;
}

export function walkPlacNodes(node: GedNode, visit: (plac: GedNode, parent: GedNode) => void): void {
  for (const child of node.children) {
    if (child.tag === "PLAC" && child.value?.trim()) visit(child, node);
    walkPlacNodes(child, visit);
  }
}

/**
 * Visit every PLAC node together with its event's ADDR value ("" when the event
 * has none).
 *
 * The pair is the real unit of a coordinate. A place value alone is shared by
 * every event naming it, so one coordinate has to serve them all — but two
 * events in "Kranj" at different addresses are genuinely different locations and
 * may legitimately hold different coordinates. Grouping by place *and* address
 * captures that: same pair ⇒ same place, so the coordinates should agree.
 */
export function walkPlaceAddr(node: GedNode, visit: (plac: GedNode, addr: string, event: GedNode) => void): void {
  walkPlacNodes(node, (plac, event) => {
    const addr = event.children.find((c) => c.tag === "ADDR" && c.value?.trim())?.value?.trim() ?? "";
    visit(plac, addr, event);
  });
}

/** Grouping key for a place+address pair. NUL cannot occur in GEDCOM text. */
export function placeAddrKey(place: string, addr: string): string {
  return `${place}\0${addr}`;
}

/** Run `apply` over every INDI/FAM record, rebuilding the changed ones and
 *  collecting the before/after RecordPatch pairs for the unified undo stack —
 *  the shared tail of every whole-file place edit here (and of the address
 *  coordinates in ./addresses.ts). */
export function patchRecords(dataset: Dataset, apply: (raw: GedNode) => boolean): RecordPatch[] {
  const patches: RecordPatch[] = [];
  for (const indi of dataset.individuals.values()) {
    const before = cloneRaw(indi.raw);
    if (apply(indi.raw)) {
      rebuildIndividual(dataset, indi);
      patches.push({ type: "individual", id: indi.id, before, after: cloneRaw(indi.raw) });
    }
  }
  for (const fam of dataset.families.values()) {
    const before = cloneRaw(fam.raw);
    if (apply(fam.raw)) {
      rebuildFamily(dataset, fam);
      patches.push({ type: "family", id: fam.id, before, after: cloneRaw(fam.raw) });
    }
  }
  return patches;
}

/** A row's currently proposed/selected coordinate with its display label. */
export interface ChosenCoord {
  coord: GeoCoord;
  label: string;
  /** GOV id (only set when the pick came from GOV) — written back as `_GOV`. */
  govId?: string;
}

/** An accepted coordinate to write into the file, with its optional GOV id. */
export interface GeoAssignment {
  coord: GeoCoord;
  govId?: string;
  /** Replace a coordinate the value already carries (re-geocoding a placed
   *  row). Only events with no ADDR are overwritten — an address-bound
   *  coordinate describes that house, not the settlement. */
  overwrite?: boolean;
}

/** One "take the official name" step: rename every occurrence of `from` to
 *  the register's spelling `to`, then place the renamed value. */
export interface OfficialRename {
  from: string;
  to: string;
  /** Address to move out of the place value onto the event's own `ADDR` line —
   *  the register check's place/address split. Absent for a plain rename. */
  addr?: string;
  /** Where to place the renamed value. Absent when the step is a rewording
   *  rather than a register match, and there is no coordinate to write. */
  assignment?: GeoAssignment;
  /** What each comma part of `to` stands for, in this file's own wording —
   *  written as the value's `FORM`. A name taken from a register arrives with
   *  its levels known, so the label line that describes them should be written
   *  too rather than left saying what the old value's levels were. Absent when
   *  the file attests no FORM for a place of that shape, in which case a stale
   *  one is dropped rather than guessed at. */
  form?: string;
}

/** A pick's display label: the entry's name with its administrative parent —
 *  "Vinji Vrh (Brežice)" — so a same-named settlement in the wrong
 *  municipality is visible everywhere the pick is shown, above all in the
 *  row header the eye actually reads before accepting.
 *
 *  A municipality named after its own seat says nothing twice: "Ig (Ig)" and
 *  "Šmartno pri Litiji (Šmartno pri Litiji)" are the name and its echo, and the
 *  bracket is there to tell places apart, not to repeat one. */
export function pickLabel(name: string, admin?: string): string {
  const parent = adminOf(name, admin);
  return parent ? `${name} (${parent})` : name;
}

/** The division a candidate is filed under, when it says something the name
 *  itself does not — see {@link pickLabel}. Also the file's own spelling of the
 *  division where the place string named it (`adminDisplay`). */
export function adminOf(name: string, admin?: string): string | undefined {
  const parent = admin?.trim();
  return parent && parent.toLowerCase() !== name.trim().toLowerCase() ? parent : undefined;
}

/**
 * The coordinate a review row currently resolves to: an explicit user pick
 * when there is one, else the file's own coordinate for this exact value,
 * else the best gazetteer candidate.
 * Shared by the row (radio/badge state) and the panel's apply pass.
 */
export function chosenCoordFor(
  row: GeocodeRow,
  override: ChosenCoord | undefined,
  labels: { fromFile: string },
): ChosenCoord | undefined {
  if (override) return override;
  // The file's own coordinate for this exact value beats any gazetteer
  // guess — same file, same spelling, already placed by someone.
  if (row.fileCoord) return { coord: row.fileCoord, label: labels.fromFile };
  const best = row.candidates[0];
  return best
    ? { coord: { lat: best.entry.lat, lon: best.entry.lon }, label: pickLabel(best.entry.name, best.adminDisplay ?? best.entry.admin) }
    : undefined;
}

/** Ambiguity guard for bulk accept: runner-up must trail the best clearly. */
const AMBIGUITY_GAP = 0.05;

/**
 * Whether the top candidate matched well enough — and unambiguously enough —
 * to act on in bulk. This is the *name's* confidence, distinct from a row
 * being `confident` because the file already carries a coordinate for it:
 * bulk rename must hold candidates to this bar even on rows the file has
 * placed, or a fuzzy guess rides a fileCoord row into a mass rename.
 */
export function confidentCandidate(candidates: GazCandidate[]): boolean {
  const best = candidates[0];
  return (
    !!best &&
    best.score >= HIGH_CONFIDENCE &&
    (candidates.length < 2 || candidates[1].score <= best.score - AMBIGUITY_GAP)
  );
}

/** Answers per distinct value: the question is asked of every place in the file
 *  twice over (the review list and the panel's badge count), and the answer
 *  depends on nothing but the string. */
const registerAddressCache = new Map<string, boolean>();

/**
 * Whether this place value is itself a house address the register can resolve —
 * it names a house number ("Črni vrh 35", "Kranj (Slovenija), Stražišče 114"),
 * and that number sits in a country the address register covers.
 *
 * Such a value is not a place with one coordinate but a building with its own,
 * so it belongs to the grouped address rows rather than the place list: there it
 * is reviewed alongside the rest of its settlement's houses, in one batched
 * register lookup, instead of appearing as one unplaceable row per house among
 * thousands. Everything the address rows cannot resolve — a house abroad, a
 * street with no number — stays in the place list with its full set of lookups.
 */
export function isRegisterAddress(value: string): boolean {
  const cached = registerAddressCache.get(value);
  if (cached !== undefined) return cached;
  const answer = !!placeAddressDetail(decomposePlace(value)) && rnQueriesFrom(value, undefined).length > 0;
  registerAddressCache.set(value, answer);
  return answer;
}

/**
 * Scan every PLAC value in the file, group by exact raw value, and propose
 * candidates (when a gazetteer is loaded) for the values missing coordinates.
 */
export function scanGeocode(
  dataset: Dataset,
  index: GazetteerIndex | undefined,
  decisions: ReadonlyMap<string, GeocodeDecision>,
  /** The country a value naming none stands in — see {@link countryOf}. */
  home = "",
): GeocodeScan {
  const groups = new Map<
    string,
    {
      count: number;
      missing: number;
      coords: Map<string, { coord: GeoCoord; n: number }>;
      people: Set<string>;
      allPeople: Set<string>;
    }
  >();
  const visitRecord = (raw: GedNode, personIds: string[]) => {
    walkPlaceAddr(raw, (plac, addr) => {
      const key = plac.value!.trim();
      let g = groups.get(key);
      if (!g) {
        g = { count: 0, missing: 0, coords: new Map(), people: new Set(), allPeople: new Set() };
        groups.set(key, g);
      }
      g.count++;
      for (const id of personIds) g.allPeople.add(id);
      const coord = coordOf(plac);
      if (!coord) {
        g.missing++;
        for (const id of personIds) g.people.add(id);
      } else if (!addr) {
        // Only a coordinate from an event with no address counts towards this
        // row's `fileCoord`. One on an address describes that house, not the
        // settlement the row is about, and must not be proposed — let alone
        // bulk-accepted — for every other event in the place.
        const ck = `${coord.lat}:${coord.lon}`;
        const hit = g.coords.get(ck);
        if (hit) hit.n++;
        else g.coords.set(ck, { coord, n: 1 });
      }
    });
  };
  for (const indi of dataset.individuals.values()) visitRecord(indi.raw, [indi.id]);
  for (const fam of dataset.families.values())
    visitRecord(fam.raw, [fam.husband, fam.wife].filter((id): id is string => !!id));

  const rows: GeocodeRow[] = [];
  const placed: GeocodeRow[] = [];
  let coveredDistinct = 0;
  let totalOccurrences = 0;
  let coveredOccurrences = 0;
  for (const [key, g] of groups) {
    totalOccurrences += g.count;
    coveredOccurrences += g.count - g.missing;
    if (!g.missing) {
      coveredDistinct++;
      // Finished work, offered behind "Show already placed". A value whose
      // every coordinate is address-bound has no settlement position of its
      // own — its houses are the address rows' business, so it is skipped
      // here just like the pending register addresses below.
      const fileCoord = [...g.coords.values()].sort((a, b) => b.n - a.n)[0]?.coord;
      if (fileCoord && !isRegisterAddress(key)) {
        placed.push({
          key,
          count: g.count,
          missing: 0,
          fileCoord,
          candidates: [],
          confident: false,
          missingIn: [...g.allPeople],
          placed: true,
        });
      }
      continue;
    }
    // A value that is itself a house address is reviewed by the address rows,
    // grouped under its settlement — listing it here as well would ask the same
    // question twice, once per house.
    if (isRegisterAddress(key)) continue;
    const candidates = index ? lookupPlace(index, key, home) : [];
    // The most frequent coordinate other occurrences of this value carry.
    const fileCoord = [...g.coords.values()].sort((a, b) => b.n - a.n)[0]?.coord;
    const confident = !!fileCoord || confidentCandidate(candidates);
    const row: GeocodeRow = { key, count: g.count, missing: g.missing, candidates, confident, missingIn: [...g.people] };
    if (fileCoord) row.fileCoord = fileCoord;
    const cached = decisions.get(key);
    if (cached?.status === "nomatch") row.cached = cached;
    rows.push(row);
  }
  rows.sort((a, b) => {
    const aHas = a.fileCoord || a.candidates.length ? 1 : 0;
    const bHas = b.fileCoord || b.candidates.length ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return b.missing - a.missing || placeCollator.compare(a.key, b.key);
  });
  placed.sort((a, b) => b.count - a.count || placeCollator.compare(a.key, b.key));
  return { rows, placed, coveredDistinct, totalOccurrences, coveredOccurrences };
}

/** Which country a raw PLAC value stands in, as the key the country chips group
 *  on — an ISO code, or `""` for a value naming no country. See
 *  {@link placeCountryFacet}: a name counts only when it is a country's (or a
 *  state of one of the countries whose files stop at the state), so a parish
 *  patron or a mistyped date no longer poses as one.
 *
 *  `home` is the country a value naming none is taken to stand in — the file's
 *  own home country (see {@link detectHomeCountry}), `""` to assume nothing. */
export function countryOf(key: string, home = ""): string {
  return placeCountryFacet(key) || home;
}

/** Cheap count of distinct PLAC values still missing coordinates — the
 *  Places-panel chip badge (equals the review list's row count, so it leaves
 *  out the house addresses the same way {@link scanGeocode} does). */
export function countGeocodePending(dataset: Dataset): number {
  const missing = new Set<string>();
  const visit = (plac: GedNode) => {
    if (!coordOf(plac)) missing.add(plac.value!.trim());
  };
  for (const indi of dataset.individuals.values()) walkPlacNodes(indi.raw, visit);
  for (const fam of dataset.families.values()) walkPlacNodes(fam.raw, visit);
  let count = 0;
  for (const value of missing) if (!isRegisterAddress(value)) count++;
  return count;
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
 * The renames that would write the home country into the places that name no
 * country: "Golnik" → "Golnik,Slovenija", in the file's own separator and its
 * own spelling of the country.
 *
 * Offered only for the rows a loaded directory recognizes — a confident match,
 * or a coordinate the file already carries for the value. A place list holds
 * more than places: parish patrons, hospitals, a date somebody typed into a
 * place field. None of those becomes a Slovenian place by having the country
 * appended to it, and a mass rename is exactly where that would go unnoticed.
 */
export function planCountryFill(rows: readonly GeocodeRow[], country: string, separator: string): OfficialRename[] {
  const suffix = `${separator}${country}`;
  const out: OfficialRename[] = [];
  for (const row of rows) {
    if (placeCountryFacet(row.key)) continue;
    if (!row.fileCoord && !confidentCandidate(row.candidates)) continue;
    out.push({ from: row.key, to: `${row.key}${suffix}` });
  }
  return out;
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
export function renamePlaceValue(
  dataset: Dataset,
  from: string,
  to: string,
  addr?: string,
  form?: string,
): RecordPatch[] {
  return renamePlaceValues(dataset, [
    { from, to, ...(addr !== undefined ? { addr } : {}), ...(form !== undefined ? { form } : {}) },
  ]);
}

/**
 * Every rename of {@link renamePlaceValue}, in one pass over the records:
 * "Use official names" over hundreds of rows used to walk the whole dataset
 * once per row, which froze the tab on a large file. The assignments riding
 * on the renames are the caller's business (one batched {@link applyGeocode}
 * call), so only the rename fields are read here.
 */
export function renamePlaceValues(dataset: Dataset, renames: readonly OfficialRename[]): RecordPatch[] {
  const byFrom = new Map<string, { target: string; addrTarget: string; form?: string }>();
  for (const r of renames) {
    const target = r.to.trim();
    const addrTarget = r.addr?.trim() ?? "";
    if (!target || (target === r.from && !addrTarget)) continue;
    byFrom.set(r.from, { target, addrTarget, ...(r.form ? { form: r.form } : {}) });
  }
  if (!byFrom.size) return [];
  return patchRecords(dataset, (raw) => {
    let changed = false;
    walkPlacNodes(raw, (plac, parent) => {
      const r = byFrom.get(plac.value!.trim());
      if (!r) return;
      // Count only what is actually written: with an unchanged place part and
      // an ADDR already carrying a value, a node used to count as "changed"
      // anyway — inflating the report and pushing an empty patch. A value that
      // differs only by surrounding whitespace is also left alone (never
      // rewrite the user's own spacing unasked).
      let wrote = false;
      if (plac.value!.trim() !== r.target) {
        const prev = plac.value!;
        plac.value = r.target;
        // The FORM names each comma part of the value it sits on. A rename that
        // changes how many parts there are leaves it describing something else,
        // so it is rewritten from the register's own levels where the caller
        // knows them, carried minus the deleted parts' labels where the rename
        // only deleted parts, and dropped where it no longer lines up.
        reconcilePlaceForm(plac, r.form, prev);
        wrote = true;
      }
      if (r.addrTarget) {
        // The ADDR sibling lives on the PLAC's parent event.
        const existing = parent.children.find((c) => c.tag === "ADDR");
        if (!existing) {
          const at = parent.children.indexOf(plac) + 1;
          parent.children.splice(at, 0, { level: plac.level, tag: "ADDR", value: r.addrTarget, children: [] });
          wrote = true;
        } else if (!existing.value?.trim()) {
          existing.value = r.addrTarget;
          wrote = true;
        }
      }
      if (wrote) changed = true;
    });
    return changed;
  });
}

/**
 * Move the events at the given place+address pairs ({@link placeAddrKey}) to a
 * different place: their PLAC becomes `toPlace`, their ADDR is left alone.
 *
 * This is the one place edit keyed by the *address*, which is what splitting a
 * place needs — when a file records a whole hamlet under its neighbour (every
 * "Klošter N" filed under Gradac, because the post office is Gradac), neither
 * the segment rename nor {@link renamePlaceValue} can help: both would move
 * every event of the place, including those genuinely there.
 *
 * The coordinate that travels along is the *destination's*, not the old
 * settlement's: every row this can be called for carries at most a
 * settlement-precise coordinate (see `scanAddresses`) — the position of the
 * village being moved *away* from — so the moved events are placed at
 * `toCoord` (a destination the caller looked up in a register) or, failing
 * that, at the coordinate the file itself records for `toPlace`
 * ({@link fileCoordForPlace}). When neither knows one, the old coordinate is
 * kept rather than thrown away: an approximate position beats none, the address
 * lookup can still sharpen it, and a move within one municipality usually lands
 * close by. The `_GOV` id never survives — it names one specific place.
 *
 * `toCoord` must be the *place's* coordinate, never a single house's: it is
 * written to every moved event, which sit at different addresses.
 */
export function movePlaceForAddresses(
  dataset: Dataset,
  keys: ReadonlySet<string>,
  toPlace: string,
  toCoord?: GeoAssignment,
): RecordPatch[] {
  const target = toPlace.trim();
  if (!target || !keys.size) return [];
  const targetCoord = toCoord ?? fileCoordForPlace(dataset, target);
  return patchRecords(dataset, (raw) => {
    let changed = false;
    walkPlaceAddr(raw, (plac, addr) => {
      if (!keys.has(placeAddrKey(plac.value!.trim(), addr))) return;
      if (plac.value!.trim() === target) return;
      const prev = plac.value!;
      plac.value = target;
      // The moved value has its own levels; a FORM describing the old place's
      // is no longer true of it (see reconcilePlaceForm).
      reconcilePlaceForm(plac, undefined, prev);
      clearPlaceGov(plac);
      if (targetCoord) setPlaceCoord(plac, targetCoord.coord, targetCoord.govId);
      changed = true;
    });
    return changed;
  });
}

/**
 * The settlement coordinate the file itself records for a place value: the most
 * frequent coordinate carried by PLAC nodes with exactly this value on an event
 * with *no* address, together with the `_GOV` id beside it. An address-bound
 * coordinate is deliberately ignored — it describes that house, not the place
 * (the same rule `scanGeocode` uses for a row's `fileCoord`).
 */
export function fileCoordForPlace(dataset: Dataset, place: string): GeoAssignment | undefined {
  const seen = new Map<string, { assignment: GeoAssignment; n: number }>();
  const visit = (raw: GedNode) =>
    walkPlaceAddr(raw, (plac, addr) => {
      if (addr || plac.value!.trim() !== place) return;
      const coord = coordOf(plac);
      if (!coord) return;
      const key = `${coord.lat}:${coord.lon}`;
      const hit = seen.get(key);
      if (hit) {
        hit.n++;
        return;
      }
      const govId = firstChild(plac, "_GOV")?.value?.trim();
      seen.set(key, { assignment: govId ? { coord, govId } : { coord }, n: 1 });
    });
  for (const indi of dataset.individuals.values()) visit(indi.raw);
  for (const fam of dataset.families.values()) visit(fam.raw);
  return [...seen.values()].sort((a, b) => b.n - a.n)[0]?.assignment;
}

/** Every distinct raw PLAC value in the file, for target autocomplete. */
export function collectPlaceValues(dataset: Dataset): string[] {
  const values = new Set<string>();
  const visit = (raw: GedNode) => walkPlacNodes(raw, (plac) => values.add(plac.value!.trim()));
  for (const indi of dataset.individuals.values()) visit(indi.raw);
  for (const fam of dataset.families.values()) visit(fam.raw);
  values.delete("");
  return [...values].sort((a, b) => placeCollator.compare(a, b));
}

/**
 * Write accepted coordinates into every PLAC node whose exact value matches
 * an assignment and that still lacks a coordinate. An assignment marked
 * `overwrite` (re-geocoding a placed row) also replaces the coordinates the
 * value already carries — but only on events with no ADDR: an address-bound
 * coordinate is that house's own position and must survive a settlement
 * re-geocode. Mutates the dataset in place and returns RecordPatch[] for the
 * unified undo stack.
 */
export function applyGeocode(dataset: Dataset, assignments: ReadonlyMap<string, GeoAssignment>): RecordPatch[] {
  return patchRecords(dataset, (raw) => {
    let changed = false;
    walkPlaceAddr(raw, (plac, addr) => {
      const a = assignments.get(plac.value!.trim());
      if (!a) return;
      const existing = coordOf(plac);
      if (existing) {
        // Only an overwrite may replace a coordinate the value carries, an
        // address-bound one never (that house's own position) — and a re-pick
        // of the position already written, compared at the precision the file
        // stores, changes nothing and must write nothing. A pick bringing a
        // new GOV identity still writes (the id is the change).
        if (!a.overwrite || addr) return;
        if (sameWrittenCoord(existing, a.coord) && !a.govId) return;
      }
      // A stale _GOV names the old position; it only survives a move when the
      // new pick brings its own id (setPlaceCoord then replaces it).
      if (existing && !a.govId) clearPlaceGov(plac);
      setPlaceCoord(plac, a.coord, a.govId);
      changed = true;
    });
    return changed;
  });
}

/**
 * Like {@link applyGeocode}, but keyed by place+address ({@link placeAddrKey}) so
 * a coordinate reaches only the events at that exact address — used by the
 * address-register writes and by the health check's coordinate fill, both of
 * which must not spread one house's position across a settlement.
 *
 * `overwrite` replaces a coordinate the node already has, which is how an
 * address lookup upgrades a settlement-precise coordinate to the actual house.
 */
export function applyGeocodeByAddress(
  dataset: Dataset,
  assignments: ReadonlyMap<string, GeoAssignment>,
  overwrite = false,
): RecordPatch[] {
  return patchRecords(dataset, (raw) => {
    let changed = false;
    walkPlaceAddr(raw, (plac, addr) => {
      const a = assignments.get(placeAddrKey(plac.value!.trim(), addr));
      if (!a) return;
      const existing = coordOf(plac);
      // Same rule as applyGeocode: compared at written precision, so re-picking
      // the position a house already holds is a no-op, not a "change".
      if (existing && (!overwrite || (sameWrittenCoord(existing, a.coord) && !a.govId))) return;
      setPlaceCoord(plac, a.coord, a.govId);
      changed = true;
    });
    return changed;
  });
}

// ── Staged review state ─────────────────────────────────────────────────────
// The panel's picks and no-match marks between a scan and the Write. Kept as
// pure functions because their invariants are exactly where this tool's
// incident history lives: a rescan silently discarding in-progress picks, a
// rename orphaning (or clobbering) a staged coordinate, a written row's
// leftover tick re-writing — this time overwriting — on the next Write.

/** Every key the scan currently knows — the only keys staged state may hold. */
export function scanKeys(scan: GeocodeScan): Set<string> {
  return new Set([...scan.rows, ...scan.placed].map((r) => r.key));
}

/**
 * Staged picks after a rescan: work on rows that survived (e.g. after renaming
 * one *other* row) is preserved, not silently discarded; keys the scan no
 * longer produces drop theirs. Nothing arrives pre-picked — accepting a
 * coordinate is this run's act.
 */
export function reconcilePicksAfterScan<T>(scan: GeocodeScan, prev: ReadonlyMap<string, T>): Map<string, T> {
  const keys = scanKeys(scan);
  return new Map([...prev].filter(([k]) => keys.has(k)));
}

/** No-match marks after a rescan: marks on vanished keys drop, and remembered
 *  no-match decisions seed the set. */
export function reconcileNoMatchAfterScan(scan: GeocodeScan, prev: ReadonlySet<string>): Set<string> {
  const keys = scanKeys(scan);
  const next = new Set([...prev].filter((k) => keys.has(k)));
  for (const r of scan.rows) if (r.cached?.status === "nomatch") next.add(r.key);
  return next;
}

/**
 * The staged pick carried across a plain respelling rename: the pick is about
 * the *place*, not its spelling, so it follows the row to its new key — unless
 * the rename merges into a row with staged work of its own, which stands.
 */
export function carryPickAcrossRename<T>(prev: ReadonlyMap<string, T>, from: string, to: string): Map<string, T> {
  const carried = prev.get(from);
  const next = new Map(prev);
  next.delete(from);
  if (carried !== undefined && !next.has(to)) next.set(to, carried);
  return next;
}

/**
 * What one Write does with the staged state: an assignment per staged pick —
 * a pick on a `placed` row is a deliberate re-geocode, so only those carry
 * `overwrite` — plus the no-match marks to remember (only the ones not already
 * cached). The caller must then drop exactly the written keys from the staged
 * picks: a tick left behind would keep the row listed, and the next Write
 * would write it again, this time overwriting.
 */
export function buildWriteSet(
  scan: GeocodeScan,
  chosen: ReadonlyMap<string, ChosenCoord>,
  noMatch: ReadonlySet<string>,
  now: number,
): { assignments: Map<string, GeoAssignment>; toStore: GeocodeDecision[] } {
  const assignments = new Map<string, GeoAssignment>();
  const toStore: GeocodeDecision[] = [];
  for (const row of [...scan.rows, ...scan.placed]) {
    const c = chosen.get(row.key);
    if (c) {
      const a: GeoAssignment = c.govId ? { coord: c.coord, govId: c.govId } : { coord: c.coord };
      if (row.placed) a.overwrite = true;
      assignments.set(row.key, a);
    } else if (noMatch.has(row.key) && row.cached?.status !== "nomatch") {
      toStore.push({ key: row.key, status: "nomatch", ts: now });
    }
  }
  return { assignments, toStore };
}

import { useMemo } from "react";
import type { GeoCoord } from "../../gedcom/types";
import { placeCollator } from "../../gedcom/place";
import type { RnResult } from "../../geo/rn";
import type { NominatimResult } from "../../geo/nominatim";
import type { LookupState } from "../../geo/lookup";
import { suggestMovedPlace, type AddressRow } from "../../tools/addresses";
import { findSameHouse } from "../../tools/sameHouse";
import { matchesQuery } from "../globalSearch";
import { personMatches } from "./shared";
import { countryFacet } from "./CountryChips";

// The derivations behind the address-coordinate list (AddressCoordsSection):
// the scanned rows narrowed by the filter, the toggles and the chips, and
// grouped by place. Pure reads of the section's state — no state of its own.

export type SearchState = LookupState<RnResult>;

/** The same, for the OpenStreetMap fallback below — a separate state per row,
 *  because the two lookups answer independently and a row may have both. */
export type OsmState = LookupState<NominatimResult>;

/** The lookup-state chips over the list, mirroring the places list's work
 *  chips: what still needs a register query, what came back with houses to
 *  judge, what the register does not know, what it cannot be asked about at
 *  all, and what is staged for writing. */
export type AddrStatus = "unsearched" | "found" | "none" | "manual" | "placed" | "picked";
/**
 * What the row of chips narrows to — the lookup states, and "written twice",
 * which is not a lookup state at all but belongs in the same row because it
 * answers the same question ("show me which of these?") and because a row of
 * chips is read as one selector. Standing outside it, its own green beside the
 * green on "All" said two contradictory things about one list.
 */
export type ListFilter = "all" | AddrStatus | "sameHouse";

/** A row's lookup state right now. An error or in-flight search still counts
 *  as "unsearched" — it has no answer yet and the lookup can be retried; a row
 *  with no query at all is "manual", since no amount of retrying will help. */
export function addrStatus(
  row: AddressRow,
  searches: ReadonlyMap<string, SearchState>,
  picked: ReadonlyMap<string, unknown>,
  osm: ReadonlyMap<string, OsmState>,
): AddrStatus {
  if (picked.has(row.key)) return "picked";
  // Already carrying a position of its own — the hamlet's, say, given to the
  // whole run of houses at once. Still listed, since a rough position may want
  // sharpening, but it is not work waiting to be done and does not read as any
  // of the lookup states below.
  if (row.placed) return "placed";
  // OpenStreetMap only ever *upgrades* a row: houses it found are answers to
  // judge, exactly like the register's. Finding none leaves the row where it
  // was — a row the register cannot be asked about at all is still by hand.
  if ((osm.get(row.key)?.results.length ?? 0) > 0) return "found";
  if (!row.queries.length) return "manual";
  const s = searches.get(row.key);
  if (s?.state === "done") return s.results.length ? "found" : "none";
  return "unsearched";
}

/** Addresses of one place, with the totals its header shows. */
export interface PlaceGroup {
  place: string;
  rows: AddressRow[];
  events: number;
  /** Everyone the group's addresses belong to, each once however many of its
   *  houses or events name them — the count the header shows, as every list on
   *  these pages shows the people rather than the rows. */
  people: string[];
  /** Whether these addresses can be moved to another place: only when every one
   *  of them names the place in a value of its own, so rewriting that value
   *  moves the event and nothing else. */
  movable: boolean;
  /** Where these addresses suggest they belong, when they agree on one — the
   *  place with its settlement swapped for the name the house numbers hang off
   *  ({@link suggestMovedPlace}), and the rows that say so. */
  suggestion?: { place: string; keys: string[] };
}

/** The place the most of a group's addresses point at, with those rows. */
function groupSuggestion(place: string, rows: AddressRow[]): PlaceGroup["suggestion"] {
  const byPlace = new Map<string, string[]>();
  for (const row of rows) {
    const target = suggestMovedPlace(place, row.address);
    if (!target) continue;
    const keys = byPlace.get(target);
    if (keys) keys.push(row.key);
    else byPlace.set(target, [row.key]);
  }
  let best: PlaceGroup["suggestion"];
  for (const [target, keys] of byPlace) {
    if (!best || keys.length > best.keys.length) best = { place: target, keys };
  }
  return best;
}

export function useAddressCoordRows({
  all,
  query,
  terms,
  personNames,
  home,
  searches,
  osmSearches,
  picked,
  noMatch,
  showPlaced,
  showHidden,
  statusFilter,
  countryFilter,
}: {
  all: AddressRow[];
  query: string;
  terms: readonly string[];
  personNames: Map<string, string>;
  home: string;
  searches: ReadonlyMap<string, SearchState>;
  osmSearches: ReadonlyMap<string, OsmState>;
  picked: ReadonlyMap<string, { coord: GeoCoord; label: string }>;
  noMatch: ReadonlySet<string>;
  showPlaced: boolean;
  showHidden: boolean;
  statusFilter: ListFilter;
  countryFilter: string | null;
}) {
  const onlySameHouse = statusFilter === "sameHouse";
  const byKey = useMemo(() => new Map(all.map((row) => [row.key, row])), [all]);
  // Matching on the address alone would drop the settlement a search like
  // "Kranj" is really about, and matching on the place alone would hide the one
  // house someone typed a number for — so a row matches on the two together,
  // each typed part on its own and in any order, as the place field reads a
  // query: "Zg Bitnj 266" finds the house, "Bitnje" the village.
  const rows = useMemo(
    () =>
      query
        ? all.filter(
            (row) =>
              matchesQuery(`${row.place} ${row.address}`, terms) ||
              // …or the name of someone whose events are at this house: a
              // reader looking for one person's addresses has no house number
              // to type.
              personMatches(row.people, personNames, terms),
          )
        : all,
    [all, query, personNames, terms],
  );
  /** The rows the list works over. A row with a pick staged stays whatever the
   *  toggles say — work in progress is never hidden. */
  const visibleRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          picked.has(row.key) ||
          ((showPlaced || !row.placed) && (showHidden || !noMatch.has(row.key))),
      ),
    [rows, showPlaced, showHidden, picked, noMatch],
  );
  /** Groups the filter matched by *address*, which are worth opening: the row
   *  looked for is inside, and there may be one of it under a hundred. */
  const hits = useMemo(() => {
    const found = new Set<string>();
    if (query) {
      for (const row of visibleRows) {
        // A name is as good a reason to open the group as a house number: it
        // is what the reader typed, and the row they want is inside.
        if (matchesQuery(row.address, terms) || personMatches(row.people, personNames, terms)) {
          found.add(row.place);
        }
      }
    }
    return found;
  }, [visibleRows, query, personNames, terms]);
  // One chip per country the addresses stand in, counting the addresses each
  // click would show — a chip's count respects every filter except its own,
  // exactly as in the two lists beside this one.
  /**
   * The houses the file writes twice — one row the fuller spelling of another,
   * within the same place. Computed over every row, filters included, so the
   * fuller row is known even when the filters would have hidden it.
   */
  const sameHouse = useMemo(() => findSameHouse(all), [all]);
  /** Both halves of every such pair: the row that would move and the row it
   *  would move into, since a suggestion is unreadable without what it points
   *  at. */
  const sameHouseKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const [key, dup] of sameHouse) {
      keys.add(key);
      keys.add(dup.into);
    }
    return keys;
  }, [sameHouse]);
  const country = useMemo(() => {
    const inStatus = (r: AddressRow) =>
      statusFilter === "all" ||
      statusFilter === "sameHouse" ||
      addrStatus(r, searches, picked, osmSearches) === statusFilter;
    return countryFacet(visibleRows, visibleRows.filter(inStatus), (row) => row.place, home, countryFilter);
  }, [visibleRows, statusFilter, searches, picked, osmSearches, home, countryFilter]);
  /**
   * Houses written twice that this click would actually list — the country and
   * status filters respected, its own toggle and the row-hiding ones not, since
   * those are exactly what it overrides. Counted over every row for the same
   * reason the pool is: the pairs live among the placed ones.
   */
  const sameHouseCount = useMemo(() => {
    let n = 0;
    for (const row of rows) {
      if (!sameHouse.has(row.key)) continue;
      if (!country.inCountry(row)) continue;
      if (statusFilter !== "all" && statusFilter !== "sameHouse" && addrStatus(row, searches, picked, osmSearches) !== statusFilter)
        continue;
      n++;
    }
    return n;
  }, [rows, sameHouse, country, statusFilter, searches, picked, osmSearches]);
  const groups = useMemo(() => {
    // Both halves of every pair, whatever the toggles say. A house written
    // twice is very often already placed — that is what the second spelling
    // was made for — so the placed toggle, which hides finished work, hid the
    // very rows this chip counts: it said 15 and listed none. A suggestion is
    // also unreadable without the row it points at, and that row may be hidden
    // for reasons of its own.
    const pool = onlySameHouse ? rows.filter((r) => sameHouseKeys.has(r.key)) : visibleRows;
    const kept = pool
      .filter(country.inCountry)
      .filter(
        (r) =>
          statusFilter === "all" ||
          statusFilter === "sameHouse" ||
          addrStatus(r, searches, picked, osmSearches) === statusFilter,
      );
    const byPlace = new Map<string, PlaceGroup>();
    // One person can hold several houses of a village, and several events at
    // each — the header counts them once, so its number is the people you would
    // see on opening it, exactly as a row's own count is.
    const seenPeople = new Map<string, Set<string>>();
    for (const row of kept) {
      const g = byPlace.get(row.place);
      if (g) {
        g.rows.push(row);
        g.events += row.count;
        g.movable &&= !row.derived;
      } else {
        byPlace.set(row.place, { place: row.place, rows: [row], events: row.count, people: [], movable: !row.derived });
        seenPeople.set(row.place, new Set());
      }
      const group = byPlace.get(row.place)!;
      const seen = seenPeople.get(row.place)!;
      for (const id of row.people) {
        if (seen.has(id)) continue;
        seen.add(id);
        group.people.push(id);
      }
    }
    for (const g of byPlace.values()) {
      if (g.movable) g.suggestion = groupSuggestion(g.place, g.rows);
      // Inside a place, the addresses are that village's numbering — read in
      // order, not ranked by how often the file happens to name each house.
      g.rows.sort((a, b) => placeCollator.compare(a.address, b.address));
    }
    // Most-used places first — that is where geocoding pays off soonest.
    return [...byPlace.values()].sort((a, b) => b.events - a.events || placeCollator.compare(a.place, b.place));
  }, [rows, visibleRows, searches, osmSearches, picked, statusFilter, country, onlySameHouse, sameHouseKeys]);

  return { byKey, rows, visibleRows, hits, sameHouse, country, sameHouseCount, groups };
}

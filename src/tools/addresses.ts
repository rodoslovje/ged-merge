import type { Dataset, GedNode, GeoCoord } from "../gedcom/types";
import type { RecordPatch } from "../ui/historyTypes";
import { decomposePlace } from "../gedcom/place";
import { rnQueryFrom, type RnQuery } from "../geo/rn";
import { applyGeocodeByAddress, coordOf, placeAddrKey, walkPlaceAddr } from "./geocode";

// Geocoding the ADDR side of an event, as opposed to its PLAC.
//
// The Geocode-places tool works on distinct PLAC strings, which is right for
// places: one string, one coordinate, shared by every event that names it. An
// address is finer — two events in "Kranj" at different addresses are different
// locations — so these rows are keyed by the place+address pair, and the
// coordinate is written to that event's own standard PLAC.MAP. The health check
// groups by the same pair, so those differing coordinates are expected rather
// than reported (and a *disagreement within* one pair is what it flags).

/** One distinct place+address pair whose house the register could place. */
export interface AddressRow {
  /** Stable key: {@link placeAddrKey} of the two raw values. */
  key: string;
  /** Raw PLAC value of the events ("" when they have none). */
  place: string;
  /** Raw ADDR value. */
  address: string;
  /** The register query this row would run. */
  query: RnQuery;
  /** Events carrying this pair. */
  count: number;
  /** How many of them already have a coordinate (the settlement's, which a
   *  register match would sharpen to the building). */
  covered: number;
  /** Individuals the events belong to (both spouses for a family event). */
  people: string[];
}

/**
 * Find the place+address pairs a register lookup could place.
 *
 * Included when the ADDR yields a query and the events' coordinate is either
 * missing or no finer than the settlement's — the latter so an address can still
 * be sharpened after the place flow has filled in a settlement coordinate (the
 * Geocode-places list only offers places missing one outright, so without this
 * such an address would have nowhere to be resolved). Which coordinates count as
 * settlement-precise is worked out in pass 1 below.
 *
 * Excluded when the PLAC itself names a house number: that value is already
 * house-specific, so the Geocode-places row resolves it against the register
 * directly and listing it here would ask the same question twice.
 */
export function scanAddresses(dataset: Dataset): AddressRow[] {
  // Pass 1: which coordinates are only settlement-precise? Two tells, because a
  // house coordinate is by definition unique to its address:
  //   - it sits on an event that names no address at all, or
  //   - the same coordinate is shared by two *different* addresses — so it
  //     cannot be either house, only the settlement they share.
  // Checking just the first would miss a file where every event has an address
  // (a gazetteer fill would then look house-precise and never be offered).
  const addressesPerCoord = new Map<string, Set<string>>();
  const collect = (raw: GedNode) =>
    walkPlaceAddr(raw, (plac, addr) => {
      const coord = coordOf(plac);
      if (!coord) return;
      const key = `${plac.value!.trim()} ${coord.lat}:${coord.lon}`;
      const seen = addressesPerCoord.get(key);
      if (seen) seen.add(addr);
      else addressesPerCoord.set(key, new Set([addr]));
    });
  for (const indi of dataset.individuals.values()) collect(indi.raw);
  for (const fam of dataset.families.values()) collect(fam.raw);

  /** True when this coordinate is no finer than the settlement. */
  const isSettlementCoord = (place: string, coord: GeoCoord): boolean => {
    const seen = addressesPerCoord.get(`${place} ${coord.lat}:${coord.lon}`);
    return !!seen && (seen.has("") || seen.size > 1);
  };

  const groups = new Map<
    string,
    { place: string; address: string; query: RnQuery; count: number; covered: number; people: Set<string> }
  >();
  const visit = (raw: GedNode, personIds: string[]) => {
    walkPlaceAddr(raw, (plac, address) => {
      if (!address) return;
      const place = plac.value!.trim();
      // A PLAC that names the house belongs to the places flow, not here.
      if (decomposePlace(place).houseNumber) return;
      const coord = coordOf(plac);
      // Already sharper than the settlement — nothing left to improve.
      if (coord && !isSettlementCoord(place, coord)) return;
      const query = rnQueryFrom(place || undefined, address);
      if (!query) return;
      const key = placeAddrKey(place, address);
      let g = groups.get(key);
      if (!g) {
        g = { place, address, query, count: 0, covered: 0, people: new Set() };
        groups.set(key, g);
      }
      g.count++;
      if (coord) g.covered++;
      for (const id of personIds) g.people.add(id);
    });
  };
  for (const indi of dataset.individuals.values()) visit(indi.raw, [indi.id]);
  for (const fam of dataset.families.values())
    visit(fam.raw, [fam.husband, fam.wife].filter((id): id is string => !!id));

  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      place: g.place,
      address: g.address,
      query: g.query,
      count: g.count,
      covered: g.covered,
      people: [...g.people],
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Write accepted house coordinates onto every event at the matching place+address
 * pair, as standard `PLAC`/`MAP`. Overwrites a coordinate already there, since a
 * register match is by definition sharper than the settlement value it replaces.
 * Mutates the dataset in place and returns RecordPatch[] for the undo stack.
 */
export function applyAddressCoords(dataset: Dataset, assignments: ReadonlyMap<string, GeoCoord>): RecordPatch[] {
  const withIds = new Map([...assignments].map(([key, coord]) => [key, { coord }] as const));
  return applyGeocodeByAddress(dataset, withIds, true);
}

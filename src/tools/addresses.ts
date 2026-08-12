import type { Dataset, GedNode, GeoCoord } from "../gedcom/types";
import type { RecordPatch } from "../ui/historyTypes";
import {
  addressStreetName,
  decomposePlace,
  looksLikeStreet,
  placeAddressDetail,
  placeCollator,
  placeWithoutAddress,
} from "../gedcom/place";
import { rnQueriesFrom, type RnQuery } from "../geo/rn";
import { applyGeocodeByAddress, coordOf, patchRecords, placeAddrKey, walkPlaceAddr } from "./geocode";
import { reconcilePlaceForm } from "../gedcom/edit/geo";

// Geocoding the address of an event, as opposed to the place around it.
//
// The Geocode-places tool works on distinct PLAC strings, which is right for
// places: one string, one coordinate, shared by every event that names it. An
// address is finer — two events in "Kranj" at different addresses are different
// locations — so these rows are keyed by the place+address pair, and the
// coordinate is written to that event's own standard PLAC.MAP. The health check
// groups by the same pair, so those differing coordinates are expected rather
// than reported (and a *disagreement within* one pair is what it flags).
//
// Where the address is written is the file's business, not this tool's: an ADDR
// line beside the place, the whole place value ("Črni vrh 35"), or a house
// packed in among the other parts ("Kranj (Slovenija), Stražišče 114 - župnija
// Šmartin"). {@link detectAddress} reads all three into the same place+address
// pair, so a file that keeps no ADDR at all is reviewed by settlement exactly
// like one that does.

/**
 * The place and address one event names, wherever the file happens to keep
 * them. `place` is the file's own PLAC value when that value names only the
 * place; when it carries the address itself, the address is lifted out of it
 * and `place` becomes the jurisdiction part alone — the settlement the house
 * belongs to, which is what groups the houses of one village together.
 */
export interface DetectedAddress {
  place: string;
  /** "" when the event names no address at all. */
  address: string;
  /** True when the address was read out of the PLAC value, so `place` is a
   *  derived label rather than text the file writes anywhere. */
  derived: boolean;
}

/**
 * Split one event's PLAC and ADDR into the place+address pair they describe.
 *
 * An ADDR line is the address whenever there is one — it is the more specific
 * field, and the same event's place may name the house too. Otherwise the place
 * value is asked whether it carries an address inside itself, which is how the
 * files that keep no ADDR line record one.
 */
export function detectAddress(place: string, addr: string): DetectedAddress {
  const d = place ? decomposePlace(place) : undefined;
  const detail = d && placeAddressDetail(d);
  if (!d || !detail) return { place, address: addr, derived: false };
  return { place: placeWithoutAddress(d), address: addr || detail, derived: true };
}

/** One distinct place+address pair whose house the register could place. */
export interface AddressRow {
  /** Stable key: {@link placeAddrKey} of the row's place and address. */
  key: string;
  /**
   * The raw place+address pairs the row's events actually carry — where a
   * coordinate is written. More than one when the file spells the same house
   * several ways, as it does when the place value carries the address and an
   * annotation beside it ("… - župnija Šmartin" and "… - župnija Kranj" are the
   * same house), which is exactly what this row merges.
   */
  rawKeys: string[];
  /** The place the address sits in — see {@link DetectedAddress}. */
  place: string;
  /** The address, from the ADDR line or lifted out of the place value. */
  address: string;
  /** True when any of the row's events keep the address inside the place value,
   *  so the place shown is derived and the events cannot be moved by it. */
  derived?: boolean;
  /** The register queries this row would run — one per house number the address
   *  names, since old records often keep both an older and a newer number, and
   *  one per street when a renamed street left the house two whole addresses.
   *  Empty when the register cannot be asked at all: no house number, or a
   *  country it does not cover. Such a row is still reviewed — by hand, or with
   *  the rest of its place — it simply has no lookup to offer. */
  queries: RnQuery[];
  /** Events carrying this pair. */
  count: number;
  /** How many of them already have a coordinate (the settlement's, which a
   *  register match would sharpen to the building). */
  covered: number;
  /** The coordinate those events carry, when they have one — what the map can
   *  show before any lookup has run. */
  coord?: GeoCoord;
  /** True when that coordinate is not the settlement's own: this house was
   *  given a position of its own (if only its hamlet's), rather than
   *  inheriting the one the place's address-less events use. */
  placed?: boolean;
  /** Individuals the events belong to (both spouses for a family event). */
  people: string[];
}

/**
 * Find the file's place+address pairs, marked by whether they still need
 * placing.
 *
 * Every pair is a row; {@link AddressRow.placed} tells finished work (a
 * coordinate of the house's own, or at least not the settlement's) from the
 * work list (a coordinate missing or merely inherited from the place). The
 * finished rows ride along on purpose: the review list hides them by default
 * but offers them back on request, for checking a position or sharpening a
 * rough one. Which coordinates count as inherited is worked out in pass 1
 * below.
 *
 * Whether the register could answer is NOT a condition. It was, while a register
 * hit was the only way to place a row; now that a row can be given a position by
 * hand or a whole run of them one approximate position at once, the addresses the
 * register cannot answer are the ones that need this list most — a hamlet with no
 * number ("Stražišče"), a house known only by its farm name, an address abroad.
 * They arrive with no {@link AddressRow.queries}, which is how the review list
 * knows to offer them everything except the register lookup.
 *
 * Excluded when the PLAC itself names a house number: that value is already
 * house-specific, so the Geocode-places row resolves it against the register
 * directly and listing it here would ask the same question twice.
 */
export function scanAddresses(dataset: Dataset): AddressRow[] {
  // One decomposition per distinct PLAC+ADDR pair: a file that writes its
  // addresses in the place value has as many distinct values as events, and
  // both passes below ask the same question of every one of them.
  const detected = new Map<string, DetectedAddress>();
  const detect = (place: string, addr: string): DetectedAddress => {
    const memo = placeAddrKey(place, addr);
    let hit = detected.get(memo);
    if (!hit) {
      hit = detectAddress(place, addr);
      detected.set(memo, hit);
    }
    return hit;
  };

  // Pass 1: which coordinate is each settlement's own — collected from the
  // events that name no address (see below).
  /** place → the coordinates its address-less events use (see below). */
  const settlementCoords = new Map<string, Set<string>>();
  const collect = (raw: GedNode) =>
    walkPlaceAddr(raw, (plac, addr) => {
      const coord = coordOf(plac);
      if (!coord) return;
      const { place, address } = detect(plac.value!.trim(), addr);
      // The place's own position, kept apart: what an event carries when it
      // names no address is the settlement's coordinate, and a house holding
      // exactly that has not been placed — it inherited it.
      if (!address) {
        const at = `${coord.lat}:${coord.lon}`;
        const own = settlementCoords.get(place);
        if (own) own.add(at);
        else settlementCoords.set(place, new Set([at]));
      }
    });
  for (const indi of dataset.individuals.values()) collect(indi.raw);
  for (const fam of dataset.families.values()) collect(fam.raw);

  /**
   * True when this coordinate is the settlement's own — the one the file uses
   * for events at this place that name no address at all.
   *
   * This is what tells "not placed yet" from "placed, roughly". A house
   * inheriting the settlement's position has had nothing done to it; a hamlet's
   * houses sharing a position of their own were put there by someone. Both stay
   * in the list — a rough position may still want sharpening — so the row has
   * to say which of the two it is.
   */
  const isSettlementOwn = (place: string, coord: GeoCoord): boolean =>
    !!settlementCoords.get(place)?.has(`${coord.lat}:${coord.lon}`);

  const groups = new Map<
    string,
    {
      place: string;
      address: string;
      derived: boolean;
      queries: RnQuery[];
      rawKeys: Set<string>;
      count: number;
      covered: number;
      coord?: GeoCoord;
      placed: boolean;
      people: Set<string>;
    }
  >();
  /** Register queries per row key — the same answer for every event of a row,
   *  and worth remembering for the rows that yield none, since those are asked
   *  about once per event otherwise. */
  const queries = new Map<string, RnQuery[]>();
  const visit = (raw: GedNode, personIds: string[]) => {
    walkPlaceAddr(raw, (plac, addr) => {
      const rawPlace = plac.value!.trim();
      const { place, address, derived } = detect(rawPlace, addr);
      if (!address) return;
      const coord = coordOf(plac);
      const key = placeAddrKey(place, address);
      let q = queries.get(key);
      if (!q) {
        q = rnQueriesFrom(place || undefined, address);
        queries.set(key, q);
      }
      let g = groups.get(key);
      if (!g) {
        g = {
          place,
          address,
          derived,
          queries: q,
          rawKeys: new Set(),
          count: 0,
          covered: 0,
          placed: false,
          people: new Set(),
        };
        groups.set(key, g);
      }
      // One event keeping the address in its place value is enough to make the
      // row's place a derived label — the group can no longer be moved by it.
      g.derived ||= derived;
      g.rawKeys.add(placeAddrKey(rawPlace, addr));
      g.count++;
      if (coord) {
        g.covered++;
        // The row shows the position the house was given, not one it merely
        // inherited, when its events carry both.
        if (!g.coord || (isSettlementOwn(place, g.coord) && !isSettlementOwn(place, coord))) g.coord = coord;
        // One event placed away from the settlement is enough to call the house
        // placed: the others simply have not caught up yet.
        g.placed ||= !isSettlementOwn(place, coord);
      }
      for (const id of personIds) g.people.add(id);
    });
  };
  for (const indi of dataset.individuals.values()) visit(indi.raw, [indi.id]);
  for (const fam of dataset.families.values())
    visit(fam.raw, [fam.husband, fam.wife].filter((id): id is string => !!id));

  return [...groups.entries()]
    .map(([key, g]) => ({
      key,
      rawKeys: [...g.rawKeys],
      place: g.place,
      address: g.address,
      ...(g.derived ? { derived: true as const } : {}),
      queries: g.queries,
      count: g.count,
      covered: g.covered,
      ...(g.coord ? { coord: g.coord } : {}),
      ...(g.placed ? { placed: true as const } : {}),
      people: [...g.people],
    }))
    .sort((a, b) => b.count - a.count || placeCollator.compare(a.key, b.key));
}

/**
 * Every address the file writes at each place, read the same way the rows above
 * are ({@link detectAddress}) — the suggestion list behind an address rename.
 *
 * Deliberately wider than {@link scanAddresses}: an address whose events already
 * carry their own house coordinate is no longer a geocoding row, but it is still
 * the spelling a straggler should be renamed *onto*, and joining the two is what
 * makes one house of them again.
 */
export function addressesByPlace(dataset: Dataset): Map<string, string[]> {
  // Memoized per distinct PLAC+ADDR pair, like the scan above: a file that keeps
  // its addresses in the place value has one such pair per event.
  const detected = new Map<string, DetectedAddress>();
  const byPlace = new Map<string, Set<string>>();
  const visit = (raw: GedNode) =>
    walkPlaceAddr(raw, (plac, addr) => {
      const rawPlace = plac.value!.trim();
      const memo = placeAddrKey(rawPlace, addr);
      let hit = detected.get(memo);
      if (!hit) {
        hit = detectAddress(rawPlace, addr);
        detected.set(memo, hit);
      }
      if (!hit.address) return;
      const seen = byPlace.get(hit.place);
      if (seen) seen.add(hit.address);
      else byPlace.set(hit.place, new Set([hit.address]));
    });
  for (const indi of dataset.individuals.values()) visit(indi.raw);
  for (const fam of dataset.families.values()) visit(fam.raw);
  return new Map(
    [...byPlace].map(([place, addrs]) => [place, [...addrs].sort((a, b) => placeCollator.compare(a, b))]),
  );
}

/** One house's rename, as the lists ask for it. A list of these is applied in a
 *  single undo step — see the `onRenameAddresses` prop the panels carry. */
export interface AddressRename {
  /** The row's raw place+address spellings ({@link AddressRow.rawKeys}). */
  rawKeys: string[];
  from: string;
  to: string;
}

/**
 * Rename one house's address on every event that carries it — the ADDR-line
 * form and the packed-in-PLAC form both. `rawKeys` are the row's raw
 * place+address spellings ({@link AddressRow.rawKeys}), so exactly the
 * events the row merged are touched. An ADDR line takes the new text
 * outright; an address written inside the place value is replaced only where
 * the old text appears verbatim, leaving annotations ("- župnija X") intact.
 * Renaming onto another row's address merges the two on the next scan — that
 * is the point: one house, two spellings, one row.
 */
export function renameAddress(
  dataset: Dataset,
  rawKeys: readonly string[],
  fromAddress: string,
  toAddress: string,
): RecordPatch[] {
  const from = fromAddress.trim();
  const to = toAddress.trim();
  if (!to || to === from) return [];
  const keys = new Set(rawKeys);
  return patchRecords(dataset, (raw) => {
    let changed = false;
    walkPlaceAddr(raw, (plac, addr, event) => {
      const rawPlace = plac.value!.trim();
      if (!keys.has(placeAddrKey(rawPlace, addr))) return;
      if (addr) {
        const addrNode = event.children.find((c) => c.tag === "ADDR" && c.value?.trim());
        if (addrNode && addrNode.value?.trim() !== to) {
          addrNode.value = to;
          changed = true;
        }
      }
      if (plac.value!.includes(from)) {
        plac.value = plac.value!.replace(from, to);
        // An address written inside the place value is one of its comma parts,
        // so rewriting it can change how many there are — and a FORM naming the
        // old count would then describe something else.
        reconcilePlaceForm(plac, undefined);
        changed = true;
      }
    });
    return changed;
  });
}

/**
 * The same place with its settlement swapped for `locality`, keeping every
 * outer level and the file's own spelling of them — "Gradac, Metlika, Slovenia"
 * with "Klošter" becomes "Klošter, Metlika, Slovenia", not a freshly composed
 * string that would drift from the rest of the file.
 *
 * Only the plain comma form is handled: the packed Brother's Keeper syntax puts
 * the settlement in among parentheticals where a blind substitution could just as
 * easily hit a house name. Returns undefined when the leading segment is not the
 * settlement, or when it already is `locality`.
 */
export function replaceLocality(place: string, locality: string): string | undefined {
  const name = locality.trim();
  const segments = place.split(",");
  const first = segments[0]?.trim();
  if (!name || !first || first === name) return undefined;
  if (first !== decomposePlace(place).locality) return undefined;
  segments[0] = segments[0].replace(first, name);
  return segments.join(",");
}

/**
 * Where an address suggests its events really belong — the offline half of the
 * split: an address whose house number hangs off a name that is *not* the place's
 * settlement ("Klošter 12" under "Gradac, Metlika, Slovenia") is either a street
 * in that settlement or a settlement of its own recorded as though it were one.
 * A name carrying no street word is the second reading, and the proposal is that
 * place with the settlement swapped.
 *
 * A guess, not a verdict — the register check confirms it, and either way the
 * move is the researcher's explicit click.
 */
export function suggestMovedPlace(place: string, address: string): string | undefined {
  const host = addressStreetName(address);
  if (!host || looksLikeStreet(host)) return undefined;
  return replaceLocality(place, host);
}

/**
 * Write accepted house coordinates onto every event at the matching place+address
 * pair, as standard `PLAC`/`MAP`. The keys are the raw pairs a row covers
 * ({@link AddressRow.rawKeys}), not the row's own key: the row groups the file's
 * spellings of one house, and each of them has to be matched as written.
 * Overwrites a coordinate already there, since a
 * register match is by definition sharper than the settlement value it replaces.
 * Mutates the dataset in place and returns RecordPatch[] for the undo stack.
 */
export function applyAddressCoords(dataset: Dataset, assignments: ReadonlyMap<string, GeoCoord>): RecordPatch[] {
  const withIds = new Map([...assignments].map(([key, coord]) => [key, { coord }] as const));
  return applyGeocodeByAddress(dataset, withIds, true);
}

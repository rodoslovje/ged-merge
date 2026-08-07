import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { stripHouseNumber } from "../../gedcom/place";
import { formatCoord, sameCoord } from "../../geo/points";
import { batchAnswered, isOfflineQuery, resultsForQuery, searchAddressBatch, searchAddresses, splitAddressVariants, type RnResult } from "../../geo/rn";
import { placeLookupLanguage } from "../../geo/lookupLanguage";
import { osmKindLabel, osmNamesPlace, osmShortLabel, searchNominatim, type NominatimResult } from "../../geo/nominatim";
import type { PlaceProposal } from "../../geo/placeProposal";
import { replaceLocality, suggestMovedPlace, type AddressRow } from "../../tools/addresses";
import { countryOf, placeAddrKey, type GeoAssignment } from "../../tools/geocode";
import type { Translate } from "../../locales/i18n";
import { foldSearch } from "../globalSearch";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import { EventCoordPicker } from "../edit/EventCoordPicker";
import { PlaceAutocomplete } from "../edit/PlaceAutocomplete";
import { usePlaceLookup } from "../edit/PlaceLookupContext";
import type { PlaceSuggestions } from "../edit/placeSuggestions";
import { useNameOf, useSettings } from "../SettingsContext";
import { lineageClass, type KinshipResolver } from "../../match/kinship";
import { PersonLink } from "../PersonLink";
import { AppliedNote, ExpandAllToggle, GeoRowHeader, MapToggle, RowMap } from "./shared";
import { requestSettings } from "../settingsBus";

// The ADDR half of geocoding: house coordinates from the GURS address register
// for events whose PLAC names only the settlement. Kept apart from the place
// rows above because the unit is different — a place string has one coordinate
// shared by every event naming it, whereas each address is its own house.
//
// Grouped by place, and collapsed: a real file has hundreds of addresses (997 in
// one test corpus), so a flat list is unreadable and a single "look up all" would
// fire that many throttled requests. Work proceeds one place at a time instead.
//
// The place a group is named after is the file's own value when the file keeps
// its addresses in ADDR lines, and the settlement lifted out of the place values
// when it does not (see detectAddress). Only the first kind can be *moved*:
// moving rewrites the place value of the ticked addresses, which for the second
// kind is the very text holding the house number.

type SearchState = { state: "idle" | "loading" | "error" | "done"; results: RnResult[] };

/** The same, for the OpenStreetMap fallback below — a separate state per row,
 *  because the two lookups answer independently and a row may have both. */
type OsmState = { state: "idle" | "loading" | "error" | "done"; results: NominatimResult[] };

const IDLE: SearchState = { state: "idle", results: [] };
const OSM_IDLE: OsmState = { state: "idle", results: [] };

/** The lookup-state chips over the list, mirroring the places list's work
 *  chips: what still needs a register query, what came back with houses to
 *  judge, what the register does not know, what it cannot be asked about at
 *  all, and what is staged for writing. */
type AddrStatus = "unsearched" | "found" | "none" | "manual" | "placed" | "picked";
const ADDR_FILTERS: ("all" | AddrStatus)[] = ["all", "unsearched", "found", "none", "manual", "placed", "picked"];

/** A row's lookup state right now. An error or in-flight search still counts
 *  as "unsearched" — it has no answer yet and the lookup can be retried; a row
 *  with no query at all is "manual", since no amount of retrying will help. */
function addrStatus(
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

/** One answer offered for a row, whichever service found it. `label` is the
 *  line shown and staged as the pick's origin; `source` is its badge. */
interface AddrCandidate {
  coord: GeoCoord;
  label: string;
  /** What the hit is — "suburb", "service road" — where the service says so.
   *  OpenStreetMap answers one name with the place, the street named after it
   *  and every service road off it, all under the same display line. */
  detail?: string;
  /** Set when the hit does not name this address at all: the place it names
   *  instead. A free-text search for a house the service does not know answers
   *  with the same number in another village. */
  elsewhere?: string;
  /** The service's full display line, when `label` is a shortened form of it —
   *  kept as the option's tooltip. */
  title?: string;
  source: "GURS" | "OSM";
  badgeClass: "official" | "reuse";
}

/** A row's answers as one list: the register's first — it is the official
 *  record of the house — then OpenStreetMap's, minus any hit already standing
 *  at the same point, so the two services agreeing reads as one answer. An
 *  OpenStreetMap hit that names somewhere else entirely goes last, marked with
 *  the place it does name. */
function rowCandidates(search: SearchState, osm: OsmState, address: string, t: Translate): AddrCandidate[] {
  const out: AddrCandidate[] = search.results.map((r) => ({
    coord: r.coord,
    label: r.label,
    source: "GURS",
    badgeClass: "official",
  }));
  const named = stripHouseNumber(address).trim();
  const strays: AddrCandidate[] = [];
  for (const r of osm.results) {
    if (out.some((c) => sameCoord(c.coord, r.coord))) continue;
    const detail = osmKindLabel(r, t);
    // The short composed line; the raw display chain stays in the tooltip.
    const label = osmShortLabel(r);
    const cand: AddrCandidate = {
      coord: r.coord,
      label,
      ...(label !== r.label ? { title: r.label } : {}),
      ...(detail ? { detail } : {}),
      source: "OSM",
      badgeClass: "reuse",
    };
    // Not this address at all: OpenStreetMap matched the house number against
    // another village. Kept — a renumbered house does turn up this way — but
    // named for what it is and pushed below the answers that do fit.
    if (named && !osmNamesPlace(r, named)) {
      const where = r.parts?.locality ?? r.admin;
      strays.push({ ...cand, elsewhere: where || r.name });
    } else out.push(cand);
  }
  return [...out, ...strays];
}

/** House numbers compared as numbers: 4 · 6 · 7 · 32, not 32 · 4 · 6 · 7. */
const BY_NUMBER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** How many places a filter may open by itself. */
const AUTO_OPEN_LIMIT = 20;

/** Addresses of one place, with the totals its header shows. */
interface PlaceGroup {
  place: string;
  rows: AddressRow[];
  events: number;
  /** Whether these addresses can be moved to another place: only when every one
   *  of them names the place in a value of its own, so rewriting that value
   *  moves the event and nothing else. */
  movable: boolean;
  /** Where these addresses suggest they belong, when they agree on one — the
   *  place with its settlement swapped for the name the house numbers hang off
   *  ({@link suggestMovedPlace}), and the rows that say so. */
  suggestion?: { place: string; keys: string[] };
}

/** What the register says about a group: addresses it files under a settlement
 *  other than the one the file's place names. */
interface RegisterSplit {
  /** The register's settlement (NASELJE_NAZIV). */
  settlement: string;
  /** Its municipality, when the register gave one. */
  municipality?: string;
  /** The destination place — the file's own, with the settlement swapped. */
  place?: string;
  keys: string[];
  events: number;
}

/**
 * Addresses whose register hit sits in a different settlement than the place
 * claims. This is the register's own verdict, not a guess: the ladder asks for
 * "Klošter 12" as naselje Klošter once Gradac has nothing, and what comes back
 * is filed under Klošter, občina Metlika.
 *
 * Rows with no result yet, or one that agrees, are simply absent; splits are
 * keyed by settlement so a place that turns out to hide two hamlets offers both.
 */
function registerSplits(group: PlaceGroup, searches: ReadonlyMap<string, SearchState>): RegisterSplit[] {
  const out = new Map<string, RegisterSplit>();
  for (const row of group.rows) {
    const results = searches.get(row.key)?.results ?? [];
    // Only an unambiguous hit is evidence — several candidates mean the register
    // itself could not tell which house, let alone which settlement.
    if (results.length !== 1) continue;
    const hit = results[0];
    const claimed = row.queries[0]?.settlement;
    if (!hit.settlement || !claimed || foldSearch(hit.settlement) === foldSearch(claimed)) continue;
    const split = out.get(hit.settlement);
    if (split) {
      split.keys.push(row.key);
      split.events += row.count;
    } else {
      out.set(hit.settlement, {
        settlement: hit.settlement,
        ...(hit.municipality ? { municipality: hit.municipality } : {}),
        ...(replaceLocality(group.place, hit.settlement) ? { place: replaceLocality(group.place, hit.settlement) } : {}),
        keys: [row.key],
        events: row.count,
      });
    }
  }
  return [...out.values()].sort((a, b) => b.keys.length - a.keys.length);
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

export function AddressCoordsSection({
  dataset,
  all,
  addrsByPlace,
  places,
  onApply,
  onMove,
  query,
  actionsHost,
  onRenameAddress,
  kinship,
  onNavigate,
}: {
  dataset: Dataset;
  /** The scanned address rows — computed by the panel, which also needs the
   *  count for the tab that shows or hides this whole section. */
  all: AddressRow[];
  /** Every address the file writes at each place, the rename field's
   *  completions — wider than `all`, which drops the placed houses. */
  addrsByPlace: ReadonlyMap<string, string[]>;
  /** Existing place values for the move target's autocomplete — the panel's
   *  own scanGen-keyed list, so a place renamed this session is offered under
   *  its new spelling (the dataset mutates in place; a local memo would not
   *  see the change). */
  places: PlaceSuggestions;
  onApply: (assignments: Map<string, GeoCoord>) => number;
  /** `coord` is the destination's own position, when it was picked from a
   *  register — the moved events are placed there instead of keeping the
   *  coordinate of the settlement they are leaving. */
  onMove: (keys: Set<string>, toPlace: string, coord?: GeoAssignment) => number;
  /** The page's filter, already folded. A group whose place matches keeps all
   *  its addresses; otherwise only the addresses that match are listed. */
  query: string;
  /** Tab-row element to render the action buttons into (portal): the tabs
   *  already name and count this list, so the section shows no heading of its
   *  own while hosted. Null until the slot mounts. */
  actionsHost?: HTMLElement | null;
  /** Rename one house's address on every event that carries it (edit/undo
   *  pipeline); returns the number of records changed. */
  onRenameAddress: (rawKeys: string[], fromAddress: string, toAddress: string) => number;
  /** Kinship labels for the rows' people lists — the places rows' resolver. */
  kinship?: KinshipResolver;
  /** Jump to a person in Edit mode (the rows' people lists). */
  onNavigate: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const { settings } = useSettings();
  const nameOf = useNameOf();
  const byKey = useMemo(() => new Map(all.map((row) => [row.key, row])), [all]);
  // Matching on the address alone would drop the settlement a search like
  // "Kranj" is really about, and matching on the place alone would hide the one
  // house someone typed a number for — so a row matches on either.
  const rows = useMemo(
    () =>
      query ? all.filter((row) => foldSearch(row.place).includes(query) || foldSearch(row.address).includes(query)) : all,
    [all, query],
  );
  const [searches, setSearches] = useState<Map<string, SearchState>>(new Map());
  /** What OpenStreetMap answered per row — the fallback for everything the
   *  address register cannot take: a house with no number, a hamlet named
   *  rather than numbered, an address outside Slovenia. */
  const [osmSearches, setOsmSearches] = useState<Map<string, OsmState>>(new Map());
  const [picked, setPicked] = useState<Map<string, { coord: GeoCoord; label: string }>>(new Map());
  // A rescan can re-key rows from outside this section — a place renamed on
  // the Places tab, an edit made in Edit mode — leaving staged work under keys
  // no row carries any more. Drop exactly those entries, or the Write button
  // counts picks it cannot write. Keyed on the rescan (not on the staged maps),
  // so work this section re-keys itself — applyRename carries a pick to the
  // new spelling before the rescan lands — is never caught mid-flight.
  useEffect(() => {
    const dropGone = <V,>(prev: Map<string, V>) => {
      let changed = false;
      const next = new Map(prev);
      for (const key of next.keys()) {
        if (!byKey.has(key)) {
          next.delete(key);
          changed = true;
        }
      }
      return changed ? next : prev;
    };
    setPicked(dropGone);
    setSearches(dropGone);
    setOsmSearches(dropGone);
  }, [byKey]);
  // Whether already-placed addresses are on the list at all. Off by default:
  // the list is a worklist, and a placed row is finished work — it comes back
  // on request, for checking a position or sharpening a rough one.
  const [showPlaced, setShowPlaced] = useState(false);
  /** The rows the list works over. A row with a pick staged stays whatever the
   *  toggle says — work in progress is never hidden. */
  const visibleRows = useMemo(
    () => (showPlaced ? rows : rows.filter((row) => !row.placed || picked.has(row.key))),
    [rows, showPlaced, picked],
  );
  /** Groups the filter matched by *address*, which are worth opening: the row
   *  looked for is inside, and there may be one of it under a hundred. */
  const hits = useMemo(() => {
    const found = new Set<string>();
    if (query) {
      for (const row of visibleRows) if (foldSearch(row.address).includes(query)) found.add(row.place);
    }
    return found;
  }, [visibleRows, query]);
  // Which lookup state is on screen; "all" leaves the list whole. Like the
  // places chips, a chip's count is exactly what clicking it shows.
  const [statusFilter, setStatusFilter] = useState<"all" | AddrStatus>("all");
  /** The country on screen — a place value's last comma part, the same key the
   *  places and compliance lists chip on. `null` = all of them. */
  const [countryFilter, setCountryFilter] = useState<string | null>(null);
  // Rows whose people list is open — asked for by clicking the person count.
  const [peopleOpen, setPeopleOpen] = useState<Set<string>>(new Set());
  // The one row whose rename editor is open, and its draft.
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  /** Which row's coordinate panel is open. Held here rather than inside the
   *  picker because the row opens it from two controls — the address and the
   *  pin — with the rename ✎ between them. */
  const [coordOpen, setCoordOpen] = useState<string | null>(null);

  // Hover lists of the people behind each address's person count.
  const peopleTitles = useMemo(() => {
    const titles = new Map<string, string>();
    for (const row of all) {
      if (!row.people.length) continue;
      const shown = row.people.slice(0, 15).map((id) => {
        const p = dataset.individuals.get(id);
        return p ? nameOf(p) : id;
      });
      const more = row.people.length - shown.length;
      titles.set(row.key, shown.join("\n") + (more > 0 ? `\n… +${more}` : ""));
    }
    return titles;
  }, [all, nameOf, dataset]);

  // One chip per country the addresses stand in, counting the addresses each
  // click would show — a chip's count respects every filter except its own,
  // exactly as in the two lists beside this one.
  const countryChips = useMemo(() => {
    const inStatus = (r: AddressRow) =>
      statusFilter === "all" || addrStatus(r, searches, picked, osmSearches) === statusFilter;
    const counts = new Map<string, number>();
    for (const row of visibleRows) {
      const c = countryOf(row.place);
      counts.set(c, (counts.get(c) ?? 0) + (inStatus(row) ? 1 : 0));
    }
    return [...counts].map(([country, count]) => ({ country, count })).sort(
      (a, b) => b.count - a.count || a.country.localeCompare(b.country),
    );
  }, [visibleRows, statusFilter, searches, picked, osmSearches]);
  const activeCountry =
    countryFilter !== null && countryChips.some((c) => c.country === countryFilter) ? countryFilter : null;

  const groups = useMemo(() => {
    const inCountry = (r: AddressRow) => activeCountry === null || countryOf(r.place) === activeCountry;
    const kept = visibleRows
      .filter(inCountry)
      .filter((r) => statusFilter === "all" || addrStatus(r, searches, picked, osmSearches) === statusFilter);
    const byPlace = new Map<string, PlaceGroup>();
    for (const row of kept) {
      const g = byPlace.get(row.place);
      if (g) {
        g.rows.push(row);
        g.events += row.count;
        g.movable &&= !row.derived;
      } else byPlace.set(row.place, { place: row.place, rows: [row], events: row.count, movable: !row.derived });
    }
    for (const g of byPlace.values()) {
      if (g.movable) g.suggestion = groupSuggestion(g.place, g.rows);
      // Inside a place, the addresses are that village's numbering — read in
      // order, not ranked by how often the file happens to name each house.
      g.rows.sort((a, b) => BY_NUMBER.compare(a.address, b.address));
    }
    // Most-used places first — that is where geocoding pays off soonest.
    return [...byPlace.values()].sort((a, b) => b.events - a.events || a.place.localeCompare(b.place));
  }, [visibleRows, searches, osmSearches, picked, statusFilter, activeCountry]);

  const [open, setOpen] = useState<Set<string>>(new Set());
  /** The one group whose map is drawn — never on open, always on request, and
   *  one at a time: a map is a Leaflet instance, and this list runs to hundreds
   *  of places (the same rule the places and compliance lists follow). */
  const [mapOpen, setMapOpen] = useState<string | null>(null);
  const [applied, setApplied] = useState<number | null>(null);
  // The move panel: which group's is open, where to, and which of its rows go.
  const [moveGroup, setMoveGroup] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [moveSel, setMoveSel] = useState<Set<string>>(new Set());
  const [moved, setMoved] = useState<number | null>(null);
  // A destination picked from a register, with the coordinate that register
  // puts it at. Held together with the text it belongs to, so editing the
  // destination afterwards drops the coordinate rather than moving the events
  // to a place they no longer name.
  const [movePick, setMovePick] = useState<{ place: string; assignment: GeoAssignment } | null>(null);
  // The one-coordinate panel: which group's is open, the position chosen for it,
  // and which of its rows take it. For the houses no register can answer — old
  // village numbering, a farm long gone — where an approximate position shared
  // by the whole hamlet is worth far more than no position at all.
  const [coordGroup, setCoordGroup] = useState<string | null>(null);
  const [coordPick, setCoordPick] = useState<{ coord: GeoCoord; label: string } | null>(null);
  const [coordSel, setCoordSel] = useState<Set<string>>(new Set());
  /** Text the ticked addresses must start with, when the choice is a run of
   *  them rather than the whole place — the house names of one farm, the
   *  numbers of one hamlet. Empty means the group entire. */
  const [coordPrefix, setCoordPrefix] = useState("");

  // A filter that lands on a handful of places opens them: the address looked
  // for is one row inside a group of a hundred, and finding it should not cost a
  // second click. Seeded into the ordinary open set, so it can be closed again
  // like any group. A broad filter is left alone — expanding several hundred
  // groups renders every address in them, and answers nothing.
  useEffect(() => {
    if (!hits.size || hits.size > AUTO_OPEN_LIMIT) return;
    setOpen((prev) => {
      if ([...hits].every((place) => prev.has(place))) return prev;
      return new Set([...prev, ...hits]);
    });
  }, [hits]);

  if (!all.length) return null;

  const allOpen = groups.length > 0 && groups.every((g) => open.has(g.place));

  // Faceted like the places chips: counted over the rows on offer, so each
  // chip says how many addresses clicking it leaves on screen.
  const statusCounts = { unsearched: 0, found: 0, none: 0, manual: 0, placed: 0, picked: 0 };
  for (const row of visibleRows) statusCounts[addrStatus(row, searches, picked, osmSearches)]++;
  /** How many rows the placed toggle is holding back (or, on, has let in). */
  const placedTotal = rows.filter((r) => r.placed && !picked.has(r.key)).length;

  const togglePeople = (key: string) =>
    setPeopleOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const setSearch = (key: string, next: SearchState) => setSearches((prev) => new Map(prev).set(key, next));

  const runSearch = (row: AddressRow) => {
    setSearch(row.key, { state: "loading", results: [] });
    searchAddresses(row.queries).then(
      (results) => setSearch(row.key, { state: "done", results }),
      () => setSearch(row.key, { state: "error", results: [] }),
    );
  };

  const setOsm = (key: string, next: OsmState) => setOsmSearches((prev) => new Map(prev).set(key, next));

  /**
   * Ask OpenStreetMap for this one address — the register's fallback, and the
   * only lookup for the rows it cannot take at all.
   *
   * One row at a time, never a group: Nominatim's policy is one request per
   * second and no bulk use, so the batch the register offers has no counterpart
   * here. The query is the address ahead of its place, which is how the service
   * reads an address best (the Edit view's picker asks in the same order).
   */
  const runOnline = (row: AddressRow) => {
    const compose = (addr: string) => [addr, row.place].map((s) => s.trim()).filter(Boolean).join(", ");
    if (!compose(row.address)) return;
    setOsm(row.key, { state: "loading", results: [] });
    // Asked in the language the place is written in, not the interface's: a
    // file that says "United States" must not be answered "Združene države
    // Amerike", or the answer names a country the file does not.
    const lang = placeLookupLanguage(row.place, i18n.language);
    // A house OpenStreetMap has never been told about is answered with whatever
    // else carries that number — "Čirče 5, Kranj" comes back as "5, Breg ob
    // Savi", a house of another village entirely. When nothing that came back
    // names the address at all, ask again for the street or hamlet without its
    // number: OpenStreetMap knows Čirče perfectly well, and the village's own
    // position is worth far more here than a stranger's front door.
    const lookup = async (variant: string): Promise<NominatimResult[]> => {
      const named = stripHouseNumber(variant).trim();
      const results = await searchNominatim(compose(variant), lang);
      if (!named || named === variant.trim() || results.some((r) => osmNamesPlace(r, named))) return results;
      const wider = await searchNominatim(compose(named), lang);
      return wider.length ? wider : results;
    };
    // A house under both its old and new street name ("Labore 4 / Škofjeloška
    // 4") is two whole addresses; each is asked on its own — read as one string
    // it is an address no service knows — and the answers stand in one list,
    // minus any hit another variant already placed at the same point.
    Promise.all(splitAddressVariants(row.address).map(lookup))
      .then((perVariant) => {
        const results: NominatimResult[] = [];
        for (const r of perVariant.flat()) {
          if (!results.some((have) => sameCoord(have.coord, r.coord))) results.push(r);
        }
        setOsm(row.key, { state: "done", results });
      })
      .catch(() => setOsm(row.key, { state: "error", results: [] }));
  };

  /**
   * Look up every address of one place in one request. The register accepts
   * `HS_STEVILKA IN (…)`, so a place's whole list costs a single round trip
   * instead of up to four per address — 37 addresses used to mean well over a
   * hundred throttled requests, which took more than a minute and read as hung.
   *
   * A row the batch cannot answer is marked "no match"; its own button still
   * offers the full per-address ladder (suffix retry, any street, the outer
   * settlements), which is more than a batch can express.
   */
  const searchGroup = (group: PlaceGroup) => {
    // Rows with no query are not "pending" — there is nothing to ask about, and
    // marking them loading would leave them stuck at it.
    const pending = group.rows.filter(
      (row) => row.queries.length > 0 && (searches.get(row.key) ?? IDLE).state === "idle",
    );
    if (!pending.length) return;
    setSearches((prev) => {
      const next = new Map(prev);
      for (const row of pending) next.set(row.key, { state: "loading", results: [] });
      return next;
    });
    searchAddressBatch(pending.flatMap((row) => row.queries)).then(
      (pool) =>
        setSearches((prev) => {
          const next = new Map(prev);
          // A group the batch could not fetch (one timeout used to fail the
          // whole place) marks only its own rows as errors — the groups that
          // resolved keep their answers.
          for (const row of pending) {
            next.set(
              row.key,
              batchAnswered(row.queries, pool)
                ? { state: "done", results: resultsForQuery(row.queries, pool) }
                : { state: "error", results: [] },
            );
          }
          return next;
        }),
      () =>
        setSearches((prev) => {
          const next = new Map(prev);
          for (const row of pending) next.set(row.key, { state: "error", results: [] });
          return next;
        }),
    );
  };

  const toggleMap = (place: string) => setMapOpen((prev) => (prev === place ? null : place));

  const toggle = (place: string) => {
    // The place's houses on its map, from the moment it is opened by hand.
    setMapOpen((prev) => (open.has(place) ? (prev === place ? null : prev) : place));
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(place)) next.delete(place);
      else next.add(place);
      return next;
    });
  };

  /** Open the move panel for a group, pre-filled with what its addresses
   *  suggest — the whole group when they suggest nothing. A `split` from the
   *  register overrides that guess with its verdict. */
  const startMove = (group: PlaceGroup, split?: RegisterSplit) => {
    setMoveGroup(group.place);
    setCoordGroup(null);
    setMoved(null);
    setMoveTarget(split?.place ?? split?.settlement ?? group.suggestion?.place ?? "");
    setMoveSel(new Set(split?.keys ?? group.suggestion?.keys ?? group.rows.map((r) => r.key)));
    setMovePick(null);
  };

  const closeMove = () => {
    setMoveGroup(null);
    setMoveTarget("");
    setMoveSel(new Set());
    setMovePick(null);
  };

  const toggleMoveRow = (key: string) =>
    setMoveSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const applyMove = () => {
    const pick = movePick?.place === moveTarget.trim() ? movePick.assignment : undefined;
    const keys = new Set<string>();
    for (const key of moveSel) for (const raw of byKey.get(key)?.rawKeys ?? []) keys.add(raw);
    const changed = onMove(keys, moveTarget, pick);
    closeMove();
    // The moved rows are keyed by their old place, so their picks and lookups
    // are stale — and their destination rows, under new keys, start unasked,
    // which is worth a fresh look. Every other row keeps its key across the
    // rescan, so what is staged there stands: accepting one move must not
    // throw away the rest of the worklist.
    const dropMoved = <V,>(prev: Map<string, V>) => {
      const next = new Map(prev);
      for (const key of moveSel) next.delete(key);
      return next;
    };
    setPicked(dropMoved);
    setSearches(dropMoved);
    setOsmSearches(dropMoved);
    setMoved(changed);
  };

  const pick = (key: string, result: { coord: GeoCoord; label: string }) =>
    setPicked((prev) => new Map(prev).set(key, { coord: result.coord, label: result.label }));

  /** Open the one-coordinate panel for a group. Every address is ticked to
   *  begin with — the case this is for is a village the register cannot answer
   *  at all — and the position the file already uses for the place is the
   *  opening offer, since that is the "centre of the village" being asked for. */
  const startCoords = (group: PlaceGroup) => {
    setCoordGroup(group.place);
    setMoveGroup(null);
    setApplied(null);
    setCoordPrefix("");
    setCoordSel(new Set(group.rows.map((r) => r.key)));
    const fromFile = group.rows.find((r) => r.coord)?.coord;
    setCoordPick(fromFile ? { coord: fromFile, label: t("tools.geocode.fromFile") } : null);
  };

  const closeCoords = () => {
    setCoordGroup(null);
    setCoordSel(new Set());
    setCoordPrefix("");
    setCoordPick(null);
  };

  /** Tick exactly the addresses that begin with `prefix` — folded, so the
   *  diacritics need not be typed. An empty prefix is the whole group again.
   *  Ticks made by hand afterwards stand until the next keystroke. */
  const selectByPrefix = (group: PlaceGroup, prefix: string) => {
    setCoordPrefix(prefix);
    const q = foldSearch(prefix.trim());
    setCoordSel(new Set(group.rows.filter((r) => !q || foldSearch(r.address).startsWith(q)).map((r) => r.key)));
  };

  const toggleCoordRow = (key: string) =>
    setCoordSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** Stage the chosen position for every ticked address. Staged, not written:
   *  these rows now read like any other pick, and the page's own Write button
   *  commits them together — one undo step for the whole village. */
  const applyCoords = () => {
    if (!coordPick) return;
    setPicked((prev) => {
      const next = new Map(prev);
      for (const key of coordSel) next.set(key, { coord: coordPick.coord, label: coordPick.label });
      return next;
    });
    closeCoords();
  };

  /** Rename the row's address on every event that carries it, then close the
   *  editor — the rescan (edit version) merges it into an existing row when
   *  the new spelling already has one, which is how duplicates are joined. */
  const applyRename = (row: AddressRow) => {
    const to = renameDraft.trim();
    if (!to || to === row.address) return;
    onRenameAddress(row.rawKeys, row.address, to);
    setRenameKey(null);
    // The row's key changes with its address, so state tied to the old key has
    // to travel with it. A position staged here is about the *house*, not its
    // spelling — dropping it silently lost a pick the row still displayed, and
    // the rename was written on its own. Where the rename joins the row to one
    // that already carries a pick, that pick stands: both name the same house,
    // and the surviving row is the one the list now shows.
    const renamedKey = placeAddrKey(row.place, to);
    setPicked((prev) => {
      const carried = prev.get(row.key);
      const next = new Map(prev);
      next.delete(row.key);
      if (carried && !next.has(renamedKey)) next.set(renamedKey, carried);
      return next;
    });
    // The answers, by contrast, were to a question about the old spelling —
    // both services were asked for that address, so the renamed row starts
    // unasked, as the list's own comment beside the lookup says.
    setSearches((prev) => {
      const next = new Map(prev);
      next.delete(row.key);
      return next;
    });
    setOsmSearches((prev) => {
      const next = new Map(prev);
      next.delete(row.key);
      return next;
    });
  };

  /** Rows the register answered with exactly one house — safe to stage in one
   *  click, like the places list's Select confident. A hit the register files
   *  under a settlement other than the claimed one is NOT safe: that is the
   *  split-warning case, and it stays for review (or the move flow). */
  const confidentRows = rows.filter((row) => {
    if (picked.has(row.key)) return false;
    const results = searches.get(row.key)?.results ?? [];
    if (results.length !== 1) return false;
    const claimed = row.queries[0]?.settlement;
    const hit = results[0];
    return !(hit.settlement && claimed && foldSearch(hit.settlement) !== foldSearch(claimed));
  });
  const selectConfident = () =>
    setPicked((prev) => {
      const next = new Map(prev);
      for (const row of confidentRows) {
        const r = (searches.get(row.key)?.results ?? [])[0];
        if (r) next.set(row.key, { coord: r.coord, label: r.label });
      }
      return next;
    });

  /** Clicking the chosen option again drops the choice — a radio group has no
   *  "none" of its own, and a row picked by mistake would otherwise be written. */
  const unpick = (key: string) =>
    setPicked((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });

  /**
   * Every house found for this place, on one map — the point of grouping: the
   * addresses of a village are neighbours, so seeing them together shows at a
   * glance which candidates are plausible and which one is the odd one out.
   * Clicking a pin picks that candidate for its own row.
   */
  const groupPins = (group: PlaceGroup): MiniMapPin[] => {
    const pins: MiniMapPin[] = [];
    for (const row of group.rows) {
      const chosen = picked.get(row.key);
      // Where the file already puts this address — usually the settlement's
      // coordinate, shared by the whole place. Without it the map opens empty
      // until a lookup has run, which made "show on map" look broken.
      if (row.coord && !pins.some((p) => sameCoord(p.coord, row.coord))) {
        // The settlement's own position is not a house and must not look like
        // one: a village whose addresses all inherit it would otherwise put a
        // candidate-coloured pin on the church square, competing with the
        // register's real answers. Neutral colour, and it says what it is.
        const own = !row.placed;
        pins.push({
          coord: row.coord,
          label: t(own ? "tools.geocode.addr.placePin" : "tools.geocode.fromFile"),
          sub: row.address,
          lines: [t("tools.geocode.addr.uses", { count: row.count })],
          kind: "candidate",
          // A settlement's position covers the whole village, so it is drawn as
          // a wide ring around its houses rather than as another house-sized dot.
          ...(own ? { colorVar: "--map-other", area: true } : {}),
        });
      }
      // A pick of the researcher's own — typed, taken off a map, or given to the
      // whole village at once. It is not among the answers below, so without
      // this the map opened without the very position being staged.
      if (chosen && !pins.some((p) => sameCoord(p.coord, chosen.coord))) {
        pins.push({
          coord: chosen.coord,
          label: chosen.label,
          sub: row.address,
          lines: [t("tools.geocode.addr.uses", { count: row.count })],
          kind: "chosen",
        });
      }
      // The answers a lookup returned are deliberately NOT drawn here. This map
      // is the place's — a hundred addresses' worth of candidates on it says
      // nothing about any one of them, and buries the positions that are
      // actually in force. Candidates belong to the one address they answer, on
      // the map inside its coordinate panel, where they are numbered.
    }
    return pins;
  };

  const apply = () => {
    // A row stands for one house, which the file may spell more than one way —
    // every spelling gets the coordinate, so the row is done in one step.
    const assignments = new Map<string, GeoCoord>();
    for (const [key, v] of picked) {
      for (const raw of byKey.get(key)?.rawKeys ?? []) assignments.set(raw, v.coord);
    }
    const changed = onApply(assignments);
    // The written rows are done and leave the worklist; the answers held by
    // the rows still waiting were to questions the write did not change, so
    // they stand — writing one wave must not cost the next its lookups.
    const dropWritten = <V,>(prev: Map<string, V>) => {
      const next = new Map(prev);
      for (const key of picked.keys()) next.delete(key);
      return next;
    };
    setSearches(dropWritten);
    setOsmSearches(dropWritten);
    setPicked(new Map());
    setApplied(changed);
  };

  const actions = (
    <>
      <button className="nav-btn primary tools-run" onClick={apply} disabled={picked.size === 0}>
        {t("tools.geocode.addr.apply", { count: picked.size })}
      </button>
      <button
        className="tools-issue-link"
        onClick={selectConfident}
        disabled={confidentRows.length === 0}
        title={t("tools.geocode.addr.selectConfidentHint")}
      >
        {t("tools.geocode.selectConfident", { count: confidentRows.length })}
      </button>
      <button className="tools-issue-link" onClick={() => setPicked(new Map())} disabled={picked.size === 0}>
        {t("tools.sources.dupSelectNone")}
      </button>
      <AppliedNote count={applied} />
      {moved !== null && <span className="tools-applied-note">{t("tools.geocode.addr.moved", { count: moved })}</span>}
    </>
  );

  return (
    <section className="tools-cleanup-section">
      {actionsHost ? (
        createPortal(actions, actionsHost)
      ) : (
        <div className="tools-dup-kind-head">
          {t("tools.geocode.addr.heading", { count: visibleRows.length, places: groups.length })}
          <div className="tools-dup-bulk">{actions}</div>
        </div>
      )}
      <p className="tools-intro">
        {t("tools.geocode.addr.intro")} {t("tools.geocode.addr.introOnline")}{" "}
        <button className="tools-issue-link" onClick={() => requestSettings("advanced")}>
          {t("tools.geocode.settingsAdvanced")}
        </button>
        .
      </p>
      {/* One country's file has nothing to narrow, so the row appears from two
          up — the same rule the places list follows. */}
      {countryChips.length > 1 && (
        <div className="tools-chips">
          <button
            className={`tools-chip ${activeCountry === null ? "active" : ""}`}
            onClick={() => setCountryFilter(null)}
          >
            {t("tools.geocode.filter.all")}{" "}
            <span className="tools-chip-count">{countryChips.reduce((n, c) => n + c.count, 0)}</span>
          </button>
          {countryChips.map((c) => (
            <button
              key={c.country || "?"}
              className={`tools-chip ${activeCountry === c.country ? "active" : ""}`}
              onClick={() => setCountryFilter(c.country)}
            >
              {c.country || t("tools.geocode.countryUnknown")} <span className="tools-chip-count">{c.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="tools-chips">
        {ADDR_FILTERS.filter((f) => showPlaced || f !== "placed").map((f) => (
          <button
            key={f}
            className={`tools-chip ${statusFilter === f ? "active" : ""}`}
            onClick={() => setStatusFilter(f)}
          >
            {t(`tools.geocode.addr.filter.${f}`)}{" "}
            <span className="tools-chip-count">{f === "all" ? visibleRows.length : statusCounts[f]}</span>
          </button>
        ))}
        {/* A view control, beside the other view controls. */}
        <ExpandAllToggle
          allOpen={allOpen}
          onToggle={() => {
            if (allOpen) {
              setOpen(new Set());
              setMapOpen(null);
            } else setOpen(new Set(groups.map((g) => g.place)));
          }}
        />
        {placedTotal > 0 && (
          <label className="tools-reshape-site" title={t("tools.geocode.addr.showPlacedHint")}>
            <input
              type="checkbox"
              checked={showPlaced}
              onChange={(e) => {
                setShowPlaced(e.target.checked);
                // The chip the toggle takes away must not stay the active
                // filter, or the list would sit empty with no chip saying why.
                if (!e.target.checked && statusFilter === "placed") setStatusFilter("all");
              }}
            />
            {t("tools.geocode.addr.showPlaced")} <span className="tools-chip-count">{placedTotal}</span>
          </label>
        )}
      </div>
      {/* Said rather than shown as an empty list: the section is the only place
          the file's addresses live, so vanishing under a filter would read as
          "this file has none". */}
      {!groups.length && <p className="tools-clean">{t("tools.search.noMatch")}</p>}
      <ul className="tools-geo-addr-list">
        {groups.map((group) => {
          const isOpen = open.has(group.place);
          return (
            <li key={group.place} className="tools-geo-addr-group">
              <GeoRowHeader
                open={isOpen}
                onToggle={() => toggle(group.place)}
                place={group.place || t("tools.geocode.addr.noPlace")}
              >
                <span className="tools-geo-count">
                  {t("tools.geocode.addr.groupMeta", { count: group.rows.length, events: group.events })}
                </span>
                {/* The place is derived, not a value the file writes — worth
                    saying, since it is also why this group cannot be moved. */}
                {!group.movable && (
                  <span className="tools-geo-online-note" title={t("tools.geocode.addr.inPlaceHint")}>
                    {t("tools.geocode.addr.inPlace")}
                  </span>
                )}
              </GeoRowHeader>
              {isOpen && (
                <div className="tools-geo-actions">
                  {/* The place's houses on one map — asked for, like every other
                      map on this page, and drawn above the addresses it is about. */}
                  {groupPins(group).length > 0 && (
                    <MapToggle open={mapOpen === group.place} onToggle={() => toggleMap(group.place)} />
                  )}
                  {/* Counted over what the register can actually be asked about:
                      a place whose houses carry no numbers has nothing to look
                      up, and the button would promise a search that never runs. */}
                  {(() => {
                    // Counted over what is actually left to ask: rows the
                    // register cannot answer, and rows it already has, are not
                    // part of the offer — the button would run a search that
                    // does nothing and still name a number for it.
                    const askable = group.rows.filter(
                      (r) => r.queries.length && (searches.get(r.key) ?? IDLE).state === "idle",
                    );
                    // A whole Croatian village is answered from this browser,
                    // so the online opt-in does not gate it — see isOfflineQuery.
                    const local = askable.every((r) => isOfflineQuery(r.queries));
                    if ((!settings.allowLinkFetch && !local) || askable.length < 2) return null;
                    return (
                      <button className="tools-issue-link" onClick={() => searchGroup(group)}>
                        {t("tools.geocode.addr.searchGroup", { count: askable.length })}
                      </button>
                    );
                  })()}
                  {group.place && group.movable && moveGroup !== group.place && (
                    <button
                      className="tools-issue-link"
                      title={t("tools.geocode.addr.moveHint")}
                      onClick={() => startMove(group)}
                    >
                      {t("tools.geocode.addr.move")}
                    </button>
                  )}
                  {coordGroup !== group.place && (
                    <button
                      className="tools-issue-link"
                      title={t("tools.geocode.addr.bulkHint")}
                      onClick={() => startCoords(group)}
                    >
                      {t("tools.geocode.addr.bulk")}
                    </button>
                  )}
                </div>
              )}
              {isOpen && coordGroup === group.place && (
                <BulkCoordPanel
                  group={group}
                  pick={coordPick}
                  selected={coordSel}
                  prefix={coordPrefix}
                  onPrefix={(value) => selectByPrefix(group, value)}
                  onPick={(coord, label) => setCoordPick({ coord, label: label ?? t("tools.geocode.manual") })}
                  onClear={() => setCoordPick(null)}
                  onSelectAll={(all) => setCoordSel(new Set(all ? group.rows.map((r) => r.key) : []))}
                  onApply={applyCoords}
                  onCancel={closeCoords}
                />
              )}
              {isOpen && group.movable && moveGroup !== group.place &&
                registerSplits(group, searches).map((split) => (
                  <p key={split.settlement} className="tools-geo-addr-split">
                    <span className="tools-reshape-badge official">GURS</span>{" "}
                    {t("tools.geocode.addr.splitFound", {
                      count: split.keys.length,
                      events: split.events,
                      settlement: split.municipality
                        ? `${split.settlement} (${split.municipality})`
                        : split.settlement,
                      place: group.place,
                    })}{" "}
                    <button className="tools-issue-link" onClick={() => startMove(group, split)}>
                      {t("tools.geocode.addr.splitMove", { place: split.place ?? split.settlement })}
                    </button>
                  </p>
                ))}
              {isOpen && moveGroup === group.place && (
                <MovePanel
                  group={group}
                  target={moveTarget}
                  selected={moveSel}
                  places={places}
                  onTarget={setMoveTarget}
                  // A register offer names the destination and places it: the
                  // address it may carry is one house of many being moved, so
                  // only a settlement-level offer hands over its coordinate.
                  onPickProposal={(proposal) => {
                    setMoveTarget(proposal.plac);
                    setMovePick(
                      proposal.addr
                        ? null
                        : {
                            place: proposal.plac,
                            assignment: proposal.govId
                              ? { coord: proposal.coord, govId: proposal.govId }
                              : { coord: proposal.coord },
                          },
                    );
                  }}
                  onSelectAll={(all) => setMoveSel(new Set(all ? group.rows.map((r) => r.key) : []))}
                  onApply={applyMove}
                  onCancel={closeMove}
                />
              )}
              {isOpen && mapOpen === group.place && (() => {
                const pins = groupPins(group);
                if (!pins.length) return null;
                return (
                  <RowMap
                    pins={pins}
                    title={t("tools.geocode.addr.mapHint")}
                    // Re-frame as each lookup lands, so the view always holds
                    // every house found so far for this place.
                    fitKey={`${group.place} ${pins.map((p) => `${p.coord.lat},${p.coord.lon}`).join("|")}`}
                  />
                );
              })()}
              {isOpen && (
                <ul className="tools-tree-children tools-geo-addr-sublist">
                  {group.rows.map((row) => {
                    const search = searches.get(row.key) ?? IDLE;
                    const osm = osmSearches.get(row.key) ?? OSM_IDLE;
                    const chosen = picked.get(row.key);
                    const candidates = rowCandidates(search, osm, row.address, t);
                    return (
                      <li key={row.key} className="tools-geo-addr-row">
                        {/* Address, usage and its own lookup on one line — with a
                            hundred-odd addresses under a place, a second line per
                            row doubles the list for no gain. */}
                        <div className="tools-geo-addr-head">
                          {/* The handle every row on this page opens from, in
                              the same leading position: the address and its
                              coordinate beside it are shortcuts to the very
                              same panel, but only this one says, open or shut,
                              which state the row is in. */}
                          <button
                            className={`tools-pair-toggle ${coordOpen === row.key ? "open" : ""}`}
                            aria-expanded={coordOpen === row.key}
                            aria-label={row.address}
                            title={t("tools.geocode.addr.openHint")}
                            onClick={() => setCoordOpen(coordOpen === row.key ? null : row.key)}
                          >
                            ▶
                          </button>
                          {/* One tick box, whichever panel is asking: the move's
                              destination or the one coordinate for the lot. */}
                          {(moveGroup === group.place || coordGroup === group.place) && (
                            <input
                              type="checkbox"
                              aria-label={row.address}
                              checked={(moveGroup === group.place ? moveSel : coordSel).has(row.key)}
                              onChange={() => (moveGroup === group.place ? toggleMoveRow : toggleCoordRow)(row.key)}
                            />
                          )}
                          {/* The address opens the coordinate panel too — map to
                              pick on, register lookup, manual entry, which is
                              the one thing a row is opened for. It is its own
                              button rather than part of the pin's, because the
                              rename ✎ sits between the two and buttons do not
                              nest; both drive the same open state. */}
                          <button
                            className="tools-geo-addr-name"
                            title={t("tools.geocode.addr.openHint")}
                            onClick={() => setCoordOpen(coordOpen === row.key ? null : row.key)}
                          >
                            {row.address}
                          </button>
                          {renameKey === row.key ? (
                            <button
                              className="tools-place-edit-btn tools-place-edit-cancel"
                              onClick={() => setRenameKey(null)}
                              title={t("tools.places.rename.cancel")}
                            >
                              ✕
                            </button>
                          ) : (
                            <button
                              className="tools-place-edit-btn"
                              onClick={() => {
                                setRenameKey(row.key);
                                setRenameDraft(row.address);
                              }}
                              title={t("tools.geocode.addr.renameOpen")}
                            >
                              ✎
                            </button>
                          )}
                          {/* The position this row holds, in the place rows' own
                              shape: → where it came from · the pinned
                              coordinate, accent once it is this house's own.
                              Clicking it puts the place's map up on that point,
                              exactly as a place row's does — placing the house
                              is the address's job, beside it. */}
                          {(chosen?.coord ?? row.coord) && (
                            <button
                              type="button"
                              className="tools-tree-meta tools-geo-coord-btn"
                              title={t("tools.geocode.addr.coordHint")}
                              onClick={() => setCoordOpen(coordOpen === row.key ? null : row.key)}
                            >
                              {chosen && (
                                <>
                                  →{" "}
                                  <span className="tools-geo-picked-from" title={chosen.label}>
                                    {chosen.label}
                                  </span>{" "}
                                  ·{" "}
                                </>
                              )}
                              <span className={"gm-data gm-coord" + (chosen || row.placed ? " gm-coord--set" : "")}>
                                {formatCoord((chosen?.coord ?? row.coord)!)}
                              </span>
                              {/* The tag belongs to the position, so it is part
                                  of the same control rather than dead text
                                  beside it — a click anywhere on the run opens
                                  the panel. A placed house wears the same chip
                                  a placed place row does. */}
                              {!chosen && row.coord && (
                                <>
                                  {" "}
                                  {row.placed ? (
                                    <span className="tools-reshape-badge new" title={t("tools.geocode.addr.placedHint")}>
                                      {t("tools.geocode.placedBadge")}
                                    </span>
                                  ) : (
                                    <span className="tools-geo-addr-tag" title={t("tools.geocode.addr.inheritedHint")}>
                                      {t("tools.geocode.addr.inherited")}
                                    </span>
                                  )}
                                </>
                              )}
                            </button>
                          )}
                          {/* The panel itself, with no button of its own: the
                              address above opens it, and the coordinate beside
                              it belongs to the map. The house the register
                              cannot find is placed in here; a pick is staged
                              like the radios below, and nothing is written
                              until Write. */}
                          <EventCoordPicker
                            place={row.place}
                            address={row.address}
                            coord={chosen?.coord}
                            title={row.address}
                            // A position of this house's own is exactly what
                            // `filePairCoord` means; anything else the row holds
                            // is the settlement's, which the panel draws as the
                            // area it is rather than as another house.
                            {...(row.placed ? { filePairCoord: row.coord } : { fileCoord: row.coord })}
                            hideTrigger
                            // Everything the row found, so the panel's map draws
                            // the lot under the row's own numbers.
                            candidates={candidates}
                            open={coordOpen === row.key}
                            onOpenChange={(next) => setCoordOpen(next ? row.key : null)}
                            // A register lookup run inside the panel is this
                            // row's lookup: its houses land in the list under
                            // the address, and the row's own register link goes
                            // — the answer is already here, and asking again
                            // returns it.
                            onRegisterSearch={(next) => setSearch(row.key, next)}
                            onPick={(coord, label) =>
                              setPicked((prev) =>
                                new Map(prev).set(row.key, { coord, label: label ?? t("tools.geocode.manual") }),
                              )
                            }
                            onClear={() => unpick(row.key)}
                          />
                          {/* The register comes after the position, being the way
                              to reach one rather than a fact about the row — and
                              it goes once it has answered: the answer is the list
                              of houses below, and asking again returns it. A
                              rename makes a new row, which starts unasked. */}
                          {!row.queries.length ? (
                            // Nothing for the *register* to answer. Said only
                            // where it settles the row: with OpenStreetMap on
                            // offer below there is something to look up after
                            // all, and the button says so better than a note
                            // denying it.
                            !settings.allowLinkFetch && (
                              <span className="tools-geo-online-note" title={t("tools.geocode.addr.noQueryHint")}>
                                {t("tools.geocode.addr.noQuery")}
                              </span>
                            )
                          ) : !settings.allowLinkFetch && !isOfflineQuery(row.queries) ? (
                            <span className="tools-geo-online-note">{t("tools.geocode.downloadNeedsOptIn")}</span>
                          ) : (
                            <>
                              {(search.state !== "done" || !search.results.length) && (
                                <button
                                  className="tools-issue-link"
                                  disabled={search.state === "loading"}
                                  onClick={() => runSearch(row)}
                                >
                                  {search.state === "loading"
                                    ? t("tools.geocode.rn.searching")
                                    : t("tools.geocode.rn.search")}
                                </button>
                              )}
                              {search.state === "error" && (
                                <span className="tools-geo-online-note">{t("tools.geocode.rn.error")}</span>
                              )}
                              {/* "No match" is not final: the group batch can't
                                  walk the per-address ladder's outer rungs, so
                                  the button above stays and asks the full
                                  ladder — suffix retry, any street, the outer
                                  settlements — for this one row. */}
                              {search.state === "done" && !search.results.length && (
                                <span className="tools-geo-online-note">{t("tools.geocode.rn.none")}</span>
                              )}
                            </>
                          )}
                          {/* OpenStreetMap, the register's fallback: it covers
                              the addresses GURS cannot take — a house with no
                              number, a hamlet, anything outside Slovenia — and
                              often names a house the register spells otherwise.
                              One row at a time, never a whole place: the service
                              allows one request per second and no bulk use. */}
                          {settings.allowLinkFetch && (
                            <>
                              {osm.state !== "done" && (
                                <button
                                  className="tools-issue-link"
                                  disabled={osm.state === "loading"}
                                  title={t("tools.geocode.online.tooltip")}
                                  onClick={() => runOnline(row)}
                                >
                                  {osm.state === "loading"
                                    ? t("tools.geocode.online.searching")
                                    : t("tools.geocode.online.search")}
                                </button>
                              )}
                              {osm.state === "error" && (
                                <span className="tools-geo-online-note">{t("tools.geocode.online.error")}</span>
                              )}
                              {osm.state === "done" && !osm.results.length && (
                                <span className="tools-geo-online-note">{t("tools.geocode.online.none")}</span>
                              )}
                            </>
                          )}
                          {/* Who the events belong to — count as the toggle,
                              names on hover, last on the line, exactly like the
                              places rows. How many events there are is not
                              shown: the people are what the row is read for,
                              and the group header above counts the events. */}
                          {row.people.length > 0 && (
                            <button
                              className="tools-chip-count tools-count-toggle"
                              title={peopleTitles.get(row.key)}
                              aria-pressed={peopleOpen.has(row.key)}
                              aria-label={t("tools.geocode.peopleToggle")}
                              onClick={() => togglePeople(row.key)}
                            >
                              {row.people.length}
                            </button>
                          )}
                        </div>
                        {renameKey === row.key && (
                          <div
                            className="tools-place-rename"
                            onKeyDown={(e) => {
                              // Enter on a highlighted suggestion, and Escape with the
                              // dropdown open, belong to the autocomplete
                              // (defaultPrevented); the next press is the editor's.
                              if (e.key === "Enter" && !e.defaultPrevented) applyRename(row);
                              if (e.key === "Escape" && !e.defaultPrevented) setRenameKey(null);
                            }}
                          >
                            {/* Completed from the other houses of this same place: a
                                rename here is usually a straggler being joined to a
                                spelling the place already has, and typing it out again
                                by hand is how the two miss each other by a character. */}
                            <PlaceAutocomplete
                              value={renameDraft}
                              suggestions={(addrsByPlace.get(group.place) ?? []).filter((a) => a !== row.address)}
                              canonical={places.addrCanonical}
                              isDirty={false}
                              className="tools-place-rename-input"
                              wrapClassName="tools-place-rename-auto"
                              placeholder={t("tools.geocode.renameAddrPlaceholder")}
                              autoFocus
                              // A rename may be exactly a casing fix ("Pod Gozdom" →
                              // "pod gozdom") — the canonical map must not undo it.
                              preserveCase
                              onChange={setRenameDraft}
                              onCommit={setRenameDraft}
                              onClear={() => setRenameDraft("")}
                            />
                            <button
                              className="nav-btn primary tools-place-rename-apply"
                              onClick={() => applyRename(row)}
                              disabled={!renameDraft.trim() || renameDraft.trim() === row.address}
                            >
                              {t("tools.places.rename.apply")}
                            </button>
                          </div>
                        )}
                        {/* The lookup's answers directly under the row they
                            answer — the people list, however long, comes after,
                            like the place rows'. */}
                        {candidates.length > 0 && (
                          <ul className="tools-geo-candidates">
                            {candidates.map((r, i) => (
                              <li key={i}>
                                <label title={r.title ?? r.label}>
                                  {/* The number *is* the radio: it ties the line
                                      to its pin on the panel's map, and a second
                                      round control beside it would be one dot too
                                      many. The input stays for the keyboard and
                                      for screen readers, clipped out of sight —
                                      the number renders its state. */}
                                  <input
                                    type="radio"
                                    className="tools-geo-cand-radio"
                                    name={`addr-${row.key}`}
                                    aria-label={`${i + 1}. ${r.label}`}
                                    checked={sameCoord(chosen?.coord, r.coord)}
                                    onChange={() => pick(row.key, r)}
                                    onClick={() => sameCoord(chosen?.coord, r.coord) && unpick(row.key)}
                                  />
                                  <span className="tools-geo-cand-num">{i + 1}</span>
                                  {/* No pin before the answer either: its own
                                      coordinate carries one at the end of the
                                      line, and the row above already reads as
                                      addresses. */}
                                  <span className="tools-geo-cand-name">{r.label}</span>
                                  {/* What this hit is, where the service says —
                                      the one thing telling identical lines apart. */}
                                  {r.detail && <span className="tools-geo-cand-kind">{r.detail}</span>}
                                  {/* Not this address: the place the answer
                                      really names, so a house number matched in
                                      the next village over cannot be taken for
                                      the house being placed. */}
                                  {r.elsewhere && (
                                    <span className="tools-geo-cand-elsewhere" title={t("tools.geocode.addr.elsewhereHint")}>
                                      {t("tools.geocode.addr.elsewhere", { place: r.elsewhere })}
                                    </span>
                                  )}
                                  {/* Every answer's coordinate opens the row's
                                      own coordinate panel, which draws them all
                                      on one map under these same numbers: which
                                      of several is the house is a question only
                                      the map answers. */}
                                  <button
                                    type="button"
                                    className="gm-data gm-coord tools-geo-coord-btn"
                                    title={t("tools.geocode.addr.openHint")}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      setCoordOpen(row.key);
                                    }}
                                  >
                                    {formatCoord(r.coord)}
                                  </button>
                                  <span className={`tools-reshape-badge ${r.badgeClass}`}>{r.source}</span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        )}
                        {peopleOpen.has(row.key) && (
                          <>
                            <ul className="tools-usage tools-geo-people">
                              {row.people.slice(0, 30).map((id) => {
                                const kin = kinship?.label(id);
                                return (
                                  <li key={id}>
                                    <PersonLink dataset={dataset} id={id} fallback={id} onNavigate={onNavigate} />
                                    {kin && (
                                      <span className={`person-kinship ${lineageClass(kinship?.lineage(id))}`}>{kin}</span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                            {row.people.length > 30 && (
                              <p className="tools-geo-more">
                                {t("tools.geocode.morePeople", { count: row.people.length - 30 })}
                              </p>
                            )}
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Give every ticked address of one place the same position.
 *
 * For the houses no register can answer: village numbering that has since been
 * redrawn, a farm that no longer stands, a house named after a family rather
 * than numbered. Their coordinate cannot be the building's, but it can be the
 * hamlet's — near enough to put the family on a map, and far better than
 * nothing, which is what those events have now.
 *
 * The position comes from the Edit view's own coordinate control, so it can be
 * typed, taken off the map, or searched for in OpenStreetMap; the file's own
 * coordinate for the place opens as the offer, since "the centre of the
 * village" is usually exactly that. The picks are staged like every other one
 * on this page — the section's Write button commits the lot as one undo step.
 */
function BulkCoordPanel({
  group,
  pick,
  selected,
  prefix,
  onPrefix,
  onPick,
  onClear,
  onSelectAll,
  onApply,
  onCancel,
}: {
  group: PlaceGroup;
  pick: { coord: GeoCoord; label: string } | null;
  selected: ReadonlySet<string>;
  /** Ticks every address starting with this text; empty means all of them. */
  prefix: string;
  onPrefix: (value: string) => void;
  onPick: (coord: GeoCoord, label?: string) => void;
  onClear: () => void;
  onSelectAll: (all: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const events = group.rows.filter((r) => selected.has(r.key)).reduce((n, r) => n + r.count, 0);
  const fileCoord = group.rows.find((r) => r.coord)?.coord;
  /** Held here because two controls open the one panel — the pin and the
   *  position beside it — exactly as an address row does it. */
  const [open, setOpen] = useState(false);

  return (
    <div
      className="tools-place-rename tools-geo-addr-move"
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.defaultPrevented && pick && selected.size) onApply();
        if (e.key === "Escape" && !e.defaultPrevented) onCancel();
      }}
    >
      <p className="tools-intro">{t("tools.geocode.addr.bulkIntro")}</p>
      <EventCoordPicker
        place={group.place}
        // The prefix that ticked these rows is also what they are: "Stražišče"
        // under Kranj, "Vas" under a hamlet. Handing it over as the address
        // asks the registers about that place — "Stražišče, Kranj" rather than
        // Kranj alone — which is the position being looked for. Empty prefix,
        // empty address: then the whole place is ticked and its own centre is
        // exactly the answer.
        address={prefix.trim()}
        coord={pick?.coord}
        title={group.place}
        fileCoord={fileCoord}
        open={open}
        onOpenChange={setOpen}
        onPick={onPick}
        onClear={onClear}
      />
      {/* The position picked, beside the pin that picked it — unmarked, since
          that pin is the mark and stands right against this text. It opens the
          panel too: a position on screen is the thing being changed, and every
          address row below is opened by clicking exactly this. */}
      <button
        type="button"
        className={"tools-place-rename-hint tools-geo-coord-btn" + (pick ? " gm-data" : "")}
        title={t("tools.geocode.addr.openHint")}
        onClick={() => setOpen(true)}
      >
        {pick ? formatCoord(pick.coord) : t("tools.geocode.addr.bulkNoCoord")}
      </button>
      {/* Ticking a run of houses by what they start with — "Stražišče 11" for
          both farms of that number, "Vas" for a hamlet whose numbering the
          register lost. The ticks stay visible below, so what a prefix caught
          is read off the list rather than trusted. */}
      <span className="tools-geo-addr-chip" title={t("tools.geocode.addr.bulkPrefixHint")}>
        {t("tools.geocode.addr.bulkPrefixLabel")}:
        <input
          type="text"
          className="tools-geo-addr-chip-input"
          value={prefix}
          size={Math.max(10, prefix.length + 1)}
          placeholder={t("tools.geocode.addr.bulkPrefix")}
          onChange={(e) => onPrefix(e.target.value)}
        />
        {prefix && (
          <button
            className="tools-geo-addr-chip-clear"
            onClick={() => onPrefix("")}
            aria-label={t("tools.places.rename.cancel")}
          >
            ×
          </button>
        )}
      </span>
      <span className="tools-place-rename-hint">
        {t("tools.geocode.addr.moveCount", { count: selected.size, events })}
      </span>
      <button className="tools-issue-link" onClick={() => onSelectAll(selected.size < group.rows.length)}>
        {selected.size < group.rows.length ? t("tools.geocode.addr.moveAll") : t("tools.geocode.addr.moveNone")}
      </button>
      <button
        className="nav-btn primary tools-place-rename-apply"
        onClick={onApply}
        disabled={!pick || selected.size === 0}
      >
        {t("tools.geocode.addr.bulkApply", { count: selected.size })}
      </button>
      <button className="nav-btn" onClick={onCancel}>
        {t("tools.places.rename.cancel")}
      </button>
    </div>
  );
}

/**
 * Move the ticked addresses of one place to another place. The destination is a
 * whole PLAC value, autocompleted from the ones the file already uses so a split
 * lands on an existing spelling rather than a near-duplicate — and, for the case
 * this panel exists for, looked up in the registers: a hamlet the file has only
 * ever filed under its neighbour is by definition a place the file cannot spell
 * yet, and the register knows its chain and where it is.
 */
function MovePanel({
  group,
  target,
  selected,
  places,
  onTarget,
  onPickProposal,
  onSelectAll,
  onApply,
  onCancel,
}: {
  group: PlaceGroup;
  target: string;
  selected: ReadonlySet<string>;
  places: PlaceSuggestions;
  onTarget: (value: string) => void;
  onPickProposal: (proposal: PlaceProposal) => void;
  onSelectAll: (all: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const lookup = usePlaceLookup();
  const trimmed = target.trim();
  const events = group.rows.filter((r) => selected.has(r.key)).reduce((n, r) => n + r.count, 0);
  const disabled = !trimmed || trimmed === group.place || selected.size === 0;

  return (
    <div
      className="tools-place-rename tools-geo-addr-move"
      onKeyDown={(e) => {
        // Enter on a highlighted suggestion, and Escape with the dropdown open,
        // belong to the autocomplete (defaultPrevented); the next press is the
        // panel's, exactly as in the rename row above.
        if (e.key === "Enter" && !e.defaultPrevented && !disabled) onApply();
        if (e.key === "Escape" && !e.defaultPrevented) onCancel();
      }}
    >
      <p className="tools-intro">{t("tools.geocode.addr.moveIntro")}</p>
      <PlaceAutocomplete
        value={target}
        suggestions={places.placeSuggestions}
        canonical={places.placeCanonical}
        isDirty={false}
        className="tools-place-rename-input"
        wrapClassName="tools-place-rename-auto"
        placeholder={t("tools.geocode.addr.movePlaceholder")}
        autoFocus
        onChange={onTarget}
        onCommit={onTarget}
        onClear={() => onTarget("")}
        onPickProposal={onPickProposal}
        onLookup={lookup ? (query) => lookup.search(query) : undefined}
        lookupNote={lookup && !lookup.online ? t("event.place.lookup.offlineOnly") : undefined}
      />
      <span className="tools-place-rename-hint">
        {t("tools.geocode.addr.moveCount", { count: selected.size, events })}
      </span>
      <button className="tools-issue-link" onClick={() => onSelectAll(selected.size < group.rows.length)}>
        {selected.size < group.rows.length ? t("tools.geocode.addr.moveAll") : t("tools.geocode.addr.moveNone")}
      </button>
      <button className="nav-btn primary tools-place-rename-apply" onClick={onApply} disabled={disabled}>
        {t("tools.geocode.addr.moveApply", { count: selected.size })}
      </button>
      <button className="nav-btn" onClick={onCancel}>
        {t("tools.places.rename.cancel")}
      </button>
    </div>
  );
}

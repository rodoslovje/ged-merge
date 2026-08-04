import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { sameCoord } from "../../geo/points";
import { resultsForQuery, searchAddressBatch, searchAddresses, type RnResult } from "../../geo/rn";
import type { PlaceProposal } from "../../geo/placeProposal";
import { replaceLocality, suggestMovedPlace, type AddressRow } from "../../tools/addresses";
import type { GeoAssignment } from "../../tools/geocode";
import { foldSearch } from "../globalSearch";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import { EventCoordPicker } from "../edit/EventCoordPicker";
import { PlaceAutocomplete } from "../edit/PlaceAutocomplete";
import { usePlaceLookup } from "../edit/PlaceLookupContext";
import { buildPlaceSuggestions, type PlaceSuggestions } from "../edit/placeSuggestions";
import { useNameOf, useSettings } from "../SettingsContext";
import { lineageClass, type KinshipResolver } from "../../match/kinship";
import { PersonLink } from "../PersonLink";
import { ExpandAllToggle, GeoRowHeader, MapToggle } from "./shared";
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

const MiniPlaceMap = lazy(() => import("../map/MiniPlaceMap"));

const IDLE: SearchState = { state: "idle", results: [] };

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
): AddrStatus {
  if (picked.has(row.key)) return "picked";
  // Already carrying a position of its own — the hamlet's, say, given to the
  // whole run of houses at once. Still listed, since a rough position may want
  // sharpening, but it is not work waiting to be done and does not read as any
  // of the lookup states below.
  if (row.placed) return "placed";
  if (!row.queries.length) return "manual";
  const s = searches.get(row.key);
  if (s?.state === "done") return s.results.length ? "found" : "none";
  return "unsearched";
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
  const { t } = useTranslation();
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
  /** Groups the filter matched by *address*, which are worth opening: the row
   *  looked for is inside, and there may be one of it under a hundred. */
  const hits = useMemo(() => {
    const found = new Set<string>();
    if (query) {
      for (const row of rows) if (foldSearch(row.address).includes(query)) found.add(row.place);
    }
    return found;
  }, [rows, query]);
  const [searches, setSearches] = useState<Map<string, SearchState>>(new Map());
  const [picked, setPicked] = useState<Map<string, { coord: GeoCoord; label: string }>>(new Map());
  // Which lookup state is on screen; "all" leaves the list whole. Like the
  // places chips, a chip's count is exactly what clicking it shows.
  const [statusFilter, setStatusFilter] = useState<"all" | AddrStatus>("all");
  // Rows whose people list is open — asked for by clicking the person count.
  const [peopleOpen, setPeopleOpen] = useState<Set<string>>(new Set());
  // The one row whose rename editor is open, and its draft.
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

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

  const groups = useMemo(() => {
    const kept = statusFilter === "all" ? rows : rows.filter((r) => addrStatus(r, searches, picked) === statusFilter);
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
  }, [rows, searches, picked, statusFilter]);

  // Existing place values for the move target's autocomplete, so a split lands
  // on the file's own spelling of the destination when it already has one. The
  // Edit fields' own list, so the destination is offered the same way — and
  // canonically cased — wherever a place is typed.
  const places = useMemo(() => buildPlaceSuggestions(dataset), [dataset]);

  const [open, setOpen] = useState<Set<string>>(new Set());
  /** Groups whose map is drawn — never on open, always on request. */
  const [mapOpen, setMapOpen] = useState<Set<string>>(new Set());
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

  // Faceted like the places chips: counted over the search-filtered rows, so
  // each chip says how many addresses clicking it leaves on screen.
  const statusCounts = { unsearched: 0, found: 0, none: 0, manual: 0, placed: 0, picked: 0 };
  for (const row of rows) statusCounts[addrStatus(row, searches, picked)]++;

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
          for (const row of pending) next.set(row.key, { state: "done", results: resultsForQuery(row.queries, pool) });
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

  const toggleMap = (place: string) =>
    setMapOpen((prev) => {
      const next = new Set(prev);
      if (next.has(place)) next.delete(place);
      else next.add(place);
      return next;
    });

  const toggle = (place: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(place)) next.delete(place);
      else next.add(place);
      return next;
    });

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
    // The moved rows are keyed by their old place, so every pick and lookup
    // against them is stale — and the destination is worth looking up afresh.
    setPicked(new Map());
    setSearches(new Map());
    setMoved(changed);
  };

  const pick = (key: string, result: RnResult) =>
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
    // The row's key changes with its address: drop state tied to the old key.
    setPicked((prev) => {
      const next = new Map(prev);
      next.delete(row.key);
      return next;
    });
    setSearches((prev) => {
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
        pins.push({
          coord: row.coord,
          label: t("tools.geocode.fromFile"),
          sub: row.address,
          lines: [t("tools.geocode.addr.uses", { count: row.count })],
          kind: "candidate",
        });
      }
      for (const r of (searches.get(row.key) ?? IDLE).results) {
        pins.push({
          coord: r.coord,
          label: r.label,
          // Which of the place's addresses this pin answers, how much of the
          // file rides on it, and that a click takes it. Its position closes
          // the tooltip on its own (see MiniPlaceMap).
          sub: row.address,
          lines: [t("tools.geocode.addr.uses", { count: row.count }), t("event.coord.pinPick")],
          kind: sameCoord(chosen?.coord, r.coord) ? "chosen" : "candidate",
          onPick: () => pick(row.key, r),
        });
      }
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
    setPicked(new Map());
    setSearches(new Map());
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
      <ExpandAllToggle
        allOpen={allOpen}
        onToggle={() => {
          if (allOpen) {
            setOpen(new Set());
            setMapOpen(new Set());
          } else setOpen(new Set(groups.map((g) => g.place)));
        }}
      />
    </>
  );

  return (
    <section className="tools-cleanup-section">
      {actionsHost ? (
        createPortal(actions, actionsHost)
      ) : (
        <div className="tools-dup-kind-head">
          {t("tools.geocode.addr.heading", { count: rows.length, places: groups.length })}
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
      {applied !== null && <p className="tools-clean tools-clean--ok">{t("tools.geocode.addr.applied", { count: applied })}</p>}
      {moved !== null && <p className="tools-clean tools-clean--ok">{t("tools.geocode.addr.moved", { count: moved })}</p>}
      <div className="tools-chips">
        {ADDR_FILTERS.map((f) => (
          <button
            key={f}
            className={`tools-chip ${statusFilter === f ? "active" : ""}`}
            onClick={() => setStatusFilter(f)}
          >
            {t(`tools.geocode.addr.filter.${f}`)}{" "}
            <span className="tools-chip-count">{f === "all" ? rows.length : statusCounts[f]}</span>
          </button>
        ))}
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
                    <MapToggle open={mapOpen.has(group.place)} onToggle={() => toggleMap(group.place)} />
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
                    ).length;
                    if (!settings.allowLinkFetch || askable < 2) return null;
                    return (
                      <button className="tools-issue-link" onClick={() => searchGroup(group)}>
                        {t("tools.geocode.addr.searchGroup", { count: askable })}
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
              {isOpen && mapOpen.has(group.place) && (() => {
                const pins = groupPins(group);
                if (!pins.length) return null;
                return (
                  <Suspense fallback={<div className="tools-geo-minimap" />}>
                    <MiniPlaceMap
                      pins={pins}
                      title={t("tools.geocode.addr.mapHint")}
                      // Re-frame as each lookup lands, so the view always holds
                      // every house found so far for this place.
                      fitKey={`${group.place} ${pins.map((p) => `${p.coord.lat},${p.coord.lon}`).join("|")}`}
                    />
                  </Suspense>
                );
              })()}
              {isOpen && (
                <ul className="tools-tree-children tools-geo-addr-sublist">
                  {group.rows.map((row) => {
                    const search = searches.get(row.key) ?? IDLE;
                    const chosen = picked.get(row.key);
                    return (
                      <li key={row.key} className="tools-geo-addr-row">
                        {/* Address, usage and its own lookup on one line — with a
                            hundred-odd addresses under a place, a second line per
                            row doubles the list for no gain. */}
                        <div className="tools-geo-addr-head">
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
                          {/* Green once this house has a position — the one it
                              is staged at, or the one its events already carry
                              — muted while it has none, exactly as the Edit
                              view's pin reads. */}
                          <span
                            className={`tools-geo-cand-name gm-addr${chosen || row.placed ? " gm-addr--set" : ""}`}
                          >
                            {row.address}
                          </span>
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
                          <span className="tools-geo-count">{t("tools.geocode.addr.uses", { count: row.count })}</span>
                          {/* Who the events belong to — count as the toggle,
                              names on hover, exactly like the places rows. */}
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
                          {/* The Edit view's own coordinate control, so a house
                              the register cannot find is still reachable here:
                              type a coordinate, pick one off the map, or search
                              OpenStreetMap. It stages the pick like the radios
                              above — nothing is written until Write. */}
                          <EventCoordPicker
                            place={row.place}
                            address={row.address}
                            coord={chosen?.coord}
                            title={row.address}
                            fileCoord={row.coord}
                            onPick={(coord, label) =>
                              setPicked((prev) =>
                                new Map(prev).set(row.key, { coord, label: label ?? t("tools.geocode.manual") }),
                              )
                            }
                            onClear={() => unpick(row.key)}
                          />
                          {/* What the pin now holds, beside it: the address of the
                              position taken — the register's own line, "from this
                              file", "manual" — and the position itself, so a row
                              staged with the rest of its village can be read off
                              the list rather than one tooltip at a time. */}
                          {!chosen && row.placed && row.coord && (
                            <span className="tools-geo-online-note" title={t("tools.geocode.addr.placedHint")}>
                              {t("tools.geocode.addr.placed")}{" "}
                              <span className="gm-data">
                                {row.coord.lat.toFixed(5)}, {row.coord.lon.toFixed(5)}
                              </span>
                            </span>
                          )}
                          {chosen && (
                            <span
                              // No pin of its own: it sits against the picker's
                              // pin, which is the mark this text belongs to.
                              className="tools-geo-picked"
                            >
                              {chosen.label}{" "}
                              <span className="gm-data">
                                {chosen.coord.lat.toFixed(5)}, {chosen.coord.lon.toFixed(5)}
                              </span>
                            </span>
                          )}
                          {/* The register comes after the position, being the way
                              to reach one rather than a fact about the row — and
                              it goes once it has answered: the answer is the list
                              of houses below, and asking again returns it. A
                              rename makes a new row, which starts unasked. */}
                          {!row.queries.length ? (
                            <span className="tools-geo-online-note" title={t("tools.geocode.addr.noQueryHint")}>
                              {t("tools.geocode.addr.noQuery")}
                            </span>
                          ) : !settings.allowLinkFetch ? (
                            <span className="tools-geo-online-note">{t("tools.geocode.downloadNeedsOptIn")}</span>
                          ) : (
                            <>
                              {search.state !== "done" && (
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
                              {search.state === "done" && !search.results.length && (
                                <span className="tools-geo-online-note">{t("tools.geocode.rn.none")}</span>
                              )}
                            </>
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
                        {search.results.length > 0 && (
                          <ul className="tools-geo-candidates">
                            {search.results.map((r, i) => (
                              <li key={i}>
                                <label title={r.label}>
                                  <input
                                    type="radio"
                                    name={`addr-${row.key}`}
                                    checked={sameCoord(chosen?.coord, r.coord)}
                                    onChange={() => pick(row.key, r)}
                                    onClick={() => sameCoord(chosen?.coord, r.coord) && unpick(row.key)}
                                  />
                                  <span className="tools-geo-cand-name gm-addr">{r.label}</span>
                                  {/* The coordinate doubles as "show on the
                                      place's map", like the places rows —
                                      the house appears among its neighbours. */}
                                  <button
                                    type="button"
                                    className="gm-data gm-coord tools-geo-coord-btn"
                                    title={t("tools.geocode.showMap")}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      setMapOpen((prev) => new Set(prev).add(group.place));
                                    }}
                                  >
                                    {r.coord.lat.toFixed(5)}, {r.coord.lon.toFixed(5)}
                                  </button>
                                  <span className="tools-reshape-badge official">GURS</span>
                                </label>
                              </li>
                            ))}
                          </ul>
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
        address=""
        coord={pick?.coord}
        title={group.place}
        fileCoord={fileCoord}
        onPick={onPick}
        onClear={onClear}
      />
      <span className={"tools-place-rename-hint" + (pick ? " gm-coord gm-coord--set" : "")}>
        {pick ? `${pick.coord.lat.toFixed(5)}, ${pick.coord.lon.toFixed(5)}` : t("tools.geocode.addr.bulkNoCoord")}
      </span>
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

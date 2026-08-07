import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import {
  chosenCoordFor,
  collectFileCoords,
  countryOf,
  placeAddrKey,
  scanGeocode,
  type ChosenCoord,
  type GeoAssignment,
  type GeocodeRow,
  type OfficialRename,
} from "../../tools/geocode";
import { loadDecisions, putDecisions, type GeocodeDecision } from "../../persist/geoDb";
import { ExpandAllToggle, ToolsLoading, TreeSearch, useDebounced } from "./shared";
import { useVirtualList } from "../useVirtualList";
import { createKinshipResolver } from "../../match/kinship";
import { buildPlaceSuggestions, placeCombosOf } from "../edit/placeSuggestions";
import { foldSearch } from "../globalSearch";
import { PlaceLookupProvider, usePlaceLookupValue } from "../edit/PlaceLookupContext";
import { GazetteerSetup, useGazetteer } from "./GazetteerManager";
import { AddressCoordsSection } from "./AddressCoordsSection";
import { addressesByPlace, replaceLocality, scanAddresses } from "../../tools/addresses";
import { CoordConflicts } from "./CoordConflicts";
import { GeocodePlaceRow, type RowLookups } from "./GeocodePlaceRow";
import { RegisterCheckSection } from "./RegisterCheckSection";
import { checkPlacesAgainstRegister } from "../../tools/registerCheck";
import { BackButton } from "../BackButton";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { useNameOf, useSettings } from "../SettingsContext";
import { ToolSummary } from "./ToolSummary";

// The "Geocode places" tool (MAPVIEW.md phase 2). Top: the place directories the
// lookups draw on — managed in Settings → Map, offered here while there are none
// ({@link GazetteerSetup}). Below: the review list — every distinct PLAC value
// still missing coordinates, with proposed matches (one GeocodePlaceRow each).
// Nothing is written without review: checked rows are applied in one undoable
// batch; "no match" marks go to the decision cache only, never into the file.

/** Stable empty-rows identity for the renders before the scan arrives — a
 *  fresh [] every render would drop the virtual list's measurements. */
const NO_ROWS: GeocodeRow[] = [];

/** The review chips split the list by the kind of attention a row needs:
 *  "confident" a letter-perfect, unambiguous match (or the file's own
 *  coordinate); "partial" any best proposal under 100% — grouped by the score
 *  the row shows, so a parent-qualified 96% lands here even though its green
 *  badge means Select confident still takes it; "review" a perfect-name tie —
 *  several places match 100% and only the researcher can pick; "noProposal"
 *  research or a rename; "decided" already handled; "placed" finished work,
 *  on the list only while "Show already placed" is ticked. */
type StatusFilter = "all" | "confident" | "review" | "partial" | "noProposal" | "decided" | "placed";
const STATUS_FILTERS: StatusFilter[] = ["all", "confident", "partial", "review", "noProposal", "decided", "placed"];

/** A row has something to judge when any coordinate is on offer — the file's
 *  own, or a gazetteer candidate. */
function hasProposal(row: GeocodeRow): boolean {
  return !!row.fileCoord || row.candidates.length > 0;
}

interface Props {
  dataset: Dataset;
  active: boolean;
  /** Bumped on every committed edit batch, including undo/redo — the scans
   *  here walk the in-place-mutated dataset, so this is their only signal
   *  that it changed under them. */
  editVersion: number;
  /** Write the accepted coordinates (with any GOV ids) through the edit/undo
   *  pipeline; returns the number of records changed. */
  onApplyGeocode: (assignments: Map<string, GeoAssignment>) => number;
  /** Rename all occurrences of exactly this raw place value (edit/undo
   *  pipeline); with `addr`, split into PLAC `to` + an ADDR on the parent
   *  event. Returns the number of records changed. */
  onRenamePlaceValue: (from: string, to: string, addr?: string) => number;
  /** Batched "take the official name" renames — each row renamed to the
   *  register's spelling and placed at its coordinate, all one undo step. */
  onApplyOfficialNames: (renames: OfficialRename[]) => number;
  /** Rename one house's address on every event that carries it. */
  onRenameAddress: (rawKeys: string[], fromAddress: string, toAddress: string) => number;
  /** Move the events at these place+address pairs to `toPlace`; `coord` is the
   *  destination's position when it came from a register pick. */
  onMovePlaceForAddresses: (keys: Set<string>, toPlace: string, coord?: GeoAssignment) => number;
  /** Write accepted house coordinates onto the events at each place+address pair
   *  (standard `PLAC`/`MAP`); returns the number of records changed. */
  onApplyAddressCoords: (assignments: Map<string, GeoCoord>) => number;
  /** Return to the Places tree (the panel hosting this view). */
  onBack: () => void;
  /** Jump to a person in Edit mode (the expanded row's people list). */
  onNavigate: (id: string) => void;
  /** The app-wide start person, for kinship labels in the people list. */
  startId?: string;
}

export function GeocodePanel({ dataset, active, editVersion, onApplyGeocode, onApplyAddressCoords, onRenamePlaceValue, onApplyOfficialNames, onRenameAddress, onMovePlaceForAddresses, onBack, onNavigate, startId }: Props) {
  const { t } = useTranslation();
  const { settings: appSettings } = useSettings();
  const nameOf = useNameOf();

  // Kinship labels for the expanded row's people list — same resolver and
  // display gate (the Kinship display setting) as the Map's event panel.
  const kinship = useMemo(
    () => (startId && appSettings.showKinship ? createKinshipResolver(dataset, startId, t) : undefined),
    [dataset, startId, appSettings.showKinship, t],
  );

  // Esc returns to the Places tree, like leaving Organize sources. Only while
  // this panel is the one on screen: it stays mounted (staged picks must
  // survive a switch to Edit and back), so without the gate an Esc pressed in
  // another view would silently "go back" here and drop all staged work.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isEditableTarget(e.target) || isModalOpen()) return;
      e.preventDefault();
      onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onBack]);

  // The place directories every lookup here draws on. Settings → Map manages
  // them; this panel needs the built index for the review list below, and offers
  // the import itself while there is nothing to work with.
  const gaz = useGazetteer({ withIndex: true });
  const { countries, index } = gaz;
  const [decisions, setDecisions] = useState<Map<string, GeocodeDecision> | null>(null);

  useEffect(() => {
    void loadDecisions().then(setDecisions);
  }, []);

  // ── Scan + review state ───────────────────────────────────────────────────
  const [scanGen, setScanGen] = useState(0);
  // Every edit batch — the panel's own applies, but equally an undo/redo or
  // an edit made in another view — mutates the dataset in place, so nothing
  // in the memo deps moves on its own. Rescan whenever the edit version has
  // advanced while this panel is on screen; a hidden panel catches up the
  // moment it is shown again.
  const lastEditVersion = useRef(editVersion);
  useEffect(() => {
    if (!active) return;
    if (lastEditVersion.current !== editVersion) {
      lastEditVersion.current = editVersion;
      setScanGen((g) => g + 1);
    }
  }, [active, editVersion]);
  const scan = useMemo(
    () => (decisions ? scanGeocode(dataset, index, decisions) : null),
    // scanGen re-runs the scan after an apply mutates the dataset in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, index, decisions, scanGen],
  );

  // Existing place values for the rename input's autocomplete — the same
  // suggestion list (and canonical casing) the Edit-mode event fields use.
  const placeSug = useMemo(
    () => buildPlaceSuggestions(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, scanGen],
  );

  // Place+address combos for the rename input — one box searches both, and
  // picking a combo queues the address part as the split's ADDR (shown as a
  // removable chip next to the input).
  const placeCombos = useMemo(() => placeCombosOf(placeSug.placeToAddrs, placeSug.placeCanonical), [placeSug]);

  // The register lookup behind those inputs — the same one the Edit view builds,
  // so a place the file has never written can be completed (chain, address,
  // coordinate) here too instead of being typed out by hand.
  const placeLookup = usePlaceLookupValue(dataset, placeSug.placeSuggestions);

  // The address rows the section below reviews — scanned here because the
  // Places/Addresses tab bar needs the count before the section renders.
  const addrRows = useMemo(
    () => scanAddresses(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, scanGen],
  );
  // Every address the file writes at each place — what an address rename is
  // offered as completions. Scanned apart from the rows above because it must
  // include the houses those rows leave out (already placed ones): renaming a
  // second spelling onto them is exactly how the two become one house.
  const addrsByPlace = useMemo(
    () => addressesByPlace(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, scanGen],
  );
  // Which of the page's work lists is on screen. They stay mounted (their
  // lookup results and staged picks must survive switching) and toggle with
  // display, like the app's Edit/Merge views.
  const [tab, setTab] = useState<"places" | "addresses" | "register">("places");
  // The compliance report is offered only where there is an authority to hold
  // the file to: an official national register (GURS, DGU). A crowd-sourced
  // directory can propose a coordinate but cannot say a spelling is wrong.
  const hasRegister = useMemo(() => !!index?.entries.some((e) => e.register), [index]);
  // Run once the tab has been opened, and from then on with every rescan: the
  // check looks up every place in the file, placed ones included, which is a
  // pass no one asked for while another tab is on screen.
  const [registerSeen, setRegisterSeen] = useState(false);
  const registerReport = useMemo(
    () => (registerSeen && decisions ? checkPlacesAgainstRegister(dataset, index, decisions) : null),
    // scanGen re-runs the check after a rename mutates the dataset in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, index, decisions, registerSeen, scanGen],
  );
  // The tab-row slot the address and register sections portal their action
  // buttons into — their state (staged picks, filters) lives inside the
  // section, the row lives here. Only the section on screen fills it.
  const [tabActionsEl, setTabActionsEl] = useState<HTMLElement | null>(null);

  // Every coordinate the file already carries — the mini map's context dots.
  const fileCoords = useMemo(
    () => collectFileCoords(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, scanGen],
  );

  // Hover lists of the people each unresolved place occurs at — precomputed
  // per scan, not per render (300 rows × nameOf per keystroke adds up).
  const missingInTitles = useMemo(() => {
    const titles = new Map<string, string>();
    if (!scan) return titles;
    for (const row of [...scan.rows, ...scan.placed]) {
      if (!row.missingIn.length) continue;
      const shown = row.missingIn.slice(0, 15).map((id) => {
        const p = dataset.individuals.get(id);
        return p ? nameOf(p) : id;
      });
      const more = row.missingIn.length - shown.length;
      titles.set(row.key, shown.join("\n") + (more > 0 ? `\n… +${more}` : ""));
    }
    return titles;
  }, [scan, nameOf, dataset]);

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Map<string, ChosenCoord>>(new Map());
  // Each row's on-demand OSM/GOV/register results, keyed by row key. Owned
  // here — not in the row — because the list is virtualized: a row scrolled
  // out of the window unmounts, and its fetched results (from rate-limited
  // services) must be there when it scrolls back.
  const [rowLookups, setRowLookups] = useState<Map<string, RowLookups>>(new Map());
  const patchRowLookups = useCallback((key: string, patch: Partial<RowLookups>) => {
    setRowLookups((prev) => new Map(prev).set(key, { ...prev.get(key), ...patch }));
  }, []);
  /** Rows whose coordinate the researcher has cleared: the pre-selected default
   *  must not come back on its own (see chosenFor). */
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [noMatch, setNoMatch] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The one row whose mini map is mounted — a Leaflet instance per expanded
  // row is too heavy under "Expand all", so the map follows the row the user
  // last opened (other expanded rows offer a "show on map" link to claim it).
  const [mapKey, setMapKey] = useState<string | null>(null);
  const [lastApplied, setLastApplied] = useState<number | null>(null);
  // One filter for the whole page: the place rows, the addresses grouped under
  // their settlements, and the coordinate conflicts are three views of the same
  // place vocabulary, so narrowing to "Kranj" should narrow all of them. Folded,
  // so a Slovenian place is found without reaching for its diacritics.
  const [search, setSearch] = useState("");
  const query = foldSearch(useDebounced(search.trim()));
  // Which kind of work is on screen, and which country — two chip rows above
  // the list. Both narrow only the place list; the search box stays the
  // page-wide filter. `null` country = all of them.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [countryFilter, setCountryFilter] = useState<string | null>(null);
  // Whether already-placed values are on the list at all. Off by default: the
  // list is a worklist, and a placed value is finished work — it comes back on
  // request, for checking a position or re-geocoding it (same rule as the
  // address rows' toggle).
  const [showPlaced, setShowPlaced] = useState(false);

  // The filtered view: chip lists with faceted counts — a chip's count
  // respects every filter except its own row's, so its number is exactly how
  // many rows clicking it puts on screen, and the chips sort by it — plus the
  // rows the active filters leave. Memoized because the virtual list below
  // keys its row measurements on the rows array's identity.
  const view = useMemo(() => {
    if (!scan) return null;
    const statusOf = (row: GeocodeRow): Exclude<StatusFilter, "all"> =>
      checked.has(row.key) || noMatch.has(row.key)
        ? "decided"
        : row.placed
          ? "placed"
          : !row.fileCoord && row.candidates[0] && Math.round(row.candidates[0].score * 100) < 100
            ? "partial"
            : row.confident
              ? "confident"
              : hasProposal(row)
                ? "review"
                : "noProposal";
    const inStatus = (row: GeocodeRow) => statusFilter === "all" || statusOf(row) === statusFilter;

    // The rows the list works over. With the toggle off, a placed row with
    // work in progress (checked for a re-geocode) stays — staged work is
    // never hidden.
    const pool = showPlaced ? [...scan.rows, ...scan.placed] : [...scan.rows, ...scan.placed.filter((r) => checked.has(r.key))];
    const searched = query ? pool.filter((r) => foldSearch(r.key).includes(query)) : pool;

    // One chip per country (a place value's last comma part) in the pending
    // list; a country the other filters empty out stays visible at 0.
    const countryChips: { country: string; count: number }[] = [];
    let countryAllCount = 0;
    const byCountry = new Map<string, (typeof countryChips)[number]>();
    for (const row of pool) {
      const country = countryOf(row.key);
      if (!byCountry.has(country)) {
        const chip = { country, count: 0 };
        byCountry.set(country, chip);
        countryChips.push(chip);
      }
    }
    for (const row of searched) {
      if (!inStatus(row)) continue;
      byCountry.get(countryOf(row.key))!.count++;
      countryAllCount++;
    }
    countryChips.sort((a, b) => b.count - a.count || a.country.localeCompare(b.country));

    // A country whose last row was just resolved loses its chip — the stale
    // pick falls back to "all" instead of filtering the list to nothing.
    const activeCountry =
      countryFilter !== null && countryChips.some((c) => c.country === countryFilter) ? countryFilter : null;
    const inCountry = (row: GeocodeRow) => activeCountry === null || countryOf(row.key) === activeCountry;

    const statusCounts = { confident: 0, review: 0, partial: 0, noProposal: 0, decided: 0, placed: 0 };
    let statusAllCount = 0;
    for (const row of searched) {
      if (!inCountry(row)) continue;
      statusCounts[statusOf(row)]++;
      statusAllCount++;
    }

    const rows = searched.filter((r) => inStatus(r) && inCountry(r));
    // What the "Show already placed" toggle offers: the placed rows the search
    // leaves, minus those already on the list because work is staged on them.
    const placedTotal = (query ? scan.placed.filter((r) => foldSearch(r.key).includes(query)) : scan.placed).filter(
      (r) => !checked.has(r.key),
    ).length;
    return { countryChips, countryAllCount, activeCountry, statusCounts, statusAllCount, rows, placedTotal };
  }, [scan, query, statusFilter, countryFilter, checked, noMatch, showPlaced]);
  const rows = view?.rows ?? NO_ROWS;

  // Every filtered row is reachable — long lists render windowed (the same
  // virtualization as the duplicates and health-check lists), so scrolling
  // covers all of them with only the rows near the viewport mounted.
  const virtual = useVirtualList({ count: rows.length, estimate: 26, itemsKey: rows });

  // A fresh scan seeds the no-match marks from the remembered decisions — but
  // in-progress picks on rows that survived the rescan (e.g. after renaming
  // one other row) are preserved, not silently discarded. Nothing arrives
  // pre-ticked: accepting a coordinate is this run's act, and the accepted
  // ones live in the file once written, not in the browser.
  useEffect(() => {
    if (!scan) return;
    const keys = new Set([...scan.rows, ...scan.placed].map((r) => r.key));
    setChecked((prev) => new Set([...prev].filter((k) => keys.has(k))));
    setNoMatch((prev) => {
      const next = new Set([...prev].filter((k) => keys.has(k)));
      for (const r of scan.rows) if (r.cached?.status === "nomatch") next.add(r.key);
      return next;
    });
    setChosen((prev) => new Map([...prev].filter(([k]) => keys.has(k))));
    setCleared((prev) => new Set([...prev].filter((k) => keys.has(k))));
    setExpanded((prev) => new Set([...prev].filter((k) => keys.has(k))));
    setMapKey((prev) => (prev && keys.has(prev) ? prev : null));
    setRowLookups((prev) => new Map([...prev].filter(([k]) => keys.has(k))));
  }, [scan]);

  /**
   * The row's coordinate as it stands: the pick, else what the row proposes by
   * default (the file's own, else the best candidate).
   *
   * Unless the researcher has said no to it — `cleared`. A radio group has no
   * "none" of its own, and here the default is pre-selected, so without this a
   * click on the chosen option dropped the pick and the default walked straight
   * back in. Saying no has to stick until something is picked.
   */
  const chosenFor = (row: GeocodeRow): ChosenCoord | undefined =>
    cleared.has(row.key)
      ? undefined
      : chosenCoordFor(row, chosen.get(row.key), { fromFile: t("tools.geocode.fromFile") });

  const toggleChecked = (key: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  /** Choose a coordinate for the row: remember it, check the row, and drop
   *  a no-match mark — shared by every option (candidate, file, cached, GOV).
   *  A govId is carried only by GOV picks and ends up in the `_GOV` write-back. */
  const pickCoord = (row: GeocodeRow, coord: GeoCoord, label: string, govId?: string) => {
    setChosen((prev) => new Map(prev).set(row.key, govId ? { coord, label, govId } : { coord, label }));
    toggleChecked(row.key, true);
    setCleared((prev) => {
      if (!prev.has(row.key)) return prev;
      const next = new Set(prev);
      next.delete(row.key);
      return next;
    });
    setNoMatch((prev) => {
      const next = new Set(prev);
      next.delete(row.key);
      return next;
    });
  };

  /** Drop a row's pick: the row is left with no coordinate at all — not with
   *  the default it opened with — and unticked, so nothing of it is written
   *  until something is picked again. */
  const unpickCoord = (row: GeocodeRow) => {
    setChosen((prev) => {
      const next = new Map(prev);
      next.delete(row.key);
      return next;
    });
    setCleared((prev) => new Set(prev).add(row.key));
    toggleChecked(row.key, false);
  };

  const toggleOpen = (key: string) => {
    const willOpen = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(key);
      else next.delete(key);
      return next;
    });
    // The map is never opened for you — it is asked for, like everywhere else
    // on this page. Closing the row does free it.
    if (!willOpen && mapKey === key) setMapKey(null);
  };

  const renameValue = (from: string, to: string, addr?: string, coord?: GeoAssignment) => {
    const renamed = onRenamePlaceValue(from, to, addr);
    // A register pick brings the place's coordinate with it, so the row is
    // resolved in the same step rather than sent back to the list to be
    // matched again. A house coordinate (the offer named an address) reaches
    // only the events at that address; a settlement's goes to the value —
    // where, like any geocode write, it fills the gaps and overwrites nothing.
    const placed = !coord
      ? 0
      : addr
        ? onApplyAddressCoords(new Map([[placeAddrKey(to, addr), coord.coord]]))
        : onApplyGeocode(new Map([[to, coord]]));
    // The two passes touch overlapping records, so the larger count is the
    // honest "records changed", not the sum. The edit-version effect above
    // handles the rescan.
    setLastApplied(Math.max(renamed, placed));
    // A plain respelling keeps the row's staged work — the pick is about the
    // place, not its spelling (the address rows' rename makes the same call).
    // Where the rename merges into a row with its own staged pick, that one
    // stands. A register pick has no work to carry: it resolves the row here,
    // and an addr split re-keys the events past any place row.
    if (renamed && !coord && !addr) {
      setChosen((prev) => {
        const carried = prev.get(from);
        const next = new Map(prev);
        next.delete(from);
        if (carried && !next.has(to)) next.set(to, carried);
        return next;
      });
      setChecked((prev) => {
        if (!prev.has(from)) return prev;
        const next = new Set(prev);
        next.delete(from);
        next.add(to);
        return next;
      });
    }
  };

  const toggleNoMatch = (key: string) => {
    setNoMatch((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        toggleChecked(key, false);
      }
      return next;
    });
  };

  const selectConfident = () => {
    if (!scan) return;
    setChecked((prev) => {
      const next = new Set(prev);
      for (const row of scan.rows) if (row.confident && !noMatch.has(row.key) && !cleared.has(row.key)) next.add(row.key);
      return next;
    });
  };

  const apply = async () => {
    if (!scan) return;
    const assignments = new Map<string, GeoAssignment>();
    const toStore: GeocodeDecision[] = [];
    const now = Date.now();
    for (const row of [...scan.rows, ...scan.placed]) {
      if (checked.has(row.key)) {
        const c = chosenFor(row);
        if (!c) continue;
        // Accepted coordinates go into the file and nowhere else — the saved
        // GEDCOM is their record; only no-match marks are remembered. A placed
        // row's pick is a re-geocode, so it may overwrite what the value
        // already carries (address-bound house positions excepted).
        const a: GeoAssignment = c.govId ? { coord: c.coord, govId: c.govId } : { coord: c.coord };
        if (row.placed) a.overwrite = true;
        assignments.set(row.key, a);
      } else if (noMatch.has(row.key) && row.cached?.status !== "nomatch") {
        toStore.push({ key: row.key, status: "nomatch", ts: now });
      }
    }
    const changed = assignments.size ? onApplyGeocode(assignments) : 0;
    // A written row is finished work and must leave the staged sets: now that
    // placed rows with staged work stay on the worklist, a tick left behind
    // would keep the row listed — and the next Write would write it again,
    // this time overwriting.
    if (assignments.size) {
      setChecked((prev) => new Set([...prev].filter((k) => !assignments.has(k))));
      setChosen((prev) => new Map([...prev].filter(([k]) => !assignments.has(k))));
    }
    setLastApplied(changed);
    // Decisions reload re-keys the scan memo; dataset changes (when anything
    // was written) rescan via the edit-version effect.
    await putDecisions(toStore);
    const fresh = await loadDecisions();
    setDecisions(fresh);
  };

  // ── Rendering ─────────────────────────────────────────────────────────────
  if (!scan || countries === null || !view) return <ToolsLoading label={t("tools.running")} />;

  const { countryChips, countryAllCount, activeCountry, statusCounts, statusAllCount, placedTotal } = view;
  const confidentCount = scan.rows.filter((r) => r.confident && !checked.has(r.key) && !noMatch.has(r.key)).length;

  // "Take official names": rows whose best proposal is the register's longer
  // (or differently cased) spelling of the very place they write — confident
  // ones only, so a fuzzy guess never renames anything in bulk. Scoped to the
  // filtered rows, like the chips: what you see is what the button takes.
  const officialFor = (row: GeocodeRow): OfficialRename | undefined => {
    const cand = row.candidates[0];
    if (!cand || !row.confident || noMatch.has(row.key)) return undefined;
    const to = replaceLocality(row.key, cand.entry.name);
    return to ? { from: row.key, to, assignment: { coord: { lat: cand.entry.lat, lon: cand.entry.lon } } } : undefined;
  };
  const officialRenames = rows.flatMap((r) => officialFor(r) ?? []);
  const takeOfficialNames = () => {
    if (!officialRenames.length) return;
    setLastApplied(onApplyOfficialNames(officialRenames));
  };

  return (
    // The registers behind every place field on this page: the rename row and
    // the move panel below complete a place the file has never written, exactly
    // as the Edit view's event fields do.
    <PlaceLookupProvider value={placeLookup}>
    <div className="tools-geocode">
      <div className="tools-filter-row">
        <BackButton label={t("tools.places.geocodeBack")} shortcutHint="Esc" showLabel onClick={onBack} />
        <TreeSearch value={search} onChange={setSearch} />
        <ToolSummary>
          {[
            scan.totalOccurrences > 0 &&
              t("tools.geocode.progress", {
                covered: scan.coveredDistinct,
                total: scan.coveredDistinct + scan.rows.length,
                pct: Math.round((100 * scan.coveredOccurrences) / scan.totalOccurrences),
              }),
            // A write that changed nothing says so in words: "0 updated
            // records" is read as the button having done nothing at all,
            // when what happened is that the file already held the position.
            lastApplied !== null &&
              (lastApplied === 0 ? t("tools.geocode.appliedNone") : t("tools.geocode.applied", { count: lastApplied })),
          ]
            .filter(Boolean)
            .join(" · ")}
        </ToolSummary>
      </div>
      <GazetteerSetup gaz={gaz} />

      {/* Above the lists, below the gazetteer: it is the only outright error on
          the page — coordinates that contradict each other, which no lookup
          below can resolve — but it is a finding, not part of the setup. */}
      <CoordConflicts dataset={dataset} scanGen={scanGen} onApply={onApplyAddressCoords} query={query} />

      {/* The two work lists switch as tabs — a long places list otherwise
          buries the addresses below it. No tabs while the file has no
          addresses: the page is just the places list then. */}
      {(() => {
        const hasTabs = addrRows.length > 0 || hasRegister;
        // The places actions render either on the tab row (tabs shown) or in
        // the section's own head (no addresses, no tabs) — one definition.
        const placesActions = (scan.rows.length > 0 || scan.placed.length > 0) && (
          <div className="tools-dup-bulk">
            <button className="nav-btn primary tools-run" onClick={() => void apply()} disabled={checked.size === 0 && noMatch.size === 0}>
              {t("tools.geocode.apply", { count: checked.size })}
            </button>
            <button className="tools-issue-link" onClick={selectConfident} disabled={confidentCount === 0}>
              {t("tools.geocode.selectConfident", { count: confidentCount })}
            </button>
            {officialRenames.length > 0 && (
              <button className="tools-issue-link" onClick={takeOfficialNames} title={t("tools.geocode.official.bulkTooltip")}>
                {t("tools.geocode.official.bulk", { count: officialRenames.length })}
              </button>
            )}
            {/* Clearing the selection drops the staged picks too, not just the
                ticks — a pick left behind keeps its radio lit and comes back
                with the next tick. Rows fall back to their scan default. */}
            <button
              className="tools-issue-link"
              onClick={() => {
                setChecked(new Set());
                setChosen(new Map());
              }}
            >
              {t("tools.sources.dupSelectNone")}
            </button>
            <ExpandAllToggle
              allOpen={rows.length > 0 && rows.every((r) => expanded.has(r.key))}
              onToggle={() => {
                if (rows.length > 0 && rows.every((r) => expanded.has(r.key))) {
                  setExpanded(new Set());
                  setMapKey(null);
                } else setExpanded(new Set(rows.map((r) => r.key)));
              }}
            />
          </div>
        );
        return (
          <>
      {/* The tab row carries the active list's actions too — the tabs already
          say what and how much, so a heading line per section would repeat it. */}
      {hasTabs && (
        <div className="tools-geo-tabs-row">
          <div className="tools-geo-tabs" role="tablist">
            <button role="tab" aria-selected={tab === "places"} className={tab === "places" ? "active" : ""} onClick={() => setTab("places")}>
              {t("tools.geocode.tab.places")} <span className="tools-chip-count">{scan.rows.length}</span>
            </button>
            {addrRows.length > 0 && (
              <button role="tab" aria-selected={tab === "addresses"} className={tab === "addresses" ? "active" : ""} onClick={() => setTab("addresses")}>
                {/* The worklist count: placed rows are in addrRows but hidden by
                    default, so counting them would promise more than the tab shows. */}
                {t("tools.geocode.tab.addresses")} <span className="tools-chip-count">{addrRows.filter((r) => !r.placed).length}</span>
              </button>
            )}
            {hasRegister && (
              <button
                role="tab"
                aria-selected={tab === "register"}
                className={tab === "register" ? "active" : ""}
                onClick={() => {
                  setRegisterSeen(true);
                  setTab("register");
                }}
              >
                {/* No count until the check has run — the tab is what starts it,
                    and a number guessed before it would be a promise. */}
                {t("tools.geocode.tab.register")}
                {registerReport && (
                  <span className="tools-chip-count">{registerReport.findings.filter((f) => !f.dismissed).length}</span>
                )}
              </button>
            )}
          </div>
          {tab === "places" && placesActions}
          {/* The address and register sections own their buttons' state; they
              portal them here. */}
          {(tab === "addresses" || tab === "register") && <div className="tools-dup-bulk" ref={setTabActionsEl} />}
        </div>
      )}

      <div style={tab === "places" ? undefined : { display: "none" }}>
      {/* The offline-matching promise is the places tab's — the address tab
          asks the register online and says so in its own intro. */}
      <p className="tools-intro">{t("tools.geocode.intro")}</p>
      {scan.rows.length === 0 && <p className="tools-clean tools-clean--ok">{t("tools.geocode.allCovered")}</p>}

      {/* The placed rows keep the section alive after the worklist is done —
          "all covered" above, and below it the toggle that lists them again. */}
      {(scan.rows.length > 0 || scan.placed.length > 0) && (
      <section className="tools-cleanup-section">
        {!hasTabs && (
          <div className="tools-dup-kind-head">
            {t("tools.geocode.heading")}
            <span className="tools-chip-count">{scan.rows.length}</span>
            {placesActions}
          </div>
        )}
      {/* One country's file shows no country row — there is nothing to narrow. */}
      {countryChips.length > 1 && (
        <div className="tools-chips">
          <button
            className={`tools-chip ${activeCountry === null ? "active" : ""}`}
            onClick={() => setCountryFilter(null)}
          >
            {t("tools.geocode.filter.all")} <span className="tools-chip-count">{countryAllCount}</span>
          </button>
          {countryChips.map((c) => (
            <button
              key={c.country || "?"}
              className={`tools-chip ${activeCountry === c.country ? "active" : ""}`}
              onClick={() => setCountryFilter(c.country)}
            >
              {c.country || t("tools.geocode.countryUnknown")}{" "}
              <span className="tools-chip-count">{c.count}</span>
            </button>
          ))}
        </div>
      )}
      <div className="tools-chips">
        {STATUS_FILTERS.filter((f) => showPlaced || f !== "placed").map((f) => (
          <button
            key={f}
            className={`tools-chip ${statusFilter === f ? "active" : ""}`}
            onClick={() => setStatusFilter(f)}
          >
            {t(`tools.geocode.filter.${f}`)}{" "}
            <span className="tools-chip-count">{f === "all" ? statusAllCount : statusCounts[f]}</span>
          </button>
        ))}
        {(placedTotal > 0 || showPlaced) && (
          <label className="tools-reshape-site" title={t("tools.geocode.showPlacedHint")}>
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
            {t("tools.geocode.showPlaced")} <span className="tools-chip-count">{placedTotal}</span>
          </label>
        )}
      </div>
      {!rows.length && <p className="tools-clean">{t("tools.search.noMatch")}</p>}
      <ul className="tools-tree">
        <li className="v-spacer" style={{ height: virtual.padTop }} ref={virtual.topRef} aria-hidden />
        {rows.slice(virtual.start, virtual.end).map((row) => (
          <GeocodePlaceRow
            key={row.key}
            row={row}
            dataset={dataset}
            isChecked={checked.has(row.key)}
            isOpen={expanded.has(row.key)}
            hasMap={mapKey === row.key}
            marked={noMatch.has(row.key)}
            override={chosen.get(row.key)}
            isCleared={cleared.has(row.key)}
            fileCoords={fileCoords}
            placeSug={placeSug}
            placeCombos={placeCombos}
            kinship={kinship}
            missingInTitle={missingInTitles.get(row.key)}
            onToggleChecked={toggleChecked}
            onToggleOpen={toggleOpen}
            onClaimMap={(key) => setMapKey((prev) => (prev === key ? null : key))}
            onPickCoord={pickCoord}
            onUnpickCoord={unpickCoord}
            onToggleNoMatch={toggleNoMatch}
            onRename={renameValue}
            onNavigate={onNavigate}
            lookups={rowLookups.get(row.key)}
            onLookupsChange={patchRowLookups}
          />
        ))}
        <li className="v-spacer" style={{ height: virtual.padBottom }} ref={virtual.bottomRef} aria-hidden />
      </ul>
      </section>
      )}

      </div>

      {/* Addresses whose house coordinate the register can supply, for events
          whose PLAC names only the settlement. Renders nothing when there are
          none, so files without ADDR lines see no change. */}
      <div style={tab === "addresses" ? undefined : { display: "none" }}>
      <AddressCoordsSection
        dataset={dataset}
        all={addrRows}
        addrsByPlace={addrsByPlace}
        places={placeSug}
        onApply={onApplyAddressCoords}
        onMove={onMovePlaceForAddresses}
        query={query}
        kinship={kinship}
        onNavigate={onNavigate}
        onRenameAddress={onRenameAddress}
        actionsHost={tab === "addresses" ? tabActionsEl : null}
      />
      </div>

      {/* The compliance report: every place held against the official register
          of its country, and what the two disagree about. */}
      {hasRegister && (
        <div style={tab === "register" ? undefined : { display: "none" }}>
          <RegisterCheckSection
            report={registerReport}
            query={query}
            actionsHost={tab === "register" ? tabActionsEl : null}
            onApplyOfficialNames={onApplyOfficialNames}
            onDecisionsChanged={() => void loadDecisions().then(setDecisions)}
          />
        </div>
      )}
          </>
        );
      })()}
    </div>
    </PlaceLookupProvider>
  );
}

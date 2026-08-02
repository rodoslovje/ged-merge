import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import {
  chosenCoordFor,
  collectFileCoords,
  placeAddrKey,
  scanGeocode,
  type ChosenCoord,
  type GeoAssignment,
  type GeocodeRow,
} from "../../tools/geocode";
import { loadDecisions, putDecisions, type GeocodeDecision } from "../../persist/geoDb";
import { ExpandAllToggle, ToolsLoading, TreeSearch, useDebounced } from "./shared";
import { createKinshipResolver } from "../../match/kinship";
import { buildPlaceSuggestions, placeCombosOf } from "../edit/placeSuggestions";
import { foldSearch } from "../globalSearch";
import { PlaceLookupProvider, usePlaceLookupValue } from "../edit/PlaceLookupContext";
import { GazetteerSetup, useGazetteer } from "./GazetteerManager";
import { AddressCoordsSection } from "./AddressCoordsSection";
import { CoordConflicts } from "./CoordConflicts";
import { GeocodePlaceRow } from "./GeocodePlaceRow";
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

const SHOW_LIMIT = 300;

interface Props {
  dataset: Dataset;
  active: boolean;
  /** Write the accepted coordinates (with any GOV ids) through the edit/undo
   *  pipeline; returns the number of records changed. */
  onApplyGeocode: (assignments: Map<string, GeoAssignment>) => number;
  /** Rename all occurrences of exactly this raw place value (edit/undo
   *  pipeline); with `addr`, split into PLAC `to` + an ADDR on the parent
   *  event. Returns the number of records changed. */
  onRenamePlaceValue: (from: string, to: string, addr?: string) => number;
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

export function GeocodePanel({ dataset, onApplyGeocode, onApplyAddressCoords, onRenamePlaceValue, onMovePlaceForAddresses, onBack, onNavigate, startId }: Props) {
  const { t } = useTranslation();
  const { settings: appSettings } = useSettings();
  const nameOf = useNameOf();

  // Kinship labels for the expanded row's people list — same resolver and
  // display gate (the Kinship display setting) as the Map's event panel.
  const kinship = useMemo(
    () => (startId && appSettings.showKinship ? createKinshipResolver(dataset, startId, t) : undefined),
    [dataset, startId, appSettings.showKinship, t],
  );

  // Esc returns to the Places tree, like leaving Organize sources.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isEditableTarget(e.target) || isModalOpen()) return;
      e.preventDefault();
      onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

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
    for (const row of scan.rows) {
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

  // A fresh scan seeds the review state from the cached decisions — but
  // in-progress picks on rows that survived the rescan (e.g. after renaming
  // one other row) are preserved, not silently discarded.
  useEffect(() => {
    if (!scan) return;
    const keys = new Set(scan.rows.map((r) => r.key));
    setChecked((prev) => {
      const next = new Set([...prev].filter((k) => keys.has(k)));
      for (const r of scan.rows) if (r.cached?.status === "accepted" && r.cached.lat !== undefined) next.add(r.key);
      return next;
    });
    setNoMatch((prev) => {
      const next = new Set([...prev].filter((k) => keys.has(k)));
      for (const r of scan.rows) if (r.cached?.status === "nomatch") next.add(r.key);
      return next;
    });
    setChosen((prev) => new Map([...prev].filter(([k]) => keys.has(k))));
    setExpanded((prev) => new Set([...prev].filter((k) => keys.has(k))));
    setMapKey((prev) => (prev && keys.has(prev) ? prev : null));
  }, [scan]);

  const chosenFor = (row: GeocodeRow): ChosenCoord | undefined =>
    chosenCoordFor(row, chosen.get(row.key), {
      fromFile: t("tools.geocode.fromFile"),
      cached: t("tools.geocode.cached"),
    });

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
    setNoMatch((prev) => {
      const next = new Set(prev);
      next.delete(row.key);
      return next;
    });
  };

  /** Drop a row's pick: the coordinate goes back to whatever the row proposes by
   *  default, and the row is unticked so nothing of it is written. */
  const unpickCoord = (row: GeocodeRow) => {
    setChosen((prev) => {
      const next = new Map(prev);
      next.delete(row.key);
      return next;
    });
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
    // honest "records changed", not the sum.
    setLastApplied(Math.max(renamed, placed));
    setScanGen((g) => g + 1);
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
      for (const row of scan.rows) if (row.confident && !noMatch.has(row.key)) next.add(row.key);
      return next;
    });
  };

  const apply = async () => {
    if (!scan) return;
    const assignments = new Map<string, GeoAssignment>();
    const toStore: GeocodeDecision[] = [];
    const now = Date.now();
    for (const row of scan.rows) {
      if (checked.has(row.key)) {
        const c = chosenFor(row);
        if (!c) continue;
        assignments.set(row.key, c.govId ? { coord: c.coord, govId: c.govId } : { coord: c.coord });
        toStore.push({
          key: row.key,
          status: "accepted",
          lat: c.coord.lat,
          lon: c.coord.lon,
          label: c.label,
          ts: now,
          ...(c.govId ? { govId: c.govId } : {}),
        });
      } else if (noMatch.has(row.key) && row.cached?.status !== "nomatch") {
        toStore.push({ key: row.key, status: "nomatch", ts: now });
      }
    }
    const changed = assignments.size ? onApplyGeocode(assignments) : 0;
    setLastApplied(changed);
    await putDecisions(toStore);
    const fresh = await loadDecisions();
    setDecisions(fresh);
    setScanGen((g) => g + 1);
  };

  // ── Rendering ─────────────────────────────────────────────────────────────
  if (!scan || countries === null) return <ToolsLoading label={t("tools.running")} />;

  const rows = query ? scan.rows.filter((r) => foldSearch(r.key).includes(query)) : scan.rows;
  const shown = rows.slice(0, SHOW_LIMIT);
  const confidentCount = scan.rows.filter((r) => r.confident && !checked.has(r.key) && !noMatch.has(r.key)).length;

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
            scan.rows.length > 0 && t("tools.geocode.coverage", { distinct: scan.rows.length }),
            lastApplied !== null && t("tools.geocode.applied", { count: lastApplied }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </ToolSummary>
      </div>
      <p className="tools-intro">{t("tools.geocode.intro")}</p>

      <GazetteerSetup gaz={gaz} />

      {/* Above the lists, below the gazetteer: it is the only outright error on
          the page — coordinates that contradict each other, which no lookup
          below can resolve — but it is a finding, not part of the setup. */}
      <CoordConflicts dataset={dataset} onApply={onApplyAddressCoords} query={query} />

      {scan.rows.length === 0 && <p className="tools-clean tools-clean--ok">{t("tools.geocode.allCovered")}</p>}

      {scan.rows.length > 0 && (
      <section className="tools-cleanup-section">
        <div className="tools-dup-kind-head">
          {t("tools.geocode.heading")}
          <span className="tools-chip-count">{scan.rows.length}</span>
          <div className="tools-dup-bulk">
            <button className="nav-btn primary tools-run" onClick={() => void apply()} disabled={checked.size === 0 && noMatch.size === 0}>
              {t("tools.geocode.apply", { count: checked.size })}
            </button>
            <button className="tools-issue-link" onClick={selectConfident} disabled={confidentCount === 0}>
              {t("tools.geocode.selectConfident", { count: confidentCount })}
            </button>
            <button className="tools-issue-link" onClick={() => setChecked(new Set())}>
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
        </div>
      {!shown.length && <p className="tools-clean">{t("tools.search.noMatch")}</p>}
      <ul className="tools-tree">
        {shown.map((row) => (
          <GeocodePlaceRow
            key={row.key}
            row={row}
            dataset={dataset}
            isChecked={checked.has(row.key)}
            isOpen={expanded.has(row.key)}
            hasMap={mapKey === row.key}
            marked={noMatch.has(row.key)}
            override={chosen.get(row.key)}
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
          />
        ))}
      </ul>
      {rows.length > SHOW_LIMIT && <p className="tools-geo-more">{t("tools.geocode.more", { count: rows.length - SHOW_LIMIT })}</p>}
      </section>
      )}

      {/* Addresses whose house coordinate the register can supply, for events
          whose PLAC names only the settlement. Renders nothing when there are
          none, so files without ADDR lines see no change. */}
      <AddressCoordsSection
        dataset={dataset}
        onApply={onApplyAddressCoords}
        onMove={onMovePlaceForAddresses}
        query={query}
      />
    </div>
    </PlaceLookupProvider>
  );
}

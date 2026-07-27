import { lazy, Suspense, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { sameCoord } from "../../geo/points";
import { resultsForQuery, searchAddressBatch, searchAddresses, type RnResult } from "../../geo/rn";
import { replaceLocality, scanAddresses, suggestMovedPlace, type AddressRow } from "../../tools/addresses";
import { collectPlaceValues } from "../../tools/geocode";
import { foldSearch } from "../globalSearch";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import { useSettings } from "../SettingsContext";
import { GeoRowHeader, MapToggle } from "./shared";

// The ADDR half of geocoding: house coordinates from the GURS address register
// for events whose PLAC names only the settlement. Kept apart from the place
// rows above because the unit is different — a place string has one coordinate
// shared by every event naming it, whereas each address is its own house.
//
// Grouped by place, and collapsed: a real file has hundreds of addresses (997 in
// one test corpus), so a flat list is unreadable and a single "look up all" would
// fire that many throttled requests. Work proceeds one place at a time instead.

type SearchState = { state: "idle" | "loading" | "error" | "done"; results: RnResult[] };

const MiniPlaceMap = lazy(() => import("../map/MiniPlaceMap"));

const IDLE: SearchState = { state: "idle", results: [] };

/** Addresses of one place, with the totals its header shows. */
interface PlaceGroup {
  place: string;
  rows: AddressRow[];
  events: number;
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
  onApply,
  onMove,
}: {
  dataset: Dataset;
  onApply: (assignments: Map<string, GeoCoord>) => number;
  onMove: (keys: Set<string>, toPlace: string) => number;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const uid = useId();
  // Re-scanned whenever the dataset object changes (applying replaces it), so
  // rows that were just written disappear on their own.
  const rows = useMemo(() => scanAddresses(dataset), [dataset]);
  const groups = useMemo(() => {
    const byPlace = new Map<string, PlaceGroup>();
    for (const row of rows) {
      const g = byPlace.get(row.place);
      if (g) {
        g.rows.push(row);
        g.events += row.count;
      } else byPlace.set(row.place, { place: row.place, rows: [row], events: row.count });
    }
    for (const g of byPlace.values()) g.suggestion = groupSuggestion(g.place, g.rows);
    // Most-used places first — that is where geocoding pays off soonest.
    return [...byPlace.values()].sort((a, b) => b.events - a.events || a.place.localeCompare(b.place));
  }, [rows]);

  // Existing place values for the move target's autocomplete, so a split lands
  // on the file's own spelling of the destination when it already has one.
  const placeValues = useMemo(() => collectPlaceValues(dataset), [dataset]);

  const [open, setOpen] = useState<Set<string>>(new Set());
  /** Groups whose map is drawn — never on open, always on request. */
  const [mapOpen, setMapOpen] = useState<Set<string>>(new Set());
  const [searches, setSearches] = useState<Map<string, SearchState>>(new Map());
  const [picked, setPicked] = useState<Map<string, { coord: GeoCoord; label: string }>>(new Map());
  const [applied, setApplied] = useState<number | null>(null);
  // The move panel: which group's is open, where to, and which of its rows go.
  const [moveGroup, setMoveGroup] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState("");
  const [moveSel, setMoveSel] = useState<Set<string>>(new Set());
  const [moved, setMoved] = useState<number | null>(null);

  if (!rows.length) return null;

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
    const pending = group.rows.filter((row) => (searches.get(row.key) ?? IDLE).state === "idle");
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
    setMoved(null);
    setMoveTarget(split?.place ?? split?.settlement ?? group.suggestion?.place ?? "");
    setMoveSel(new Set(split?.keys ?? group.suggestion?.keys ?? group.rows.map((r) => r.key)));
  };

  const closeMove = () => {
    setMoveGroup(null);
    setMoveTarget("");
    setMoveSel(new Set());
  };

  const toggleMoveRow = (key: string) =>
    setMoveSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const applyMove = () => {
    const changed = onMove(moveSel, moveTarget);
    closeMove();
    // The moved rows are keyed by their old place, so every pick and lookup
    // against them is stale — and the destination is worth looking up afresh.
    setPicked(new Map());
    setSearches(new Map());
    setMoved(changed);
  };

  const pick = (key: string, result: RnResult) =>
    setPicked((prev) => new Map(prev).set(key, { coord: result.coord, label: result.label }));

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
      for (const r of (searches.get(row.key) ?? IDLE).results) {
        pins.push({
          coord: r.coord,
          label: r.label,
          // Which of the place's addresses this pin answers, how much of the file
          // rides on it, where it is, and that a click takes it.
          lines: [
            row.address,
            t("tools.geocode.addr.uses", { count: row.count }),
            `${r.coord.lat.toFixed(5)}, ${r.coord.lon.toFixed(5)}`,
            t("event.coord.pinPick"),
          ],
          kind: sameCoord(chosen?.coord, r.coord) ? "chosen" : "candidate",
          onPick: () => pick(row.key, r),
        });
      }
    }
    return pins;
  };

  const apply = () => {
    const assignments = new Map([...picked].map(([key, v]) => [key, v.coord] as const));
    const changed = onApply(assignments);
    setPicked(new Map());
    setSearches(new Map());
    setApplied(changed);
  };

  return (
    <section className="tools-cleanup-section">
      <div className="tools-dup-kind-head">
        {t("tools.geocode.addr.heading", { count: rows.length, places: groups.length })}
      </div>
      <p className="tools-intro">{t("tools.geocode.addr.intro")}</p>
      {/* Its own action row, like the place list above — in the heading the
          button read as part of the title and sat off the text's baseline. */}
      <div className="tools-reshape-options">
        <button className="nav-btn primary tools-run" onClick={apply} disabled={picked.size === 0}>
          {t("tools.geocode.addr.apply", { count: picked.size })}
        </button>
      </div>
      {applied !== null && <p className="tools-clean tools-clean--ok">{t("tools.geocode.addr.applied", { count: applied })}</p>}
      {moved !== null && <p className="tools-clean tools-clean--ok">{t("tools.geocode.addr.moved", { count: moved })}</p>}
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
              </GeoRowHeader>
              {isOpen && (
                <div className="tools-geo-actions">
                  {/* The place's houses on one map — asked for, like every other
                      map on this page, and drawn above the addresses it is about. */}
                  <MapToggle open={mapOpen.has(group.place)} onToggle={() => toggleMap(group.place)} />
                  {settings.allowLinkFetch && group.rows.length > 1 && (
                    <button className="tools-issue-link" onClick={() => searchGroup(group)}>
                      {t("tools.geocode.addr.searchGroup", { count: group.rows.length })}
                    </button>
                  )}
                  {group.place && moveGroup !== group.place && (
                    <button
                      className="tools-issue-link"
                      title={t("tools.geocode.addr.moveHint")}
                      onClick={() => startMove(group)}
                    >
                      {t("tools.geocode.addr.move")}
                    </button>
                  )}
                </div>
              )}
              {isOpen && moveGroup !== group.place &&
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
                  placeValues={placeValues}
                  listId={`addr-move-${uid}`}
                  onTarget={setMoveTarget}
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
                          {moveGroup === group.place && (
                            <input
                              type="checkbox"
                              aria-label={row.address}
                              checked={moveSel.has(row.key)}
                              onChange={() => toggleMoveRow(row.key)}
                            />
                          )}
                          <span className="tools-geo-cand-name">{row.address}</span>
                          <span className="tools-geo-count">{t("tools.geocode.addr.uses", { count: row.count })}</span>
                          {settings.allowLinkFetch ? (
                            <>
                              <button
                                className="tools-issue-link"
                                disabled={search.state === "loading"}
                                onClick={() => runSearch(row)}
                              >
                                {search.state === "loading" ? t("tools.geocode.rn.searching") : t("tools.geocode.rn.search")}
                              </button>
                              {search.state === "error" && (
                                <span className="tools-geo-online-note">{t("tools.geocode.rn.error")}</span>
                              )}
                              {search.state === "done" && !search.results.length && (
                                <span className="tools-geo-online-note">{t("tools.geocode.rn.none")}</span>
                              )}
                            </>
                          ) : (
                            <span className="tools-geo-online-note">{t("tools.geocode.downloadNeedsOptIn")}</span>
                          )}
                          {chosen && <span className="tools-reshape-badge official">{chosen.label}</span>}
                        </div>
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
                                  />
                                  <span className="tools-geo-cand-name">{r.label}</span>
                                  <span className="gm-data">
                                    {r.coord.lat.toFixed(5)}, {r.coord.lon.toFixed(5)}
                                  </span>
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
 * Move the ticked addresses of one place to another place. The destination is a
 * whole PLAC value, autocompleted from the ones the file already uses so a split
 * lands on an existing spelling rather than a near-duplicate.
 */
function MovePanel({
  group,
  target,
  selected,
  placeValues,
  listId,
  onTarget,
  onSelectAll,
  onApply,
  onCancel,
}: {
  group: PlaceGroup;
  target: string;
  selected: ReadonlySet<string>;
  placeValues: string[];
  listId: string;
  onTarget: (value: string) => void;
  onSelectAll: (all: boolean) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const trimmed = target.trim();
  const events = group.rows.filter((r) => selected.has(r.key)).reduce((n, r) => n + r.count, 0);
  const disabled = !trimmed || trimmed === group.place || selected.size === 0;

  return (
    <div className="tools-place-rename tools-geo-addr-move">
      <p className="tools-intro">{t("tools.geocode.addr.moveIntro")}</p>
      <datalist id={listId}>
        {placeValues.map((v) => <option key={v} value={v} />)}
      </datalist>
      <input
        type="text"
        className="tools-place-rename-input"
        value={target}
        list={listId}
        autoFocus
        placeholder={t("tools.geocode.addr.movePlaceholder")}
        onChange={(e) => onTarget(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !disabled) onApply();
          if (e.key === "Escape") onCancel();
        }}
      />
      <span className="tools-place-rename-hint">
        {t("tools.geocode.addr.moveCount", { count: selected.size, events })}
      </span>
      <button className="tools-issue-link" onClick={() => onSelectAll(selected.size < group.rows.length)}>
        {selected.size < group.rows.length ? t("tools.geocode.addr.moveAll") : t("tools.geocode.addr.moveNone")}
      </button>
      <button className="nav-btn primary tools-place-rename-apply" onClick={onApply} disabled={disabled}>
        {t("tools.geocode.addr.moveApply")}
      </button>
      <button className="nav-btn" onClick={onCancel}>
        {t("tools.places.rename.cancel")}
      </button>
    </div>
  );
}

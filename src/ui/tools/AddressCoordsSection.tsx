import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { sameCoord } from "../../geo/points";
import { searchAddresses, type RnResult } from "../../geo/rn";
import { scanAddresses, type AddressRow } from "../../tools/addresses";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import { useSettings } from "../SettingsContext";

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
}

export function AddressCoordsSection({
  dataset,
  onApply,
}: {
  dataset: Dataset;
  onApply: (assignments: Map<string, GeoCoord>) => number;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
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
    // Most-used places first — that is where geocoding pays off soonest.
    return [...byPlace.values()].sort((a, b) => b.events - a.events || a.place.localeCompare(b.place));
  }, [rows]);

  const [open, setOpen] = useState<Set<string>>(new Set());
  const [searches, setSearches] = useState<Map<string, SearchState>>(new Map());
  const [picked, setPicked] = useState<Map<string, { coord: GeoCoord; label: string }>>(new Map());
  const [applied, setApplied] = useState<number | null>(null);

  if (!rows.length) return null;

  const setSearch = (key: string, next: SearchState) => setSearches((prev) => new Map(prev).set(key, next));

  const runSearch = (row: AddressRow) => {
    setSearch(row.key, { state: "loading", results: [] });
    searchAddresses(row.queries).then(
      (results) => setSearch(row.key, { state: "done", results }),
      () => setSearch(row.key, { state: "error", results: [] }),
    );
  };

  /** Look up every address of one place — bounded work, unlike the whole file. */
  const searchGroup = (group: PlaceGroup) => {
    for (const row of group.rows) {
      if ((searches.get(row.key) ?? IDLE).state === "idle") runSearch(row);
    }
  };

  const toggle = (place: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(place)) next.delete(place);
      else next.add(place);
      return next;
    });

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
          // Which of the place's addresses this pin answers, and how much of the
          // file rides on it.
          lines: [row.address, t("tools.geocode.addr.uses", { count: row.count })],
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
        {picked.size > 0 && (
          <button className="nav-btn tools-run" onClick={apply}>
            {t("tools.geocode.addr.apply", { count: picked.size })}
          </button>
        )}
      </div>
      <p className="tools-intro">{t("tools.geocode.addr.intro")}</p>
      {applied !== null && <p className="tools-clean tools-clean--ok">{t("tools.geocode.addr.applied", { count: applied })}</p>}
      <ul className="tools-geo-addr-list">
        {groups.map((group) => {
          const isOpen = open.has(group.place);
          return (
            <li key={group.place} className="tools-geo-addr-group">
              <div className="tools-geo-addr-head">
                {/* Same caret as the place rows above — one rotating ▶, not a
                    boxed button, so the two lists read as one tool. */}
                <button
                  className={`tools-pair-toggle ${isOpen ? "open" : ""}`}
                  aria-expanded={isOpen}
                  onClick={() => toggle(group.place)}
                >
                  ▶
                </button>
                <span className="tools-tree-label clickable" onClick={() => toggle(group.place)}>
                  {group.place || t("tools.geocode.addr.noPlace")}
                </span>
                <span className="tools-geo-count">
                  {t("tools.geocode.addr.groupMeta", { count: group.rows.length, events: group.events })}
                </span>
                {settings.allowLinkFetch && isOpen && group.rows.length > 1 && (
                  <button className="tools-issue-link" onClick={() => searchGroup(group)}>
                    {t("tools.geocode.addr.searchGroup", { count: group.rows.length })}
                  </button>
                )}
              </div>
              {isOpen && (() => {
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
                <ul className="tools-geo-addr-list tools-tree-children">
                  {group.rows.map((row) => {
                    const search = searches.get(row.key) ?? IDLE;
                    const chosen = picked.get(row.key);
                    return (
                      <li key={row.key} className="tools-geo-addr-row">
                        {/* Address, usage and its own lookup on one line — with a
                            hundred-odd addresses under a place, a second line per
                            row doubles the list for no gain. */}
                        <div className="tools-geo-addr-head">
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

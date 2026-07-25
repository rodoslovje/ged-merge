import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { sameCoord } from "../../geo/points";
import { searchAddress, type RnResult } from "../../geo/rn";
import { scanAddresses } from "../../tools/addresses";
import { useSettings } from "../SettingsContext";

// The ADDR half of geocoding: house coordinates from the GURS address register
// for events whose PLAC names only the settlement. Kept apart from the place
// rows above because the unit is different — a place string has one coordinate
// shared by every event naming it, whereas each address is its own house — and
// because the write target differs (see setAddressCoord).

type SearchState = { state: "idle" | "loading" | "error" | "done"; results: RnResult[] };

const IDLE: SearchState = { state: "idle", results: [] };

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
  const [searches, setSearches] = useState<Map<string, SearchState>>(new Map());
  const [picked, setPicked] = useState<Map<string, { coord: GeoCoord; label: string }>>(new Map());
  const [applied, setApplied] = useState<number | null>(null);

  if (!rows.length) return null;

  const setSearch = (key: string, next: SearchState) => setSearches((prev) => new Map(prev).set(key, next));

  const runSearch = (key: string) => {
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    setSearch(key, { state: "loading", results: [] });
    searchAddress(row.query).then(
      (results) => setSearch(key, { state: "done", results }),
      () => setSearch(key, { state: "error", results: [] }),
    );
  };

  /** Look every unsearched row up in one go, respecting the module's throttle. */
  const searchAll = () => {
    for (const row of rows) {
      if ((searches.get(row.key) ?? IDLE).state === "idle") runSearch(row.key);
    }
  };

  const pick = (key: string, result: RnResult) =>
    setPicked((prev) => new Map(prev).set(key, { coord: result.coord, label: result.label }));

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
        {t("tools.geocode.addr.heading", { count: rows.length })}
        {picked.size > 0 && (
          <button className="nav-btn tools-run" onClick={apply}>
            {t("tools.geocode.addr.apply", { count: picked.size })}
          </button>
        )}
        {settings.allowLinkFetch && rows.length > 1 && (
          <button className="tools-issue-link" onClick={searchAll}>
            {t("tools.geocode.addr.searchAll")}
          </button>
        )}
      </div>
      <p className="tools-intro">{t("tools.geocode.addr.intro")}</p>
      {applied !== null && <p className="tools-clean tools-clean--ok">{t("tools.geocode.addr.applied", { count: applied })}</p>}
      <ul className="tools-geo-addr-list">
        {rows.map((row) => {
          const search = searches.get(row.key) ?? IDLE;
          const chosen = picked.get(row.key);
          return (
            <li key={row.key} className="tools-geo-addr-row">
              <div className="tools-geo-addr-head">
                <span className="tools-geo-cand-name">{row.address}</span>
                <span className="gm-data">{row.place}</span>
                <span className="tools-geo-count">{t("tools.geocode.addr.uses", { count: row.count })}</span>
                {chosen && <span className="tools-reshape-badge official">{chosen.label}</span>}
              </div>
              {settings.allowLinkFetch ? (
                <div className="tools-geo-addr-actions">
                  <button className="tools-issue-link" disabled={search.state === "loading"} onClick={() => runSearch(row.key)}>
                    {search.state === "loading" ? t("tools.geocode.rn.searching") : t("tools.geocode.rn.search")}
                  </button>
                  {search.state === "error" && <span className="tools-geo-online-note">{t("tools.geocode.rn.error")}</span>}
                  {search.state === "done" && !search.results.length && (
                    <span className="tools-geo-online-note">{t("tools.geocode.rn.none")}</span>
                  )}
                </div>
              ) : (
                <span className="tools-geo-online-note">{t("tools.geocode.downloadNeedsOptIn")}</span>
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
    </section>
  );
}

import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { sameCoord } from "../../geo/points";
import type { GazCandidate } from "../../geo/gazetteer";
import { searchNominatim, type NominatimResult } from "../../geo/nominatim";
import { searchGov, type GovResult } from "../../geo/gov";
import { rnQueriesFrom, searchAddresses, type RnResult } from "../../geo/rn";
import { chosenCoordFor, type ChosenCoord, type FileCoord, type GeocodeRow } from "../../tools/geocode";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import type { KinshipResolver } from "../../match/kinship";
import { lineageClass } from "../../match/kinship";
import { PersonLink } from "../PersonLink";
import { PlaceAutocomplete } from "../edit/PlaceAutocomplete";
import type { PlaceSuggestions } from "../edit/placeSuggestions";
import { useSettings } from "../SettingsContext";

// One row of the Geocode-places review list: the raw PLAC value, its badge
// (file coordinate / score / remembered / no-match), the rename editor, and —
// expanded — the mini map plus the radio list of coordinate options and the
// people the unresolved value belongs to. Draft state that concerns only this
// row (rename and manual-coordinate inputs) lives here, so typing in one row
// doesn't re-render the whole list; the actual review state (checked, chosen,
// no-match, expanded) stays with the panel — it must survive rescans and
// drive the apply pass.

/** The expanded-row mini map, in the Leaflet lazy chunk it shares with the
 *  Map chart — the list itself must not pull Leaflet into the main bundle. */
const MiniPlaceMap = lazy(() => import("../map/MiniPlaceMap"));

/** "lat, lon" free input → validated coordinate. */
export function parseManualCoord(text: string): GeoCoord | undefined {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(text);
  if (!m) return undefined;
  const lat = Number(m[1].replace(",", "."));
  const lon = Number(m[2].replace(",", "."));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return { lat, lon };
}

interface Props {
  row: GeocodeRow;
  dataset: Dataset;
  isChecked: boolean;
  isOpen: boolean;
  /** This row currently owns the single mounted mini map. */
  hasMap: boolean;
  /** The row is marked "no match". */
  marked: boolean;
  /** The user's explicit pick for this row, when any (panel-owned). */
  override?: ChosenCoord;
  /** Context dots for the mini map: every coordinate the file carries. */
  fileCoords: FileCoord[];
  /** Suggestions for the rename input (the Edit fields' lists). */
  placeSug: PlaceSuggestions;
  placeCombos: { place: string; addr: string }[];
  kinship?: KinshipResolver;
  /** Hover list of the people this place is missing at (precomputed). */
  missingInTitle?: string;
  onToggleChecked: (key: string, on: boolean) => void;
  onToggleOpen: (key: string) => void;
  onClaimMap: (key: string) => void;
  /** Choose a coordinate for the row; `govId` is set only for GOV picks and
   *  drives the `_GOV` write-back. */
  onPickCoord: (row: GeocodeRow, coord: GeoCoord, label: string, govId?: string) => void;
  onToggleNoMatch: (key: string) => void;
  /** Rename all occurrences of the row's raw value (with an optional
   *  place/ADDR split); the panel applies it and rescans. */
  onRename: (from: string, to: string, addr?: string) => void;
  onNavigate: (id: string) => void;
}

export function GeocodePlaceRow({
  row,
  dataset,
  isChecked,
  isOpen,
  hasMap,
  marked,
  override,
  fileCoords,
  placeSug,
  placeCombos,
  kinship,
  missingInTitle,
  onToggleChecked,
  onToggleOpen,
  onClaimMap,
  onPickCoord,
  onToggleNoMatch,
  onRename,
  onNavigate,
}: Props) {
  const { t, i18n } = useTranslation();
  const { settings: appSettings } = useSettings();

  const c = chosenCoordFor(row, override, {
    fromFile: t("tools.geocode.fromFile"),
    cached: t("tools.geocode.cached"),
  });

  // On-demand Nominatim (OSM) search for this row's raw value — the online
  // fallback for strings the offline gazetteer can't resolve, above all
  // street addresses. Behind the online opt-in; the query text leaves the
  // device, so it only ever runs from this explicit button.
  const [online, setOnline] = useState<{ state: "idle" | "loading" | "error" | "done"; results: NominatimResult[] }>({
    state: "idle",
    results: [],
  });
  const runOnlineSearch = () => {
    setOnline({ state: "loading", results: [] });
    searchNominatim(row.key, i18n.language).then(
      (results) => setOnline({ state: "done", results }),
      () => setOnline({ state: "error", results: [] }),
    );
  };

  // GOV (gov.genealogy.net) — the genealogy gazetteer with time-valid,
  // multilingual historical names and a stable GOV id. Same online opt-in and
  // explicit-button model as Nominatim; accepting a GOV match also writes the
  // GEDCOM-L `_GOV` id into the file.
  const [gov, setGov] = useState<{ state: "idle" | "loading" | "error" | "done"; results: GovResult[] }>({
    state: "idle",
    results: [],
  });
  const runGovSearch = () => {
    setGov({ state: "loading", results: [] });
    searchGov(row.key, i18n.language).then(
      (results) => setGov({ state: "done", results }),
      () => setGov({ state: "error", results: [] }),
    );
  };

  // GURS address register — the official Slovenian house-number gazetteer. Only
  // offered when this row's place value actually carries a house number, since
  // that is what the register resolves; the settlement alone is the offline
  // gazetteer's job. Same online opt-in and explicit-button model as the others.
  const rnQueries = useMemo(() => rnQueriesFrom(row.key, undefined), [row.key]);
  const [rn, setRn] = useState<{ state: "idle" | "loading" | "error" | "done"; results: RnResult[] }>({
    state: "idle",
    results: [],
  });
  const runRnSearch = () => {
    if (!rnQueries.length) return;
    setRn({ state: "loading", results: [] });
    searchAddresses(rnQueries).then(
      (results) => setRn({ state: "done", results }),
      () => setRn({ state: "error", results: [] }),
    );
  };

  // Inline rename of this row's raw place value (fix a typo so it matches).
  // The optional address draft splits the value into PLAC + ADDR on apply.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameAddrDraft, setRenameAddrDraft] = useState("");
  // The manual-coordinate input (typed or map-picked). When the panel already
  // carries a manual pick for this row (e.g. this row remounted after a
  // search filter), the input starts out showing it.
  const [manualDraft, setManualDraft] = useState(() =>
    override && override.label === t("tools.geocode.manual") ? `${override.coord.lat}, ${override.coord.lon}` : "",
  );

  // A remembered (cached) acceptance is shown with its original origin
  // badge — file coordinate or gazetteer score — and only the tooltip
  // says it came from a previous session; the plain "remembered" badge
  // remains for decisions with no recognizable origin (e.g. manual).
  const cachedCoord =
    row.cached?.status === "accepted" && row.cached.lat !== undefined && row.cached.lon !== undefined
      ? { lat: row.cached.lat, lon: row.cached.lon }
      : undefined;
  const cachedIsFile = sameCoord(cachedCoord, row.fileCoord);
  const cachedCand = cachedCoord
    ? row.candidates.find((cand) => sameCoord({ lat: cand.entry.lat, lon: cand.entry.lon }, cachedCoord))
    : undefined;

  // Rename every occurrence of exactly this raw value, then rescan —
  // the corrected spelling gets fresh gazetteer proposals (or merges
  // into an already-covered row and drops off the list).
  const applyRename = () => {
    const target = renameDraft.trim();
    const addrTarget = renameAddrDraft.trim();
    if (!target || (target === row.key && !addrTarget)) return;
    onRename(row.key, target, addrTarget || undefined);
    setRenameOpen(false);
  };
  const renameDisabled = !renameDraft.trim() || (renameDraft.trim() === row.key && !renameAddrDraft.trim());

  // The manual coordinate as a selectable option: parsed draft (typed
  // or map-picked), checked when it is the row's chosen coordinate.
  const draftCoord = parseManualCoord(manualDraft);
  const manualChosen = !!c && !!draftCoord && sameCoord(c.coord, draftCoord);
  const setManual = () => {
    if (draftCoord) onPickCoord(row, draftCoord, t("tools.geocode.manual"));
  };
  const pickCandidate = (cand: GazCandidate) =>
    onPickCoord(row, { lat: cand.entry.lat, lon: cand.entry.lon }, cand.entry.name);

  return (
    <li className="tools-tree-node">
      <div className="tools-tree-row">
        <input
          type="checkbox"
          className="tools-dup-check"
          checked={isChecked}
          disabled={!c || marked}
          onChange={(e) => onToggleChecked(row.key, e.target.checked)}
        />
        <button className={`tools-pair-toggle ${isOpen ? "open" : ""}`} onClick={() => onToggleOpen(row.key)} aria-expanded={isOpen}>
          ▶
        </button>
        <span
          className={`tools-tree-label clickable${marked ? " tools-reshape-removed" : ""}`}
          onClick={() => onToggleOpen(row.key)}
        >
          {row.key}
        </span>
        {renameOpen ? (
          <button
            className="tools-place-edit-btn tools-place-edit-cancel"
            onClick={() => setRenameOpen(false)}
            title={t("tools.places.rename.cancel")}
          >
            ✕
          </button>
        ) : (
          <button
            className="tools-place-edit-btn"
            onClick={() => {
              setRenameOpen(true);
              setRenameDraft(row.key);
              setRenameAddrDraft("");
            }}
            title={t("tools.geocode.renameOpen")}
          >
            ✏︎
          </button>
        )}
        {c && (
          <span className="tools-tree-meta">
            → {c.label} · <span className="gm-data">{c.coord.lat.toFixed(4)}, {c.coord.lon.toFixed(4)}</span>
          </span>
        )}
        {marked ? (
          <span className="tools-reshape-badge remove" title={t("tools.geocode.noMatch")}>
            {t("tools.geocode.noMatchBadge")}
          </span>
        ) : cachedCoord && !override ? (
          cachedIsFile ? (
            <span className="tools-reshape-badge new" title={`${t("tools.geocode.fromFileTooltip")} · ${t("tools.geocode.cachedTooltip")}`}>
              {t("tools.geocode.fromFile")}
            </span>
          ) : cachedCand ? (
            <span
              className={`tools-geo-score${row.confident || isChecked ? " confident" : ""}`}
              title={t("tools.geocode.cachedTooltip")}
            >
              {Math.round(cachedCand.score * 100)}%
            </span>
          ) : (
            <span className="tools-reshape-badge reuse" title={t("tools.geocode.cachedTooltip")}>
              {t("tools.geocode.cached")}
            </span>
          )
        ) : row.fileCoord && !override ? (
          <span className="tools-reshape-badge new" title={t("tools.geocode.fromFileTooltip")}>
            {t("tools.geocode.fromFile")}
          </span>
        ) : row.candidates[0] && !override ? (
          // Green when confident — or hand-selected for writing: a
          // checked row's badge should read as "going in" too.
          <span className={`tools-geo-score${row.confident || isChecked ? " confident" : ""}`}>
            {Math.round(row.candidates[0].score * 100)}%
          </span>
        ) : !c ? (
          <span className="tools-tree-meta">{t("tools.geocode.noCandidate")}</span>
        ) : null}
        <button
          className="tools-issue-link"
          onClick={() => onToggleNoMatch(row.key)}
          aria-pressed={marked}
          title={marked ? t("tools.geocode.noMatchUndo") : t("tools.geocode.noMatch")}
        >
          {marked ? "↩" : "🗑"}
        </button>
        <span className="tools-chip-count" title={missingInTitle}>{row.missing}</span>
      </div>
      {renameOpen && (
        <div
          className="tools-place-rename"
          onKeyDown={(e) => {
            // Enter with a highlighted suggestion, and Escape with an
            // open dropdown, are consumed by the autocomplete
            // (defaultPrevented); the next press reaches the editor.
            if (e.key === "Enter" && !e.defaultPrevented) applyRename();
            if (e.key === "Escape" && !e.defaultPrevented) setRenameOpen(false);
          }}
        >
          <PlaceAutocomplete
            value={renameDraft}
            suggestions={placeSug.placeSuggestions}
            canonical={placeSug.placeCanonical}
            combos={placeCombos}
            isDirty={false}
            className="tools-place-rename-input"
            wrapClassName="tools-place-rename-auto"
            placeholder={t("tools.places.rename.placeholder")}
            autoFocus
            onChange={setRenameDraft}
            onCommit={setRenameDraft}
            onClear={() => setRenameDraft("")}
            onPickCombo={(place, addr) => {
              setRenameDraft(place);
              setRenameAddrDraft(addr);
            }}
          />
          <span className="tools-geo-addr-chip" title={t("tools.geocode.renameAddrTooltip")}>
            {t("event.colAddr")}:
            <input
              type="text"
              className="tools-geo-addr-chip-input"
              value={renameAddrDraft}
              size={Math.max(8, renameAddrDraft.length + 1)}
              placeholder={t("tools.geocode.renameAddrPlaceholder")}
              onChange={(e) => setRenameAddrDraft(e.target.value)}
            />
            {renameAddrDraft && (
              <button
                className="tools-geo-addr-chip-clear"
                onClick={() => setRenameAddrDraft("")}
                aria-label={t("tools.places.rename.cancel")}
              >
                ×
              </button>
            )}
          </span>
          <button
            className="nav-btn primary tools-place-rename-apply"
            onClick={applyRename}
            disabled={renameDisabled}
          >
            {t("tools.places.rename.apply")}
          </button>
        </div>
      )}
      {isOpen && (
        <div className="tools-tree-children tools-geo-detail">
          {(() => {
            // Cheap gates first — under "Expand all" most rows render
            // the claim link, and must not build throwaway pin arrays.
            if (
              !row.candidates.length &&
              !c &&
              !draftCoord &&
              !online.results.length &&
              !gov.results.length &&
              !rn.results.length &&
              !fileCoords.length
            )
              return null;
            if (!hasMap)
              return (
                <button className="tools-issue-link tools-geo-showmap" onClick={() => onClaimMap(row.key)}>
                  {t("tools.geocode.showMap")}
                </button>
              );
            // Candidate pins (click = pick), the chosen coordinate
            // highlighted, plus a live pin for a parseable manual draft.
            const pins: MiniMapPin[] = row.candidates.map((cand) => ({
              coord: { lat: cand.entry.lat, lon: cand.entry.lon },
              label: `${cand.entry.name} · ${Math.round(cand.score * 100)}%`,
              kind:
                c && sameCoord(c.coord, { lat: cand.entry.lat, lon: cand.entry.lon })
                  ? ("chosen" as const)
                  : ("candidate" as const),
              onPick: () => pickCandidate(cand),
            }));
            for (const r of online.results) {
              if (pins.some((p) => sameCoord(p.coord, r.coord))) continue;
              pins.push({
                coord: r.coord,
                label: `${r.name} · OSM`,
                kind: c && sameCoord(c.coord, r.coord) ? ("chosen" as const) : ("candidate" as const),
                onPick: () => onPickCoord(row, r.coord, r.name),
              });
            }
            for (const r of gov.results) {
              if (pins.some((p) => sameCoord(p.coord, r.coord))) continue;
              pins.push({
                coord: r.coord,
                label: `${r.name} · GOV`,
                kind: c && sameCoord(c.coord, r.coord) ? ("chosen" as const) : ("candidate" as const),
                onPick: () => onPickCoord(row, r.coord, r.name, r.govId),
              });
            }
            for (const r of rn.results) {
              if (pins.some((p) => sameCoord(p.coord, r.coord))) continue;
              pins.push({
                coord: r.coord,
                label: `${r.address} · GURS`,
                kind: c && sameCoord(c.coord, r.coord) ? ("chosen" as const) : ("candidate" as const),
                onPick: () => onPickCoord(row, r.coord, r.address),
              });
            }
            if (c && !pins.some((p) => sameCoord(p.coord, c.coord)))
              pins.push({ coord: c.coord, label: c.label, kind: "chosen" });
            if (draftCoord && !pins.some((p) => sameCoord(p.coord, draftCoord)))
              pins.push({ coord: draftCoord, label: t("tools.geocode.manual"), kind: "chosen" });
            return (
              <Suspense fallback={<div className="tools-geo-minimap" />}>
                <MiniPlaceMap
                  pins={pins}
                  context={fileCoords}
                  title={t("tools.geocode.mapPickHint")}
                  // Re-frame when an online lookup brings in new coordinates —
                  // otherwise the map keeps the view it fitted on open and the
                  // fresh candidates can sit outside it entirely.
                  fitKey={
                    [...rn.results, ...online.results, ...gov.results]
                      .map((r) => `${r.coord.lat},${r.coord.lon}`)
                      .join("|") || row.key
                  }
                  onPickCoord={(coord) => {
                    // A background click is a hand-picked coordinate:
                    // fill the manual field and select it.
                    setManualDraft(`${coord.lat}, ${coord.lon}`);
                    onPickCoord(row, coord, t("tools.geocode.manual"));
                  }}
                />
              </Suspense>
            );
          })()}
          <ul className="tools-geo-candidates">
            {/* The file's own coordinate as the first option — it is
                the default proposal, so it must show as selected. */}
            {row.fileCoord && (
              <li>
                <label>
                  <input
                    type="radio"
                    name={`geo-${row.key}`}
                    checked={sameCoord(c?.coord, row.fileCoord)}
                    onChange={() => onPickCoord(row, row.fileCoord!, t("tools.geocode.fromFile"))}
                  />
                  <span className="tools-geo-cand-name">{t("tools.geocode.fromFile")}</span>
                  <span className="gm-data">
                    {row.fileCoord.lat.toFixed(4)}, {row.fileCoord.lon.toFixed(4)}
                  </span>
                </label>
              </li>
            )}
            {/* A remembered coordinate matching neither the file's nor
                any candidate still needs its own selectable row. */}
            {cachedCoord && !cachedIsFile && !cachedCand && (
              <li>
                <label>
                  <input
                    type="radio"
                    name={`geo-${row.key}`}
                    checked={sameCoord(c?.coord, cachedCoord)}
                    onChange={() => onPickCoord(row, cachedCoord, row.cached?.label ?? t("tools.geocode.cached"))}
                  />
                  <span className="tools-geo-cand-name">{row.cached?.label ?? t("tools.geocode.cached")}</span>
                  <span className="gm-data">
                    {cachedCoord.lat.toFixed(4)}, {cachedCoord.lon.toFixed(4)}
                  </span>
                  <span className="tools-reshape-badge reuse">{t("tools.geocode.cached")}</span>
                </label>
              </li>
            )}
            {row.candidates.map((cand, i) => (
              <li key={i}>
                <label>
                  <input
                    type="radio"
                    name={`geo-${row.key}`}
                    checked={sameCoord(c?.coord, { lat: cand.entry.lat, lon: cand.entry.lon })}
                    onChange={() => pickCandidate(cand)}
                  />
                  <span className="tools-geo-cand-name">{cand.entry.name}</span>
                  {/* The municipality the register files it under — the only
                      thing that tells two same-named settlements apart. */}
                  {cand.entry.admin && <span className="tools-geo-count">({cand.entry.admin})</span>}
                  <span className="gm-data">
                    {cand.entry.population > 0 && `· ${t("tools.geocode.population", { count: cand.entry.population })} · `}
                    {`${cand.entry.lat.toFixed(4)}, ${cand.entry.lon.toFixed(4)}`}
                  </span>
                  <span className="tools-geo-score">{Math.round(cand.score * 100)}%</span>
                  {/* Source last, like the GOV/OSM/GURS rows below: the register
                      code when the entry is from an official one (SI-GURS),
                      otherwise the plain country code, which is all a
                      crowd-sourced entry knows. */}
                  <span className={`tools-reshape-badge ${cand.entry.register ? "official" : "reuse"}`}>
                    {cand.entry.register ?? cand.entry.country}
                  </span>
                </label>
              </li>
            ))}
            {online.results.map((r, i) => (
              <li key={`osm-${i}`}>
                <label title={r.label}>
                  <input
                    type="radio"
                    name={`geo-${row.key}`}
                    checked={sameCoord(c?.coord, r.coord)}
                    onChange={() => onPickCoord(row, r.coord, r.name)}
                  />
                  <span className="tools-geo-cand-name">{r.label}</span>
                  <span className="gm-data">
                    {r.coord.lat.toFixed(4)}, {r.coord.lon.toFixed(4)}
                  </span>
                  <span className="tools-reshape-badge reuse">OSM</span>
                </label>
              </li>
            ))}
            {gov.results.map((r, i) => (
              <li key={`gov-${i}`}>
                <label title={`${r.label} · GOV ${r.govId}`}>
                  <input
                    type="radio"
                    name={`geo-${row.key}`}
                    checked={sameCoord(c?.coord, r.coord)}
                    onChange={() => onPickCoord(row, r.coord, r.name, r.govId)}
                  />
                  <span className="tools-geo-cand-name">{r.label}</span>
                  {/* The place it is part of, like the register candidates —
                      four same-named Osredek differ only in this. */}
                  {r.admin && <span className="tools-geo-count">({r.admin})</span>}
                  <span className="gm-data">
                    {r.coord.lat.toFixed(4)}, {r.coord.lon.toFixed(4)}
                  </span>
                  <span className="tools-reshape-badge new">GOV</span>
                </label>
              </li>
            ))}
            {rn.results.map((r, i) => (
              <li key={`rn-${i}`}>
                <label title={r.label}>
                  <input
                    type="radio"
                    name={`geo-${row.key}`}
                    checked={sameCoord(c?.coord, r.coord)}
                    onChange={() => onPickCoord(row, r.coord, r.address)}
                  />
                  <span className="tools-geo-cand-name">{r.label}</span>
                  <span className="gm-data">
                    {r.coord.lat.toFixed(4)}, {r.coord.lon.toFixed(4)}
                  </span>
                  <span className="tools-reshape-badge official">GURS</span>
                </label>
              </li>
            ))}
            {/* Online (Nominatim) search for what the offline gazetteer
                can't resolve — above all street addresses. Explicit per-row
                action behind the online opt-in: the text leaves the device. */}
            {appSettings.allowLinkFetch && (
              <li className="tools-geo-online">
                {/* Only for a value that names a house number — the register
                    resolves houses, not settlements. */}
                {rnQueries.length > 0 && (
                  <>
                    <button
                      className="tools-issue-link"
                      disabled={rn.state === "loading"}
                      title={t("tools.geocode.rn.tooltip")}
                      onClick={runRnSearch}
                    >
                      {rn.state === "loading" ? t("tools.geocode.rn.searching") : t("tools.geocode.rn.search")}
                    </button>
                    {rn.state === "error" && <span className="tools-geo-online-note">{t("tools.geocode.rn.error")}</span>}
                    {rn.state === "done" && !rn.results.length && (
                      <span className="tools-geo-online-note">{t("tools.geocode.rn.none")}</span>
                    )}
                  </>
                )}
                <button
                  className="tools-issue-link"
                  disabled={online.state === "loading"}
                  title={t("tools.geocode.online.tooltip")}
                  onClick={runOnlineSearch}
                >
                  {online.state === "loading" ? t("tools.geocode.online.searching") : t("tools.geocode.online.search")}
                </button>
                {online.state === "error" && <span className="tools-geo-online-note">{t("tools.geocode.online.error")}</span>}
                {online.state === "done" && !online.results.length && (
                  <span className="tools-geo-online-note">{t("tools.geocode.online.none")}</span>
                )}
                <button
                  className="tools-issue-link"
                  disabled={gov.state === "loading"}
                  title={t("tools.geocode.gov.tooltip")}
                  onClick={runGovSearch}
                >
                  {gov.state === "loading" ? t("tools.geocode.gov.searching") : t("tools.geocode.gov.search")}
                </button>
                {gov.state === "error" && <span className="tools-geo-online-note">{t("tools.geocode.gov.error")}</span>}
                {gov.state === "done" && !gov.results.length && (
                  <span className="tools-geo-online-note">{t("tools.geocode.gov.none")}</span>
                )}
              </li>
            )}
            {/* Manual entry as the last option — the same radio group,
                selectable once the draft (typed or map-picked) parses. */}
            <li className="tools-geo-manual">
              <label>
                <input
                  type="radio"
                  name={`geo-${row.key}`}
                  checked={manualChosen}
                  disabled={!draftCoord}
                  onChange={setManual}
                />
                <span className="tools-geo-cand-name">{t("tools.geocode.manual")}</span>
              </label>
              <input
                type="text"
                placeholder={t("tools.geocode.manualPlaceholder")}
                title={t("tools.geocode.manualTooltip")}
                value={manualDraft}
                onChange={(e) => setManualDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setManual();
                }}
              />
            </li>
          </ul>
          {/* Who this unresolved place belongs to — standard person
              links (sex colour, lifespan, click to open in Edit),
              with the kinship chip and the person's event count. */}
          <ul className="tools-usage tools-geo-people">
            {row.missingIn.slice(0, 30).map((id) => {
              const indi = dataset.individuals.get(id);
              const kin = kinship?.label(id);
              // The person's events at this exact place (own + spouse
              // family events, matching how scanGeocode attributes
              // family PLACs to the spouses) — listed in the tooltip.
              const placeEvents = indi
                ? [...indi.events, ...indi.spouseOf.flatMap((fid) => dataset.families.get(fid)?.events ?? [])]
                    .filter((ev) => ev.place?.raw.trim() === row.key)
                : [];
              const placeEventsTitle = placeEvents
                .map((ev) => {
                  const label = ev.tag === "EVEN" && ev.type ? ev.type : t(`event.${ev.tag}`, { defaultValue: ev.tag });
                  return ev.date?.raw ? `${label}: ${ev.date.raw}` : label;
                })
                .join("\n");
              return (
                <li key={id}>
                  <PersonLink dataset={dataset} id={id} fallback={id} onNavigate={onNavigate} />
                  {kin && <span className={`person-kinship ${lineageClass(kinship?.lineage(id))}`}>{kin}</span>}
                  {indi && placeEvents.length > 0 && (
                    <span className="tools-chip-count" title={placeEventsTitle}>
                      {placeEvents.length}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {row.missingIn.length > 30 && (
            <p className="tools-geo-more">{t("tools.geocode.morePeople", { count: row.missingIn.length - 30 })}</p>
          )}
        </div>
      )}
    </li>
  );
}

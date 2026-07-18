import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { buildGazetteerIndex, type GazCandidate, type GazetteerIndex } from "../../geo/gazetteer";
import { collectFileCoords, scanGeocode, type GeocodeRow } from "../../tools/geocode";
import type { MiniMapPin } from "../map/MiniPlaceMap";
import {
  deleteCountry,
  loadCountries,
  loadDecisions,
  putDecisions,
  type CountryMeta,
  type GeocodeDecision,
} from "../../persist/geoDb";
import type { GeoWorkerRequest, GeoWorkerResponse } from "../../worker/geoMessages";
import { ToolsError, ToolsLoading, TreeSearch, useDebounced } from "./shared";
import { PlaceAutocomplete } from "../edit/PlaceAutocomplete";
import { buildPlaceSuggestions } from "../edit/placeSuggestions";
import { BackButton } from "../BackButton";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { useSettings } from "../SettingsContext";

// The "Geocode places" tool (MAPVIEW.md phase 2). Top: the offline gazetteer
// manager — imported GeoNames country extracts living in the gedmerge-geo
// IndexedDB. Below: the review list — every distinct PLAC value still missing
// coordinates, with proposed matches. Nothing is written without review:
// checked rows are applied in one undoable batch; "no match" marks go to the
// decision cache only, never into the file.

const SHOW_LIMIT = 300;

/** The expanded-row mini map, in the Leaflet lazy chunk it shares with the
 *  Map chart — the list itself must not pull Leaflet into the main bundle. */
const MiniPlaceMap = lazy(() => import("../map/MiniPlaceMap"));

/** "lat, lon" free input → validated coordinate. */
function parseManualCoord(text: string): GeoCoord | undefined {
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(text);
  if (!m) return undefined;
  const lat = Number(m[1].replace(",", "."));
  const lon = Number(m[2].replace(",", "."));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return undefined;
  return { lat, lon };
}

interface Chosen {
  coord: GeoCoord;
  label: string;
}

type ImportState = { phase: "running"; done: number; total: number } | { phase: "error"; message: string } | null;

interface Props {
  dataset: Dataset;
  active: boolean;
  /** Write the accepted coordinates through the edit/undo pipeline; returns
   *  the number of records changed. */
  onApplyGeocode: (assignments: Map<string, GeoCoord>) => number;
  /** Rename all occurrences of exactly this raw place value (edit/undo
   *  pipeline); with `addr`, split into PLAC `to` + an ADDR on the parent
   *  event. Returns the number of records changed. */
  onRenamePlaceValue: (from: string, to: string, addr?: string) => number;
  /** Return to the Places tree (the panel hosting this view). */
  onBack: () => void;
}

/** Read a response body with byte progress (falls back to one shot). */
async function readWithProgress(
  res: Response,
  onProgress: (done: number, total: number) => void,
): Promise<ArrayBuffer> {
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.byteLength;
    onProgress(done, Math.max(total, done));
  }
  const out = new Uint8Array(done);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

/** Overpass (OpenStreetMap) endpoints — CORS-enabled, so the browser can
 *  fetch a country's places directly. geonames.org was tried first but sends
 *  no CORS headers and blocks the public relays' addresses, so the one-click
 *  path uses OSM; GeoNames stays available via the manual file import. */
const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];

/** Every place node in the country: settlements down to isolated dwellings. */
function overpassQuery(code: string): string {
  return `[out:json][timeout:180];area["ISO3166-1"="${code}"][admin_level=2]->.a;node(area.a)[place~"^(city|town|village|hamlet|suburb|locality|isolated_dwelling)$"];out qt;`;
}

export function GeocodePanel({ dataset, onApplyGeocode, onRenamePlaceValue, onBack }: Props) {
  const { t, i18n } = useTranslation();
  const { settings: appSettings } = useSettings();

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

  // ── Gazetteer (IndexedDB) ─────────────────────────────────────────────────
  const [countries, setCountries] = useState<CountryMeta[] | null>(null);
  const [index, setIndex] = useState<GazetteerIndex | undefined>(undefined);
  const [decisions, setDecisions] = useState<Map<string, GeocodeDecision> | null>(null);
  const [importState, setImportState] = useState<ImportState>(null);
  const workerRef = useRef<Worker | null>(null);

  const refreshGazetteer = async () => {
    const stored = await loadCountries();
    setCountries(stored.map(({ code, count, importedAt }) => ({ code, count, importedAt })).sort((a, b) => b.count - a.count));
    setIndex(stored.length ? buildGazetteerIndex(stored.flatMap((c) => c.entries)) : undefined);
  };

  useEffect(() => {
    void refreshGazetteer();
    void loadDecisions().then(setDecisions);
    return () => workerRef.current?.terminate();
  }, []);

  const runImport = (buffer: ArrayBuffer, fileName: string, extra?: { format: "overpass"; country: string }) => {
    setImportState({ phase: "running", done: 0, total: buffer.byteLength });
    const worker = new Worker(new URL("../../worker/geo.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (e: MessageEvent<GeoWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "progress") setImportState({ phase: "running", done: msg.done, total: msg.total });
      else if (msg.type === "result") {
        worker.terminate();
        workerRef.current = null;
        setImportState(null);
        void refreshGazetteer();
      } else {
        worker.terminate();
        workerRef.current = null;
        setImportState({ phase: "error", message: msg.message });
      }
    };
    const req: GeoWorkerRequest = { type: "importGazetteer", requestId: 1, buffer, fileName, ...extra };
    worker.postMessage(req, [buffer]);
  };

  const importFile = async (file: File) => {
    runImport(await file.arrayBuffer(), file.name);
  };

  // Direct download of a country's places — the download-then-pick round
  // trip is confusing, so fetch from Overpass (OpenStreetMap) here, gated
  // behind the same online-lookups opt-in as the other network features.
  const [countryDraft, setCountryDraft] = useState("");
  const fetchAbortRef = useRef<AbortController | null>(null);
  const downloadCountry = async () => {
    const code = countryDraft.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return;
    const abort = new AbortController();
    fetchAbortRef.current = abort;
    setImportState({ phase: "running", done: 0, total: 0 });
    const onProgress = (done: number, total: number) => setImportState({ phase: "running", done, total });
    try {
      let buffer: ArrayBuffer | undefined;
      for (const endpoint of OVERPASS_ENDPOINTS) {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            body: new URLSearchParams({ data: overpassQuery(code) }),
            signal: abort.signal,
          });
          if (res.ok) {
            buffer = await readWithProgress(res, onProgress);
            if (buffer.byteLength > 200) break;
            buffer = undefined;
          }
        } catch (e) {
          if (abort.signal.aborted) return;
          void e;
        }
      }
      if (!buffer) {
        setImportState({ phase: "error", message: t("tools.geocode.downloadFailed") });
        return;
      }
      runImport(buffer, `${code}.osm.json`, { format: "overpass", country: code });
    } finally {
      fetchAbortRef.current = null;
    }
  };

  const cancelImport = () => {
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    setImportState(null);
  };

  const removeCountry = async (code: string) => {
    await deleteCountry(code);
    void refreshGazetteer();
  };

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

  // Known addresses for the rename editor's address input autocomplete.
  const addrSug = useMemo(() => [...new Set(placeSug.addrCanonical.values())].sort(), [placeSug]);

  // Every coordinate the file already carries — the mini map's context dots.
  const fileCoords = useMemo(
    () => collectFileCoords(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, scanGen],
  );

  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Map<string, Chosen>>(new Map());
  const [noMatch, setNoMatch] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [manualDraft, setManualDraft] = useState<Map<string, string>>(new Map());
  // Inline rename of one row's raw place value (fix a typo so it matches).
  // The optional address draft splits the value into PLAC + ADDR on apply.
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameAddrDraft, setRenameAddrDraft] = useState("");
  const [lastApplied, setLastApplied] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim().toLowerCase());

  // A fresh scan re-seeds the review state from the cached decisions.
  useEffect(() => {
    if (!scan) return;
    setChecked(new Set(scan.rows.filter((r) => r.cached?.status === "accepted" && r.cached.lat !== undefined).map((r) => r.key)));
    setNoMatch(new Set(scan.rows.filter((r) => r.cached?.status === "nomatch").map((r) => r.key)));
    setChosen(new Map());
    setExpanded(new Set());
  }, [scan]);

  const chosenFor = (row: GeocodeRow): Chosen | undefined => {
    const override = chosen.get(row.key);
    if (override) return override;
    if (row.cached?.status === "accepted" && row.cached.lat !== undefined && row.cached.lon !== undefined)
      return { coord: { lat: row.cached.lat, lon: row.cached.lon }, label: row.cached.label ?? t("tools.geocode.cached") };
    // The file's own coordinate for this exact value beats any gazetteer
    // guess — same file, same spelling, already placed by someone.
    if (row.fileCoord) return { coord: row.fileCoord, label: t("tools.geocode.fromFile") };
    const best = row.candidates[0];
    return best ? { coord: { lat: best.entry.lat, lon: best.entry.lon }, label: best.entry.name } : undefined;
  };

  const toggleChecked = (key: string, on: boolean) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const pickCandidate = (row: GeocodeRow, c: GazCandidate) => {
    setChosen((prev) => new Map(prev).set(row.key, { coord: { lat: c.entry.lat, lon: c.entry.lon }, label: c.entry.name }));
    toggleChecked(row.key, true);
    setNoMatch((prev) => {
      const next = new Set(prev);
      next.delete(row.key);
      return next;
    });
  };

  const setManual = (row: GeocodeRow) => {
    const coord = parseManualCoord(manualDraft.get(row.key) ?? "");
    if (!coord) return;
    setChosen((prev) => new Map(prev).set(row.key, { coord, label: t("tools.geocode.manual") }));
    toggleChecked(row.key, true);
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
    const assignments = new Map<string, GeoCoord>();
    const toStore: GeocodeDecision[] = [];
    const now = Date.now();
    for (const row of scan.rows) {
      if (checked.has(row.key)) {
        const c = chosenFor(row);
        if (!c) continue;
        assignments.set(row.key, c.coord);
        toStore.push({ key: row.key, status: "accepted", lat: c.coord.lat, lon: c.coord.lon, label: c.label, ts: now });
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

  const rows = query ? scan.rows.filter((r) => r.key.toLowerCase().includes(query)) : scan.rows;
  const shown = rows.slice(0, SHOW_LIMIT);
  const confidentCount = scan.rows.filter((r) => r.confident && !checked.has(r.key) && !noMatch.has(r.key)).length;
  const dateFmt = new Intl.DateTimeFormat(i18n.language);

  return (
    <div className="tools-geocode">
      <div className="tools-filter-row">
        <BackButton label={t("tools.places.geocodeBack")} shortcutHint="Esc" showLabel onClick={onBack} />
        <p className="tools-summary">
          {[
            scan.rows.length > 0 && t("tools.geocode.coverage", { distinct: scan.rows.length }),
            lastApplied !== null && t("tools.geocode.applied", { count: lastApplied }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <p className="tools-intro">{t("tools.geocode.intro")}</p>

      <div className="tools-geo-gazetteer">
        {countries.length === 0 && <p className="tools-geo-empty">{t("tools.geocode.noGazetteer")}</p>}
        {countries.length > 0 && (
          <>
          <p className="tools-geo-loaded">{t("tools.geocode.loadedCountries")}</p>
          <ul className="tools-geo-countries">
            {countries.map((c) => (
              <li key={c.code}>
                <span className="tools-geo-country gm-data">{c.code}</span>
                <span className="tools-geo-count">{t("tools.geocode.countryMeta", { count: c.count, date: dateFmt.format(c.importedAt) })}</span>
                <button
                  className="tools-geo-delete"
                  onClick={() => void removeCountry(c.code)}
                  title={t("tools.geocode.deleteCountry")}
                  aria-label={t("tools.geocode.deleteCountry")}
                >
                  🗑
                </button>
              </li>
            ))}
          </ul>
          </>
        )}
        {importState?.phase === "running" ? (
          <ToolsLoading
            label={t("tools.geocode.importing")}
            progress={importState.total > 0 ? importState : undefined}
            onCancel={cancelImport}
          />
        ) : (
          <div className="tools-geo-acquire">
            {appSettings.allowLinkFetch && (
              <span className="tools-geo-download">
                <input
                  type="text"
                  maxLength={2}
                  placeholder={t("tools.geocode.countryCodePlaceholder")}
                  title={t("tools.geocode.countryCodeTooltip")}
                  value={countryDraft}
                  onChange={(e) => setCountryDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void downloadCountry();
                  }}
                />
                <button
                  className="nav-btn tools-run"
                  onClick={() => void downloadCountry()}
                  disabled={!/^[A-Za-z]{2}$/.test(countryDraft.trim())}
                >
                  {t("tools.geocode.downloadBtn")}
                </button>
              </span>
            )}
            <label className="nav-btn tools-geo-import">
              {t("tools.geocode.importBtn")}
              <input
                type="file"
                accept=".txt,.zip"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void importFile(file);
                }}
              />
            </label>
          </div>
        )}
        {importState?.phase === "error" && <ToolsError message={importState.message} />}
        <p className="tools-geo-hint">
          {t("tools.geocode.importHint")}{" "}
          <a href="https://download.geonames.org/export/dump/" target="_blank" rel="noreferrer">
            download.geonames.org/export/dump
          </a>{" "}
          {t("tools.geocode.importHint2")}
          {!appSettings.allowLinkFetch && ` ${t("tools.geocode.downloadNeedsOptIn")}`}
        </p>
      </div>

      {scan.rows.length === 0 && <p className="tools-clean tools-clean--ok">{t("tools.geocode.allCovered")}</p>}

      {scan.rows.length > 0 && (
      <section className="tools-cleanup-section">
        <div className="tools-dup-kind-head">
          {t("tools.geocode.heading")}
          <span className="tools-chip-count">{scan.rows.length}</span>
          <div className="tools-dup-bulk">
            <button className="tools-issue-link" onClick={selectConfident} disabled={confidentCount === 0}>
              {t("tools.geocode.selectConfident", { count: confidentCount })}
            </button>
            <button className="tools-issue-link" onClick={() => setChecked(new Set())}>
              {t("tools.sources.dupSelectNone")}
            </button>
            <button className="tools-issue-link" onClick={() => setExpanded(new Set(rows.map((r) => r.key)))}>
              {t("tools.sources.expandAll")}
            </button>
            <button className="tools-issue-link" onClick={() => setExpanded(new Set())}>
              {t("tools.sources.collapseAll")}
            </button>
          </div>
        </div>
        <div className="tools-reshape-options">
          <TreeSearch value={search} onChange={setSearch} />
          <button className="nav-btn tools-run" onClick={() => void apply()} disabled={checked.size === 0 && noMatch.size === 0}>
            {t("tools.geocode.apply", { count: checked.size })}
          </button>
        </div>

      <ul className="tools-tree">
        {shown.map((row) => {
          const c = chosenFor(row);
          const isOpen = expanded.has(row.key);
          const marked = noMatch.has(row.key);
          // A remembered (cached) acceptance is shown with its original origin
          // badge — file coordinate or gazetteer score — and only the tooltip
          // says it came from a previous session; the plain "remembered" badge
          // remains for decisions with no recognizable origin (e.g. manual).
          const cachedCoord =
            row.cached?.status === "accepted" && row.cached.lat !== undefined && row.cached.lon !== undefined
              ? { lat: row.cached.lat, lon: row.cached.lon }
              : undefined;
          const cachedIsFile = !!cachedCoord && row.fileCoord?.lat === cachedCoord.lat && row.fileCoord?.lon === cachedCoord.lon;
          const cachedCand = cachedCoord
            ? row.candidates.find((cand) => cand.entry.lat === cachedCoord.lat && cand.entry.lon === cachedCoord.lon)
            : undefined;
          // Rename every occurrence of exactly this raw value, then rescan —
          // the corrected spelling gets fresh gazetteer proposals (or merges
          // into an already-covered row and drops off the list).
          const applyRename = () => {
            const target = renameDraft.trim();
            const addrTarget = renameAddrDraft.trim();
            if (!target || (target === row.key && !addrTarget)) return;
            setLastApplied(onRenamePlaceValue(row.key, target, addrTarget || undefined));
            setRenameKey(null);
            setScanGen((g) => g + 1);
          };
          const renameDisabled = !renameDraft.trim() || (renameDraft.trim() === row.key && !renameAddrDraft.trim());
          const toggleOpen = () =>
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(row.key)) next.delete(row.key);
              else next.add(row.key);
              return next;
            });
          return (
            <li key={row.key} className="tools-tree-node">
              <div className="tools-tree-row">
                <input
                  type="checkbox"
                  className="tools-dup-check"
                  checked={checked.has(row.key)}
                  disabled={!c || marked}
                  onChange={(e) => toggleChecked(row.key, e.target.checked)}
                />
                <button className={`tools-pair-toggle ${isOpen ? "open" : ""}`} onClick={toggleOpen} aria-expanded={isOpen}>
                  ▶
                </button>
                <span
                  className={`tools-tree-label clickable${marked ? " tools-reshape-removed" : ""}`}
                  onClick={toggleOpen}
                >
                  {row.key}
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
                ) : cachedCoord && !chosen.has(row.key) ? (
                  cachedIsFile ? (
                    <span className="tools-reshape-badge new" title={`${t("tools.geocode.fromFileTooltip")} · ${t("tools.geocode.cachedTooltip")}`}>
                      {t("tools.geocode.fromFile")}
                    </span>
                  ) : cachedCand ? (
                    <span className={`tools-geo-score${row.confident ? " confident" : ""}`} title={t("tools.geocode.cachedTooltip")}>
                      {Math.round(cachedCand.score * 100)}%
                    </span>
                  ) : (
                    <span className="tools-reshape-badge reuse" title={t("tools.geocode.cachedTooltip")}>
                      {t("tools.geocode.cached")}
                    </span>
                  )
                ) : row.fileCoord && !chosen.has(row.key) ? (
                  <span className="tools-reshape-badge new" title={t("tools.geocode.fromFileTooltip")}>
                    {t("tools.geocode.fromFile")}
                  </span>
                ) : row.candidates[0] && !chosen.has(row.key) ? (
                  <span className={`tools-geo-score${row.confident ? " confident" : ""}`}>
                    {Math.round(row.candidates[0].score * 100)}%
                  </span>
                ) : !c ? (
                  <span className="tools-tree-meta">{t("tools.geocode.noCandidate")}</span>
                ) : null}
                <button
                  className="tools-issue-link"
                  onClick={() => toggleNoMatch(row.key)}
                  aria-pressed={marked}
                  title={marked ? t("tools.geocode.noMatchUndo") : t("tools.geocode.noMatch")}
                >
                  {marked ? "↩" : "🗑"}
                </button>
                <span className="tools-chip-count">{row.missing}</span>
              </div>
              {renameKey === row.key && (
                <div
                  className="tools-place-rename"
                  onKeyDown={(e) => {
                    // Enter with a highlighted suggestion is consumed by the
                    // autocomplete (defaultPrevented); a second Enter applies.
                    if (e.key === "Enter" && !e.defaultPrevented) applyRename();
                    if (e.key === "Escape") setRenameKey(null);
                  }}
                >
                  <PlaceAutocomplete
                    value={renameDraft}
                    suggestions={placeSug.placeSuggestions}
                    canonical={placeSug.placeCanonical}
                    isDirty={false}
                    className="tools-place-rename-input"
                    wrapClassName="tools-place-rename-auto"
                    placeholder={t("tools.places.rename.placeholder")}
                    autoFocus
                    onChange={setRenameDraft}
                    onCommit={setRenameDraft}
                    onClear={() => setRenameDraft("")}
                  />
                  <PlaceAutocomplete
                    value={renameAddrDraft}
                    suggestions={addrSug}
                    canonical={placeSug.addrCanonical}
                    isDirty={false}
                    className="tools-place-rename-input"
                    wrapClassName="tools-place-rename-auto"
                    placeholder={t("tools.geocode.renameAddrPlaceholder")}
                    title={t("tools.geocode.renameAddrTooltip")}
                    onChange={setRenameAddrDraft}
                    onCommit={setRenameAddrDraft}
                    onClear={() => setRenameAddrDraft("")}
                  />
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
                    // Candidate pins (click = pick), the chosen coordinate
                    // highlighted, plus a live pin for a parseable manual draft.
                    const pins: MiniMapPin[] = row.candidates.map((cand) => ({
                      coord: { lat: cand.entry.lat, lon: cand.entry.lon },
                      label: `${cand.entry.name} · ${Math.round(cand.score * 100)}%`,
                      kind:
                        c && c.coord.lat === cand.entry.lat && c.coord.lon === cand.entry.lon
                          ? ("chosen" as const)
                          : ("candidate" as const),
                      onPick: () => pickCandidate(row, cand),
                    }));
                    if (c && !pins.some((p) => p.coord.lat === c.coord.lat && p.coord.lon === c.coord.lon))
                      pins.push({ coord: c.coord, label: c.label, kind: "chosen" });
                    const draftCoord = parseManualCoord(manualDraft.get(row.key) ?? "");
                    if (draftCoord && !pins.some((p) => p.coord.lat === draftCoord.lat && p.coord.lon === draftCoord.lon))
                      pins.push({ coord: draftCoord, label: t("tools.geocode.manual"), kind: "chosen" });
                    if (!pins.length && !fileCoords.length) return null;
                    return (
                      <Suspense fallback={<div className="tools-geo-minimap" />}>
                        <MiniPlaceMap
                          pins={pins}
                          context={fileCoords}
                          title={t("tools.geocode.mapPickHint")}
                          onPickCoord={(coord) => {
                            // A background click is a hand-picked coordinate:
                            // fill the manual field and select it, like "Use".
                            setManualDraft((prev) => new Map(prev).set(row.key, `${coord.lat}, ${coord.lon}`));
                            setChosen((prev) => new Map(prev).set(row.key, { coord, label: t("tools.geocode.manual") }));
                            toggleChecked(row.key, true);
                            setNoMatch((prev) => {
                              const next = new Set(prev);
                              next.delete(row.key);
                              return next;
                            });
                          }}
                        />
                      </Suspense>
                    );
                  })()}
                  {row.candidates.length > 0 && (
                    <ul className="tools-geo-candidates">
                      {row.candidates.map((cand, i) => (
                        <li key={i}>
                          <label>
                            <input
                              type="radio"
                              name={`geo-${row.key}`}
                              checked={c?.coord.lat === cand.entry.lat && c?.coord.lon === cand.entry.lon}
                              onChange={() => pickCandidate(row, cand)}
                            />
                            <span className="tools-geo-cand-name">{cand.entry.name}</span>
                            <span className="gm-data">
                              {cand.entry.country}
                              {cand.entry.population > 0 && ` · ${t("tools.geocode.population", { count: cand.entry.population })}`}
                              {` · ${cand.entry.lat.toFixed(4)}, ${cand.entry.lon.toFixed(4)}`}
                            </span>
                            <span className="tools-geo-score">{Math.round(cand.score * 100)}%</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="tools-geo-manual">
                    <input
                      type="text"
                      placeholder={t("tools.geocode.manualPlaceholder")}
                      title={t("tools.geocode.manualTooltip")}
                      value={manualDraft.get(row.key) ?? ""}
                      onChange={(e) => setManualDraft((prev) => new Map(prev).set(row.key, e.target.value))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") setManual(row);
                      }}
                    />
                    <button
                      className="nav-btn"
                      onClick={() => setManual(row)}
                      disabled={!parseManualCoord(manualDraft.get(row.key) ?? "")}
                    >
                      {t("tools.geocode.manualSet")}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length > SHOW_LIMIT && <p className="tools-geo-more">{t("tools.geocode.more", { count: rows.length - SHOW_LIMIT })}</p>}
      </section>
      )}
    </div>
  );
}

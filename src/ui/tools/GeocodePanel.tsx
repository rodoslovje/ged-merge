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
import { PersonLink } from "../PersonLink";
import { createKinshipResolver, lineageClass } from "../../match/kinship";
import { PlaceAutocomplete } from "../edit/PlaceAutocomplete";
import { buildPlaceSuggestions, placeCombosOf } from "../edit/placeSuggestions";
import { BackButton } from "../BackButton";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { useNameOf, useSettings } from "../SettingsContext";

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
  /** Jump to a person in Edit mode (the expanded row's people list). */
  onNavigate: (id: string) => void;
  /** The app-wide start person, for kinship labels in the people list. */
  startId?: string;
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

export function GeocodePanel({ dataset, onApplyGeocode, onRenamePlaceValue, onBack, onNavigate, startId }: Props) {
  const { t, i18n } = useTranslation();
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

  // Place+address combos for the rename input — one box searches both, and
  // picking a combo queues the address part as the split's ADDR (shown as a
  // removable chip next to the input).
  const placeCombos = useMemo(() => placeCombosOf(placeSug.placeToAddrs, placeSug.placeCanonical), [placeSug]);

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
  const [chosen, setChosen] = useState<Map<string, Chosen>>(new Map());
  const [noMatch, setNoMatch] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The one row whose mini map is mounted — a Leaflet instance per expanded
  // row is too heavy under "Expand all", so the map follows the row the user
  // last opened (other expanded rows offer a "show on map" link to claim it).
  const [mapKey, setMapKey] = useState<string | null>(null);
  const [manualDraft, setManualDraft] = useState<Map<string, string>>(new Map());
  // Inline rename of one row's raw place value (fix a typo so it matches).
  // The optional address draft splits the value into PLAC + ADDR on apply.
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameAddrDraft, setRenameAddrDraft] = useState("");
  const [lastApplied, setLastApplied] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const query = useDebounced(search.trim().toLowerCase());

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
    setManualDraft((prev) => new Map([...prev].filter(([k]) => keys.has(k))));
    setExpanded((prev) => new Set([...prev].filter((k) => keys.has(k))));
    setMapKey((prev) => (prev && keys.has(prev) ? prev : null));
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

  /** Choose a coordinate for the row: remember it, check the row, and drop
   *  a no-match mark — shared by every option (candidate, file, cached). */
  const pickCoord = (row: GeocodeRow, coord: GeoCoord, label: string) => {
    setChosen((prev) => new Map(prev).set(row.key, { coord, label }));
    toggleChecked(row.key, true);
    setNoMatch((prev) => {
      const next = new Set(prev);
      next.delete(row.key);
      return next;
    });
  };

  const pickCandidate = (row: GeocodeRow, c: GazCandidate) =>
    pickCoord(row, { lat: c.entry.lat, lon: c.entry.lon }, c.entry.name);

  const setManual = (row: GeocodeRow) => {
    const coord = parseManualCoord(manualDraft.get(row.key) ?? "");
    if (coord) pickCoord(row, coord, t("tools.geocode.manual"));
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
            <button
              className="tools-issue-link"
              onClick={() => {
                setExpanded(new Set());
                setMapKey(null);
              }}
            >
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
          // The manual coordinate as a selectable option: parsed draft (typed
          // or map-picked), checked when it is the row's chosen coordinate.
          const draftCoord = parseManualCoord(manualDraft.get(row.key) ?? "");
          const manualChosen = !!c && !!draftCoord && c.coord.lat === draftCoord.lat && c.coord.lon === draftCoord.lon;
          const toggleOpen = () => {
            const willOpen = !expanded.has(row.key);
            setExpanded((prev) => {
              const next = new Set(prev);
              if (willOpen) next.add(row.key);
              else next.delete(row.key);
              return next;
            });
            // The map follows the row being opened; closing it frees the map.
            if (willOpen) setMapKey(row.key);
            else if (mapKey === row.key) setMapKey(null);
          };
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
                    <span
                      className={`tools-geo-score${row.confident || checked.has(row.key) ? " confident" : ""}`}
                      title={t("tools.geocode.cachedTooltip")}
                    >
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
                  // Green when confident — or hand-selected for writing: a
                  // checked row's badge should read as "going in" too.
                  <span className={`tools-geo-score${row.confident || checked.has(row.key) ? " confident" : ""}`}>
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
                <span className="tools-chip-count" title={missingInTitles.get(row.key)}>{row.missing}</span>
              </div>
              {renameKey === row.key && (
                <div
                  className="tools-place-rename"
                  onKeyDown={(e) => {
                    // Enter with a highlighted suggestion, and Escape with an
                    // open dropdown, are consumed by the autocomplete
                    // (defaultPrevented); the next press reaches the editor.
                    if (e.key === "Enter" && !e.defaultPrevented) applyRename();
                    if (e.key === "Escape" && !e.defaultPrevented) setRenameKey(null);
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
                  {renameAddrDraft && (
                    <span className="tools-geo-addr-chip" title={t("tools.geocode.renameAddrTooltip")}>
                      {t("event.colAddr")}: {renameAddrDraft}
                      <button
                        className="tools-geo-addr-chip-clear"
                        onClick={() => setRenameAddrDraft("")}
                        aria-label={t("tools.places.rename.cancel")}
                      >
                        ×
                      </button>
                    </span>
                  )}
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
                    if (!row.candidates.length && !c && !draftCoord && !fileCoords.length) return null;
                    if (mapKey !== row.key)
                      return (
                        <button className="tools-issue-link tools-geo-showmap" onClick={() => setMapKey(row.key)}>
                          {t("tools.geocode.showMap")}
                        </button>
                      );
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
                    if (draftCoord && !pins.some((p) => p.coord.lat === draftCoord.lat && p.coord.lon === draftCoord.lon))
                      pins.push({ coord: draftCoord, label: t("tools.geocode.manual"), kind: "chosen" });
                    return (
                      <Suspense fallback={<div className="tools-geo-minimap" />}>
                        <MiniPlaceMap
                          pins={pins}
                          context={fileCoords}
                          title={t("tools.geocode.mapPickHint")}
                          onPickCoord={(coord) => {
                            // A background click is a hand-picked coordinate:
                            // fill the manual field and select it.
                            setManualDraft((prev) => new Map(prev).set(row.key, `${coord.lat}, ${coord.lon}`));
                            pickCoord(row, coord, t("tools.geocode.manual"));
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
                            checked={c?.coord.lat === row.fileCoord.lat && c?.coord.lon === row.fileCoord.lon}
                            onChange={() => pickCoord(row, row.fileCoord!, t("tools.geocode.fromFile"))}
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
                              checked={c?.coord.lat === cachedCoord.lat && c?.coord.lon === cachedCoord.lon}
                              onChange={() => pickCoord(row, cachedCoord, row.cached?.label ?? t("tools.geocode.cached"))}
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
                            checked={c?.coord.lat === cand.entry.lat && c?.coord.lon === cand.entry.lon}
                            onChange={() => pickCandidate(row, cand)}
                          />
                          <span className="gm-data">{cand.entry.country}</span>
                          <span className="tools-geo-cand-name">{cand.entry.name}</span>
                          <span className="gm-data">
                            {cand.entry.population > 0 && `· ${t("tools.geocode.population", { count: cand.entry.population })} · `}
                            {`${cand.entry.lat.toFixed(4)}, ${cand.entry.lon.toFixed(4)}`}
                          </span>
                          <span className="tools-geo-score">{Math.round(cand.score * 100)}%</span>
                        </label>
                      </li>
                    ))}
                    {/* Manual entry as the last option — the same radio group,
                        selectable once the draft (typed or map-picked) parses. */}
                    <li className="tools-geo-manual">
                      <label>
                        <input
                          type="radio"
                          name={`geo-${row.key}`}
                          checked={manualChosen}
                          disabled={!draftCoord}
                          onChange={() => setManual(row)}
                        />
                        <span className="tools-geo-cand-name">{t("tools.geocode.manual")}</span>
                      </label>
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
                          {indi && (
                            <span
                              className="tools-chip-count"
                              title={placeEventsTitle || t("tools.geocode.eventCount", { count: indi.events.length })}
                            >
                              {indi.events.length}
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
        })}
      </ul>
      {rows.length > SHOW_LIMIT && <p className="tools-geo-more">{t("tools.geocode.more", { count: rows.length - SHOW_LIMIT })}</p>}
      </section>
      )}
    </div>
  );
}

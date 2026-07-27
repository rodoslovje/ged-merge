import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GeoCoord } from "../../gedcom/types";
import { buildGazetteerIndex, type GazetteerIndex } from "../../geo/gazetteer";
import {
  chosenCoordFor,
  collectFileCoords,
  scanGeocode,
  type ChosenCoord,
  type GeoAssignment,
  type GeocodeRow,
} from "../../tools/geocode";
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
import { createKinshipResolver } from "../../match/kinship";
import { buildPlaceSuggestions, placeCombosOf } from "../edit/placeSuggestions";
import { AddressCoordsSection } from "./AddressCoordsSection";
import { CoordConflicts } from "./CoordConflicts";
import { GeocodePlaceRow } from "./GeocodePlaceRow";
import { BackButton } from "../BackButton";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { useNameOf, useSettings } from "../SettingsContext";

// The "Geocode places" tool (MAPVIEW.md phase 2). Top: the offline gazetteer
// manager — imported GeoNames country extracts living in the gedmerge-geo
// IndexedDB. Below: the review list — every distinct PLAC value still missing
// coordinates, with proposed matches (one GeocodePlaceRow each). Nothing is
// written without review: checked rows are applied in one undoable batch;
// "no match" marks go to the decision cache only, never into the file.

const SHOW_LIMIT = 300;

type ImportState = { phase: "running"; done: number; total: number } | { phase: "error"; message: string } | null;

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
  onMovePlaceForAddresses: (keys: Set<string>, toPlace: string) => number;
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

/** Read a response body with byte progress (falls back to one shot). `total` is
 *  0 when the server announced no Content-Length — chunked transfer, which both
 *  Overpass and the GURS endpoint use — and the caller shows bytes instead of a
 *  percentage in that case. */
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
    onProgress(done, total);
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

/** GURS RPE settlements ("naselja") — the authoritative Slovenian register,
 *  served as GeoJSON in WGS84 with CORS open, so the browser fetches it
 *  directly. All 6035 settlements come in one response (the service ignores
 *  `properties=`, so the ~45 MB of polygons is unavoidable); the worker keeps
 *  only each polygon's centroid. Data © Geodetska uprava RS, CC BY 4.0. */
const GURS_NASELJA_URL =
  "https://ipi.eprostor.gov.si/wfs-si-gurs-rpe/ogc/features/collections/SI.GURS.RPE:NASELJA/items?f=application%2Fgeo%2Bjson&limit=10000";

/** RPE municipalities — the id→name table the settlements join to, so a
 *  candidate can name its občina. Small next to the settlements (212 rows). */
const GURS_OBCINE_URL =
  "https://ipi.eprostor.gov.si/wfs-si-gurs-rpe/ogc/features/collections/SI.GURS.RPE:OBCINE/items?f=application%2Fgeo%2Bjson&limit=1000";

/** Every place node in the country: settlements down to isolated dwellings. */
function overpassQuery(code: string): string {
  return `[out:json][timeout:180];area["ISO3166-1"="${code}"][admin_level=2]->.a;node(area.a)[place~"^(city|town|village|hamlet|suburb|locality|isolated_dwelling)$"];out qt;`;
}

export function GeocodePanel({ dataset, onApplyGeocode, onApplyAddressCoords, onRenamePlaceValue, onMovePlaceForAddresses, onBack, onNavigate, startId }: Props) {
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
  // The gazetteer manager is one-time setup that outlives the file — it lives in
  // IndexedDB, so it survives reloads and file switches — and folds away once
  // something is loaded. It stays open when there is nothing loaded (it is the
  // empty state, and the list below cannot work without it) and while an import
  // runs or fails, since the progress and the error live inside it.
  const [gazOpenPref, setGazOpen] = useState(false);
  const gazOpen = gazOpenPref || countries?.length === 0 || importState !== null;
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

  const runImport = (
    buffer: ArrayBuffer,
    fileName: string,
    extra?: { format: "overpass"; country: string } | { format: "rpe"; obcine?: ArrayBuffer },
  ) => {
    // Only the GeoNames dump path reports parse progress by chunk; the Overpass
    // and GURS payloads are converted in one shot, so leave their total at 0 and
    // show a bare spinner rather than a 0 % that never moves.
    setImportState({ phase: "running", done: 0, total: extra ? 0 : buffer.byteLength });
    const worker = new Worker(new URL("../../worker/geo.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    const fail = (message: string) => {
      worker.terminate();
      workerRef.current = null;
      setImportState({ phase: "error", message });
    };
    worker.onmessage = (e: MessageEvent<GeoWorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "progress") setImportState({ phase: "running", done: msg.done, total: msg.total });
      else if (msg.type === "result") {
        worker.terminate();
        workerRef.current = null;
        setImportState(null);
        void refreshGazetteer();
      } else fail(msg.message);
    };
    // A worker that fails to load or throws outside the message handler would
    // otherwise leave the import spinner running forever — surface it instead.
    worker.onerror = () => fail(t("tools.geocode.importFailed"));
    worker.onmessageerror = () => fail(t("tools.geocode.importFailed"));
    const req: GeoWorkerRequest = { type: "importGazetteer", requestId: 1, buffer, fileName, ...extra };
    worker.postMessage(req, req.obcine ? [buffer, req.obcine] : [buffer]);
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

  // One-click Slovenian gazetteer from GURS. Same opt-in gate and progress
  // handling as the Overpass download, but a single known endpoint — a failure
  // here is a real outage, so there is no fallback list to walk.
  const downloadSlovenia = async () => {
    const abort = new AbortController();
    fetchAbortRef.current = abort;
    setImportState({ phase: "running", done: 0, total: 0 });
    try {
      const res = await fetch(GURS_NASELJA_URL, { signal: abort.signal });
      if (!res.ok) {
        setImportState({ phase: "error", message: t("tools.geocode.downloadFailed") });
        return;
      }
      const buffer = await readWithProgress(res, (done, total) => setImportState({ phase: "running", done, total }));
      // The municipalities are a separate collection (212 rows) joined by
      // EID_OBCINA — what lets two settlements of one name be told apart
      // ("Soteska (Kamnik)" vs "Soteska (Dolenjske Toplice)"). Failing to get
      // it is not fatal: the settlements are still worth importing without it.
      let obcine: ArrayBuffer | undefined;
      try {
        const oRes = await fetch(GURS_OBCINE_URL, { signal: abort.signal });
        if (oRes.ok) obcine = await oRes.arrayBuffer();
      } catch (e) {
        if (abort.signal.aborted) return;
        void e;
      }
      runImport(buffer, "SI.gurs-naselja.json", { format: "rpe", ...(obcine ? { obcine } : {}) });
    } catch (e) {
      if (abort.signal.aborted) return;
      void e;
      setImportState({ phase: "error", message: t("tools.geocode.downloadFailed") });
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
  const [chosen, setChosen] = useState<Map<string, ChosenCoord>>(new Map());
  const [noMatch, setNoMatch] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The one row whose mini map is mounted — a Leaflet instance per expanded
  // row is too heavy under "Expand all", so the map follows the row the user
  // last opened (other expanded rows offer a "show on map" link to claim it).
  const [mapKey, setMapKey] = useState<string | null>(null);
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

  const toggleOpen = (key: string) => {
    const willOpen = !expanded.has(key);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(key);
      else next.delete(key);
      return next;
    });
    // The map follows the row being opened; closing it frees the map.
    if (willOpen) setMapKey(key);
    else if (mapKey === key) setMapKey(null);
  };

  const renameValue = (from: string, to: string, addr?: string) => {
    setLastApplied(onRenamePlaceValue(from, to, addr));
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
          <div className="tools-geo-summary">
            <button
              className={`tools-pair-toggle ${gazOpen ? "open" : ""}`}
              aria-expanded={gazOpen}
              onClick={() => setGazOpen(!gazOpen)}
            >
              ▶
            </button>
            <span className="tools-geo-loaded clickable" onClick={() => setGazOpen(!gazOpen)}>
              {t("tools.geocode.loadedCountries")}
            </span>
            {/* Collapsed, the heading carries the answer itself — which
                gazetteers are in and how big — so the one-time setup takes one
                line while still saying what the rankings below can draw on. */}
            {!gazOpen &&
              countries.map((c) => (
                <span key={c.code} className="tools-geo-summary-entry">
                  <span className="tools-geo-country gm-data">{c.code}</span>
                  <span className="tools-geo-count">{c.count.toLocaleString(i18n.language)}</span>
                </span>
              ))}
          </div>
        )}
        {gazOpen && (
          <>
          {countries.length > 0 && (
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
          )}
          {importState?.phase === "running" ? (
          <ToolsLoading
            label={t("tools.geocode.importing")}
            progress={importState}
            bytes
            onCancel={cancelImport}
          />
        ) : (
          <div className="tools-geo-acquire">
            {appSettings.allowLinkFetch && (
              <>
                <button
                  className="nav-btn tools-run"
                  onClick={() => void downloadSlovenia()}
                  title={t("tools.geocode.gursTooltip")}
                >
                  {t("tools.geocode.gursBtn")}
                </button>
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
              </>
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
          {t("tools.geocode.importHint2")}{" "}
          {t("tools.geocode.gursCredit")}{" "}
          <a href="https://www.e-prostor.gov.si/dostopi/javni-dostop/" target="_blank" rel="noreferrer">
            e-prostor.gov.si
          </a>
          {!appSettings.allowLinkFetch && ` ${t("tools.geocode.downloadNeedsOptIn")}`}
        </p>
          </>
        )}
      </div>

      {/* Above the lists, below the gazetteer: it is the only outright error on
          the page — coordinates that contradict each other, which no lookup
          below can resolve — but it is a finding, not part of the setup. */}
      <CoordConflicts dataset={dataset} onApply={onApplyAddressCoords} />

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
            onClaimMap={setMapKey}
            onPickCoord={pickCoord}
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
      <AddressCoordsSection dataset={dataset} onApply={onApplyAddressCoords} onMove={onMovePlaceForAddresses} />
    </div>
  );
}

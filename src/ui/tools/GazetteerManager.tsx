import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { COUNTRY_CODES } from "../../gedcom/countryCode";
import { buildGazetteerIndex, type GazetteerIndex } from "../../geo/gazetteer";
import { deleteCountry, loadCountries, type CountryMeta } from "../../persist/geoDb";
import type { GeoWorkerRequest, GeoWorkerResponse } from "../../worker/geoMessages";
import { invalidateGazetteerIndex } from "../edit/PlaceLookupContext";
import { useSettings } from "../SettingsContext";
import { ToolsError, ToolsLoading } from "./shared";

// The place-directory manager: the offline gazetteers (GeoNames country extracts,
// OpenStreetMap downloads, the GURS register of Slovenian settlements) that live
// in the gedmerge-geo IndexedDB and back every place lookup in the app.
//
// It is one-time setup that outlives the file, so Settings → Map owns it. The
// Geocode places tool keeps the same controls for as long as there is nothing
// loaded — that is where a researcher first learns they need a directory, and
// sending them elsewhere at that moment would be a dead end — and shrinks to a
// one-line summary once there is.

type ImportState =
  | { phase: "running"; done: number; total: number }
  | { phase: "error"; message: string }
  | null;

/** Overpass (OpenStreetMap) endpoints — CORS-enabled, so the browser can
 *  fetch a country's places directly. geonames.org was tried first but sends
 *  no CORS headers and blocks the public relays' addresses, so the one-click
 *  path uses OSM; GeoNames stays available via the manual file import. */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

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

/** Every mounted manager, so an import made in Settings is reflected in the
 *  Geocode tool underneath it (and the other way round) without a reload. */
const listeners = new Set<() => void>();

/** What {@link useGazetteer} hands its controls — and, in the Geocode tool, the
 *  built index the whole review list is scored against. */
export interface Gazetteer {
  /** Null until IndexedDB has answered; empty array = nothing imported yet. */
  countries: CountryMeta[] | null;
  /** The searchable index, built only where it is used (`withIndex`). */
  index: GazetteerIndex | undefined;
  importState: ImportState;
  countryDraft: string;
  setCountryDraft: (code: string) => void;
  importFile: (file: File) => Promise<void>;
  downloadCountry: () => Promise<void>;
  downloadSlovenia: () => Promise<void>;
  cancelImport: () => void;
  removeCountry: (code: string) => Promise<void>;
}

/**
 * The gazetteer store: what is imported, and every way to change it. Held by the
 * two hosts separately — `withIndex` because only the Geocode tool searches the
 * entries, and building that index over a country's places is not work Settings
 * should do to show a list of two lines.
 */
export function useGazetteer({ withIndex = false }: { withIndex?: boolean } = {}): Gazetteer {
  const { t } = useTranslation();
  const [countries, setCountries] = useState<CountryMeta[] | null>(null);
  const [index, setIndex] = useState<GazetteerIndex | undefined>(undefined);
  const [importState, setImportState] = useState<ImportState>(null);
  const [countryDraft, setCountryDraft] = useState("");
  const workerRef = useRef<Worker | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);

  const reload = async () => {
    const stored = await loadCountries();
    setCountries(
      stored.map(({ code, count, importedAt }) => ({ code, count, importedAt })).sort((a, b) => b.count - a.count),
    );
    if (withIndex) setIndex(stored.length ? buildGazetteerIndex(stored.flatMap((c) => c.entries)) : undefined);
  };

  const refreshGazetteer = async () => {
    // The Edit view's lookup keeps its own index for the whole session, so an
    // import or removal here has to drop it — otherwise the place fields answer
    // from the gazetteer this manager has just replaced.
    invalidateGazetteerIndex();
    await reload();
    for (const listener of listeners) listener();
  };

  useEffect(() => {
    void reload();
    const listener = () => void reload();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      workerRef.current?.terminate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    await refreshGazetteer();
  };

  return {
    countries,
    index,
    importState,
    countryDraft,
    setCountryDraft,
    importFile,
    downloadCountry,
    downloadSlovenia,
    cancelImport,
    removeCountry,
  };
}

/** What is imported, with the date and a way to drop it again. */
function GazetteerList({ gaz }: { gaz: Gazetteer }) {
  const { t, i18n } = useTranslation();
  const dateFmt = new Intl.DateTimeFormat(i18n.language);
  if (!gaz.countries?.length) return null;
  return (
    <ul className="tools-geo-countries">
      {gaz.countries.map((c) => (
        <li key={c.code}>
          <span className="tools-geo-country gm-data">{c.code}</span>
          <span className="tools-geo-count">
            {t("tools.geocode.countryMeta", { count: c.count, date: dateFmt.format(c.importedAt) })}
          </span>
          <button
            className="tools-geo-delete"
            onClick={() => void gaz.removeCountry(c.code)}
            title={t("tools.geocode.deleteCountry")}
            aria-label={t("tools.geocode.deleteCountry")}
          >
            🗑
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The three ways in: the GURS register, any country from OpenStreetMap, or a
 *  GeoNames file. The two downloads need the online-lookups opt-in; the file
 *  import never does. */
function GazetteerAcquire({ gaz }: { gaz: Gazetteer }) {
  const { t, i18n } = useTranslation();
  const { settings } = useSettings();
  // The picker replaces a two-letter code box: nobody should have to know that
  // Croatia is HR. Names come from the browser in the reader's own language, and
  // fall back to the code itself where it has none.
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames([i18n.language], { type: "region" });
    return COUNTRY_CODES.map((code) => ({ code, name: names.of(code) ?? code })).sort((a, b) =>
      a.name.localeCompare(b.name, i18n.language),
    );
  }, [i18n.language]);
  if (gaz.importState?.phase === "running") {
    return (
      <ToolsLoading
        label={t("tools.geocode.importing")}
        progress={gaz.importState}
        bytes
        onCancel={gaz.cancelImport}
      />
    );
  }
  return (
    // Three independent ways in, one per row: they are alternatives, not a
    // sequence, and a wrapped row read as though the country picker belonged to
    // whichever button happened to land beside it.
    <div className="tools-geo-acquire">
      {settings.allowLinkFetch && (
        <>
          <div className="tools-geo-option">
            <button
              className="nav-btn tools-run"
              onClick={() => void gaz.downloadSlovenia()}
              title={t("tools.geocode.gursTooltip")}
            >
              {t("tools.geocode.gursBtn")}
            </button>
          </div>
          <div className="tools-geo-option">
            <select
              className="tools-geo-country-select"
              title={t("tools.geocode.countryTooltip")}
              value={gaz.countryDraft}
              onChange={(e) => gaz.setCountryDraft(e.target.value)}
            >
              <option value="">{t("tools.geocode.countryPick")}</option>
              {countries.map(({ code, name }) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
            <button
              className="nav-btn tools-run"
              onClick={() => void gaz.downloadCountry()}
              disabled={!/^[A-Za-z]{2}$/.test(gaz.countryDraft.trim())}
            >
              {t("tools.geocode.downloadBtn")}
            </button>
          </div>
        </>
      )}
      <div className="tools-geo-option">
        <label className="nav-btn tools-geo-import">
          {t("tools.geocode.importBtn")}
          <input
            type="file"
            accept=".txt,.zip"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void gaz.importFile(file);
            }}
          />
        </label>
      </div>
    </div>
  );
}

/** Where the data comes from and what it costs — sources, licences, and the
 *  opt-in the two downloads need. */
function GazetteerCredits() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  return (
    <p className="tools-geo-hint">
      {t("tools.geocode.importHint")}{" "}
      <a href="https://download.geonames.org/export/dump/" target="_blank" rel="noreferrer">
        download.geonames.org/export/dump
      </a>{" "}
      {t("tools.geocode.importHint2")} {t("tools.geocode.gursCredit")}{" "}
      <a href="https://www.e-prostor.gov.si/dostopi/javni-dostop/" target="_blank" rel="noreferrer">
        e-prostor.gov.si
      </a>
      {!settings.allowLinkFetch && ` ${t("tools.geocode.downloadNeedsOptIn")}`}
    </p>
  );
}

/** The whole manager, as Settings → Map shows it: everything imported, every way
 *  to add more, and the credits. */
export function GazetteerManager({ gaz }: { gaz: Gazetteer }) {
  const { t } = useTranslation();
  return (
    <div className="tools-geo-gazetteer settings-geo">
      {gaz.countries?.length === 0 && <p className="tools-geo-empty">{t("settings.geo.empty")}</p>}
      <GazetteerList gaz={gaz} />
      <GazetteerAcquire gaz={gaz} />
      {gaz.importState?.phase === "error" && <ToolsError message={gaz.importState.message} />}
      <GazetteerCredits />
    </div>
  );
}

/**
 * The manager as the Geocode tool shows it. With nothing imported it is the full
 * thing, because that is the moment the need is discovered and the list below
 * cannot work without it. With something imported it is one line — which
 * directories are in and how big — and the managing happens in Settings.
 */
export function GazetteerSetup({ gaz }: { gaz: Gazetteer }) {
  const { t, i18n } = useTranslation();
  const busy = gaz.importState !== null;
  if (gaz.countries === null) return null;

  if (gaz.countries.length > 0 && !busy) {
    return (
      <div className="tools-geo-gazetteer">
        <div className="tools-geo-summary">
          <span className="tools-geo-loaded">{t("tools.geocode.loadedCountries")}</span>
          {gaz.countries.map((c) => (
            <span key={c.code} className="tools-geo-summary-entry">
              <span className="tools-geo-country gm-data">{c.code}</span>
              <span className="tools-geo-count">{c.count.toLocaleString(i18n.language)}</span>
            </span>
          ))}
          <span className="tools-geo-manage">{t("tools.geocode.manageInSettings")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="tools-geo-gazetteer">
      {gaz.countries.length === 0 && <p className="tools-geo-empty">{t("tools.geocode.noGazetteer")}</p>}
      <GazetteerList gaz={gaz} />
      <GazetteerAcquire gaz={gaz} />
      {gaz.importState?.phase === "error" && <ToolsError message={gaz.importState.message} />}
      <GazetteerCredits />
    </div>
  );
}

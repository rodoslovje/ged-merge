import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { COUNTRY_CODES } from "../../gedcom/countryCode";
import {
  buildGazetteerIndex,
  mergeDivisions,
  overpassFailure,
  overpassSubdivisions,
  type GazetteerIndex,
  type Subdivision,
} from "../../geo/gazetteer";
import { deleteCountry, loadCountries, type CountryMeta } from "../../persist/geoDb";
import type { GeoWorkerRequest, GeoWorkerResponse } from "../../worker/geoMessages";
import { invalidateGazetteerIndex } from "../edit/PlaceLookupContext";
import { useSettings } from "../SettingsContext";
import { requestSettings } from "../settingsBus";
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

/**
 * What an import is doing, so the spinner can say it. The three stages are not
 * cosmetic: Overpass computes a country's extract before it sends a single byte,
 * so a download sits at zero bytes for ten seconds or more and a byte counter
 * alone reads as hung. GURS, by contrast, streams from the first moment.
 */
type ImportStage = "waiting" | "downloading" | "parsing";

type ImportState =
  | {
      phase: "running";
      stage: ImportStage;
      done: number;
      total: number;
      /** What this particular download is, when one click starts many: the
       *  region being fetched and its place in the run. */
      note?: string;
    }
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

/** The direction each source moves data: two fetch it from a service, one takes
 *  it off your own disk. Plain arrows, not emoji — they inherit the button's
 *  colour in both themes, where ⬇/⬆ would draw in their own. */
const DOWNLOAD_GLYPH = "↓";
const UPLOAD_GLYPH = "↑";

/** Every place node in the area `.a`: settlements down to isolated dwellings. */
const PLACE_NODES =
  `node(area.a)[place~"^(city|town|village|hamlet|suburb|locality|isolated_dwelling)$"];out qt;`;

/** Every place in the country. */
function countryQuery(code: string): string {
  return `[out:json][timeout:180];area["ISO3166-1"="${code}"][admin_level=2]->.a;${PLACE_NODES}`;
}

/** One subdivision's boundary relation (tags only — the marker the importer
 *  reads the division's names off) followed by its places. Overpass emits
 *  output statements in query order, so every place lands after the marker of
 *  the division it sits in. */
function subdivisionBlock(code: string): string {
  return `rel["ISO3166-2"="${code}"][boundary=administrative];out tags;area["ISO3166-2"="${code}"]->.a;${PLACE_NODES}`;
}

/** Every place in the country, grouped under its subdivisions' markers so each
 *  entry can say which county/state it sits in. Costs the server one area
 *  expansion per subdivision, so it is only used for a moderate list — a
 *  country with hundreds of ISO-coded municipalities gets the plain query. */
function annotatedCountryQuery(subdivisions: Subdivision[]): string {
  return `[out:json][timeout:180];${subdivisions.map((s) => subdivisionBlock(s.code)).join("")}`;
}

/** Above this many subdivisions the annotated whole-country query is riskier
 *  than it is worth (Slovenia's ISO codes are its 212 municipalities) — the
 *  plain query keeps the download working, just without division labels. */
const MAX_ANNOTATED_SUBDIVISIONS = 60;

/** Every place in one ISO 3166-2 subdivision ("US-CA"), for a country whose
 *  own area is more than the service will chew through in one query. The
 *  leading marker labels the entries the same way the annotated country
 *  query does. */
function regionQuery(region: string): string {
  return `[out:json][timeout:180];${subdivisionBlock(region)}`;
}

/** The country's subdivisions — boundary relations, tags only, no geometry, so
 *  it answers in seconds even where the places themselves time out. */
function subdivisionsQuery(code: string): string {
  return `[out:json][timeout:120];relation["ISO3166-2"~"^${code}-"][boundary=administrative];out tags;`;
}

/** Countries already known to need splitting, with the subdivisions found for
 *  them — so the discovery (three minutes of a query timing out) happens once
 *  per browser and not once per visit. */
const REGIONS_KEY = "gedmerge.osmRegions";

function loadKnownRegions(): Record<string, Subdivision[]> {
  try {
    const raw = localStorage.getItem(REGIONS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Subdivision[]>) : {};
  } catch {
    return {};
  }
}

function rememberRegions(country: string, list: Subdivision[]): void {
  try {
    localStorage.setItem(REGIONS_KEY, JSON.stringify({ ...loadKnownRegions(), [country]: list }));
  } catch {
    // A full or blocked storage costs the shortcut, nothing else.
  }
}

/**
 * Read a response body, counting the bytes as they arrive.
 *
 * Counted, never scaled: the total these downloads will come to is not
 * knowable. The GURS endpoint sends chunked and announces no length at all,
 * and Overpass announces one that counts the *compressed* body while the reader
 * hands back the decompressed bytes — which read as "140 %" and then kept
 * climbing. Whether a response was compressed is not something a cross-origin
 * fetch may ask (`Content-Encoding` is not CORS-safelisted, `Content-Length`
 * is), so the header cannot be corrected for, only distrusted. The caller
 * therefore always shows megabytes, which are true.
 */
async function readWithProgress(
  res: Response,
  onProgress: (done: number, total: number) => void,
): Promise<ArrayBuffer> {
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.byteLength;
    onProgress(done, 0);
  }
  const out = new Uint8Array(done);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

/** What a download attempt produced: the bytes, or why there are none. */
type OverpassResult = { buffer: ArrayBuffer } | { failure: "timeout" | "busy" };

/**
 * Run one Overpass query, walking the endpoints until one answers.
 *
 * A 200 is not success: Overpass reports a query it could not finish inside its
 * time budget as valid JSON with no elements and a `remark`, and a loaded
 * dispatcher as a small HTML page — imported at face value, both would land as
 * "this country has no places". {@link overpassFailure} tells the two apart, and
 * the distinction matters to the caller: a timeout means the area is too big and
 * has to be split, a busy service means try again.
 */
async function fetchOverpass(
  query: string,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<OverpassResult> {
  let timedOut = false;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal,
      });
      if (res.ok) {
        const buffer = await readWithProgress(res, onProgress);
        // The remark is emitted after the elements, so the tail is enough — and
        // decoding the last few KB of a 30 MB country costs nothing.
        const tail = new TextDecoder().decode(
          new Uint8Array(buffer).slice(Math.max(0, buffer.byteLength - 4096)),
        );
        const failure = buffer.byteLength > 200 ? overpassFailure(tail) : "busy";
        if (!failure) return { buffer };
        if (failure === "timeout") timedOut = true;
      }
    } catch (e) {
      void e;
      if (signal.aborted) break;
    }
  }
  return { failure: timedOut ? "timeout" : "busy" };
}

/** Wait, unless the run is cancelled first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Whole seconds since `active` became true, 0 when it is not. Overpass answers a
 * country query only once it has computed the whole extract, so for ten seconds
 * or more there is no byte to count and nothing else on screen moves — a ticking
 * number is the difference between "working" and "hung".
 */
function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const id = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active ? seconds : 0;
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
  importFile: (file: File) => Promise<void>;
  /** Fetch one country's places from OpenStreetMap, by ISO 3166-1 alpha-2. */
  downloadCountry: (country: string) => Promise<void>;
  downloadSlovenia: () => Promise<void>;
  /** The country whose places are too many for one query, and the subdivisions
   *  offered instead. Null whenever there is no such offer on the table. */
  regions: { country: string; list: Subdivision[] } | null;
  /** Fetch one ISO 3166-2 subdivision ("US-CA") into its country's directory. */
  downloadRegion: (region: string) => Promise<void>;
  /** Fetch every offered subdivision, one after another. */
  downloadAllRegions: () => Promise<void>;
  dismissRegions: () => void;
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
  const [regions, setRegions] = useState<{ country: string; list: Subdivision[] } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);

  const reload = async () => {
    const stored = await loadCountries();
    setCountries(
      stored.map(({ code, count, importedAt }) => ({ code, count, importedAt })).sort((a, b) => b.count - a.count),
    );
    if (withIndex)
      setIndex(stored.length ? buildGazetteerIndex(stored.flatMap((c) => c.entries), mergeDivisions(stored)) : undefined);
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

  /** Hand a payload to the worker. Resolves true once it is stored, false on a
   *  failure it has already put on screen — a batch of regions needs to know
   *  which of its downloads landed. `note` labels the run it belongs to, and
   *  keeps the spinner on that label instead of blanking between regions. */
  const runImport = (
    buffer: ArrayBuffer,
    fileName: string,
    extra?:
      | { format: "overpass"; country: string; region?: string }
      | { format: "rpe"; obcine?: ArrayBuffer },
    note?: string,
  ): Promise<boolean> =>
    new Promise((resolve) => {
      // Only the GeoNames dump path reports parse progress by chunk; the Overpass
      // and GURS payloads are converted in one shot, so leave their total at 0 and
      // show a bare spinner rather than a 0 % that never moves.
      setImportState({ phase: "running", stage: "parsing", done: 0, total: extra ? 0 : buffer.byteLength, note });
      const worker = new Worker(new URL("../../worker/geo.worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      const fail = (message: string) => {
        worker.terminate();
        workerRef.current = null;
        setImportState({ phase: "error", message });
        resolve(false);
      };
      worker.onmessage = (e: MessageEvent<GeoWorkerResponse>) => {
        const msg = e.data;
        if (msg.type === "progress") {
          setImportState({ phase: "running", stage: "parsing", done: msg.done, total: msg.total, note });
        }
        else if (msg.type === "result") {
          worker.terminate();
          workerRef.current = null;
          // Mid-batch the spinner stays up under the same label: the next region
          // starts immediately, and a blank frame between the two reads as done.
          setImportState(note ? { phase: "running", stage: "waiting", done: 0, total: 0, note } : null);
          void refreshGazetteer();
          resolve(true);
        } else fail(msg.message);
      };
      // A worker that fails to load or throws outside the message handler would
      // otherwise leave the import spinner running forever — surface it instead.
      worker.onerror = () => fail(t("tools.geocode.importFailed"));
      worker.onmessageerror = () => fail(t("tools.geocode.importFailed"));
      const req: GeoWorkerRequest = { type: "importGazetteer", requestId: 1, buffer, fileName, ...extra };
      worker.postMessage(req, req.obcine ? [buffer, req.obcine] : [buffer]);
    });

  const importFile = async (file: File) => {
    await runImport(await file.arrayBuffer(), file.name);
  };

  const onProgress = (note?: string) => (done: number, total: number) =>
    setImportState({ phase: "running", stage: "downloading", done, total, note });

  // Direct download of a country's places — the download-then-pick round
  // trip is confusing, so fetch from Overpass (OpenStreetMap) here, gated
  // behind the same online-lookups opt-in as the other network features.
  const downloadCountry = async (country: string) => {
    const code = country.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return;
    setRegions(null);
    // A country already known to be too large goes straight to its regions
    // rather than spending another three minutes proving it again.
    const known = loadKnownRegions()[code];
    if (known?.length) {
      setImportState(null);
      setRegions({ country: code, list: known });
      return;
    }
    const abort = new AbortController();
    fetchAbortRef.current = abort;
    setImportState({ phase: "running", stage: "waiting", done: 0, total: 0 });
    try {
      // The subdivision list first (tags only, answers in seconds): with it the
      // places query groups every place under its county/state, so each entry
      // can say where it is. Without one — none mapped, too many, or the list
      // query itself failed — the plain query still downloads everything, the
      // entries just carry no division label.
      const subdivisions = await fetchSubdivisions(code, abort);
      if (abort.signal.aborted) return;
      const annotate = subdivisions.length > 0 && subdivisions.length <= MAX_ANNOTATED_SUBDIVISIONS;
      const query = annotate ? annotatedCountryQuery(subdivisions) : countryQuery(code);
      setImportState({ phase: "running", stage: "waiting", done: 0, total: 0 });
      const res = await fetchOverpass(query, abort.signal, onProgress());
      if (abort.signal.aborted) return;
      if ("buffer" in res) {
        await runImport(res.buffer, `${code}.osm.json`, { format: "overpass", country: code });
        return;
      }
      if (res.failure === "busy") {
        setImportState({ phase: "error", message: t("tools.geocode.downloadFailed") });
        return;
      }
      await offerRegions(code, abort, subdivisions);
    } finally {
      fetchAbortRef.current = null;
    }
  };

  /** The country's ISO 3166-2 subdivisions, or [] when it has none mapped or
   *  the query failed — the caller treats both the same. */
  const fetchSubdivisions = async (code: string, abort: AbortController): Promise<Subdivision[]> => {
    setImportState({ phase: "running", stage: "waiting", done: 0, total: 0, note: t("tools.geocode.regionsLoading") });
    const res = await fetchOverpass(subdivisionsQuery(code), abort.signal, () => {});
    if (abort.signal.aborted || !("buffer" in res)) return [];
    try {
      return overpassSubdivisions(JSON.parse(new TextDecoder().decode(res.buffer)), code);
    } catch {
      return [];
    }
  };

  // The country is more than the service will do in one query — the United
  // States times out before it counts its places, let alone sends them. Its
  // subdivisions each fit comfortably, and asking for them is a tags-only query
  // that answers in seconds, so the dead end becomes a choice.
  const offerRegions = async (code: string, abort: AbortController, prefetched?: Subdivision[]) => {
    const list = prefetched?.length ? prefetched : await fetchSubdivisions(code, abort);
    if (abort.signal.aborted) return;
    if (!list.length) {
      setImportState({ phase: "error", message: t("tools.geocode.tooLargeNoRegions") });
      return;
    }
    rememberRegions(code, list);
    setImportState(null);
    setRegions({ country: code, list });
  };

  /** One region: download and import. False when it did not land — the message
   *  is already on screen, and a batch run counts it and carries on. */
  const fetchRegion = async (region: string, abort: AbortController, note?: string): Promise<boolean> => {
    const country = region.slice(0, region.indexOf("-"));
    setImportState({ phase: "running", stage: "waiting", done: 0, total: 0, note });
    const res = await fetchOverpass(regionQuery(region), abort.signal, onProgress(note));
    if (abort.signal.aborted) return false;
    if (!("buffer" in res)) {
      setImportState({
        phase: "error",
        message: t(res.failure === "timeout" ? "tools.geocode.regionTooLarge" : "tools.geocode.downloadFailed", {
          region,
        }),
      });
      return false;
    }
    return await runImport(res.buffer, `${region}.osm.json`, { format: "overpass", country, region }, note);
  };

  const downloadRegion = async (region: string) => {
    const abort = new AbortController();
    fetchAbortRef.current = abort;
    try {
      await fetchRegion(region, abort);
    } finally {
      fetchAbortRef.current = null;
    }
  };

  // Every region, one after another. Sequential and unhurried on purpose: the
  // public endpoints meter concurrent queries per address, and fifty heavy ones
  // fired off together get the whole run refused rather than served faster.
  // Each region is stored as it arrives, so a cancelled or half-failed run
  // still leaves everything it did fetch.
  const downloadAllRegions = async () => {
    const target = regions;
    if (!target) return;
    const abort = new AbortController();
    fetchAbortRef.current = abort;
    const failed: string[] = [];
    try {
      for (const [i, region] of target.list.entries()) {
        if (abort.signal.aborted) return;
        const note = t("tools.geocode.regionProgress", {
          name: region.name,
          index: i + 1,
          total: target.list.length,
        });
        const ok = await fetchRegion(region.code, abort, note);
        if (abort.signal.aborted) return;
        if (!ok) failed.push(region.name);
        if (i < target.list.length - 1) await sleep(2000, abort.signal);
      }
      setImportState(
        failed.length
          ? { phase: "error", message: t("tools.geocode.regionAllFailed", { count: failed.length, names: failed.join(", ") }) }
          : null,
      );
      if (!failed.length) setRegions(null);
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
    setImportState({ phase: "running", stage: "waiting", done: 0, total: 0 });
    try {
      const res = await fetch(GURS_NASELJA_URL, { signal: abort.signal });
      if (!res.ok) {
        setImportState({ phase: "error", message: t("tools.geocode.downloadFailed") });
        return;
      }
      const buffer = await readWithProgress(res, (done, total) =>
        setImportState({ phase: "running", stage: "downloading", done, total }),
      );
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
      await runImport(buffer, "SI.gurs-naselja.json", { format: "rpe", ...(obcine ? { obcine } : {}) });
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
    importFile,
    downloadCountry,
    downloadSlovenia,
    regions,
    downloadRegion,
    downloadAllRegions,
    dismissRegions: () => setRegions(null),
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

/**
 * The way out of a country too large to fetch whole: its regions, one at a time
 * or all of them in a row.
 *
 * It appears in place of an error, because a timeout on the United States is not
 * a fault to report — the country simply has to be asked for in pieces, and the
 * pieces are right here. The whole-country control above stays where it is: what
 * fails for one country works for the next.
 */
function RegionPicker({ gaz, regions }: { gaz: Gazetteer; regions: { country: string; list: Subdivision[] } }) {
  const { t, i18n } = useTranslation();
  const countryName = useMemo(
    () => new Intl.DisplayNames([i18n.language], { type: "region" }).of(regions.country) ?? regions.country,
    [i18n.language, regions.country],
  );
  return (
    <div className="tools-geo-regions">
      <p className="tools-geo-hint">
        {t("tools.geocode.regionIntro", { country: countryName, count: regions.list.length })}
      </p>
      <div className="tools-geo-acquire">
        <select
          className="nav-btn tools-run tools-geo-osm"
          aria-label={t("tools.geocode.regionPick")}
          value=""
          onChange={(e) => {
            const region = e.target.value;
            if (region) void gaz.downloadRegion(region);
          }}
        >
          <option value="">{`${DOWNLOAD_GLYPH} ${t("tools.geocode.regionPick")}`}</option>
          {regions.list.map(({ code, name }) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <button className="nav-btn tools-run" onClick={() => void gaz.downloadAllRegions()}>
          <span aria-hidden="true">{DOWNLOAD_GLYPH} </span>
          {t("tools.geocode.regionAll", { count: regions.list.length })}
        </button>
        <button className="tools-issue-link" onClick={gaz.dismissRegions}>
          {t("tools.geocode.regionDismiss")}
        </button>
      </div>
      <p className="tools-geo-hint">{t("tools.geocode.regionAllHint", { count: regions.list.length })}</p>
    </div>
  );
}

/** The three ways in: the GURS register, any country from OpenStreetMap, or a
 *  GeoNames file.The two downloads need the online-lookups opt-in; the file
 *  import never does — and it sits under the paragraph that tells you where to
 *  fetch the file, because that instruction is half the button. */
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
  const running = gaz.importState?.phase === "running" ? gaz.importState : undefined;
  const waited = useElapsed(running?.stage === "waiting");
  if (running) {
    // Each stage says what it is actually doing: waiting on a service that sends
    // nothing until it is ready, receiving bytes, or converting them. Only the
    // wait needs a clock — the other two have their own numbers.
    const stage =
      running.stage === "waiting"
        ? `${t("tools.geocode.waiting")}${waited ? ` ${waited} s` : ""}`
        : running.stage === "downloading"
          ? t("tools.geocode.downloading")
          : t("tools.geocode.importing");
    // In a region run the region leads: which of the fifty is on the wire is
    // the thing being waited for, and the stage is a detail of it.
    const label = running.note ? `${running.note} — ${stage}` : stage;
    return <ToolsLoading label={label} progress={running} bytes onCancel={gaz.cancelImport} />;
  }
  return (
    <>
      {gaz.importState?.phase === "error" && <ToolsError message={gaz.importState.message} />}
      {gaz.regions && <RegionPicker gaz={gaz} regions={gaz.regions} />}
      {/* Each way in is its button and the sentence that explains it, side by
          side: what the source gives you and what it asks in return is the whole
          basis for choosing between them, so it belongs beside the click rather
          than in a paragraph naming all three. */}
      <div className="tools-geo-sources">
        {settings.allowLinkFetch && (
          <>
            <button
              className="nav-btn tools-run"
              onClick={() => void gaz.downloadSlovenia()}
              title={t("tools.geocode.gursTooltip")}
            >
              <span aria-hidden="true">{DOWNLOAD_GLYPH} </span>
              {t("tools.geocode.gursBtn")}
            </button>
            <p className="tools-geo-hint">{t("tools.geocode.sourceGurs")}</p>
            {/* One control, not a pair: the button opens the country list and
                the country picked is the click — the same shape as the map tab's
                "Add a free preset…". It never holds a selection, so it reads as
                its own label again the moment the download starts. */}
            <select
              className="nav-btn tools-run tools-geo-osm"
              title={t("tools.geocode.countryTooltip")}
              aria-label={t("tools.geocode.countryTooltip")}
              value=""
              onChange={(e) => {
                const code = e.target.value;
                if (code) void gaz.downloadCountry(code);
              }}
            >
              {/* The glyph rides in the option text: a closed <select> shows
                  its selected option, and there is nothing else to draw in. */}
              <option value="">{`${DOWNLOAD_GLYPH} ${t("tools.geocode.downloadBtn")}`}</option>
              {countries.map(({ code, name }) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
            <p className="tools-geo-hint">{t("tools.geocode.sourceOsm")}</p>
          </>
        )}
        {/* The fallback: for a country neither download serves, and for anyone
            who would rather the app fetched nothing at all. */}
        <label className="nav-btn tools-geo-import">
          <span aria-hidden="true">{UPLOAD_GLYPH} </span>
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
        <p className="tools-geo-hint">
          {t("tools.geocode.sourceGeoNames")}{" "}
          <a href="https://download.geonames.org/export/dump/" target="_blank" rel="noreferrer">
            download.geonames.org/export/dump
          </a>
          {t("tools.geocode.sourceGeoNames2")}
        </p>
      </div>
      <p className="tools-geo-hint">
        {t("tools.geocode.storedLocally")}
        {!settings.allowLinkFetch && ` ${t("tools.geocode.downloadNeedsOptIn")}`}
      </p>
    </>
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
  if (gaz.countries === null) return null;

  // Nothing loaded: say so and point at the one place that manages them. The
  // controls themselves are deliberately *not* repeated here — two copies of
  // the same setup invite the reader to wonder which one is the real one, and
  // the link costs one click.
  if (gaz.countries.length === 0) {
    return (
      <div className="tools-geo-gazetteer">
        <p className="tools-geo-empty">{t("tools.geocode.noGazetteer")}</p>
        <button className="tools-issue-link" onClick={() => requestSettings("map")}>
          {t("tools.geocode.openSettings")}
        </button>
      </div>
    );
  }

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
        <button className="tools-issue-link" onClick={() => requestSettings("map")}>
          {t("tools.geocode.manageInSettings")}
        </button>
      </div>
    </div>
  );
}

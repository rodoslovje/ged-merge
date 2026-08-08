import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { COUNTRY_CODES } from "../../gedcom/countryCode";
import {
  buildGazetteerIndex,
  DGU_REGISTER,
  GURS_REGISTER,
  mergeDivisions,
  overpassFailure,
  overpassSubdivisions,
  storedEntries,
  type GazetteerIndex,
  type Subdivision,
} from "../../geo/gazetteer";
import { countryNameOf } from "../../geo/placeProposal";
import { addressRegisterInfo, invalidateAddressRegisters } from "../../geo/addressLookup";
import {
  addressDownloadState,
  cancelAddressDownload,
  clearAddressDownload,
  startAddressDownload,
  watchAddressDownload,
} from "./addressDownload";
import { deleteAddressRegister, deleteCountry, loadCountries, type CountryMeta } from "../../persist/geoDb";
import type { GeoWorkerRequest, GeoWorkerResponse } from "../../worker/geoMessages";
import { invalidateGazetteerIndex } from "../edit/PlaceLookupContext";
import { useSettings } from "../SettingsContext";
import { requestSettings } from "../settingsBus";
import { ToolsError, ToolsLoading } from "./shared";
import { SelectMenu } from "../DropdownMenu";

// The place-directory manager: the offline gazetteers (GeoNames country extracts,
// OpenStreetMap downloads, the GURS register of Slovenian settlements and the DGU
// register of Croatian geographical names) that live in the gedmerge-geo
// IndexedDB and back every place lookup in the app — and, alongside them, the
// two national *address* registers (GURS's and DGU's), downloaded here for the
// same reason and dropped here the same way, but answering houses rather than
// places (see addressRegister.ts).
//
// Each source is one row: who it comes from, named once, and what of theirs you
// can take. A register offers two things, its settlements and its house
// numbers, and they differ in cost by an order of magnitude — hence two buttons
// under one name and one description.
//
// It is one-time setup that outlives the file, so Settings → Map owns it. The
// Geocode places tool keeps the same controls for as long as there is nothing
// loaded — that is where a researcher first learns they need a directory, and
// sending them elsewhere at that moment would be a dead end — and shrinks to a
// one-line summary once there is.

/**
 * What an import is doing, so the spinner can say it. The stages are not
 * cosmetic: Overpass computes a country's extract before it sends a single byte,
 * so a download sits at zero bytes for ten seconds or more and a byte counter
 * alone reads as hung. GURS, by contrast, streams from the first moment. The
 * address register adds a fourth: writing 6759 villages into the browser's own
 * database takes long enough that a full bar would read as hung in its turn.
 */
type ImportStage = "waiting" | "downloading" | "parsing" | "storing";

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

/**
 * The populated-place feature kinds of the DGU register of geographical names,
 * by the register's own `vrstaobiljezjaid`: naselje (234), zaselak (242), selo
 * (237), dio naselja (236), gradska četvrt (233), napušteno naselje (191), the
 * farmstead group — salaš, majur, stancija (124) — and the two city kinds, grad
 * (321) and glavni grad (231).
 *
 * The register holds 128 000 names of everything a map shows, hills and springs
 * and bus stops included, and asking for the lot would download 25 MB of
 * features no place string will ever match. These nine kinds are the ones a
 * birth entry names: with the hamlets and the abandoned settlements in, and the
 * terrain out, it comes to some 24 000 places in 8 MB.
 *
 * The city kinds are here because three cities — Pula, Buje and Poreč — are
 * filed under no other one: the register has no settlement row for them at all,
 * so leaving the kind out loses them outright. The other 123 do repeat a
 * settlement of their own name, and {@link rgiPlacesToEntries} drops those.
 */
const DGU_PLACE_KINDS = [124, 191, 231, 233, 234, 236, 237, 242, 321];

/** The register of geographical names — Croatia's authoritative place
 *  directory, served as GeoJSON with CORS open, so the browser fetches it
 *  directly. Points, not polygons, so there is no centroid to compute.
 *  Data © Državna geodetska uprava. */
const DGU_PLACES_URL =
  "https://rgi.dgu.hr/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature" +
  "&typeNames=rgi:v_imjesto_geoime_gs&outputFormat=application/json&srsName=EPSG:4326&count=50000" +
  "&propertyName=im_id,pisanje_imena,jeziknaziv,status_imena,og_ime,vrstaobiljezjaid,geom" +
  `&CQL_FILTER=${encodeURIComponent(`vrstaobiljezjaid IN (${DGU_PLACE_KINDS.join(",")})`)}`;

/** One RPJ administrative-unit table, asked for without its geometry — the
 *  counties are 3 KB that way and the municipalities 75 KB, against megabytes
 *  of boundary polygons nothing here would draw. */
function dguUnitsUrl(layer: string, properties: string): string {
  return (
    "https://rgi.dgu.hr/geoserver/wfs?service=WFS&version=2.0.0&request=GetFeature" +
    `&typeNames=rgi:${layer}&outputFormat=application/json&count=1000&propertyName=${properties}`
  );
}

/** The municipalities each place's `og_ime` names, with the county each belongs
 *  to, and the counties themselves — together, which county a place sits in. */
const DGU_OPCINE_URL = dguUnitsUrl("rpj_opcina", "og_ime,zupanija_id");
const DGU_ZUPANIJE_URL = dguUnitsUrl("rpj_zupanija", "id,naziv,rb");

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

/** A small side table the main payload is joined against — the municipalities a
 *  register's places name, the counties those belong to. Undefined when it did
 *  not arrive: none of them is worth failing an import over, the places simply
 *  come in without whatever the table would have told them. */
async function fetchBuffer(url: string, signal: AbortSignal): Promise<ArrayBuffer | undefined> {
  try {
    const res = await fetch(url, { signal });
    return res.ok ? await res.arrayBuffer() : undefined;
  } catch (e) {
    void e;
    return undefined;
  }
}

/** What a payload is, beyond a GeoNames dump — the shape the worker converts it
 *  under, plus whatever that shape needs alongside the bytes. */
type ImportExtra =
  | { format: "overpass"; country: string; region?: string }
  | { format: "rpe"; obcine?: ArrayBuffer }
  | { format: "rgi"; opcine?: ArrayBuffer; zupanije?: ArrayBuffer };

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

/** A stored national address register — a different kind of thing from the
 *  place directories beside it: houses, not settlements, and read straight out
 *  of IndexedDB instead of an index built in memory. */
export interface AddressRegisterMeta {
  country: string;
  count: number;
  importedAt: number;
}

/** What {@link useGazetteer} hands its controls — and, in the Geocode tool, the
 *  built index the whole review list is scored against. */
export interface Gazetteer {
  /** Null until IndexedDB has answered; empty array = nothing imported yet. */
  countries: CountryMeta[] | null;
  /** The stored address registers — at most one, Croatia's, today. Null until
   *  IndexedDB has answered. */
  addressRegisters: AddressRegisterMeta[] | null;
  /** The searchable index, built only where it is used (`withIndex`). */
  index: GazetteerIndex | undefined;
  importState: ImportState;
  importFile: (file: File) => Promise<void>;
  /** Fetch one country's places from OpenStreetMap, by ISO 3166-1 alpha-2. */
  downloadCountry: (country: string) => Promise<void>;
  downloadSlovenia: () => Promise<void>;
  downloadCroatia: () => Promise<void>;
  /** Fetch a national address register — the houses, not the places. */
  downloadCroatiaAddresses: () => Promise<void>;
  downloadSloveniaAddresses: () => Promise<void>;
  removeAddressRegister: (country: string) => Promise<void>;
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
  const [addressRegisters, setAddressRegisters] = useState<AddressRegisterMeta[] | null>(null);
  const [index, setIndex] = useState<GazetteerIndex | undefined>(undefined);
  const [importState, setImportState] = useState<ImportState>(null);
  const [regions, setRegions] = useState<{ country: string; list: Subdivision[] } | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);

  // An address import runs outside this component, so its progress is read
  // rather than held — and a manager mounting halfway through one picks it up.
  const download = useSyncExternalStore(watchAddressDownload, addressDownloadState, addressDownloadState);
  useEffect(() => {
    if (download.phase === "done") {
      void refreshGazetteer();
      clearAddressDownload();
    }
    // refreshGazetteer is recreated each render; the phase is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [download.phase]);

  const reload = async () => {
    const stored = await loadCountries();
    setCountries(
      stored.map(({ code, count, importedAt }) => ({ code, count, importedAt })).sort((a, b) => b.count - a.count),
    );
    const registers: AddressRegisterMeta[] = [];
    for (const country of ["SI", "HR"] as const) {
      const info = await addressRegisterInfo(country);
      if (info) registers.push({ country, ...info });
    }
    setAddressRegisters(registers);
    if (withIndex)
      setIndex(stored.length ? buildGazetteerIndex(storedEntries(stored), mergeDivisions(stored)) : undefined);
  };

  const refreshGazetteer = async () => {
    // The Edit view's lookup keeps its own index for the whole session, so an
    // import or removal here has to drop it — otherwise the place fields answer
    // from the gazetteer this manager has just replaced. The address register
    // caches its own index and buckets for the same reason and needs the same
    // clearing.
    invalidateGazetteerIndex();
    invalidateAddressRegisters();
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
    extra?: ImportExtra,
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
          setImportState({
            phase: "running",
            stage: msg.stage === "storing" ? "storing" : "parsing",
            done: msg.done,
            total: msg.total,
            note,
          });
        }
        else if (msg.type === "result" || msg.type === "addressRegister") {
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
      // Every buffer in the request is transferred, whatever the format called
      // it — the payload plus whichever side tables came with it.
      const transfer = Object.values(req).filter((v): v is ArrayBuffer => v instanceof ArrayBuffer);
      worker.postMessage(req, transfer);
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

  // One-click national register. Same opt-in gate and progress handling as the
  // Overpass download, but a single known endpoint — a failure here is a real
  // outage, so there is no fallback list to walk. `extra` runs once the register
  // itself is in hand, for a source that needs a second request to make sense
  // of it.
  const downloadRegister = async (
    url: string,
    fileName: string,
    extra: (signal: AbortSignal) => Promise<ImportExtra>,
  ) => {
    const abort = new AbortController();
    fetchAbortRef.current = abort;
    setImportState({ phase: "running", stage: "waiting", done: 0, total: 0 });
    try {
      const res = await fetch(url, { signal: abort.signal });
      if (!res.ok) {
        setImportState({ phase: "error", message: t("tools.geocode.downloadFailed") });
        return;
      }
      const buffer = await readWithProgress(res, (done, total) =>
        setImportState({ phase: "running", stage: "downloading", done, total }),
      );
      const options = await extra(abort.signal);
      if (abort.signal.aborted) return;
      await runImport(buffer, fileName, options);
    } catch (e) {
      if (abort.signal.aborted) return;
      void e;
      setImportState({ phase: "error", message: t("tools.geocode.downloadFailed") });
    } finally {
      fetchAbortRef.current = null;
    }
  };

  const downloadSlovenia = () =>
    downloadRegister(GURS_NASELJA_URL, "SI.gurs-naselja.json", async (signal) => {
      // The municipalities are a separate collection (212 rows) joined by
      // EID_OBCINA — what lets two settlements of one name be told apart
      // ("Soteska (Kamnik)" vs "Soteska (Dolenjske Toplice)").
      const obcine = await fetchBuffer(GURS_OBCINE_URL, signal);
      return { format: "rpe", ...(obcine ? { obcine } : {}) };
    });

  // The register names each place's municipality on the feature itself, but the
  // county it sits in — what a place string written in English calls
  // "Primorje-Gorski Kotar" — takes the two administrative-unit tables. They are
  // 78 KB together, and failing to get them costs the county and nothing else.
  const downloadCroatia = () =>
    downloadRegister(DGU_PLACES_URL, "HR.dgu-imena.json", async (signal) => {
      const [opcine, zupanije] = await Promise.all([
        fetchBuffer(DGU_OPCINE_URL, signal),
        fetchBuffer(DGU_ZUPANIJE_URL, signal),
      ]);
      return { format: "rgi", ...(opcine ? { opcine } : {}), ...(zupanije ? { zupanije } : {}) };
    });

  // The houses, as opposed to the places above. Both countries' imports run in
  // addressDownload's own worker rather than this component's: they take
  // minutes, and this component is unmounted the moment Settings changes tab.
  const downloadCroatiaAddresses = async () => startAddressDownload("HR");
  const downloadSloveniaAddresses = async () => startAddressDownload("SI");

  const removeAddressRegister = async (country: string) => {
    await deleteAddressRegister(country);
    await refreshGazetteer();
  };

  const cancelImport = () => {
    fetchAbortRef.current?.abort();
    fetchAbortRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    cancelAddressDownload();
    setImportState(null);
  };

  const removeCountry = async (code: string) => {
    await deleteCountry(code);
    await refreshGazetteer();
  };

  // The address import's state, shown through the same spinner as the imports
  // this component does run itself.
  const addressState: ImportState =
    download.phase === "running"
      ? { phase: "running", stage: download.stage, done: download.done, total: download.total }
      : download.phase === "error"
        ? { phase: "error", message: download.message }
        : null;

  return {
    countries,
    addressRegisters,
    index,
    importState: addressState ?? importState,
    importFile,
    downloadCountry,
    downloadSlovenia,
    downloadCroatia,
    downloadCroatiaAddresses,
    downloadSloveniaAddresses,
    removeAddressRegister,
    regions,
    downloadRegion,
    downloadAllRegions,
    dismissRegions: () => setRegions(null),
    cancelImport,
    removeCountry,
  };
}

/** What a directory code stands for, spelled out for the chip's tooltip: the
 *  official registers by name, a "-OSM" key as an OpenStreetMap download, and
 *  a bare country code — by convention — as a GeoNames file. */
function directoryTitle(code: string, language: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (code === GURS_REGISTER) return t("tools.geocode.dir.gurs");
  if (code === DGU_REGISTER) return t("tools.geocode.dir.dgu");
  const country = countryNameOf(code.slice(0, 2), language) ?? code.slice(0, 2);
  return code.endsWith("-OSM") ? t("tools.geocode.dir.osm", { country }) : t("tools.geocode.dir.geonames", { country });
}

/** What is imported, with the date and a way to drop it again. The address
 *  registers sit in the same list, marked for what they are: they are imported
 *  the same way, they are dropped the same way, and a reader wants one answer
 *  to "what does this browser hold". */
function GazetteerList({ gaz }: { gaz: Gazetteer }) {
  const { t, i18n } = useTranslation();
  const dateFmt = new Intl.DateTimeFormat(i18n.language);
  if (!gaz.countries?.length && !gaz.addressRegisters?.length) return null;
  return (
    <ul className="tools-geo-countries">
      {gaz.countries?.map((c) => (
        <li key={c.code}>
          <span className="tools-geo-country gm-data" title={directoryTitle(c.code, i18n.language, t)}>{c.code}</span>
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
      {gaz.addressRegisters?.map((a) => (
        <li key={`addr-${a.country}`}>
          {/* "HR-ADR", in the same shape as the "HR-DGU" of the places above:
              the code names the source, and this source is the addresses. */}
          <span className="tools-geo-country gm-data" title={t("tools.geocode.dir.dguAddresses")}>
            {`${a.country}-ADR`}
          </span>
          <span className="tools-geo-count">
            {t("tools.geocode.addressMeta", { count: a.count, date: dateFmt.format(a.importedAt) })}
          </span>
          <button
            className="tools-geo-delete"
            onClick={() => void gaz.removeAddressRegister(a.country)}
            title={t("tools.geocode.deleteAddresses")}
            aria-label={t("tools.geocode.deleteAddresses")}
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
        <SelectMenu
          className="nav-btn tools-run tools-geo-osm"
          ariaLabel={t("tools.geocode.regionPick")}
          value=""
          placeholder={`${DOWNLOAD_GLYPH} ${t("tools.geocode.regionPick")}`}
          onChange={(region) => {
            if (region) void gaz.downloadRegion(region);
          }}
          options={regions.list.map(({ code, name }) => ({ value: code, label: name }))}
        />
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

/**
 * One source, named once above whatever it offers.
 *
 * The source's name is a label rather than words inside each control: a
 * register offers two downloads, and "GURS (Slovenia)" written into both would
 * say the same thing twice while what actually tells them apart — places
 * against addresses — is left to fight for the remaining space. With the name
 * lifted out, every row reads the same way: who it comes from, then what of
 * theirs you can take.
 */
function SourceGroup({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="tools-geo-source">
      <span className="tools-geo-source-name">{name}</span>
      <div className="tools-geo-source-actions">{children}</div>
    </div>
  );
}

/** A national register's pair: its settlements, and its house numbers. They
 *  share one description — choosing between GURS and DGU is choosing a country,
 *  while choosing between the two buttons is the smaller decision the tooltips
 *  carry, since what they cost differs by an order of magnitude. */
function RegisterSource({
  name,
  places,
  addresses,
}: {
  name: string;
  places: { onClick: () => void; title: string };
  addresses: { onClick: () => void; title: string };
}) {
  const { t } = useTranslation();
  return (
    <SourceGroup name={name}>
      <button className="nav-btn tools-run" onClick={places.onClick} title={places.title}>
        <span aria-hidden="true">{DOWNLOAD_GLYPH} </span>
        {t("tools.geocode.sourcePlaces")}
      </button>
      <button className="nav-btn tools-run" onClick={addresses.onClick} title={addresses.title}>
        <span aria-hidden="true">{DOWNLOAD_GLYPH} </span>
        {t("tools.geocode.sourceAddresses")}
      </button>
    </SourceGroup>
  );
}

/** The ways in: the two national registers (GURS, DGU), any country from
 *  OpenStreetMap, or a GeoNames file. The downloads need the online-lookups
 *  opt-in; the file import never does — and it sits under the paragraph that
 *  tells you where to fetch the file, because that instruction is half the
 *  button. */
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
          : running.stage === "storing"
            ? t("tools.geocode.storing")
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
            {/* The credit names the agency, so the agency's name is the link —
                to its own public viewer, where the datasets this row holds can
                be seen in full or one settlement checked against its source.
                The name itself is a proper noun in either language and stays
                out of the locale files. */}
            <RegisterSource
              name={t("tools.geocode.gursName")}
              places={{ onClick: () => void gaz.downloadSlovenia(), title: t("tools.geocode.gursTooltip") }}
              addresses={{
                onClick: () => void gaz.downloadSloveniaAddresses(),
                title: t("tools.geocode.gursAddressesTooltip"),
              }}
            />
            <p className="tools-geo-hint">
              {t("tools.geocode.sourceGurs")} ©{" "}
              <a href="https://ipi.eprostor.gov.si/jv/" target="_blank" rel="noreferrer">
                Geodetska uprava Republike Slovenije
              </a>
              {t("tools.geocode.licenseCcBy")}
            </p>
            <RegisterSource
              name={t("tools.geocode.dguName")}
              places={{ onClick: () => void gaz.downloadCroatia(), title: t("tools.geocode.dguTooltip") }}
              addresses={{
                onClick: () => void gaz.downloadCroatiaAddresses(),
                title: t("tools.geocode.dguAddressesTooltip"),
              }}
            />
            <p className="tools-geo-hint">
              {t("tools.geocode.sourceDgu")} ©{" "}
              <a href="https://geoportal.dgu.hr/" target="_blank" rel="noreferrer">
                Državna geodetska uprava
              </a>
              {t("tools.geocode.licenseOpen")}
            </p>
            {/* One control, not a pair: OpenStreetMap has no address register
                to offer, and the control opens the country list where the
                country picked is the click — the same shape as the map tab's
                "Add a free preset…". It never holds a selection, so it reads as
                its own label again the moment the download starts. */}
            <SourceGroup name="OpenStreetMap">
              <SelectMenu
                className="nav-btn tools-run tools-geo-osm"
                title={t("tools.geocode.countryTooltip")}
                ariaLabel={t("tools.geocode.countryTooltip")}
                value=""
                placeholder={`${DOWNLOAD_GLYPH} ${t("tools.geocode.sourcePlaces")}`}
                onChange={(code) => {
                  if (code) void gaz.downloadCountry(code);
                }}
                options={countries.map(({ code, name }) => ({ value: code, label: name }))}
              />
            </SourceGroup>
            <p className="tools-geo-hint">
              {t("tools.geocode.sourceOsm")} {t("tools.geocode.sourceOsmCredit")}{" "}
              <a href="https://www.openstreetmap.org" target="_blank" rel="noreferrer">
                OpenStreetMap
              </a>
              {t("tools.geocode.sourceOsmLicense")}
            </p>
          </>
        )}
        {/* The fallback: for a country neither download serves, and for anyone
            who would rather the app fetched nothing at all. Named like the rows
            above even though the arrow points the other way — where the data
            comes from is the thing being chosen either way. */}
        <SourceGroup name="GeoNames">
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
        </SourceGroup>
        <p className="tools-geo-hint">
          {t("tools.geocode.sourceGeoNames")}{" "}
          <a href="https://download.geonames.org/export/dump/" target="_blank" rel="noreferrer">
            download.geonames.org/export/dump
          </a>
          {t("tools.geocode.sourceGeoNames2")}©{" "}
          {/* Two links, two different things: the dump above is where the file
              is fetched from, this one is the project being credited. */}
          <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">
            GeoNames
          </a>
          {t("tools.geocode.licenseCcBy")}
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
/**
 * What a page says when it has no place directory to work with: what it cannot
 * do without one, and the one click to the place that manages them. The
 * controls themselves are deliberately *not* repeated here — two copies of the
 * same setup invite the reader to wonder which one is the real one.
 *
 * `note` is the page's own sentence, because the loss differs: the geocode list
 * can still take a coordinate typed by hand, while the compliance check has
 * nothing whatever to hold the file to.
 */
export function GazetteerMissing({ note }: { note: string }) {
  const { t } = useTranslation();
  return (
    <div className="tools-geo-gazetteer">
      <p className="tools-geo-empty">{note}</p>
      <button className="tools-issue-link" onClick={() => requestSettings("map")}>
        {t("tools.geocode.openSettings")}
      </button>
    </div>
  );
}

export function GazetteerSetup({ gaz }: { gaz: Gazetteer }) {
  const { t, i18n } = useTranslation();
  if (gaz.countries === null) return null;

  // Nothing loaded: say so and point at the one place that manages them. An
  // address register on its own counts as loaded: it answers houses, which is
  // most of what this tool is asked for.
  if (gaz.countries.length === 0 && !gaz.addressRegisters?.length) {
    return <GazetteerMissing note={t("tools.geocode.noGazetteer")} />;
  }

  return (
    <div className="tools-geo-gazetteer">
      <div className="tools-geo-summary">
        <span className="tools-geo-loaded" title={t("tools.geocode.loadedCountriesHint")}>{t("tools.geocode.loadedCountries")}</span>
        {gaz.countries.map((c) => (
          <span key={c.code} className="tools-geo-summary-entry" title={directoryTitle(c.code, i18n.language, t)}>
            <span className="tools-geo-country gm-data">{c.code}</span>
            <span className="tools-geo-count">{c.count.toLocaleString(i18n.language)}</span>
          </span>
        ))}
        {gaz.addressRegisters?.map((a) => (
          <span key={`addr-${a.country}`} className="tools-geo-summary-entry" title={t("tools.geocode.dir.dguAddresses")}>
            <span className="tools-geo-country gm-data">{`${a.country}-ADR`}</span>
            <span className="tools-geo-count">{a.count.toLocaleString(i18n.language)}</span>
          </span>
        ))}
        <button className="tools-issue-link" onClick={() => requestSettings("map")}>
          {t("tools.geocode.manageInSettings")}
        </button>
      </div>
    </div>
  );
}

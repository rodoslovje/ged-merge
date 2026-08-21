import {
  attachAdmin1Names,
  DGU_REGISTER,
  GURS_REGISTER,
  osmRegister,
  overpassFailure,
  overpassSubdivisions,
  overpassToEntries,
  parseGeoNamesLine,
  rgiCountyIndex,
  rgiPlacesToEntries,
  rpeNaseljaToEntries,
  rpeObcinaNames,
  subdivisionAdmin1,
  type DivisionNames,
  type GazEntry,
  type OverpassJson,
  type RgiOpcineJson,
  type RgiPlacesJson,
  type RgiZupanijeJson,
  type RpeNaseljaJson,
  type RpeObcineJson,
  type Subdivision,
} from "../geo/gazetteer";
import { AddressCollector } from "../geo/addressRegister";
import {
  parseAddressMember,
  parseAdminUnitNames,
  parsePostalDescriptors,
  parseThoroughfareNames,
  type HrSideTables,
} from "../geo/hrAd";
import { parseSiAddressPage, parseSiPostCodes, siAddressPageUrl, siPostalUrl, SI_AD_PAGE, type SiFeatureCollection } from "../geo/siAd";
import {
  annotatedCountryQuery,
  countryQuery,
  DGU_ADDRESSES_URL,
  DGU_OPCINE_URL,
  DGU_PLACES_URL,
  DGU_ZUPANIJE_URL,
  GURS_NASELJA_URL,
  GURS_OBCINE_URL,
  MAX_ANNOTATED_SUBDIVISIONS,
  OVERPASS_ENDPOINTS,
  regionQuery,
  subdivisionsQuery,
} from "../geo/sources";
import { extractZipTxt, zipEntries, zipEntryStream, type ZipEntry } from "../geo/zip";
import { GeoStoreError, getAddressIndex, getCountry, putAddressRegister, putCountry } from "../persist/geoDb";
import type { GeoFailure, GeoJob, GeoStage, GeoWorkerRequest, GeoWorkerResponse } from "./geoMessages";

// The geo-import worker: fetch a source, convert what comes back, and write it
// into the gedmerge-geo IndexedDB — for every source the app offers.
//
// All of it happens here, the downloading included. That is the point of the
// file: the registers and OpenStreetMap used to be fetched on the main thread
// by the settings component while the address registers were fetched here, so
// there were two of everything — two readers counting bytes, two ways to
// report a failure, two answers to what happens when the dialog closes
// mid-import. An import that owns its whole job can outlive the dialog that
// started it, and one that owns it in one place can only fail in one way.

function post(msg: GeoWorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

/** A failure with a reason the manager can put into words. Anything thrown
 *  that is not one of these is a bug rather than a foreseen outcome, and is
 *  reported as an unreadable payload with the browser's own wording. */
class GeoImportError extends Error {
  constructor(readonly failure: GeoFailure) {
    super(failure.code);
    this.name = "GeoImportError";
  }
}

let current = 0;

function progress(stage: GeoStage, done: number, total: number): void {
  post({ type: "progress", requestId: current, stage, done, total });
}

/**
 * Read a response body, counting the bytes as they arrive.
 *
 * Counted, never scaled, unless the caller says the announced length can be
 * believed: the total these downloads will come to is not knowable in general.
 * The GURS endpoint sends chunked and announces no length at all, and Overpass
 * announces one that counts the *compressed* body while the reader hands back
 * the decompressed bytes — which read as "140 %" and then kept climbing.
 * Whether a response was compressed is not something a cross-origin fetch may
 * ask (`Content-Encoding` is not CORS-safelisted, `Content-Length` is), so the
 * header cannot be corrected for, only distrusted. What is left is megabytes,
 * which are true. Croatia's address register is the exception the flag is for:
 * it is a zip, so what the server counts and what the reader hands back are the
 * same bytes.
 */
async function readBody(res: Response, stage: GeoStage, trustLength = false): Promise<ArrayBuffer> {
  const total = trustLength ? Number(res.headers.get("content-length")) || 0 : 0;
  if (!res.body) return await res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.byteLength;
    progress(stage, done, total);
  }
  const out = new Uint8Array(done);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

/** Fetch one source, with its bytes counted on the way in. Every download in
 *  this file goes through here, so "the download did not go through" means the
 *  same thing and is reported the same way whichever register was asked. */
async function fetchBytes(url: string, trustLength = false): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new GeoImportError({ code: "download" });
  }
  if (!res.ok) throw new GeoImportError({ code: "download" });
  return await readBody(res, "downloading", trustLength);
}

/** A small side table the main payload is joined against — the municipalities a
 *  register's places name, the counties those belong to. Undefined when it did
 *  not arrive: none of them is worth failing an import over, the places simply
 *  come in without whatever the table would have told them. */
async function fetchSide(url: string): Promise<ArrayBuffer | undefined> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.arrayBuffer() : undefined;
  } catch {
    return undefined;
  }
}

/** JSON out of downloaded bytes, as the source it came from is supposed to
 *  send. A register answering with something else is a failure of the
 *  download, not of the reader's file, and says so. */
function parseJson<T>(buffer: ArrayBuffer): T {
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as T;
  } catch (e) {
    throw new GeoImportError({ code: "unreadable", detail: e instanceof Error ? e.message : String(e) });
  }
}

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
async function fetchOverpass(query: string, stage: GeoStage): Promise<ArrayBuffer | "timeout" | "busy"> {
  let timedOut = false;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, { method: "POST", body: new URLSearchParams({ data: query }) });
      if (res.ok) {
        const buffer = await readBody(res, stage);
        // The remark is emitted after the elements, so the tail is enough — and
        // decoding the last few KB of a 30 MB country costs nothing.
        const tail = new TextDecoder().decode(
          new Uint8Array(buffer).slice(Math.max(0, buffer.byteLength - 4096)),
        );
        const failure = buffer.byteLength > 200 ? overpassFailure(tail) : "busy";
        if (!failure) return buffer;
        if (failure === "timeout") timedOut = true;
      }
    } catch {
      // An endpoint that cannot be reached is the next endpoint's turn.
    }
  }
  return timedOut ? "timeout" : "busy";
}

/** Write one directory, and say what landed. Every place import ends here. */
async function storeCountry(
  code: string,
  entries: GazEntry[],
  divisions?: DivisionNames,
): Promise<{ code: string; count: number }> {
  await putCountry({ code, count: entries.length, importedAt: Date.now(), entries, ...(divisions ? { divisions } : {}) });
  return { code, count: entries.length };
}

// --- The place directories -------------------------------------------------

/** The GURS register of Slovenian settlements. Stored under its own key so it
 *  sits alongside a GeoNames/OpenStreetMap "SI" import instead of replacing it
 *  — the two complement each other (GURS has the official settlements and
 *  bilingual names, OSM the hamlet tail). The key is a storage label only: the
 *  entries themselves stay country "SI", which is what lookupPlace's country
 *  gate compares. */
async function importGurs(): Promise<{ code: string; count: number }[]> {
  const buffer = await fetchBytes(GURS_NASELJA_URL);
  // The municipalities are a separate collection (212 rows) joined by
  // EID_OBCINA — what lets two settlements of one name be told apart
  // ("Soteska (Kamnik)" vs "Soteska (Dolenjske Toplice)").
  const side = await fetchSide(GURS_OBCINE_URL);
  progress("parsing", 0, 0);
  const obcine = side ? rpeObcinaNames(parseJson<RpeObcineJson>(side)) : undefined;
  const entries = rpeNaseljaToEntries(parseJson<RpeNaseljaJson>(buffer), obcine);
  if (!entries.length) throw new GeoImportError({ code: "empty" });
  return [await storeCountry(GURS_REGISTER, entries)];
}

/** The DGU register of Croatian geographical names. Same storage rule as GURS:
 *  its own key, so it complements rather than replaces an "HR" or "HR-OSM"
 *  directory. The entries stay country "HR", and the county codes are the ISO
 *  3166-2 digits those directories use too, so all of their name lists for a
 *  county pool into one. */
async function importDgu(): Promise<{ code: string; count: number }[]> {
  const buffer = await fetchBytes(DGU_PLACES_URL);
  // The register names each place's municipality on the feature itself, but the
  // county it sits in — what a place string written in English calls
  // "Primorje-Gorski Kotar" — takes the two administrative-unit tables. They are
  // 78 KB together, and failing to get them costs the county and nothing else.
  const [opcine, zupanije] = await Promise.all([fetchSide(DGU_OPCINE_URL), fetchSide(DGU_ZUPANIJE_URL)]);
  progress("parsing", 0, 0);
  const counties =
    opcine && zupanije
      ? rgiCountyIndex(parseJson<RgiOpcineJson>(opcine), parseJson<RgiZupanijeJson>(zupanije))
      : undefined;
  const entries = rgiPlacesToEntries(parseJson<RgiPlacesJson>(buffer), counties?.byUnit);
  if (!entries.length) throw new GeoImportError({ code: "empty" });
  return [await storeCountry(DGU_REGISTER, entries, counties?.divisions)];
}

/** The country's subdivisions, or [] when it has none mapped or the query did
 *  not answer — the caller treats both the same. */
async function fetchSubdivisions(country: string): Promise<Subdivision[]> {
  progress("regions", 0, 0);
  const res = await fetchOverpass(subdivisionsQuery(country), "regions");
  if (typeof res === "string") return [];
  try {
    return overpassSubdivisions(JSON.parse(new TextDecoder().decode(res)), country);
  } catch {
    return [];
  }
}

/**
 * OpenStreetMap places, for a whole country or for one of its subdivisions.
 *
 * The subdivision list comes first for a whole country (tags only, answers in
 * seconds): with it the places query groups every place under its county/state,
 * so each entry can say where it is. Without one — none mapped, too many, or
 * the list query itself failed — the plain query still downloads everything,
 * the entries just carry no division label. And when the country turns out to
 * be more than one query will do, that same list is what the failure carries
 * back, so the manager can offer it instead of reporting a dead end.
 */
async function importOsm(country: string, region?: string): Promise<{ code: string; count: number }[]> {
  const subdivisions = region ? [] : await fetchSubdivisions(country);
  const annotate = subdivisions.length > 0 && subdivisions.length <= MAX_ANNOTATED_SUBDIVISIONS;
  const query = region ? regionQuery(region) : annotate ? annotatedCountryQuery(subdivisions) : countryQuery(country);
  progress("waiting", 0, 0);
  const res = await fetchOverpass(query, "downloading");
  if (res === "timeout") {
    // Not an error the reader can do anything about as such: the country simply
    // has to be asked for in pieces, and the pieces travel with the failure. A
    // region that times out on its own carries none, and reads as the dead end
    // it is.
    throw new GeoImportError({ code: "tooLarge", regions: region ? [] : subdivisions, ...(region ? { region } : {}) });
  }
  if (res === "busy") throw new GeoImportError({ code: "busy" });

  progress("parsing", 0, 0);
  const admin1 = region ? subdivisionAdmin1(region) : "";
  const { entries, divisions } = overpassToEntries(parseJson<OverpassJson>(res), country, admin1);
  if (!entries.length) throw new GeoImportError({ code: "empty" });
  // Stored as "SI-OSM", not "SI": the storage key names the source, so this
  // sits alongside a GeoNames import of the same country rather than replacing
  // it. The entries themselves keep the bare country code.
  const code = osmRegister(country);
  // A region download is one piece of the country's directory, so it merges
  // into it: the other regions stay (their division names too), and re-fetching
  // this one replaces only its own entries. Whole-country downloads keep
  // replacing outright — that is a fresh copy of everything.
  if (!admin1) return [await storeCountry(code, entries, divisions)];
  const stored = await getCountry(code);
  const merged = [...(stored?.entries ?? []).filter((e) => e.admin1 !== admin1), ...entries];
  return [await storeCountry(code, merged, { ...stored?.divisions, ...divisions })];
}

const CHUNK = 4 * 1024 * 1024;

/** Parse the dump text streaming by chunk, reporting progress in bytes. */
function parseDump(bytes: Uint8Array<ArrayBuffer>): Map<string, GazEntry[]> {
  const byCountry = new Map<string, GazEntry[]>();
  const decoder = new TextDecoder();
  let remainder = "";
  const handle = (line: string) => {
    const entry = parseGeoNamesLine(line);
    if (!entry) return;
    const list = byCountry.get(entry.country);
    if (list) list.push(entry);
    else byCountry.set(entry.country, [entry]);
  };
  for (let off = 0; off < bytes.byteLength; off += CHUNK) {
    const text = remainder + decoder.decode(bytes.subarray(off, Math.min(off + CHUNK, bytes.byteLength)), { stream: true });
    const lines = text.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) handle(line);
    progress("parsing", Math.min(off + CHUNK, bytes.byteLength), bytes.byteLength);
  }
  if (remainder) handle(remainder);
  return byCountry;
}

/** A GeoNames extract off the reader's own disk — the one source that is not
 *  downloaded, and the only one that can hold several countries at once. */
async function importFile(file: File): Promise<{ code: string; count: number }[]> {
  const buffer = await file.arrayBuffer();
  let bytes = new Uint8Array(buffer);
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (isZip) {
    const extracted = await extractZipTxt(buffer);
    if (!extracted) throw new GeoImportError({ code: "unreadable", detail: "no .txt entry in the zip" });
    bytes = extracted;
  }
  const byCountry = parseDump(bytes);
  if (!byCountry.size) throw new GeoImportError({ code: "empty" });
  const countries: { code: string; count: number }[] = [];
  for (const [code, entries] of byCountry) {
    countries.push(await storeCountry(code, entries, attachAdmin1Names(entries)));
  }
  countries.sort((a, b) => b.count - a.count);
  return countries;
}

// --- The national address registers ---------------------------------------
//
// Croatia arrives as four GML files in one zip: three side tables small enough
// to read whole, and a fourth of 2.6 GB that is never held. Slovenia arrives as
// 116 pages off a WFS, fetched here rather than on the main thread so a gigabyte
// of JSON is parsed and dropped page by page. Both end in the same buckets.

/** One zip entry decoded to a string. For the side tables only: the address
 *  file is far past the length a JS string may reach. */
async function entryText(buffer: ArrayBuffer, entry: ZipEntry): Promise<string> {
  const decoder = new TextDecoder();
  const reader = zipEntryStream(buffer, entry).getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** Members are separated by this; a chunk boundary can fall anywhere inside
 *  one, so the tail is carried over to the next chunk. */
const MEMBER_END = "</wfs:member>";

/**
 * Parse the INSPIRE address download into per-settlement buckets and store it.
 *
 * The 2.6 GB of Address.gml is read as a stream and split member by member, so
 * the worker never holds more than one chunk of it plus the buckets themselves
 * — the difference between an import that runs on an ordinary laptop and one
 * that cannot run at all.
 */
async function importHrAddresses(): Promise<number> {
  const buffer = await fetchBytes(DGU_ADDRESSES_URL, true);

  const entries = zipEntries(buffer);
  const entryNamed = (name: string) => entries.find((e) => e.name.toLowerCase().endsWith(name.toLowerCase()));
  const adminEntry = entryNamed("AdminUnitName.gml");
  const addressEntry = entryNamed("Address.gml");
  if (!adminEntry || !addressEntry) {
    throw new GeoImportError({ code: "unreadable", detail: "no address or settlement file in the download" });
  }

  const settlements = parseAdminUnitNames(await entryText(buffer, adminEntry));
  if (!settlements.size) throw new GeoImportError({ code: "empty" });
  // Street and post names are what an answer *reads* like, not whether it can
  // be found: a download missing them still places every house.
  const streetEntry = entryNamed("ThoroughfareName.gml");
  const postEntry = entryNamed("PostalDescriptor.gml");
  const tables: HrSideTables = {
    settlements,
    streets: streetEntry ? parseThoroughfareNames(await entryText(buffer, streetEntry)) : new Map(),
    posts: postEntry ? parsePostalDescriptors(await entryText(buffer, postEntry)) : new Map(),
  };

  const collector = new AddressCollector("HR");
  const decoder = new TextDecoder();
  const reader = zipEntryStream(buffer, addressEntry).getReader();
  let read = 0;
  let carry = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    read += value.byteLength;
    const text = carry + decoder.decode(value, { stream: true });
    const parts = text.split(MEMBER_END);
    carry = parts.pop() ?? "";
    for (const part of parts) {
      const row = parseAddressMember(part, tables);
      if (row) collector.add(row);
    }
    progress("parsing", read, addressEntry.uncompressedSize);
  }
  const last = parseAddressMember(carry + decoder.decode(), tables);
  if (last) collector.add(last);
  if (!collector.count) throw new GeoImportError({ code: "empty" });

  const buckets = collector.buckets();
  await putAddressRegister(collector.index(Date.now()), buckets, (done, all) => progress("storing", done, all));
  return collector.count;
}

/**
 * Fetch and store the Slovenian address register, page by page.
 *
 * The fetching happens here rather than on the main thread because there is a
 * lot of it: 575 773 addresses come to something over a gigabyte of JSON, which
 * only stays manageable because each page is parsed into rows and then dropped.
 * (On the wire it is far less — the service gzips about 27-fold and the browser
 * asks for that itself — but decompressed is what a parser sees.)
 *
 * Progress counts addresses against the total the first page declares, which is
 * a true percentage from the second page onwards.
 */
async function importSiAddresses(): Promise<number> {
  // The post codes first: 466 rows in one request, and what turns a register
  // answer's "Adlešiči" into "8341 Adlešiči". Failing to get them costs the
  // code on the label and nothing else.
  const postsBuffer = await fetchSide(siPostalUrl());
  const posts = postsBuffer ? parseSiPostCodes(parseJson<SiFeatureCollection>(postsBuffer)) : undefined;

  const collector = new AddressCollector("SI");
  let total = 0;
  // A backstop, not a plan: the loop ends on a short page. But `startIndex` is
  // exactly the parameter the *other* GURS endpoint silently ignores — which
  // would make every page the first one and this loop run for ever — so the
  // country's own size, doubled, is the point at which something is wrong.
  const maxPages = 2 * Math.ceil(700_000 / SI_AD_PAGE);
  for (let page = 0; page < maxPages; page++) {
    let res: Response;
    try {
      res = await fetch(siAddressPageUrl(page * SI_AD_PAGE));
    } catch {
      throw new GeoImportError({ code: "download" });
    }
    if (!res.ok) throw new GeoImportError({ code: "download" });
    const body = (await res.json()) as SiFeatureCollection;
    const rows = parseSiAddressPage(body, posts);
    for (const row of rows) collector.add(row);
    total = body.numberMatched ?? total;
    progress("downloading", collector.count, total);
    // The service stops answering with features once the collection runs out;
    // a short page is the last one. Counting against numberMatched instead
    // would trust a total that can change between pages.
    if (!body.numberReturned || body.numberReturned < SI_AD_PAGE) break;
  }
  if (!collector.count) throw new GeoImportError({ code: "empty" });

  await putAddressRegister(collector.index(Date.now()), collector.buckets(), (done, all) =>
    progress("storing", done, all),
  );
  return collector.count;
}

/** The addresses of one country, and the check that they are really stored.
 *  The store is the only product of a run that takes minutes, and a write that
 *  failed must not be reported as a success that leaves the manager showing
 *  nothing and saying nothing. */
async function importAddresses(country: "SI" | "HR"): Promise<number> {
  const count = country === "HR" ? await importHrAddresses() : await importSiAddresses();
  const stored = await getAddressIndex(country);
  if (!stored) throw new GeoImportError({ code: "storeRefused", detail: "the register was not there when read back" });
  return count;
}

// --- One way in, one way out ----------------------------------------------

/** What a thrown thing means to the manager. A store that refused the write
 *  says which of the two refusals it was; a foreseen failure carries its own
 *  reason; anything else is reported with the browser's own wording rather
 *  than as a silence. */
function failureOf(e: unknown): GeoFailure {
  if (e instanceof GeoImportError) return e.failure;
  if (e instanceof GeoStoreError) {
    return e.kind === "blocked" ? { code: "storeBlocked" } : { code: "storeRefused", detail: e.detail };
  }
  return { code: "unreadable", detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
}

async function run(job: GeoJob): Promise<GeoWorkerResponse> {
  if (job.kind === "addresses") {
    const count = await importAddresses(job.country);
    return { type: "addressRegister", requestId: current, country: job.country, count };
  }
  const countries =
    job.kind === "gurs"
      ? await importGurs()
      : job.kind === "dgu"
        ? await importDgu()
        : job.kind === "file"
          ? await importFile(job.file)
          : await importOsm(job.country, job.region);
  return { type: "result", requestId: current, countries };
}

self.onmessage = async (event: MessageEvent<GeoWorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== "import") return;
  current = msg.requestId;
  progress("waiting", 0, 0);
  try {
    post(await run(msg.job));
  } catch (e) {
    post({ type: "error", requestId: msg.requestId, failure: failureOf(e) });
  }
};

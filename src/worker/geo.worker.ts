import {
  attachAdmin1Names,
  DGU_REGISTER,
  GURS_REGISTER,
  osmRegister,
  overpassToEntries,
  parseGeoNamesLine,
  rgiCountyIndex,
  rgiPlacesToEntries,
  rpeNaseljaToEntries,
  rpeObcinaNames,
  subdivisionAdmin1,
  type GazEntry,
  type OverpassJson,
  type RgiOpcineJson,
  type RgiPlacesJson,
  type RgiZupanijeJson,
  type RpeNaseljaJson,
  type RpeObcineJson,
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
import { extractZipTxt, zipEntries, zipEntryStream, type ZipEntry } from "../geo/zip";
import { getAddressIndex, getCountry, putAddressRegister, putCountry } from "../persist/geoDb";
import type { GeoWorkerRequest, GeoWorkerResponse } from "./geoMessages";

// Gazetteer import worker: decompress (if zipped), parse the tab-separated
// GeoNames dump streaming line-by-line, group entries by country, and write
// each country into the gedmerge-geo IndexedDB. Progress is reported by
// input bytes so a 100 MB extract shows movement immediately.

function post(msg: GeoWorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

const CHUNK = 4 * 1024 * 1024;

/** Parse the dump text streaming by chunk, reporting progress in bytes. */
function parseDump(bytes: Uint8Array<ArrayBuffer>, requestId: number): Map<string, GazEntry[]> {
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
    post({ type: "progress", requestId, done: Math.min(off + CHUNK, bytes.byteLength), total: bytes.byteLength });
  }
  if (remainder) handle(remainder);
  return byCountry;
}

// --- The national address registers ---------------------------------------
//
// Croatia arrives as four GML files in one zip: three side tables small enough
// to read whole, and a fourth of 2.6 GB that is never held. Slovenia arrives as
// 116 pages off a WFS, fetched here rather than on the main thread so a gigabyte
// of JSON is parsed and dropped page by page. Both end in the same buckets.

/**
 * The Croatian address register, as the DGU's INSPIRE download service serves
 * it: every one of the country's 1.68 million house numbers with its
 * coordinate, refreshed weekly, CORS open so this worker can fetch it directly.
 *
 * A download and not a query because there is nothing to query: Croatia's
 * address WFS is open to Croatian public bodies only, which is what the DGU
 * answers when asked. Data © Državna geodetska uprava.
 */
const DGU_ADDRESSES_URL = "https://geoportal.dgu.hr/services/atom/INSPIRE_Addresses_(AD).zip";

/** Read a response to the end, counting the bytes as they arrive. */
async function readAll(res: Response, onProgress: (done: number) => void): Promise<ArrayBuffer> {
  if (!res.body) return res.arrayBuffer();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.byteLength;
    onProgress(done);
  }
  const out = new Uint8Array(done);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out.buffer;
}

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
async function importHrAddresses(requestId: number): Promise<number> {
  // Fetched here rather than handed in: an import that owns its whole job can
  // outlive the dialog that started it (see addressDownload.ts). The announced
  // length can be believed — it is a zip, so what the server counts and what
  // the reader hands back are the same bytes.
  const res = await fetch(DGU_ADDRESSES_URL);
  if (!res.ok) throw new Error(`the address download answered HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const buffer = await readAll(res, (done) =>
    post({ type: "progress", requestId, done, total, stage: "downloading" }),
  );

  const entries = zipEntries(buffer);
  const entryNamed = (name: string) =>
    entries.find((e) => e.name.toLowerCase().endsWith(name.toLowerCase()));
  const adminEntry = entryNamed("AdminUnitName.gml");
  const addressEntry = entryNamed("Address.gml");
  if (!adminEntry || !addressEntry) throw new Error("the download is missing its address or settlement file");

  const settlements = parseAdminUnitNames(await entryText(buffer, adminEntry));
  if (!settlements.size) throw new Error("no settlements in the address register");
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
    post({ type: "progress", requestId, done: read, total: addressEntry.uncompressedSize, stage: "parsing" });
  }
  const last = parseAddressMember(carry + decoder.decode(), tables);
  if (last) collector.add(last);
  if (!collector.count) throw new Error("no addresses in the register download");

  const buckets = collector.buckets();
  await putAddressRegister(collector.index(Date.now()), buckets, (done, all) =>
    post({ type: "progress", requestId, done, total: all, stage: "storing" }),
  );
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
async function importSiAddresses(requestId: number): Promise<number> {
  // The post codes first: 466 rows in one request, and what turns a register
  // answer's "Adlešiči" into "8341 Adlešiči". Failing to get them costs the
  // code on the label and nothing else.
  let posts: Map<string, string> | undefined;
  try {
    const res = await fetch(siPostalUrl());
    if (res.ok) posts = parseSiPostCodes((await res.json()) as SiFeatureCollection);
  } catch {
    posts = undefined;
  }

  const collector = new AddressCollector("SI");
  let total = 0;
  // A backstop, not a plan: the loop ends on a short page. But `startIndex` is
  // exactly the parameter the *other* GURS endpoint silently ignores — which
  // would make every page the first one and this loop run for ever — so the
  // country's own size, doubled, is the point at which something is wrong.
  const maxPages = 2 * Math.ceil(700_000 / SI_AD_PAGE);
  for (let page = 0; page < maxPages; page++) {
    const res = await fetch(siAddressPageUrl(page * SI_AD_PAGE));
    if (!res.ok) throw new Error(`the address service answered HTTP ${res.status}`);
    const body = (await res.json()) as SiFeatureCollection;
    const rows = parseSiAddressPage(body, posts);
    for (const row of rows) collector.add(row);
    total = body.numberMatched ?? total;
    post({ type: "progress", requestId, done: collector.count, total, stage: "downloading" });
    // The service stops answering with features once the collection runs out;
    // a short page is the last one. Counting against numberMatched instead
    // would trust a total that can change between pages.
    if (!body.numberReturned || body.numberReturned < SI_AD_PAGE) break;
  }
  if (!collector.count) throw new Error("no addresses in the register download");

  await putAddressRegister(collector.index(Date.now()), collector.buckets(), (done, all) =>
    post({ type: "progress", requestId, done, total: all, stage: "storing" }),
  );
  return collector.count;
}

self.onmessage = async (event: MessageEvent<GeoWorkerRequest>) => {
  const msg = event.data;
  if (msg.type === "downloadAddresses") {
    try {
      const count =
        msg.country === "HR" ? await importHrAddresses(msg.requestId) : await importSiAddresses(msg.requestId);
      // Read the index back before calling it done. The store is the only
      // product of a run that takes minutes, and a write that failed — a full
      // disk, a refused quota — must not be reported as a success that leaves
      // the manager showing nothing and saying nothing.
      const stored = await getAddressIndex(msg.country);
      if (!stored) throw new Error("the register could not be stored in this browser");
      post({ type: "addressRegister", requestId: msg.requestId, country: msg.country, count });
    } catch (e) {
      post({ type: "error", requestId: msg.requestId, message: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  if (msg.type !== "importGazetteer") return;
  const { requestId } = msg;
  try {
    if (msg.format === "rpe") {
      const obcine = msg.obcine
        ? rpeObcinaNames(JSON.parse(new TextDecoder().decode(msg.obcine)) as RpeObcineJson)
        : undefined;
      const entries = rpeNaseljaToEntries(
        JSON.parse(new TextDecoder().decode(msg.buffer)) as RpeNaseljaJson,
        obcine,
      );
      if (!entries.length) throw new Error("no settlements in the GURS result");
      // Stored under its own key so it sits alongside a GeoNames/OpenStreetMap
      // "SI" import instead of replacing it — the two complement each other
      // (GURS has the official settlements and bilingual names, OSM the hamlet
      // tail). The key is a storage label only: the entries themselves stay
      // country "SI", which is what lookupPlace's country gate compares.
      await putCountry({ code: GURS_REGISTER, count: entries.length, importedAt: Date.now(), entries });
      post({ type: "result", requestId, countries: [{ code: GURS_REGISTER, count: entries.length }] });
      return;
    }
    if (msg.format === "rgi") {
      // The two administrative-unit tables are what let a place name its county;
      // either one missing costs the county and nothing else.
      const counties =
        msg.opcine && msg.zupanije
          ? rgiCountyIndex(
              JSON.parse(new TextDecoder().decode(msg.opcine)) as RgiOpcineJson,
              JSON.parse(new TextDecoder().decode(msg.zupanije)) as RgiZupanijeJson,
            )
          : undefined;
      const entries = rgiPlacesToEntries(
        JSON.parse(new TextDecoder().decode(msg.buffer)) as RgiPlacesJson,
        counties?.byUnit,
      );
      if (!entries.length) throw new Error("no places in the DGU result");
      // Same storage rule as GURS: its own key, so it complements rather than
      // replaces an "HR" or "HR-OSM" directory. The entries stay country "HR",
      // and the county codes are the ISO 3166-2 digits those directories use
      // too, so all of their name lists for a county pool into one.
      await putCountry({
        code: DGU_REGISTER,
        count: entries.length,
        importedAt: Date.now(),
        entries,
        ...(counties ? { divisions: counties.divisions } : {}),
      });
      post({ type: "result", requestId, countries: [{ code: DGU_REGISTER, count: entries.length }] });
      return;
    }
    if (msg.format === "overpass") {
      const country = msg.country ?? "??";
      const admin1 = msg.region ? subdivisionAdmin1(msg.region) : "";
      const { entries, divisions } = overpassToEntries(
        JSON.parse(new TextDecoder().decode(msg.buffer)) as OverpassJson,
        country,
        admin1,
      );
      if (!entries.length) throw new Error("no places in the Overpass result");
      // Stored as "SI-OSM", not "SI": the storage key names the source, so this
      // sits alongside a GeoNames import of the same country rather than
      // replacing it. The entries themselves keep the bare country code, which
      // is what lookupPlace's country gate compares.
      const code = osmRegister(country);
      // A region download is one piece of the country's directory, so it merges
      // into it: the other regions stay (their division names too), and
      // re-fetching this one replaces only its own entries. Whole-country
      // downloads keep replacing outright — that is a fresh copy of everything.
      let merged = entries;
      let mergedDivisions = divisions;
      if (admin1) {
        const stored = await getCountry(code);
        merged = [...(stored?.entries ?? []).filter((e) => e.admin1 !== admin1), ...entries];
        mergedDivisions = { ...stored?.divisions, ...divisions };
      }
      await putCountry({ code, count: merged.length, importedAt: Date.now(), entries: merged, divisions: mergedDivisions });
      post({ type: "result", requestId, countries: [{ code, count: merged.length }] });
      return;
    }
    let bytes = new Uint8Array(msg.buffer);
    const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
    if (isZip) {
      const extracted = await extractZipTxt(msg.buffer);
      if (!extracted) throw new Error("no .txt entry found in the zip");
      bytes = extracted;
    }
    const byCountry = parseDump(bytes, requestId);
    if (!byCountry.size) throw new Error("no gazetteer rows recognized");
    const countries: { code: string; count: number }[] = [];
    for (const [code, entries] of byCountry) {
      const divisions = attachAdmin1Names(entries);
      await putCountry({ code, count: entries.length, importedAt: Date.now(), entries, divisions });
      countries.push({ code, count: entries.length });
    }
    countries.sort((a, b) => b.count - a.count);
    post({ type: "result", requestId, countries });
  } catch (e) {
    post({ type: "error", requestId, message: e instanceof Error ? e.message : String(e) });
  }
};

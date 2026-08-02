import {
  GURS_REGISTER,
  osmRegister,
  overpassToEntries,
  parseGeoNamesLine,
  rpeNaseljaToEntries,
  rpeObcinaNames,
  subdivisionAdmin1,
  type GazEntry,
  type OverpassJson,
  type RpeNaseljaJson,
  type RpeObcineJson,
} from "../geo/gazetteer";
import { extractZipTxt } from "../geo/zip";
import { getCountry, putCountry } from "../persist/geoDb";
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

self.onmessage = async (event: MessageEvent<GeoWorkerRequest>) => {
  const msg = event.data;
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
    if (msg.format === "overpass") {
      const country = msg.country ?? "??";
      const admin1 = msg.region ? subdivisionAdmin1(msg.region) : "";
      const entries = overpassToEntries(
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
      // into it: the other regions stay, and re-fetching this one replaces only
      // its own entries. Whole-country downloads keep replacing outright — that
      // is a fresh copy of everything.
      let merged = entries;
      if (admin1) {
        const stored = await getCountry(code);
        merged = [...(stored?.entries ?? []).filter((e) => e.admin1 !== admin1), ...entries];
      }
      await putCountry({ code, count: merged.length, importedAt: Date.now(), entries: merged });
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
      await putCountry({ code, count: entries.length, importedAt: Date.now(), entries });
      countries.push({ code, count: entries.length });
    }
    countries.sort((a, b) => b.count - a.count);
    post({ type: "result", requestId, countries });
  } catch (e) {
    post({ type: "error", requestId, message: e instanceof Error ? e.message : String(e) });
  }
};

import { parseGeoNamesLine, type GazEntry } from "../geo/gazetteer";
import { putCountry } from "../persist/geoDb";
import type { GeoWorkerRequest, GeoWorkerResponse } from "./geoMessages";

// Gazetteer import worker: decompress (if zipped), parse the tab-separated
// GeoNames dump streaming line-by-line, group entries by country, and write
// each country into the gedmerge-geo IndexedDB. Progress is reported by
// input bytes so a 100 MB extract shows movement immediately.

function post(msg: GeoWorkerResponse): void {
  (self as unknown as Worker).postMessage(msg);
}

/** Inflate a raw-deflate block via the native DecompressionStream. */
async function inflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Minimal ZIP reader for GeoNames dumps: walks the local file headers and
 * returns the first `.txt` entry that isn't the bundled readme. GeoNames
 * zips are plain (sizes in the header, stored or deflate) — this is not a
 * general ZIP implementation.
 */
async function extractZipTxt(buffer: ArrayBuffer): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let off = 0;
  while (off + 30 <= buffer.byteLength && view.getUint32(off, true) === 0x04034b50) {
    const method = view.getUint16(off + 8, true);
    const compressedSize = view.getUint32(off + 18, true);
    const nameLen = view.getUint16(off + 26, true);
    const extraLen = view.getUint16(off + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 30, off + 30 + nameLen));
    const dataStart = off + 30 + nameLen + extraLen;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    if (/\.txt$/i.test(name) && !/readme/i.test(name)) {
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(`unsupported zip compression method ${method}`);
    }
    off = dataStart + compressedSize;
  }
  return undefined;
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

// Minimal ZIP reader for the downloaded reference data. GeoNames country
// extracts (SI.zip, …) are written in streaming mode (general-purpose bit 3
// set), so their *local* file headers carry a zero compressed size — the true
// sizes and offsets live only in the central directory. Reading the central
// directory is therefore the only reliable way to locate an entry's data. Not a
// general ZIP implementation (no ZIP64), but neither a GeoNames country file nor
// the Croatian address register comes near 4 GB compressed.

/** One entry of the central directory, located and ready to read. */
export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate; anything else this reader cannot open. */
  method: number;
  compressedSize: number;
  /** What the entry inflates to, as the directory records it. */
  uncompressedSize: number;
  /** Offset of the entry's data in the buffer, past its local header. */
  dataStart: number;
}

/** Every entry the central directory lists. Empty for a buffer that is not a
 *  zip at all, which the callers treat as "nothing to extract". */
export function zipEntries(buffer: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEocd(view, buffer.byteLength);
  if (eocd < 0) return [];
  const count = view.getUint16(eocd + 10, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let off = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count && off + 46 <= buffer.byteLength && view.getUint32(off, true) === 0x02014b50; i++) {
    const method = view.getUint16(off + 10, true);
    const compressedSize = view.getUint32(off + 20, true);
    const uncompressedSize = view.getUint32(off + 24, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = decoder.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    // The local header repeats the name/extra lengths (which may differ from
    // the central-directory entry's), so re-read them to find the data start.
    const localNameLen = view.getUint16(localOff + 26, true);
    const localExtraLen = view.getUint16(localOff + 28, true);
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      dataStart: localOff + 30 + localNameLen + localExtraLen,
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * One entry's bytes as a stream, inflated on the way out.
 *
 * A stream rather than a buffer because of the register: the Croatian addresses
 * are 85 MB of deflate that become 2.6 GB of GML, which no browser will hand
 * back as one ArrayBuffer — but read a chunk at a time and never kept, they cost
 * nothing. The GeoNames path below reads the same stream to completion, since
 * those entries really do fit.
 */
export function zipEntryStream(buffer: ArrayBuffer, entry: ZipEntry): ReadableStream<Uint8Array> {
  const data = new Uint8Array(buffer).subarray(entry.dataStart, entry.dataStart + entry.compressedSize);
  const raw = new Blob([data]).stream();
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipeThrough(new DecompressionStream("deflate-raw"));
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

/** Locate the End Of Central Directory record (signature `PK\x05\x06`) by
 *  scanning backward from the end — it sits at the tail, past an optional
 *  comment of up to 64 KB. Returns its offset, or -1 if not a valid zip. */
function findEocd(view: DataView, size: number): number {
  const min = Math.max(0, size - (0xffff + 22));
  for (let off = size - 22; off >= min; off--) {
    if (view.getUint32(off, true) === 0x06054b50) return off;
  }
  return -1;
}

/**
 * Read the central directory to find the first `.txt` entry that isn't the
 * bundled readme, then extract it. Returns undefined for a non-zip buffer or a
 * zip with no matching entry.
 */
export async function extractZipTxt(buffer: ArrayBuffer): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const entry = zipEntries(buffer).find((e) => /\.txt$/i.test(e.name) && !/readme/i.test(e.name));
  if (!entry) return undefined;
  return new Uint8Array(await new Response(zipEntryStream(buffer, entry)).arrayBuffer());
}

// Minimal ZIP reader for GeoNames dumps. GeoNames country extracts (SI.zip,
// …) are written in streaming mode (general-purpose bit 3 set), so their
// *local* file headers carry a zero compressed size — the true sizes and
// offsets live only in the central directory. Reading the central directory
// is therefore the only reliable way to locate an entry's data. Not a general
// ZIP implementation (no ZIP64), but GeoNames country files stay under 4 GB.

/** Inflate a raw-deflate block via the native DecompressionStream. */
async function inflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
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
 * bundled readme, then extract it (stored or deflate). Returns undefined for a
 * non-zip buffer or a zip with no matching entry.
 */
export async function extractZipTxt(buffer: ArrayBuffer): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEocd(view, buffer.byteLength);
  if (eocd < 0) return undefined;
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  for (let i = 0; i < count && off + 46 <= buffer.byteLength && view.getUint32(off, true) === 0x02014b50; i++) {
    const method = view.getUint16(off + 10, true);
    const compressedSize = view.getUint32(off + 20, true);
    const nameLen = view.getUint16(off + 28, true);
    const extraLen = view.getUint16(off + 30, true);
    const commentLen = view.getUint16(off + 32, true);
    const localOff = view.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    if (/\.txt$/i.test(name) && !/readme/i.test(name)) {
      // The local header repeats the name/extra lengths (which may differ from
      // the central-directory entry's), so re-read them to find the data start.
      const localNameLen = view.getUint16(localOff + 26, true);
      const localExtraLen = view.getUint16(localOff + 28, true);
      const dataStart = localOff + 30 + localNameLen + localExtraLen;
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(`unsupported zip compression method ${method}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return undefined;
}

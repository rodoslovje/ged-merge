import { describe, it, expect } from "vitest";
import { crc32, deflateRawSync } from "node:zlib";
import { extractZipTxt } from "./zip";

/**
 * Build a ZIP the way GeoNames does: streaming mode (general-purpose bit 3
 * set), so each local file header carries a zero compressed size and the real
 * sizes live in a trailing data descriptor and the central directory. This is
 * the exact shape that broke the old local-header-walking reader.
 */
function buildStreamingZip(entries: { name: string; content: string; method?: 0 | 8 }[]): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const { name, content, method = 8 } of entries) {
    const nameBytes = Buffer.from(enc.encode(name));
    const raw = Buffer.from(enc.encode(content));
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw) >>> 0;

    // Local file header — sizes deliberately zero (bit 3 = data descriptor).
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0808, 6); // flags: bit 3 (data descriptor) + bit 11 (UTF-8)
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); // time
    lh.writeUInt16LE(0, 12); // date
    lh.writeUInt32LE(0, 14); // crc — zero in the local header
    lh.writeUInt32LE(0, 18); // compressed size — zero
    lh.writeUInt32LE(0, 22); // uncompressed size — zero
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28); // extra length

    // Data descriptor after the data (with signature).
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(comp.length, 8);
    dd.writeUInt32LE(raw.length, 12);

    const localOffset = offset;
    const localBlock = Buffer.concat([lh, nameBytes, comp, dd]);
    locals.push(localBlock);
    offset += localBlock.length;

    // Central directory entry — carries the true sizes and the local offset.
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0808, 8); // flags
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12); // time
    cd.writeUInt16LE(0, 14); // date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20); // compressed size — the true value
    cd.writeUInt32LE(raw.length, 24); // uncompressed size
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt16LE(0, 30); // extra length
    cd.writeUInt16LE(0, 32); // comment length
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(localOffset, 42);
    centrals.push(Buffer.concat([cd, nameBytes]));
  }

  const localAll = Buffer.concat(locals);
  const centralAll = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralAll.length, 12);
  eocd.writeUInt32LE(localAll.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  const zip = Buffer.concat([localAll, centralAll, eocd]);
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

const SI_TXT = "3186635\tŠkofja Loka\tSkofja Loka\t\t46.16556\t14.30583\tP\tPPL\tSI\t\t07\t\t\t\t12256";

describe("extractZipTxt", () => {
  it("reads the country .txt from a GeoNames-style streaming zip (readme first)", async () => {
    // readme.txt comes first with a zero-size local header — the exact layout
    // that made the old local-header walk stop before reaching the .txt.
    const zip = buildStreamingZip([
      { name: "readme.txt", content: "GeoNames export — CC-BY.\n" },
      { name: "SI.txt", content: SI_TXT },
    ]);
    const out = await extractZipTxt(zip);
    expect(out).toBeDefined();
    expect(new TextDecoder().decode(out!)).toBe(SI_TXT);
  });

  it("handles a stored (uncompressed) entry", async () => {
    const zip = buildStreamingZip([{ name: "SI.txt", content: SI_TXT, method: 0 }]);
    const out = await extractZipTxt(zip);
    expect(new TextDecoder().decode(out!)).toBe(SI_TXT);
  });

  it("returns undefined when the zip has only a readme", async () => {
    const zip = buildStreamingZip([{ name: "readme.txt", content: "nothing here" }]);
    expect(await extractZipTxt(zip)).toBeUndefined();
  });

  it("returns undefined for a non-zip buffer", async () => {
    const buf = new TextEncoder().encode("not a zip at all").buffer;
    expect(await extractZipTxt(buf as ArrayBuffer)).toBeUndefined();
  });
});

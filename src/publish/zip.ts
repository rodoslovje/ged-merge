/**
 * A minimal ZIP writer for the family website's download: the page and its
 * photos, stored as they are. Photos are already compressed (JPEG, PNG), so
 * deflating them would cost time for nothing; the page is small beside them.
 * Names are UTF-8 (general-purpose bit 11). No ZIP64: a family's website is
 * far from 4 GB. `geo/zip.ts` reads these back.
 *
 * Each file keeps its own modification time — a photo the time of its
 * original — in the DOS fields (local time, 2-second steps) and, to the
 * second in UTC, in the extended-timestamp field (0x5455) `unzip` restores.
 * Unpacked, an unchanged photo then has an unchanged time, so `rsync` to the
 * web server skips it.
 */

export interface ZipFile {
  /** The path inside the archive, `/`-separated (`photos/o1x.jpg`). */
  name: string;
  data: Uint8Array;
  /** When the file was last changed; the archive's time when omitted. */
  modified?: Date;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The MS-DOS time and date fields a ZIP entry carries. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const UTF8_NAMES = 0x0800;

/** The extended-timestamp extra field, modification time only (9 bytes);
 *  the local and central headers carry the same. */
function unixTimeField(d: Date): Uint8Array {
  const field = new Uint8Array(9);
  const v = new DataView(field.buffer);
  v.setUint16(0, 0x5455, true);
  v.setUint16(2, 5, true);
  v.setUint8(4, 1); // the modification time is present
  v.setUint32(5, Math.max(0, Math.floor(d.getTime() / 1000)), true);
  return field;
}

/** The archive's bytes: every file stored, then the central directory. */
export function zipFiles(files: ZipFile[], when: Date = new Date()): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const modified = f.modified ?? when;
    const { time, date } = dosDateTime(modified);
    const extra = unixTimeField(modified);
    const local = new Uint8Array(30 + name.length + extra.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, UTF8_NAMES, true);
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, extra.length, true);
    local.set(name, 30);
    local.set(extra, 30 + name.length);
    parts.push(local, f.data);

    const entry = new Uint8Array(46 + name.length + extra.length);
    const cv = new DataView(entry.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, UTF8_NAMES, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, extra.length, true);
    cv.setUint32(42, offset, true);
    entry.set(name, 46);
    entry.set(extra, 46 + name.length);
    central.push(entry);
    offset += local.length + f.data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const p of [...parts, ...central, end]) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

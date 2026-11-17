import { describe, expect, it } from "vitest";
import { zipEntries, zipEntryStream } from "../geo/zip";
import { crc32, zipFiles } from "./zip";

describe("zipFiles", () => {
  it("writes an archive the app's own reader reads back", async () => {
    const enc = new TextEncoder();
    const files = [
      { name: "index.html", data: enc.encode("<!doctype html><p>Rodbina Žnidaršič</p>") },
      { name: "photos/o1.jpg", data: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
      { name: "photos/prazno.png", data: new Uint8Array() },
    ];
    const zip = zipFiles(files, new Date(2026, 10, 16, 12, 30, 10));
    const entries = zipEntries(zip.buffer);
    expect(entries.map((e) => e.name)).toEqual(files.map((f) => f.name));
    for (const [i, e] of entries.entries()) {
      expect(e.method).toBe(0);
      const back = new Uint8Array(await new Response(zipEntryStream(zip.buffer, e)).arrayBuffer());
      expect(back).toEqual(files[i].data);
    }
  });

  it("keeps each file's own time, to the second in UTC and in the DOS fields", () => {
    const photo = new Date(Date.UTC(2019, 4, 7, 9, 15, 33));
    const zip = zipFiles([{ name: "photos/o1.jpg", data: new Uint8Array([1]), modified: photo }], new Date(2026, 10, 16));
    const v = new DataView(zip.buffer);
    const [entry] = zipEntries(zip.buffer);
    // The local header's extra field ends where the data starts.
    expect(v.getUint16(entry.dataStart - 9, true)).toBe(0x5455);
    expect(v.getUint32(entry.dataStart - 4, true)).toBe(photo.getTime() / 1000);
    const dosDate = v.getUint16(12, true);
    expect([(dosDate >> 9) + 1980, (dosDate >> 5) & 15, dosDate & 31]).toEqual([photo.getFullYear(), photo.getMonth() + 1, photo.getDate()]);
  });

  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

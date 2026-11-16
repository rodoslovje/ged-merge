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

  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

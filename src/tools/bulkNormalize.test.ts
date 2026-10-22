/// <reference types="node" />
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { serializeGedcom } from "../gedcom/serialize";
import { bulkNormalize } from "./bulkNormalize";

function dataset(bytes: ArrayBuffer) {
  return buildDataset(parseGedcom(bytes));
}

/** Normalize the file's house style, save, reload, and normalize again. */
function twice(bytes: ArrayBuffer): { once: string; again: string } {
  const once = serializeGedcom(bulkNormalize(dataset(bytes)).dataset.records);
  const again = serializeGedcom(bulkNormalize(dataset(new TextEncoder().encode(once).buffer)).dataset.records);
  return { once, again };
}

describe("bulkNormalize", () => {
  it("leaves a place reduced to its country as it is on a second run", () => {
    // A packed-place file ("Town (Country), Street"): the continent after
    // "Peru" is no level of its own, so the first run packs it to "Peru" —
    // the second must not then give Peru itself as its parent.
    const event = (i: number, place: string) => `0 @I${i}@ INDI\n1 NAME A /B${i}/\n1 BIRT\n2 PLAC ${place}`;
    const text = [
      "0 HEAD\n1 CHAR UTF-8\n1 GEDC\n2 VERS 5.5.1",
      ...[1, 2, 3, 4].map((i) => event(i, `Kranj (Slovenija), Glavni trg ${i}`)),
      event(5, "Peru, Južna Amerika"),
      event(6, "Slovenija"),
      "0 TRLR",
    ].join("\n");
    const { once, again } = twice(new TextEncoder().encode(text).buffer);
    expect(once).toContain("2 PLAC Peru\n");
    expect(once).toContain("2 PLAC Slovenija\n");
    expect(again).toBe(once);
  });

  it("reaches a fixed point after one run on every corpus file", () => {
    const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/corpus");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ged"))) {
      const buf = readFileSync(resolve(dir, file));
      const { once, again } = twice(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      expect(again, file).toBe(once);
    }
  });
});

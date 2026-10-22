import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { applyFormatOverrides } from "./formatOverrides";
import { forestDiff } from "./forestDiff.testutil";
import { normalizeDataset } from "./normalize";
import { applyNormPatch, diffNormalized, type NormPatch } from "./normPatch";
import { collectLayoutValues, inferMainProfile } from "./profile";

const enc = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer as ArrayBuffer;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

/** Normalize `compare` against `main` as the worker does, then replay the
 *  diff onto a fresh parse as the main thread does. */
function roundTrip(main: ArrayBuffer, compare: ArrayBuffer) {
  const profile = applyFormatOverrides(inferMainProfile(buildDataset(parseGedcom(main))), undefined);
  const raw = buildDataset(parseGedcom(compare));
  const { dataset } = normalizeDataset(raw, profile, collectLayoutValues(raw).dateValues);
  const patch = diffNormalized(raw.records, dataset.records)!;
  const parsed = parseGedcom(compare);
  const applied = applyNormPatch(parsed.records, structuredClone(patch));
  return { normalized: dataset, applied, replayed: buildDataset(parsed), patch };
}

const corpus = resolve(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/corpus");
const corpusFiles = readdirSync(corpus).filter((f) => f.endsWith(".ged"));
const bytesOf = (file: string) => {
  const buf = readFileSync(resolve(corpus, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

describe("normalization edits", () => {
  it("replay to the very forest the worker normalized, for every corpus pair", () => {
    let changedPairs = 0;
    for (const mainFile of corpusFiles) {
      for (const compareFile of corpusFiles) {
        const { normalized, applied, replayed, patch } = roundTrip(bytesOf(mainFile), bytesOf(compareFile));
        expect(applied, `${compareFile} into ${mainFile}`).toBe(true);
        expect(forestDiff(normalized.records, replayed.records), `${compareFile} into ${mainFile}`).toBeUndefined();
        expect([...replayed.individuals.keys()]).toEqual([...normalized.individuals.keys()]);
        if (patch.ops.length) changedPairs++;
      }
    }
    // The corpus does exercise the edits: most pairs normalize something.
    expect(changedPairs).toBeGreaterThan(corpusFiles.length);
  });

  it("dropped, added and renamed lines, reshaped places and stripped placeholders", () => {
    const main = wrap("0 @I1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 02.02.1850\n2 PLAC Kranj, Gorenjska\n");
    const compare = wrap(
      "0 @P1@ INDI\n1 NAME Janez /Novak/\n1 BIRT\n2 DATE 2 FEB 1850\n2 PLAC ----\n" +
        "1 DEAT\n2 DATE __.__.____\n2 PLAC Kranj\n1 _MILI\n2 DATE 1870\n" +
        "0 @F1@ FAM\n1 HUSB @P1@\n1 _NMR\n1 _MSTAT Never married\n",
    );
    const { normalized, applied, replayed } = roundTrip(enc(main), enc(compare));
    expect(applied).toBe(true);
    expect(forestDiff(normalized.records, replayed.records)).toBeUndefined();
  });

  it("a duplicate xref renamed by the build is renamed the same way after the replay", () => {
    const compare = wrap("0 @P1@ INDI\n1 BIRT\n2 DATE 2 FEB 1850\n2 PLAC ----\n0 @P1@ INDI\n1 BIRT\n2 PLAC ----\n");
    const main = wrap("0 @I1@ INDI\n1 BIRT\n2 DATE 02.02.1850\n");
    const { normalized, applied, replayed } = roundTrip(enc(main), enc(compare));
    expect(applied).toBe(true);
    expect(forestDiff(normalized.records, replayed.records)).toBeUndefined();
    expect(replayed.individuals.size).toBe(2);
  });

  it("refuses a forest of another length, or a path that is not there", () => {
    const patch: NormPatch = { count: 3, ops: Int32Array.from([1, 1, 1, 5, 2]), lens: Int32Array.from([1]), text: "x", objs: [] };
    expect(applyNormPatch(parseGedcom(enc(wrap(""))).records, patch)).toBe(false);
    expect(applyNormPatch(parseGedcom(enc(wrap("0 @I1@ INDI\n"))).records, patch)).toBe(false);
  });

  it("an untouched forest yields no edits", () => {
    const records = parseGedcom(enc(wrap("0 @I1@ INDI\n1 NAME A /B/\n"))).records;
    const patch = diffNormalized(records, records.map((r) => structuredClone(r)))!;
    expect(patch.ops.length).toBe(0);
    expect(diffNormalized(records, records.slice(1))).toBeUndefined();
  });
});

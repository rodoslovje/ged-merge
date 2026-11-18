import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { applyFormatOverrides } from "./formatOverrides";
import { forestDiff } from "./forestDiff.testutil";
import { ALL_PASSES, normalizeDataset } from "./normalize";
import { applyNormPatch, diffNormalized, diffNormalizedFromBytes, type NormPatch } from "./normPatch";
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
  it("replay to the very forest the worker normalized, for every corpus file into five house styles", () => {
    let changedPairs = 0;
    // Distinct date, place, name, version and vendor habits, as mains.
    const mains = [
      "brotherskeeper-5.5-w1250.ged", "geneanet-5.5.1-utf8.ged", "myheritage-5.5.1-utf8.ged",
      "synium-7.0-utf8.ged", "familyhistorian-5.5.1-w1250.ged",
    ];
    for (const mainFile of mains) {
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
  }, 60_000);

  it("normalized in place and diffed against a second parse, the patch is the one a copy gives", () => {
    // The worker's low-memory path: no clone of the forest, and the "before"
    // side streamed from the bytes record by record.
    const inPlacePatch = (main: ArrayBuffer, compare: ArrayBuffer) => {
      const profile = applyFormatOverrides(inferMainProfile(buildDataset(parseGedcom(main))), undefined);
      const raw = buildDataset(parseGedcom(compare));
      const heads = raw.records.map((r) => ({ tag: r.tag, xref: r.xref }));
      const { dataset } = normalizeDataset(raw, profile, collectLayoutValues(raw).dateValues, { ...ALL_PASSES, inPlace: true });
      expect(dataset.records).toBe(raw.records);
      return { dataset, patch: diffNormalizedFromBytes(compare, heads, dataset.records) };
    };
    const mains = ["geneanet-5.5.1-utf8.ged", "synium-7.0-utf8.ged", "familyhistorian-5.5.1-w1250.ged"];
    const duplicates = enc(wrap(
      "0 @I1@ INDI\n1 NAME Ana /Kos/\n1 BIRT\n2 DATE 3 MAR 1801\n2 PLAC Kranj\n" +
        "0 @I1@ INDI\n1 NAME Ana /Kos/\n1 BIRT\n2 DATE ABT 1801\n",
    ));
    for (const mainFile of mains) {
      for (const [name, compare] of [...corpusFiles.map((f) => [f, bytesOf(f)] as const), ["duplicates", duplicates] as const]) {
        const { normalized, patch } = roundTrip(bytesOf(mainFile), compare);
        const streamed = inPlacePatch(bytesOf(mainFile), compare);
        expect(streamed.patch, `${name} into ${mainFile}`).toEqual(patch);
        expect(forestDiff(streamed.dataset.records, normalized.records), `${name} into ${mainFile}`).toBeUndefined();
      }
    }
  }, 60_000);

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

  it("carries a text-literal at-sign mark (atText) across the replay", () => {
    const text = wrap("0 @I1@ INDI\n1 NOTE @@I1@@\n");
    const records = parseGedcom(enc(text)).records;
    expect(records[1].children[0].atText).toBe("@I1@");
    const after = records.map((r) => structuredClone(r));
    delete after[1].children[0].atText;
    const fresh = parseGedcom(enc(text)).records;
    expect(applyNormPatch(fresh, diffNormalized(records, after)!)).toBe(true);
    expect(fresh[1].children[0].atText).toBeUndefined();
  });

  it("an untouched forest yields no edits", () => {
    const records = parseGedcom(enc(wrap("0 @I1@ INDI\n1 NAME A /B/\n"))).records;
    const patch = diffNormalized(records, records.map((r) => structuredClone(r)))!;
    expect(patch.ops.length).toBe(0);
    expect(diffNormalized(records, records.slice(1))).toBeUndefined();
  });

  it("carries a retagged line's upgradedFrom through a scalar edit", () => {
    const text = wrap("0 @I1@ INDI\n1 _FID ABCD-123\n1 ASSO @F1@\n");
    const before = parseGedcom(enc(text)).records;
    const after = structuredClone(before);
    const indi = after.find((r) => r.xref === "@I1@")!;
    // Retagged in place (the old child of that tag lines up) and re-pointed.
    Object.assign(indi.children[0], { tag: "EXID", upgradedFrom: { tag: "_FID" } });
    Object.assign(indi.children[1], { value: "@I1@", upgradedFrom: { tag: "ASSO", value: "@F1@" } });
    const patch = diffNormalized(before, after)!;
    const replayed = parseGedcom(enc(text)).records;
    expect(applyNormPatch(replayed, structuredClone(patch))).toBe(true);
    const out = replayed.find((r) => r.xref === "@I1@")!;
    expect(out.children[0].upgradedFrom).toEqual({ tag: "_FID" });
    expect(out.children[1].upgradedFrom).toEqual({ tag: "ASSO", value: "@F1@" });
    // And the reverse: a dropped upgradedFrom is dropped on the replay too.
    const back = diffNormalized(after, before)!;
    expect(applyNormPatch(replayed, structuredClone(back))).toBe(true);
    expect(out.children.map((c) => c.upgradedFrom)).toEqual([undefined, undefined]);
  });
});

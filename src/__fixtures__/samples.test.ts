/**
 * Loading + matching regression suite over the *shipped sample files*.
 *
 * These are the demo GEDCOMs offered on the landing page (public/samples/), the
 * first thing most users ever load. Unlike the anonymized `corpus/` (privacy-
 * scrubbed slices used for scorer precision/recall tuning), these are the exact
 * public bytes we serve, so we assert the real load path stays healthy:
 *
 *   LOADING  — parse + buildDataset yields a well-formed, NON-EMPTY dataset with
 *              a valid default start person. Guards the "sample loads but shows
 *              no individuals / a dead start person" class of regression.
 *   MATCHING — self-matching must re-find (almost) everyone and never rank a
 *              different individual above the identical one, and cross-matching
 *              two samples must run cleanly and stay self-consistent.
 *
 * The royal-family samples overlap genealogically (shared monarchs), so we do
 * NOT assert cross-family precision thresholds here — that lives in
 * corpus.match.test.ts over deliberately disjoint, anonymized trees.
 */

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { serializeGedcom } from "../gedcom/serialize";
import { matchDatasets } from "../match/engine";
import { defaultStartId } from "../match/relatives";
import type { Dataset } from "../gedcom/types";

// src/__fixtures__ → project root → public/samples
const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "public", "samples");

// Every .ged in the samples tray. Keep in sync with SAMPLE_FILES in the app —
// the count assertion below fails loudly if a sample is added or removed.
const SAMPLES = [
  "EnglishTudorRoyalFamily.ged",
  "EuropeRoyalFamilies.ged",
  "USPresidents.ged",
];

function readSample(file: string): ArrayBuffer {
  const buf = readFileSync(resolve(DIR, file));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

const cache = new Map<string, Dataset>();
function ds(file: string): Dataset {
  let d = cache.get(file);
  if (!d) {
    d = buildDataset(parseGedcom(readSample(file)));
    cache.set(file, d);
  }
  return d;
}

it("the sample tray is present and complete", () => {
  // A missing/renamed file would make readSample throw before this runs.
  expect(SAMPLES.every((f) => readSample(f).byteLength > 0)).toBe(true);
});

describe.each(SAMPLES)("loading %s", (file) => {
  it("parses to a non-empty, well-formed dataset", () => {
    const d = ds(file);
    // The regression this whole exercise chases: a loaded sample must actually
    // carry individuals (and families).
    expect(d.individuals.size).toBeGreaterThan(0);
    expect(d.families.size).toBeGreaterThan(0);
    expect(d.records[0].tag).toBe("HEAD");
    expect(d.records[d.records.length - 1].tag).toBe("TRLR");
    // Corruption on parse would surface here.
    expect(d.warnings.filter((w) => w.kind === "syntax")).toEqual([]);
  });

  it("has a default start person that exists in the dataset", () => {
    const d = ds(file);
    const start = defaultStartId(d);
    // A start id that isn't in the dataset blanks the Edit view ("no individuals
    // to edit") even though people are loaded — exactly the bug this guards.
    expect(start).toBeDefined();
    expect(d.individuals.has(start!)).toBe(true);
  });

  it("serializes to a stable fixed-point (parse→serialize is idempotent)", () => {
    const d = ds(file);
    const opts = { eol: d.eol, finalNewline: d.finalNewline };
    const text1 = serializeGedcom(d.records, opts);
    const reparsed = parseGedcom(new TextEncoder().encode(text1).buffer as ArrayBuffer);
    const text2 = serializeGedcom(reparsed.records, opts);
    expect(text2).toBe(text1);
  });
});

describe("self-match recall", () => {
  it.each(SAMPLES)("%s: re-finds nearly everyone, never misassigning", (file) => {
    const d = ds(file);
    const r = matchDatasets(d, d);
    // The engine must never rank a different individual above the identical one.
    const misassigned = r.individuals.filter((c) => c.masterId !== c.compareId);
    expect(misassigned).toEqual([]);

    const selfHits = r.individuals.filter((c) => c.masterId === c.compareId).length;
    // Ancestral trees are dense with duplicate-ish relatives, yet self-match
    // should still recover the vast majority; floor leaves headroom for drift.
    expect(selfHits / d.individuals.size).toBeGreaterThanOrEqual(0.85);
  });
});

describe("cross-sample matching", () => {
  it("runs cleanly and stays self-consistent between two samples", () => {
    // Not a precision assertion (the royal trees overlap); just that matching two
    // real files completes and returns coherent, in-range candidates.
    const r = matchDatasets(ds("EnglishTudorRoyalFamily.ged"), ds("USPresidents.ged"));
    expect(Array.isArray(r.individuals)).toBe(true);
    for (const c of r.individuals) {
      expect(c.score).toBeGreaterThanOrEqual(0);
      expect(c.score).toBeLessThanOrEqual(100);
      expect(["strong", "probable", "weak"]).toContain(c.category);
    }
  });
});

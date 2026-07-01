/**
 * Cross-file matching regression suite over the anonymized corpus.
 *
 * The app's central operation is comparing two files, yet the unit suite only
 * matches tiny synthetic inputs. These tests run the real `matchDatasets`
 * engine over realistic data to guard its two failure modes:
 *
 *   RECALL   — matching a file against itself must re-find (almost) everyone,
 *              and must always prefer the *identical* record over a look-alike.
 *   PRECISION — matching two UNRELATED families must yield no "strong" match.
 *
 * The corpus is anonymized so that unrelated files never share (nor fuzz-match)
 * a surname — see corpus/README.md and pseudonyms.ts — so a strong cross-family
 * match can only mean the scorer became over-eager, never an anonymization
 * artifact. Thresholds are calibrated to the current corpus with headroom; a
 * real regression moves them far, not a little.
 */

/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import { matchDatasets } from "../match/engine";
import type { Dataset } from "../gedcom/types";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "corpus");
const files: string[] = JSON.parse(readFileSync(resolve(DIR, "manifest.json"), "utf-8"))
  .map((m: { file: string }) => m.file);

const cache = new Map<string, Dataset>();
function ds(file: string): Dataset {
  let d = cache.get(file);
  if (!d) {
    const buf = readFileSync(resolve(DIR, file));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    d = buildDataset(parseGedcom(ab as ArrayBuffer));
    cache.set(file, d);
  }
  return d;
}

describe("self-match recall", () => {
  const totals = { indi: 0, strongSelf: 0, anySelf: 0 };

  it.each(files)("%s: always prefers the identical record", (file) => {
    const d = ds(file);
    const r = matchDatasets(d, d);
    // Every matched pair must be a record to *itself* — the engine must never
    // rank a different individual above the identical one.
    const misassigned = r.individuals.filter((c) => c.masterId !== c.compareId);
    expect(misassigned).toEqual([]);

    const n = d.individuals.size;
    const anySelf = r.individuals.filter((c) => c.masterId === c.compareId).length;
    const strongSelf = r.individuals.filter(
      (c) => c.masterId === c.compareId && c.category === "strong",
    ).length;
    // Per-file floor: catches gross breakage even on the sparsest fixture
    // (MyHeritage, ~0.60 — many "Private" living records have no name to match).
    expect(anySelf / n).toBeGreaterThanOrEqual(0.5);

    totals.indi += n;
    totals.anySelf += anySelf;
    totals.strongSelf += strongSelf;
  });

  it("re-finds nearly everyone across the whole corpus", () => {
    // Aggregate recall is far steadier than any single file; observed ~0.98
    // (any category) and ~0.84 (strong). Floors leave headroom for benign drift.
    expect(totals.anySelf / totals.indi).toBeGreaterThanOrEqual(0.92);
    expect(totals.strongSelf / totals.indi).toBeGreaterThanOrEqual(0.78);
  });
});

describe("cross-family precision", () => {
  const pairs: [string, string][] = [];
  for (let i = 0; i < files.length; i++)
    for (let j = i + 1; j < files.length; j++) pairs.push([files[i], files[j]]);

  it("produces no strong match between any two unrelated files", () => {
    const strongPairs: string[] = [];
    let maxProbable = 0;
    for (const [a, b] of pairs) {
      const r = matchDatasets(ds(a), ds(b));
      const strong = r.individuals.filter((c) => c.category === "strong");
      if (strong.length) {
        const da = ds(a), db = ds(b);
        strongPairs.push(
          `${a} × ${b}: ` +
            strong
              .map((c) => `"${da.individuals.get(c.masterId)?.names[0]?.full}"~"${db.individuals.get(c.compareId)?.names[0]?.full}"@${c.score}`)
              .join(", "),
        );
      }
      maxProbable = Math.max(maxProbable, r.individuals.filter((c) => c.category === "probable").length);
    }
    expect(strongPairs).toEqual([]);
    // A handful of "probable"s across unrelated trees is expected; a spike is not.
    expect(maxProbable).toBeLessThanOrEqual(5);
  });
});

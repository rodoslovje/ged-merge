/**
 * Matching benchmark over the real files in `test-data/` (not committed).
 *
 * Runs the cross-file matcher and the within-file duplicate finder over the
 * benchmark pairs MATCHING.md names ("Verifying changes") and prints the
 * strong / probable / weak counts and wall time per scenario. On the first
 * run it stores the pair set per scenario as a baseline next to the data
 * (`test-data/match-bench.baseline.json`, private like the data); every later
 * run diffs against it and lists the pairs gained, lost or re-categorized —
 * with names, so a scoring change can be judged pair by pair.
 *
 *   npx vitest run --config scripts/match-bench.config.ts --reporter=verbose
 *
 * Environment:
 *   MATCH_BENCH_DATA      directory holding the files (default: the nearest
 *                         `test-data/` walking up from this script — the main
 *                         checkout's, when run from a worktree)
 *   MATCH_BENCH_DUP       comma-separated files for the duplicate scans
 *                         (default: Renko, Renko-Rakar, Trobec, Ivanc, Pratnekar;
 *                         add Hawlina for the 500k-person scale check)
 *   MATCH_BENCH_BASELINE  `write` to overwrite the stored baseline with this run
 */
/// <reference types="node" />
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { buildDataset } from "../src/gedcom/builder";
import { birthYear } from "../src/gedcom/lifespan";
import { parseGedcom } from "../src/gedcom/parser";
import type { Dataset } from "../src/gedcom/types";
import { matchDatasets } from "../src/match/engine";
import { displayName, primaryName } from "../src/match/relatives";
import { categorize, DEFAULT_CONFIG, type MatchCategory } from "../src/match/types";
import { normalizeDataset } from "../src/normalize/normalize";
import { collectLayoutValues, inferMainProfile } from "../src/normalize/profile";
import { findDuplicates } from "../src/tools/duplicates";

const CROSS: Array<[string, string]> = [
  ["Renko", "Renko-Rakar-Jekovec-Pezdirc-20260615"],
  ["Renko", "Trobec"],
];
const DUP_DEFAULT = ["Renko", "Renko-Rakar-Jekovec-Pezdirc-20260615", "Trobec", "Ivanc", "Pratnekar"];

type Pair = { key: string; score: number; category: MatchCategory };
type Scenario = { name: string; pairs: Pair[]; ms: number; label: (key: string) => string };
type Baseline = Record<string, Record<string, number>>;

function dataDir(): string {
  if (process.env.MATCH_BENCH_DATA) return process.env.MATCH_BENCH_DATA;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = resolve(dir, "test-data");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("no test-data/ directory found; set MATCH_BENCH_DATA");
    dir = parent;
  }
}

const DATA = dataDir();
const BASELINE = resolve(DATA, "match-bench.baseline.json");

const cache = new Map<string, Dataset>();
function load(name: string): Dataset {
  let d = cache.get(name);
  if (!d) {
    const buf = readFileSync(resolve(DATA, `${name}.ged`));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    d = buildDataset(parseGedcom(ab));
    cache.set(name, d);
  }
  return d;
}

function person(ds: Dataset, id: string): string {
  const indi = ds.individuals.get(id);
  if (!indi) return id;
  const y = birthYear(indi);
  return `${displayName(primaryName(indi))}${y !== undefined ? ` ${y}` : ""} [${id}]`;
}

function cross(mainName: string, compareName: string): Scenario {
  const main = load(mainName);
  const raw = load(compareName);
  // The worker's path: the compare file reshaped to the main's conventions.
  const profile = inferMainProfile(main);
  const { dateValues } = collectLayoutValues(raw);
  const { dataset: compare } = normalizeDataset(raw, profile, dateValues);
  const t0 = performance.now();
  const result = matchDatasets(main, compare);
  const ms = performance.now() - t0;
  const pairs = result.individuals.map((c) => ({ key: `${c.mainId}|${c.compareId}`, score: c.score, category: c.category }));
  return {
    name: `cross ${mainName} ↔ ${compareName}`,
    pairs,
    ms,
    label: (key) => {
      const [m, c] = key.split("|");
      return `${person(main, m)} ↔ ${person(compare, c)}`;
    },
  };
}

function duplicates(name: string): Scenario {
  const ds = load(name);
  const t0 = performance.now();
  const found = findDuplicates(ds);
  const ms = performance.now() - t0;
  const pairs = found.map((p) => ({ key: `${p.aId}|${p.bId}`, score: p.score, category: categorize(p.score / 100, DEFAULT_CONFIG) }));
  return {
    name: `duplicates ${name}`,
    pairs,
    ms,
    label: (key) => {
      const [a, b] = key.split("|");
      return `${person(ds, a)} ↔ ${person(ds, b)}`;
    },
  };
}

function counts(pairs: Pair[]): string {
  const by = { strong: 0, probable: 0, weak: 0 };
  for (const p of pairs) by[p.category]++;
  return `${pairs.length} pairs — strong ${by.strong}, probable ${by.probable}, weak ${by.weak}`;
}

const LIST_CAP = 40;

function report(s: Scenario, baseline: Baseline | undefined): string[] {
  const lines = [`\n== ${s.name}: ${counts(s.pairs)} (${(s.ms / 1000).toFixed(1)} s)`];
  const before = baseline?.[s.name];
  if (!before) {
    lines.push("   (no baseline for this scenario yet)");
    return lines;
  }
  const now = new Map(s.pairs.map((p) => [p.key, p.score]));
  const gained = s.pairs.filter((p) => !(p.key in before));
  const lost = Object.entries(before).filter(([k]) => !now.has(k));
  const shifted = s.pairs.filter((p) => {
    const old = before[p.key];
    return old !== undefined && categorize(old / 100, DEFAULT_CONFIG) !== p.category;
  });
  lines.push(`   vs baseline: +${gained.length} gained, -${lost.length} lost, ${shifted.length} changed category`);
  const list = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`   ${title}:`);
    for (const item of items.slice(0, LIST_CAP)) lines.push(`     ${item}`);
    if (items.length > LIST_CAP) lines.push(`     … and ${items.length - LIST_CAP} more`);
  };
  list("gained", gained.sort((a, b) => b.score - a.score).map((p) => `${p.score.toFixed(1)}  ${s.label(p.key)}`));
  list("lost", lost.sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v.toFixed(1)}  ${s.label(k)}`));
  list("changed category", shifted.map((p) => `${before[p.key].toFixed(1)} → ${p.score.toFixed(1)}  ${s.label(p.key)}`));
  return lines;
}

it("matching benchmark", () => {
  const baseline: Baseline | undefined = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf-8")) : undefined;
  const dupFiles = process.env.MATCH_BENCH_DUP ? process.env.MATCH_BENCH_DUP.split(",") : DUP_DEFAULT;
  const scenarios: Scenario[] = [];
  console.log(`match-bench over ${DATA}`);
  const run = (s: Scenario) => {
    scenarios.push(s);
    console.log(report(s, baseline).join("\n"));
  };
  for (const [m, c] of CROSS) run(cross(m, c));
  for (const f of dupFiles) run(duplicates(f));

  // Store this run for every scenario that has no baseline yet (a file added
  // later, a first run); `write` replaces the stored baseline of all of them.
  const overwrite = process.env.MATCH_BENCH_BASELINE === "write";
  const store = scenarios.filter((s) => overwrite || !baseline?.[s.name]);
  if (store.length) {
    const next: Baseline = { ...(baseline ?? {}) };
    for (const s of store) next[s.name] = Object.fromEntries(s.pairs.map((p) => [p.key, p.score]));
    writeFileSync(BASELINE, JSON.stringify(next));
    console.log(`\nbaseline ${overwrite ? "overwritten" : "stored"} for ${store.length} scenario(s): ${BASELINE}`);
  }
});

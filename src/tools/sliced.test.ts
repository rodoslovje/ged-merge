import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import type { Individual } from "../gedcom/types";
import { buildStatsFacts, startStatsFacts } from "../stats/facts";
import { buildBatchRows, startBatchRows } from "./batch";
import { built, finish, sliced, type BuildSteps, type SlicedBuild } from "./sliced";

function* count(to: number): BuildSteps<number[]> {
  const out: number[] = [];
  for (let i = 0; i < to; i++) {
    if (i > 0) yield i / to;
    out.push(i);
  }
  return out;
}

/** Drive a build one pause at a time, as a page with no time to spare would. */
function drip<T>(build: SlicedBuild<T>): { result: T; slices: number; progress: number[] } {
  const progress: number[] = [];
  let slices = 1;
  while (!build.step(0)) {
    expect(build.result).toBeUndefined();
    progress.push(build.progress);
    slices++;
  }
  return { result: build.result!, slices, progress };
}

describe("sliced", () => {
  it("does one pause's worth of work per slice with no budget, and reports progress on the way", () => {
    const { result, slices, progress } = drip(sliced(count(5)));
    expect(result).toEqual([0, 1, 2, 3, 4]);
    expect(slices).toBe(5);
    expect(progress).toEqual([0.2, 0.4, 0.6, 0.8]);
  });

  it("finishes in one slice given the time, and stays finished", () => {
    const build = sliced(count(1000));
    expect(build.progress).toBe(0);
    expect(build.step(Infinity)).toBe(true);
    expect(build.progress).toBe(1);
    expect(build.result).toHaveLength(1000);
    expect(build.step(0)).toBe(true);
  });

  it("finish runs the steps to the end at once", () => {
    expect(finish(count(3))).toEqual([0, 1, 2]);
  });

  it("built hands out a result that is there already", () => {
    const b = built("x");
    expect(b.step(0)).toBe(true);
    expect(b.progress).toBe(1);
    expect(b.result).toBe("x");
  });
});

// Enough people for several pauses in each phase of both builds.
const PEOPLE = 1400;
const text =
  "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n" +
  Array.from({ length: PEOPLE }, (_, i) =>
    `0 @I${i}@ INDI\n1 NAME Ana${i % 37} /Novak${i % 53}/\n1 SEX ${i % 2 ? "F" : "M"}\n1 BIRT\n2 DATE ${1 + (i % 28)} MAR ${1800 + (i % 150)}\n2 PLAC Kranj, Slovenija\n` +
    (i % 3 === 0 ? `1 DEAT\n2 DATE ${1860 + (i % 150)}\n` : "") +
    (i % 2 ? `1 FAMS @F${(i - 1) / 2}@\n` : `1 FAMS @F${i / 2}@\n`),
  ).join("") +
  Array.from({ length: PEOPLE / 2 }, (_, f) => `0 @F${f}@ FAM\n1 HUSB @I${f * 2}@\n1 WIFE @I${f * 2 + 1}@\n1 MARR\n2 DATE ${1830 + (f % 100)}\n`).join("") +
  "0 TRLR\n";
const ds = buildDataset(parseGedcom(new TextEncoder().encode(text).buffer as ArrayBuffer));
const nameOf = (indi: Individual) => indi.names[0]?.full ?? indi.id;

describe("the whole-file builds, in slices", () => {
  it("batch rows come out the same as built at once", () => {
    const now = new Date(2026, 0, 15);
    const { result, slices, progress } = drip(startBatchRows(ds, nameOf, now));
    expect(slices).toBeGreaterThan(5);
    expect(result).toEqual(buildBatchRows(ds, nameOf, now));
    expect(result).toHaveLength(PEOPLE);
    // Progress only ever moves forward, and stays inside 0…1.
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.every((p) => p >= 0 && p < 1)).toBe(true);
  });

  it("statistics facts come out the same as built at once", () => {
    const { result, slices, progress } = drip(startStatsFacts(ds, "si", 2026));
    expect(slices).toBeGreaterThan(5);
    expect(result).toEqual(buildStatsFacts(ds, "si", 2026));
    expect(result.people).toHaveLength(PEOPLE);
    expect(result.families).toHaveLength(PEOPLE / 2);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(progress.every((p) => p >= 0 && p < 1)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { TreeNode } from "../chart/personTree";
import { NODE_H } from "../chart/treeLayout";
import { rollPapers } from "../chart/sheets";
import { bestPlan, planPrint, planPrintScale, planSheets, type SheetChartSource } from "./sheetExport";

// The planning half of the sheet print is pure geometry — no DOM — so the two
// numbers the dialog shows before anything is printed can be checked here: how
// many sheets, and how far the set is scaled to sit on the paper.

function node(key: string, children: TreeNode[] = []): TreeNode {
  return { key, status: "main-only", name: key, years: "", living: false, sex: "U", detail: "", children, partners: [] };
}

/** A pedigree `g` generations up — the shape that doubles every generation. */
function pedigree(g: number, p = "r"): TreeNode {
  return g === 0 ? node(p) : node(p, [pedigree(g - 1, `${p}f`), pedigree(g - 1, `${p}m`)]);
}

const source = (tree: TreeNode): SheetChartSource => ({
  tree,
  alignment: "lr",
  grid: false,
  nodeH: NODE_H,
  ancestors: true,
});

describe("planPrintScale", () => {
  it("enlarges a small chart to fill the paper instead of stranding it in white", () => {
    // Three people on A0: at native size that is a stamp in the middle of a
    // metre of paper, which is what the print used to do.
    const src = source(node("r", [node("f"), node("m")]));
    const paper = { paper: "a0", orientation: "landscape" } as const;
    expect(planPrintScale(src, { ...paper, size: "medium" }, planSheets(src, { ...paper, size: "medium" })))
      .toBeGreaterThan(1);
  });

  it("shrinks a whole pedigree onto one sheet when asked for one", () => {
    const src = source(pedigree(8));
    const paper = { paper: { wMm: 1100, hMm: 2000 }, orientation: "landscape" } as const;
    const sheets = planSheets(src, { ...paper, size: "fit" });
    expect(sheets).toHaveLength(1);
    // 511 people on one plotter sheet: it fits, and it fits by shrinking.
    const scale = planPrintScale(src, { ...paper, size: "fit" }, sheets);
    expect(scale).toBeLessThan(1);
    expect(scale).toBeGreaterThan(0);
  });

  it("never cuts, whatever the paper, once One sheet is chosen", () => {
    const src = source(pedigree(9));
    for (const paper of ["a4", "a0"] as const) {
      expect(planSheets(src, { paper, orientation: "portrait", size: "fit" })).toHaveLength(1);
    }
  });
});

describe("planPrint on a roll", () => {
  // Three generations, 64 grandchildren: left→right a strip some 800 px wide
  // and several thousand tall — the shape a descendants chart takes.
  const strip: SheetChartSource = {
    ...source(node("r", Array.from({ length: 8 }, (_, i) =>
      node(`c${i}`, Array.from({ length: 8 }, (_, j) => node(`c${i}g${j}`)))))),
    ancestors: false,
  };
  const plans = (size: 0.5 | "fit") =>
    rollPapers(600).map((paper) => planPrint(strip, { paper, orientation: "portrait", size, roll: true }, undefined));

  it("prints at the scale asked for, on as little of the roll as holds the chart", () => {
    const [down, across] = plans(0.5);
    // Run down the roll the strip is one piece, a fraction of the roll's width.
    expect(down.count).toBe(1);
    expect(down.scale).toBeCloseTo(0.5);
    // Run across it the branches stand side by side: less roll for the same print.
    expect(across.count).toBe(1);
    expect(across.packed).toBeDefined();
    expect(across.scale).toBeLessThanOrEqual(0.5);
    expect(across.length!).toBeLessThan(down.length!);
    expect(bestPlan([down, across])).toBe(across);
  });

  it("fills the roll's width when the chart is to stay in one piece", () => {
    const best = bestPlan(plans("fit"))!;
    expect(best.packed).toBeUndefined();
    // Enlarged to the 600 mm the roll is wide, not shrunk to its height.
    expect(best.scale).toBeGreaterThan(1);
    expect(best.paper.paper).toEqual(rollPapers(600)[0]);
  });
});

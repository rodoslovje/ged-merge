import { describe, expect, it } from "vitest";
import type { TreeNode } from "../chart/personTree";
import { NODE_H } from "../chart/treeLayout";
import { planPrintScale, planSheets, type SheetChartSource } from "./sheetExport";

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

import { describe, expect, it } from "vitest";
import type { TreeNode } from "./personTree";
import { NODE_H, layout } from "./treeLayout";
import {
  MIN_PRINT_SCALE,
  pageBox,
  sheetBudget,
  sheetCount,
  splitIntoSheets,
  type SheetSplitOptions,
} from "./sheets";

/** Minimal TreeNode — the splitter reads only structure, name and key. */
function node(key: string, children: TreeNode[] = [], partners: TreeNode[] = []): TreeNode {
  return { key, status: "main-only", name: key, years: "", living: false, sex: "U", detail: "", children, partners };
}

/** A perfectly balanced descendant tree: `depth` generations, `fanout` children each. */
function balanced(depth: number, fanout: number, prefix = "r"): TreeNode {
  if (depth === 0) return node(prefix);
  return node(
    prefix,
    Array.from({ length: fanout }, (_, i) => balanced(depth - 1, fanout, `${prefix}.${i}`)),
  );
}

/** A single unbroken line of descent, `depth` generations long. */
function line(depth: number, prefix = "r"): TreeNode {
  return depth === 0 ? node(prefix) : node(prefix, [line(depth - 1, `${prefix}.${depth}`)]);
}

const opts = (over: Partial<SheetSplitOptions> = {}): SheetSplitOptions => ({
  grid: false,
  alignment: "lr",
  nodeH: NODE_H,
  budget: sheetBudget("a4", "landscape", 86),
  ...over,
});

/** Every person drawn across the whole set, stubs included. */
function keysOn(root: TreeNode): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    out.push(n.key);
    n.children.forEach(walk);
    n.partners.forEach(walk);
  };
  walk(root);
  return out;
}

describe("paper geometry", () => {
  it("swaps the axes for landscape and keeps a margin on every side", () => {
    const portrait = pageBox("a4", "portrait");
    const landscape = pageBox("a4", "landscape");
    expect(landscape.w).toBe(portrait.h);
    expect(landscape.h).toBe(portrait.w);
    expect(portrait.w).toBeLessThan(794); // margins taken off both sides
  });

  it("gives a sheet more canvas than the page, by the print reduction", () => {
    const box = pageBox("a4", "landscape");
    const budget = sheetBudget("a4", "landscape", 0);
    expect(budget.w).toBeCloseTo(box.w / MIN_PRINT_SCALE);
    // A3 is the bigger sheet, so it carries more diagram.
    expect(sheetBudget("a3", "landscape", 0).w).toBeGreaterThan(budget.w);
  });

  it("charges the header and footer bands to the sheet's height", () => {
    const plain = sheetBudget("a4", "landscape", 0);
    const banded = sheetBudget("a4", "landscape", 86);
    expect(banded.h).toBe(plain.h - 86);
    expect(banded.w).toBe(plain.w);
  });
});

describe("splitIntoSheets", () => {
  it("leaves a chart that already fits on a single sheet", () => {
    const sheets = splitIntoSheets(balanced(1, 3), opts());
    expect(sheets).toHaveLength(1);
    expect(sheets[0].number).toBe(1);
    expect(sheets[0].from).toBeUndefined();
    expect(keysOn(sheets[0].root)).toHaveLength(4);
  });

  it("splits a wide tree and numbers the sheets in reading order", () => {
    const sheets = splitIntoSheets(balanced(3, 4), opts());
    expect(sheets.length).toBeGreaterThan(1);
    expect(sheets.map((s) => s.number)).toEqual(sheets.map((_, i) => i + 1));
    // Every sheet but the first says where it was cut from, and points back at
    // a sheet that comes earlier in the set.
    for (const s of sheets.slice(1)) {
      expect(s.from).toBeDefined();
      expect(s.from!.sheet).toBeLessThan(s.number);
    }
  });

  it("marks each cut point with the number of the sheet that continues it", () => {
    const sheets = splitIntoSheets(balanced(3, 4), opts());
    const stubs = new Map<number, string>();
    for (const s of sheets) {
      const walk = (n: TreeNode) => {
        if (n.continuesOn !== undefined) stubs.set(n.continuesOn, n.name);
        n.children.forEach(walk);
        n.partners.forEach(walk);
      };
      walk(s.root);
    }
    // Exactly one marker per continuation sheet, naming that sheet's person.
    for (const s of sheets.slice(1)) {
      expect(stubs.get(s.number)).toBe(s.from!.name);
      expect(s.root.name).toBe(s.from!.name);
    }
    expect(stubs.size).toBe(sheets.length - 1);
  });

  it("draws every person somewhere, and every stub again on its own sheet", () => {
    const tree = balanced(3, 4);
    const sheets = splitIntoSheets(tree, opts());
    const drawn = new Set(sheets.flatMap((s) => keysOn(s.root)));
    for (const key of keysOn(tree)) expect(drawn.has(key)).toBe(true);
  });

  it("keeps every sheet within the budget", () => {
    const o = opts();
    for (const s of splitIntoSheets(balanced(3, 4), o)) {
      const laid = layout(s.root, o.alignment, o.nodeH);
      expect(laid.width).toBeLessThanOrEqual(o.budget.w);
      expect(laid.height).toBeLessThanOrEqual(o.budget.h);
    }
  });

  it("cuts a long lineage by the level, not one generation per sheet", () => {
    // 30 generations deep and one person wide: a level cut should carry several
    // generations per sheet rather than dribbling them out one at a time.
    const sheets = splitIntoSheets(line(30), opts());
    expect(sheets.length).toBeGreaterThan(1);
    expect(sheets.length).toBeLessThan(15);
  });

  it("never leaves the caller's tree trimmed", () => {
    const tree = balanced(3, 4);
    const before = keysOn(tree).length;
    splitIntoSheets(tree, opts());
    expect(keysOn(tree)).toHaveLength(before);
    expect(tree.continuesOn).toBeUndefined();
  });

  it("needs fewer sheets on bigger paper", () => {
    const tree = balanced(3, 4);
    const a4 = sheetCount(tree, opts({ budget: sheetBudget("a4", "landscape", 86) }));
    const a3 = sheetCount(tree, opts({ budget: sheetBudget("a3", "landscape", 86) }));
    expect(a3).toBeLessThanOrEqual(a4);
    expect(a4).toBeGreaterThan(1);
  });

  it("splits the grid diagram too", () => {
    const tree = balanced(3, 4);
    const sheets = splitIntoSheets(tree, opts({ grid: true }));
    expect(sheets.length).toBeGreaterThan(1);
    const drawn = new Set(sheets.flatMap((s) => keysOn(s.root)));
    for (const key of keysOn(tree)) expect(drawn.has(key)).toBe(true);
  });

  it("splits a top-down chart along its own axes", () => {
    const tree = balanced(3, 4);
    const sheets = splitIntoSheets(tree, opts({ alignment: "tb" }));
    const o = opts({ alignment: "tb" });
    for (const s of sheets) {
      const laid = layout(s.root, "tb", o.nodeH);
      expect(laid.width).toBeLessThanOrEqual(o.budget.w);
      expect(laid.height).toBeLessThanOrEqual(o.budget.h);
    }
  });

  it("keeps a cut couple together, dropping only the line below them", () => {
    // A couple with a wide brood, hanging off a root with several such couples.
    const couple = (id: string) =>
      node(id, [], [node(`${id}w`, Array.from({ length: 12 }, (_, i) => balanced(2, 3, `${id}.${i}`)))]);
    const sheets = splitIntoSheets(node("root", [couple("a"), couple("b"), couple("c")]), opts());
    for (const s of sheets) {
      const walk = (n: TreeNode) => {
        if (n.continuesOn !== undefined) {
          expect(n.children).toHaveLength(0);
          // The spouse stays beside them; only their descendants moved on.
          for (const p of n.partners) expect(p.children).toHaveLength(0);
        }
        n.children.forEach(walk);
        n.partners.forEach(walk);
      };
      walk(s.root);
    }
  });

  it("terminates on a budget too small for anything, with one oversized sheet", () => {
    const sheets = splitIntoSheets(balanced(2, 3), opts({ budget: { w: 10, h: 10 } }));
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.length).toBeLessThan(50);
  });
});

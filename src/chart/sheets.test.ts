import { describe, expect, it } from "vitest";
import type { TreeNode } from "./personTree";
import { NODE_H, layout } from "./treeLayout";
import {
  CUSTOM_MM_MAX,
  CUSTOM_MM_MIN,
  PRINT_SCALE,
  pageBox,
  paperPx,
  sheetBudget,
  sheetCount,
  splitIntoSheets,
  type PaperSize,
  type PrintSize,
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

/** A pedigree: two parents each, `g` generations up — the shape that doubles
 *  every generation, and so the one the split has to handle well. */
function pedigree(g: number, p = "r"): TreeNode {
  return g === 0 ? node(p) : node(p, [pedigree(g - 1, `${p}f`), pedigree(g - 1, `${p}m`)]);
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
    const budget = sheetBudget("a4", "landscape", 0, "medium");
    expect(budget.w).toBeCloseTo(box.w / PRINT_SCALE.medium);
    // A3 is the bigger sheet, so it carries more diagram.
    expect(sheetBudget("a3", "landscape", 0).w).toBeGreaterThan(budget.w);
    // Smaller print fits more diagram on the same page.
    expect(sheetBudget("a4", "landscape", 0, "small").w)
      .toBeGreaterThan(sheetBudget("a4", "landscape", 0, "large").w);
  });

  it("sizes the named papers off their millimetres", () => {
    expect(paperPx("a4", "portrait")).toEqual({ w: 794, h: 1123 });
    expect(paperPx("a3", "portrait")).toEqual({ w: 1123, h: 1587 });
    expect(paperPx("letter", "portrait")).toEqual({ w: 816, h: 1056 });
    // The A series doubles in area a step at a time: A2 is A3's long edge wide.
    expect(paperPx("a2", "portrait").w).toBe(paperPx("a3", "portrait").h);
    expect(paperPx("a1", "portrait").w).toBe(paperPx("a2", "portrait").h);
    expect(paperPx("a0", "portrait").w).toBe(paperPx("a1", "portrait").h);
  });

  it("takes a custom size as typed, in millimetres, whatever the orientation", () => {
    const roll = paperPx({ wMm: 1100, hMm: 2000 }, "landscape");
    expect(roll).toEqual({ w: 4157, h: 7559 }); // 96 dpi
    // Orientation is a named-paper affair; a typed size is already the way round
    // the user meant it.
    expect(paperPx({ wMm: 1100, hMm: 2000 }, "portrait")).toEqual(roll);
    // Out-of-range figures are pulled back rather than producing a nonsense page.
    expect(paperPx({ wMm: 0, hMm: 1e9 }, "portrait")).toEqual(
      paperPx({ wMm: CUSTOM_MM_MIN, hMm: CUSTOM_MM_MAX }, "portrait"),
    );
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

  // A pedigree doubles every generation, so it is where a badly chosen cut level
  // is punished hardest: cutting one level too deep doubles the sheet count, and
  // every extra sheet holds a couple and nothing else.
  describe("pedigrees", () => {
    const countAt = (g: number, paper: PaperSize, orient: "portrait" | "landscape", size: PrintSize) =>
      sheetCount(pedigree(g), opts({ budget: sheetBudget(paper, orient, 86, size) }));

    it("cuts an 8-generation pedigree into a set you could actually print", () => {
      // 511 people. Cutting at the deepest level the page allowed used to spend
      // 136 sheets on this, 128 of them holding three people.
      expect(countAt(8, "a4", "landscape", "medium")).toBeLessThanOrEqual(20);
      expect(countAt(8, "a4", "landscape", "small")).toBeLessThanOrEqual(12);
    });

    it("never spends more sheets on bigger paper", () => {
      for (const g of [6, 8, 10]) {
        for (const size of ["large", "medium", "small"] as PrintSize[]) {
          expect(countAt(g, "a3", "landscape", size)).toBeLessThanOrEqual(
            countAt(g, "a4", "landscape", size),
          );
        }
      }
    });

    it("never spends more sheets on smaller print", () => {
      for (const g of [6, 8, 10]) {
        expect(countAt(g, "a4", "landscape", "small")).toBeLessThanOrEqual(
          countAt(g, "a4", "landscape", "medium"),
        );
        expect(countAt(g, "a4", "landscape", "medium")).toBeLessThanOrEqual(
          countAt(g, "a4", "landscape", "large"),
        );
      }
    });

    it("keeps paying off all the way up to A0 and a plotter roll", () => {
      // The point of the big formats: the same pedigree on ever fewer sheets,
      // down to one when the paper is finally as wide as the chart.
      const counts = (["a4", "a3", "a2", "a1", "a0"] as PaperSize[]).map((p) =>
        countAt(8, p, "landscape", "medium"),
      );
      for (let i = 1; i < counts.length; i++) {
        expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
      }
      expect(counts.at(-1)).toBeLessThan(counts[0]);
      // A 2 × 1.1 m plotter roll is larger again than A0, and is treated as one
      // page of exactly that size.
      expect(countAt(8, { wMm: 2000, hMm: 1100 }, "landscape", "medium")).toBeLessThanOrEqual(
        counts.at(-1)!,
      );
      expect(countAt(4, { wMm: 2000, hMm: 1100 }, "landscape", "medium")).toBe(1);
    });

    it("fills its sheets — no crop of near-empty continuations", () => {
      const o = opts({ budget: sheetBudget("a4", "landscape", 86, "medium") });
      const sheets = splitIntoSheets(pedigree(8), o);
      const empties = sheets.filter((s) => {
        const laid = layout(s.root, o.alignment, o.nodeH);
        return (laid.width * laid.height) / (o.budget.w * o.budget.h) < 0.15;
      });
      expect(empties).toHaveLength(0);
    });
  });

  it("terminates on a budget too small for anything, with one oversized sheet", () => {
    const sheets = splitIntoSheets(balanced(2, 3), opts({ budget: { w: 10, h: 10 } }));
    expect(sheets.length).toBeGreaterThan(0);
    expect(sheets.length).toBeLessThan(50);
  });
});

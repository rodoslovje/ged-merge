// Split a wide layered chart (tidy tree / grid) into printable sheets.
//
// A family diagram that reads fine on screen — pan and zoom cost nothing — is
// unprintable the moment it outgrows one page: fitting it to A4 shrinks the
// names past legibility. The classic paper answer, and the one a user asked for,
// is to cut the diagram at branch points: the first sheet carries the trunk with
// a numbered marker where a branch was cut off, and each cut branch continues on
// its own sheet headed by that same number.
//
// This module is the pure planner for that. It takes the tree the chart is
// drawing and a per-sheet budget in canvas pixels, and returns the sequence of
// sheets — each one an ordinary `TreeNode` tree the caller lays out and renders
// with the very same `layout`/`flatten` machinery as the on-screen chart. A node
// whose line continues elsewhere is left in place as a *stub* (children removed,
// {@link TreeNode.continuesOn} set to that sheet's number), so the diagram shows
// where it breaks off rather than ending in silence.
//
// Only the layered charts split: the fan/circle charts are radial (a branch is a
// sector, not a rectangle) and the timeline and relationship diagrams are narrow
// by construction.

import type { TreeNode } from "./personTree";
import {
  COL_STEP,
  NODE_W,
  PAD,
  ROW_GAP,
  ROW_GAP_TB,
  layout,
  layoutGrid,
  type ChartAlignment,
} from "./treeLayout";

// ─── Paper ────────────────────────────────────────────────────────────────────

export type PaperSize = "a4" | "a3" | "letter";
export type Orientation = "portrait" | "landscape";

export const PAPER_SIZES: PaperSize[] = ["a4", "a3", "letter"];
export const ORIENTATIONS: Orientation[] = ["landscape", "portrait"];

/** Paper dimensions in CSS pixels at 96 dpi (portrait), the unit `@page { size }`
 *  and the rest of the export pipeline work in. */
const PAPER_PX: Record<PaperSize, { w: number; h: number }> = {
  a4: { w: 794, h: 1123 }, // 210 × 297 mm
  a3: { w: 1123, h: 1587 }, // 297 × 420 mm
  letter: { w: 816, h: 1056 }, // 8.5 × 11 in
};

/** Printer-safe margin on every side, in px (≈ 6.3 mm). */
export const PAGE_MARGIN = 24;

/**
 * The smallest reduction a printed sheet may use. The node name is set at 12px,
 * which at 96 dpi is a 9 pt glyph — at 0.6 it prints around 5.4 pt, small but
 * still comfortably readable on paper, and the floor most printed family charts
 * settle on. It is what turns "the page" into a budget: a sheet may hold
 * `page / MIN_PRINT_SCALE` canvas pixels of diagram, and anything past that has
 * to be cut onto another sheet.
 */
export const MIN_PRINT_SCALE = 0.6;

/** The whole sheet of paper, in px — what `@page { size }` is set to. */
export function paperPx(paper: PaperSize, orientation: Orientation): { w: number; h: number } {
  const { w, h } = PAPER_PX[paper];
  return orientation === "landscape" ? { w: h, h: w } : { w, h };
}

/** The printable box of one page, in px, after {@link PAGE_MARGIN}. */
export function pageBox(paper: PaperSize, orientation: Orientation): { w: number; h: number } {
  const { w, h } = paperPx(paper, orientation);
  return { w: w - 2 * PAGE_MARGIN, h: h - 2 * PAGE_MARGIN };
}

/**
 * How much diagram one sheet may carry, in canvas pixels: the printable page box
 * blown up by the reduction we are willing to print at, less the fixed height of
 * the export's header and footer bands (which ride along at the same scale).
 */
export function sheetBudget(
  paper: PaperSize,
  orientation: Orientation,
  bandsH: number,
): { w: number; h: number } {
  const box = pageBox(paper, orientation);
  return { w: box.w / MIN_PRINT_SCALE, h: box.h / MIN_PRINT_SCALE - bandsH };
}

// ─── Split plan ───────────────────────────────────────────────────────────────

export interface SheetSplitOptions {
  /** `true` for the grid diagram, `false` for the tidy tree — picks the layout
   *  the sheets are measured (and later drawn) with. */
  grid: boolean;
  alignment: ChartAlignment;
  nodeH: number;
  /** Canvas pixels one sheet may hold, from {@link sheetBudget}. */
  budget: { w: number; h: number };
}

/** One printable sheet: a tree to draw, and where it came from. */
export interface Sheet {
  /** 1-based sheet number — also the number in the marker that points here. */
  number: number;
  /** The tree drawn on this sheet. Branches that continue elsewhere are left as
   *  stubs carrying {@link TreeNode.continuesOn}. */
  root: TreeNode;
  /** Set on every sheet but the first: the person this sheet picks up, and the
   *  sheet whose marker sent the reader here. */
  from?: { sheet: number; name: string };
}


/**
 * Plan the sheets for `root`. Sheet 1 holds the root; every branch cut off it
 * becomes a later sheet, numbered in reading order (breadth-first), and the cut
 * point stays behind as a stub marked with that number.
 *
 * Cuts are recorded as a set of nodes on one shared working copy, and each sheet
 * is *derived* from that set rather than snipped out of the tree. That is what
 * lets cuts nest: a later, higher cut simply inherits the ones below it as stubs
 * on its own sheet, instead of swallowing them and orphaning their sheets.
 *
 * The result is never empty: a tree too big to fit even after everything
 * cuttable has been cut still comes back as one (oversized) sheet rather than
 * disappearing.
 */
export function splitIntoSheets(root: TreeNode, opts: SheetSplitOptions): Sheet[] {
  // A private copy: the same tree is the live chart's, and planning must not
  // mark it up. `continuesOn` is then set on the derived sheets only.
  const work = cloneTree(root);
  const cuts = new Set<TreeNode>();
  const numbers = new Map<TreeNode, number>();

  const sheets: Sheet[] = [];
  let counter = 1;
  const queue: { root: TreeNode; number: number; from?: Sheet["from"] }[] = [
    { root: work, number: counter++ },
  ];
  while (queue.length) {
    const item = queue.shift()!;
    // Cuts found while planning this sheet are, by construction, the ones with
    // no other cut between them and this sheet's root — so this sheet is the one
    // whose marker sends the reader on.
    for (const cut of planCuts(item.root, cuts, opts)) {
      const number = counter++;
      numbers.set(cut, number);
      queue.push({ root: cut, number, from: { sheet: item.number, name: cut.name } });
    }
    sheets.push({ number: item.number, root: renderSheet(item.root, cuts, numbers), from: item.from });
  }
  return sheets;
}

/** How many sheets `root` needs — the answer behind the "prints as N sheets"
 *  readout, without keeping the plan around. */
export function sheetCount(root: TreeNode, opts: SheetSplitOptions): number {
  return splitIntoSheets(root, opts).length;
}

// ─── One sheet ────────────────────────────────────────────────────────────────

/**
 * Choose the cut points that bring one sheet — the subtree at `root`, with any
 * `cuts` already made below it standing as stubs — down to the budget. Two axes,
 * handled in order:
 *
 *  1. **Depth** — generations advance in fixed steps, so the last generation the
 *     sheet can show follows straight from the budget. Everything still carrying
 *     a line at that generation is cut. This is the plain "cut across a level" a
 *     reader would do by hand, and it is what stops a long thin lineage from
 *     being dribbled out one generation per sheet.
 *  2. **Breadth** — with the depth settled, the sheet can still be too wide. Cut
 *     the biggest branch that will fill a sheet of its own, re-measure, and
 *     repeat until what is left fits. Taking the biggest *sheet-sized* branch
 *     (rather than the biggest branch outright) is what makes the cut descend
 *     into a huge subtree instead of exiling it whole and leaving this sheet
 *     nearly empty.
 *
 * Adds the new cut points to `cuts` and returns them in the order found, for the
 * caller to number and queue.
 */
function planCuts(root: TreeNode, cuts: Set<TreeNode>, opts: SheetSplitOptions): TreeNode[] {
  const found: TreeNode[] = [];
  const cutHere = (node: TreeNode) => { found.push(node); cuts.add(node); };

  atDepth(root, cuts, maxGenerations(opts)).forEach(cutHere);
  while (!fits(renderSheet(root, cuts), opts)) {
    const target = pickCut(root, cuts, opts);
    if (!target) break; // nothing left to cut — print it oversized rather than lose it
    cutHere(target);
  }
  return found;
}

/**
 * The sheet for `root`: a copy of its subtree in which every cut point below it
 * is a stub — childless, and numbered with the sheet that carries on from there.
 * Spouses stay beside a stubbed person, exactly as the generation limit's own
 * prune leaves them; only the lines below the couple move on.
 */
function renderSheet(root: TreeNode, cuts: Set<TreeNode>, numbers?: Map<TreeNode, number>): TreeNode {
  const stub = (n: TreeNode): TreeNode => ({
    ...n,
    children: [],
    partners: n.partners.map((p) => ({ ...p, children: [] })),
    continuesOn: numbers?.get(n),
  });
  const copy = (n: TreeNode): TreeNode =>
    cuts.has(n)
      ? stub(n)
      : {
          ...n,
          children: n.children.map(copy),
          partners: n.partners.map((p) => ({ ...p, children: p.children.map(copy) })),
        };
  // The root is drawn whole even when it is itself a cut point — that is exactly
  // what a continuation sheet is for.
  return {
    ...root,
    children: root.children.map(copy),
    partners: root.partners.map((p) => ({ ...p, children: p.children.map(copy) })),
  };
}

/** Deep copy, so planning never marks up the chart's own tree. */
function cloneTree(n: TreeNode): TreeNode {
  return { ...n, children: n.children.map(cloneTree), partners: n.partners.map(cloneTree) };
}

/** Does `node` still carry a line below it (its own children, or a spouse's)
 *  that this sheet would have to draw? A cut point carries none: its line has
 *  already moved to another sheet. */
function hasLine(node: TreeNode, cuts: Set<TreeNode>): boolean {
  if (cuts.has(node)) return false;
  return node.children.length > 0 || node.partners.some((p) => p.children.length > 0);
}

/** Every node in this sheet at generation `maxGen` that still carries a line —
 *  the level cut. Spouses share their partner's generation; their children do
 *  not. The walk stops at cut points, which end the sheet where they stand. */
function atDepth(root: TreeNode, cuts: Set<TreeNode>, maxGen: number): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (node: TreeNode, gen: number) => {
    if (cuts.has(node) && node !== root) return;
    if (gen >= maxGen) {
      if (hasLine(node, cuts)) out.push(node);
      return;
    }
    node.children.forEach((c) => walk(c, gen + 1));
    node.partners.forEach((p) => p.children.forEach((c) => walk(c, gen + 1)));
  };
  walk(root, 0);
  return out;
}

/**
 * The deepest generation a sheet can show, counting the sheet's root as
 * generation 0. Depth advances in whole box-plus-gap steps along one axis (which
 * one depends on the alignment), so this is arithmetic rather than a search.
 */
function maxGenerations(opts: SheetSplitOptions): number {
  const lr = opts.alignment === "lr";
  const depthStep = lr ? COL_STEP : opts.nodeH + ROW_GAP_TB;
  const boxDepth = lr ? NODE_W : opts.nodeH;
  const room = (lr ? opts.budget.w : opts.budget.h) - boxDepth - 2 * PAD;
  // Never below one generation: cutting the sheet's own root would hand the
  // whole tree straight back as the next sheet and never terminate. A budget
  // that tight falls through to the breadth pass, which prints it oversized.
  return Math.max(1, Math.floor(room / depthStep));
}

/** Lay the sheet out for real and ask whether the result clears the budget. */
function fits(sheet: TreeNode, opts: SheetSplitOptions): boolean {
  const laid = opts.grid
    ? layoutGrid(sheet, opts.alignment, opts.nodeH)
    : layout(sheet, opts.alignment, opts.nodeH);
  return laid.width <= opts.budget.w && laid.height <= opts.budget.h;
}

/**
 * Pick the next branch to cut off an over-wide sheet: the one that frees the
 * most breadth among those small enough to fill a sheet on their own, falling
 * back to the biggest branch overall when every candidate is oversized (that one
 * is simply split again in turn). The sheet's own root is never a candidate —
 * cutting it would hand back the tree we started from and never finish.
 *
 * Candidates are ranked on {@link bandRows} rather than on a trial layout each:
 * with the depth already capped, breadth is the only axis left to relieve, and
 * rows track it closely enough to choose between branches. Whether the sheet
 * actually fits is always settled by a real layout in {@link fits}.
 */
function pickCut(root: TreeNode, cuts: Set<TreeNode>, opts: SheetSplitOptions): TreeNode | undefined {
  const rowsOf = rowCounter(cuts);
  const capacity = capacityRows(opts);
  let best: TreeNode | undefined;
  let bestFreed = 0;
  let bestFits = false;
  const consider = (node: TreeNode) => {
    if (!hasLine(node, cuts)) return;
    const rows = rowsOf(node);
    const freed = rows - stubRows(node);
    if (freed <= 0) return;
    const sheetFits = rows <= capacity;
    // A branch that fills a sheet of its own always beats one that overflows,
    // however much it would free here — the overflowing one only defers the cut.
    if (bestFits && !sheetFits) return;
    if (sheetFits && !bestFits) {
      [best, bestFreed, bestFits] = [node, freed, true];
      return;
    }
    if (freed > bestFreed) [best, bestFreed] = [node, freed];
  };
  const walk = (node: TreeNode) => {
    if (cuts.has(node) && node !== root) return;
    node.children.forEach((c) => { consider(c); walk(c); });
    node.partners.forEach((p) => p.children.forEach((c) => { consider(c); walk(c); }));
  };
  walk(root);
  return best;
}

/** How many breadth rows one sheet holds — the row counterpart of the pixel
 *  budget, for ranking cut candidates. */
function capacityRows(opts: SheetSplitOptions): number {
  const lr = opts.alignment === "lr";
  const breadthStep = lr ? opts.nodeH + ROW_GAP : COL_STEP;
  const boxBreadth = lr ? opts.nodeH : NODE_W;
  const room = (lr ? opts.budget.h : opts.budget.w) - boxBreadth - 2 * PAD;
  return Math.max(1, Math.floor(room / breadthStep) + 1);
}

/**
 * Breadth a subtree occupies on this sheet, in rows — the same quantity the tidy
 * tree's own arranger reserves for a node's band (its children stacked, or the
 * couple itself when that is taller). A cut point counts only as the stub it
 * leaves behind.
 */
function rowCounter(cuts: Set<TreeNode>): (node: TreeNode) => number {
  const memo = new Map<TreeNode, number>();
  const rows = (n: TreeNode): number => (cuts.has(n) ? stubRows(n) : bandRows(n));
  const bandRows = (n: TreeNode): number => {
    const cached = memo.get(n);
    if (cached !== undefined) return cached;
    const childRows =
      n.children.reduce((s, c) => s + rows(c), 0) +
      n.partners.reduce((s, p) => s + p.children.reduce((k, c) => k + rows(c), 0), 0);
    const band = Math.max(1, childRows, stubRows(n));
    memo.set(n, band);
    return band;
  };
  return bandRows;
}

/** Rows a node keeps once it is cut down to a stub (the couple, nothing else). */
function stubRows(node: TreeNode): number {
  return 1 + node.partners.length;
}

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

/** The papers offered by name. The A series runs up to A0 because a wall chart
 *  is exactly what a plotter or a copy shop is for. */
export type PaperName = "a4" | "a3" | "a2" | "a1" | "a0" | "letter";

/** A size the user typed instead, in millimetres — plotter rolls (say
 *  1100 × 2000) and anything else no standard name covers. It is taken as
 *  given: the width is the width, so {@link Orientation} has nothing left to
 *  say about it. */
export interface CustomPaper {
  wMm: number;
  hMm: number;
}

export type PaperSize = PaperName | CustomPaper;
export type Orientation = "portrait" | "landscape";

export const PAPER_NAMES: PaperName[] = ["a4", "a3", "a2", "a1", "a0", "letter"];
export const ORIENTATIONS: Orientation[] = ["landscape", "portrait"];

/** What a typed size may be, in mm: from a postcard to a ten-metre roll. */
export const CUSTOM_MM_MIN = 50;
export const CUSTOM_MM_MAX = 10000;

/** Paper dimensions in millimetres, portrait. */
const PAPER_MM: Record<PaperName, { w: number; h: number }> = {
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
  a2: { w: 420, h: 594 },
  a1: { w: 594, h: 841 },
  a0: { w: 841, h: 1189 },
  letter: { w: 215.9, h: 279.4 }, // 8.5 × 11 in
};

/** mm → CSS pixels at 96 dpi, the unit `@page { size }` and the rest of the
 *  export pipeline work in. */
function mmToPx(mm: number): number {
  return Math.round((mm * 96) / 25.4);
}

export function isCustomPaper(paper: PaperSize): paper is CustomPaper {
  return typeof paper !== "string";
}

/**
 * The paper in millimetres — what the custom fields start from when they are
 * opened on a named paper, and the size a custom paper simply is.
 */
export function paperMm(paper: PaperSize, orientation: Orientation): { w: number; h: number } {
  if (isCustomPaper(paper)) {
    const clamp = (mm: number) =>
      Math.min(CUSTOM_MM_MAX, Math.max(CUSTOM_MM_MIN, Number.isFinite(mm) ? mm : CUSTOM_MM_MIN));
    return { w: clamp(paper.wMm), h: clamp(paper.hMm) };
  }
  const { w, h } = PAPER_MM[paper];
  return orientation === "landscape" ? { w: h, h: w } : { w, h };
}

/** Printer-safe margin on every side, in px (≈ 6.3 mm). */
export const PAGE_MARGIN = 24;

/**
 * How small the print may go — the one setting that decides how much diagram a
 * sheet holds, and so how many sheets there are. The node name is set at 12px,
 * a 9 pt glyph at 96 dpi, so the reduction below reads straight off as print
 * size: 0.75 ≈ 7 pt, 0.5 ≈ 4.5 pt, 0.3 ≈ 2.7 pt.
 *
 * It is a genuine trade and the user owns it: a deep pedigree doubles in width
 * with every generation, so no amount of cleverness in the split will make it
 * both large and few. Large print is for a chart you will read at arm's length;
 * small is for the fewest sheets to tape up on a wall.
 *
 * `fit` is the end of that scale rather than a point on it: don't cut at all,
 * and let the print shrink the whole diagram onto the one sheet, however small
 * that turns out. It is what a plotter-sized sheet is for.
 */
export type PrintSize = "large" | "medium" | "small" | "fit";

export const PRINT_SIZES: PrintSize[] = ["large", "medium", "small", "fit"];

export const PRINT_SCALE: Record<Exclude<PrintSize, "fit">, number> = {
  large: 0.75,
  medium: 0.5,
  small: 0.3,
};

/** A chosen page: the paper, and which way round it goes. Every print starts
 *  here — the ones that split into sheets add a {@link PrintSize} on top. */
export interface PrintPaper {
  paper: PaperSize;
  orientation: Orientation;
}

/**
 * The one scale a print comes out at: the largest that still lands every page
 * inside the printable box.
 *
 * Taken across the whole set, so a box is the same size on every sheet — a
 * sparse continuation sheet blown up to fill its own page would read as a
 * different chart. It is free to go *above* 1: at native size a modest chart on
 * a plotter sheet would be a stamp in a metre of white paper, and "100%" means
 * nothing on paper anyway.
 */
export function fillScale(
  pages: { width: number; height: number }[],
  box: { w: number; h: number },
): number {
  return Math.min(...pages.map((p) => Math.min(box.w / p.width, box.h / p.height)));
}

/** The whole sheet of paper, in px — what `@page { size }` is set to. */
export function paperPx(paper: PaperSize, orientation: Orientation): { w: number; h: number } {
  const { w, h } = paperMm(paper, orientation);
  return { w: mmToPx(w), h: mmToPx(h) };
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
 *
 * "One sheet" sets no limit at all — nothing is ever cut, and the print then
 * scales whatever comes out onto the single page.
 */
export function sheetBudget(
  paper: PaperSize,
  orientation: Orientation,
  bandsH: number,
  size: PrintSize = "medium",
): { w: number; h: number } {
  if (size === "fit") return { w: Infinity, h: Infinity };
  const box = pageBox(paper, orientation);
  const scale = PRINT_SCALE[size];
  return { w: box.w / scale, h: box.h / scale - bandsH };
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
 * `cuts` already made below it standing as stubs — down to the budget.
 *
 * The whole cost of a split is the *number of cut points*, because every one of
 * them is another sheet. So the level to cut at is the deepest one whose trunk
 * still fits the page **on both axes** — not merely the deepest the page is tall
 * enough for. Cutting deeper than breadth allows is the trap: the deeper the
 * level, the more nodes stand on it, and each becomes a sheet carrying a couple
 * and nothing else. (A pedigree doubles every generation: one level too deep and
 * the sheet count doubles with it, which is how bigger paper used to produce
 * *more* sheets.)
 *
 * Three steps:
 *
 *  1. **The level** — the deepest generation whose trunk fits, and cut there.
 *     For an evenly branching tree this alone is the whole answer, and it is the
 *     plain "cut across a level" a reader would do by hand.
 *  2. **Put back what needn't go** — a level cut is blunt on a lopsided tree,
 *     exiling a two-person twig to a sheet of its own. So the cuts are taken back
 *     smallest-first for as long as the trunk still fits: only branches that
 *     genuinely need the room stay cut.
 *  3. **Branch cuts** — a single branch too wide even at the shallowest level
 *     leaves the trunk over budget. Cut the biggest branch that will fill a sheet
 *     of its own and repeat. Taking the biggest *sheet-sized* branch (rather than
 *     the biggest outright) makes the cut descend into a huge subtree instead of
 *     exiling it whole and leaving this sheet nearly empty.
 *
 * Adds the new cut points to `cuts` and returns them in the order found, for the
 * caller to number and queue.
 */
function planCuts(root: TreeNode, cuts: Set<TreeNode>, opts: SheetSplitOptions): TreeNode[] {
  if (fits(renderSheet(root, cuts), opts)) return [];

  // 1. Cut across the deepest level whose trunk still fits.
  const planned = new Set(atDepth(root, cuts, bestCap(root, cuts, opts)));
  planned.forEach((n) => cuts.add(n));

  // 2. Take back the cuts the sheet can afford to keep, smallest branch first.
  // Ascending order means the first one that no longer fits ends the round: any
  // bigger branch would not have fitted either.
  const rowsOf = rowCounter(cuts);
  for (const node of [...planned].sort((a, b) => rowsOf(a) - rowsOf(b))) {
    cuts.delete(node);
    if (fits(renderSheet(root, cuts), opts)) {
      planned.delete(node);
    } else {
      cuts.add(node);
      break;
    }
  }

  // 3. Anything still over budget is one over-wide branch, not a level problem.
  while (!fits(renderSheet(root, cuts), opts)) {
    const target = pickCut(root, cuts, opts);
    if (!target) break; // nothing left to cut — print it oversized rather than lose it
    cuts.add(target);
    planned.add(target);
  }
  return [...planned];
}

/**
 * The generation to cut this sheet at.
 *
 * Two bounds meet here. The trunk has to fit, which caps the level from above —
 * and since a level's width grows with its depth, that bound is the deepest
 * level the page can hold. But every node standing on the cut level becomes a
 * sheet, and a level one deeper holds more nodes (twice as many, in a pedigree),
 * so among the levels that work the *shallowest* is the cheapest.
 *
 * So: the shallowest level at which every branch cut off still fits a page of
 * its own. That spends the fewest sheets while keeping the split one level deep.
 * When the tree is too big for any such level to exist, further splitting is
 * unavoidable, and the deepest fitting level is taken instead — it at least
 * fills this sheet completely and leaves the recursion to fill the rest.
 */
function bestCap(root: TreeNode, cuts: Set<TreeNode>, opts: SheetSplitOptions): number {
  const capacity = capacityRows(opts);
  const maxGen = maxGenerations(opts);

  // The deepest level whose trunk fits — the upper bound, and the fallback.
  let deepest = 1;
  for (let cap = maxGen; cap > 1; cap--) {
    if (rowsAtCap(root, cuts, cap) <= capacity) { deepest = cap; break; }
  }

  const rowsOf = rowCounter(cuts);
  const branchFits = (n: TreeNode) => rowsOf(n) <= capacity && subtreeDepth(n, cuts) <= maxGen;
  for (let cap = 1; cap < deepest; cap++) {
    if (atDepth(root, cuts, cap).every(branchFits)) return cap;
  }
  return deepest;
}

/** Generations below `node` that this sheet's split would still have to draw. */
function subtreeDepth(node: TreeNode, cuts: Set<TreeNode>): number {
  if (cuts.has(node)) return 0;
  const kids = [...node.children, ...node.partners.flatMap((p) => p.children)];
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map((k) => subtreeDepth(k, cuts)));
}

/** Breadth rows the sheet would occupy if cut across generation `cap`. */
function rowsAtCap(root: TreeNode, cuts: Set<TreeNode>, cap: number): number {
  const rows = (node: TreeNode, gen: number): number => {
    if (gen >= cap || cuts.has(node)) return stubRows(node);
    const childRows =
      node.children.reduce((s, c) => s + rows(c, gen + 1), 0) +
      node.partners.reduce((s, p) => s + p.children.reduce((k, c) => k + rows(c, gen + 1), 0), 0);
    return Math.max(1, childRows, stubRows(node));
  };
  return rows(root, 0);
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

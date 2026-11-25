// Printing the Complete Tree on sheets of paper.
//
// The chart is already cut into numbered trees, which are the natural pieces
// of a printed set: each tree goes on paper whole when it fits a page, and a
// tree too big for one is cut further by the ordinary sheet split
// (`splitIntoSheets`) into parts labelled 15, 15.2, 15.3 … Then the pieces
// are packed onto pages: in order, each onto the first page with room left
// for it, so the small trees fill the paper beside the big ones rather than
// each taking a sheet of its own.
//
// A single tree too big for one page (a Descendants or Ancestors chart) prints
// the same way, as a Complete Tree of one: its cut branches are the pieces,
// numbered plainly 1, 2, 3 … A long, narrow chart then fills the paper with
// its branches side by side instead of running down a strip of each sheet.
//
// So does a bowtie (ancestors and descendants of one person) too big for a
// page: piece 1 keeps the person with as much of both halves as fits, and the
// branches cut off either half follow as pieces of their own.
//
// Pure: no React, no DOM.

import type { CompleteTree } from "./completeTree";
import { PANEL_GAP, PANEL_TITLE_H, packSkyline } from "./completeTree";
import type { TreeNode } from "./personTree";
import { splitIntoSheets, type Sheet, type SheetSplitOptions } from "./sheets";
import { ANCESTOR_KEY_PREFIX, NODE_W, PAD, layout, layoutBowtie, layoutGrid } from "./treeLayout";

/** One tree, or one part of a tree, framed on a page. */
export interface PagePiece {
  /** What its frame is titled with, and what the markers pointing here say:
   *  the tree's number, with the part after a dot when it was cut. */
  label: string;
  /** The tree's topmost person, for the title; for a later part, the person
   *  that part picks up. */
  top: TreeNode;
  /** The tree drawn in this frame (a cut part keeps numbered stubs). */
  root: TreeNode;
  /** Where a later part continues from: the label of the piece whose marker
   *  sends the reader here. */
  from?: string;
  /** Turns a cut-off stub's part number into its marker label. */
  markerLabel: (part: number) => string;
  /** The piece is a bowtie: `root` is its ancestor half and this the
   *  descendant half, joined at the person both start from. */
  other?: TreeNode;
  /** The piece is a branch of ancestors (its "children" are parents) —
   *  when the chart itself does not say, as a bowtie's pieces do not. */
  ancestors?: boolean;
  /** What the live chart's keys carry before this piece's own: a bowtie
   *  prefixes its ancestor half. */
  keyPrefix?: string;
  /** The frame on its page (diagram px), the title band included. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CompletePage {
  number: number;
  pieces: PagePiece[];
  /** The page's diagram extent: the pieces' bounding box. */
  width: number;
  height: number;
  /** A piece on it is bigger than the page even after cutting — a family too
   *  big to split (its children stay together) — so the page prints smaller. */
  oversized: boolean;
}

/** The trees to print: the Complete Tree's panels, or one tree as panel 1. */
type Trees = Pick<CompleteTree, "panels">;

/** Pieces of the trees, each at the size it lays out at plus its title band. */
function pieces(tree: Trees, opts: SheetSplitOptions, plain: boolean): Omit<PagePiece, "x" | "y">[] {
  const lay = opts.grid ? layoutGrid : layout;
  const size = (root: TreeNode) => {
    const l = lay(root, opts.alignment, opts.nodeH);
    return { w: l.width, h: l.height + PANEL_TITLE_H };
  };
  // Each piece pays for its title band, so a tree is cut to the page less it.
  const budget = { w: opts.budget.w, h: opts.budget.h - PANEL_TITLE_H };
  const out: Omit<PagePiece, "x" | "y">[] = [];
  for (const panel of tree.panels) {
    const n = panel.number;
    const markerLabel = plain ? String : (part: number) => `${n}.${part}`;
    const whole = size(panel.tree);
    if (whole.w <= opts.budget.w && whole.h <= opts.budget.h) {
      out.push({ label: String(n), top: panel.tree, root: panel.tree, markerLabel, ...whole });
      continue;
    }
    for (const sheet of splitIntoSheets(panel.tree, { ...opts, budget })) {
      out.push(...partPieces(sheet.root, {
        label: sheet.number === 1 ? String(n) : markerLabel(sheet.number),
        top: sheet.number === 1 ? panel.tree : sheet.root,
        from: sheet.from ? (sheet.from.sheet === 1 ? String(n) : markerLabel(sheet.from.sheet)) : undefined,
        markerLabel,
      }, size, opts.budget));
    }
  }
  return out;
}

type Loose = Omit<PagePiece, "x" | "y">;

/** One cut part as the piece — or, a family too big for the page, the pieces —
 *  it prints as. */
function partPieces(
  root: TreeNode,
  base: Omit<Loose, "root" | "w" | "h">,
  size: (root: TreeNode) => { w: number; h: number },
  page: { w: number; h: number },
): Loose[] {
  const piece = { ...base, root, ...size(root) };
  if (piece.w <= page.w && piece.h <= page.h) return [piece];
  // Still too big: a family whose children alone outgrow the page, which
  // the split never parts. Its children go over several pieces instead,
  // the couple repeated on each: 15.3, then 15.3/2, 15.3/3 …
  const fits = (r: TreeNode) => {
    const s = size(r);
    return s.w <= page.w && s.h <= page.h;
  };
  return splitFamily(root, fits).map((r, i) =>
    i === 0 ? { ...piece, root: r, ...size(r) } : { ...piece, label: `${base.label}/${i + 1}`, top: r, root: r, from: base.label, ...size(r) });
}

/**
 * The pieces of a bowtie too big for the page; `undefined` when it fits whole
 * (and so prints as the chart on screen, with no frame).
 *
 * Each half is cut as a chart of its own would be, to the share of the page
 * left to it: along the depth the two halves stand end to end, so the page is
 * divided between them — a half shallower than its share leaving the rest to
 * the other. Piece 1 is the two trunks joined; the branches cut off the
 * descendants follow, then those cut off the ancestors, numbered through.
 */
function bowtiePieces(ancestors: TreeNode, descendants: TreeNode, opts: SheetSplitOptions): Loose[] | undefined {
  const { alignment, nodeH, grid } = opts;
  const whole = layoutBowtie(ancestors, descendants, alignment, nodeH, grid);
  if (whole.width <= opts.budget.w && whole.height <= opts.budget.h) return undefined;

  const lay = grid ? layoutGrid : layout;
  const lr = alignment === "lr";
  const page = { w: opts.budget.w, h: opts.budget.h - PANEL_TITLE_H };
  const [depth, breadth] = lr ? [page.w, page.h] : [page.h, page.w];
  const depthOf = (tree: TreeNode) => {
    const l = lay(tree, alignment, nodeH);
    return lr ? l.width : l.height;
  };
  // Joined, the halves share the person's box and one pair of margins.
  const avail = depth + (lr ? NODE_W : nodeH) + 2 * PAD;
  let [da, dd] = [depthOf(ancestors), depthOf(descendants)];
  if (da + dd > avail) {
    if (da <= avail / 2) dd = avail - da;
    else if (dd <= avail / 2) da = avail - dd;
    else da = dd = avail / 2;
  }
  const split = (tree: TreeNode, depthBudget: number, share: number, next: number): Sheet[] =>
    splitIntoSheets(tree, {
      ...opts,
      budget: lr ? { w: depthBudget, h: breadth * share } : { w: breadth * share, h: depthBudget },
    }, next);
  // Across the breadth the halves overlap, each centred on the person, so both
  // may usually take all of it. When the joined trunk still overflows — one
  // half reaching far to one side, the other to the other — they take less.
  let down: Sheet[] = [];
  let up: Sheet[] = [];
  let trunk = whole;
  for (const share of [1, 0.75, 0.5]) {
    down = split(descendants, dd, share, 2);
    up = split(ancestors, da, share, down.length + 1);
    trunk = layoutBowtie(up[0].root, down[0].root, alignment, nodeH, grid);
    if (trunk.width <= page.w && trunk.height <= page.h) break;
  }

  const size = (root: TreeNode) => {
    const l = lay(root, alignment, nodeH);
    return { w: l.width, h: l.height + PANEL_TITLE_H };
  };
  const out: Loose[] = [{
    label: "1", top: descendants, root: up[0].root, other: down[0].root, markerLabel: String,
    w: trunk.width, h: trunk.height + PANEL_TITLE_H,
  }];
  for (const [sheets, isUp] of [[down, false], [up, true]] as const) {
    for (const sheet of sheets.slice(1)) {
      out.push(...partPieces(sheet.root, {
        label: String(sheet.number),
        top: sheet.root,
        from: String(sheet.from!.sheet),
        markerLabel: String,
        ancestors: isUp,
        keyPrefix: isUp ? ANCESTOR_KEY_PREFIX : undefined,
      }, size, opts.budget));
    }
  }
  return out;
}

/** Plan a bowtie's printed pages; `undefined` when it fits one page whole. */
export function planBowtiePages(ancestors: TreeNode, descendants: TreeNode, opts: SheetSplitOptions): CompletePage[] | undefined {
  const list = bowtiePieces(ancestors, descendants, opts);
  return list && packPieces(list, opts);
}

/**
 * Part a family's children over as few copies of the family as fit the page,
 * in their order: each copy keeps the person and every spouse, and carries a
 * run of the children — the spouseless ones first, then each union's, as the
 * layout draws them. A single child too big alone still gets a copy of its own
 * (the page then prints smaller; see `CompletePage.oversized`).
 */
export function splitFamily(root: TreeNode, fits: (root: TreeNode) => boolean): TreeNode[] {
  // Every child with the union it belongs to: -1 for the spouseless ones.
  const units = [
    ...root.children.map((child) => ({ union: -1, child })),
    ...root.partners.flatMap((p, union) => p.children.map((child) => ({ union, child }))),
  ];
  const copy = (run: typeof units): TreeNode => ({
    ...root,
    children: run.filter((u) => u.union === -1).map((u) => u.child),
    partners: root.partners.map((p, union) => ({ ...p, children: run.filter((u) => u.union === union).map((u) => u.child) })),
  });
  const out: TreeNode[] = [];
  let run: typeof units = [];
  for (const unit of units) {
    if (run.length > 0 && !fits(copy([...run, unit]))) {
      out.push(copy(run));
      run = [];
    }
    run.push(unit);
  }
  out.push(copy(run));
  return out;
}

/**
 * Plan the printed pages. Pieces keep their order and each goes onto the first
 * page that still has room for it, at the lowest free spot there (the same
 * skyline packing the screen uses); a page full, the next one starts. With no
 * budget ("fit" — the whole chart on one sheet) everything lands on one page
 * packed as the screen packs it.
 *
 * `plain` is for a single tree: its parts are then numbered 2, 3 … rather than
 * 1.2, 1.3 …, there being no other tree to tell them from.
 */
export function planCompletePages(tree: Trees, opts: SheetSplitOptions, plain = false): CompletePage[] {
  return packPieces(pieces(tree, opts, plain), opts);
}

/** Pack pieces onto pages, in their order (see {@link planCompletePages}). */
function packPieces(list: Loose[], opts: SheetSplitOptions): CompletePage[] {
  if (list.length === 0) return [];
  const { w: pageW, h: pageH } = opts.budget;
  if (!Number.isFinite(pageW) || !Number.isFinite(pageH)) {
    const area = list.reduce((s, p) => s + (p.w + PANEL_GAP) * (p.h + PANEL_GAP), 0);
    const sheetW = Math.max(...list.map((p) => p.w), Math.sqrt(area * 1.4));
    const spots = packSkyline(list, sheetW, PANEL_GAP);
    return [page(1, list.map((p, i) => ({ ...p, ...spots[i] })), opts.budget)];
  }
  // Open pages: what is on each so far, re-packed as a piece is tried on it.
  // Packing the page's pieces again from scratch keeps it simple and exact;
  // a page holds a handful of pieces, so the cost is nothing.
  const pages: Omit<PagePiece, "x" | "y">[][] = [];
  const fits = (onPage: Omit<PagePiece, "x" | "y">[]) => {
    const spots = packSkyline(onPage, pageW, PANEL_GAP);
    return onPage.every((p, i) => spots[i].x + p.w <= pageW + 0.5 && spots[i].y + p.h <= pageH + 0.5);
  };
  for (const p of list) {
    const at = pages.findIndex((onPage) => fits([...onPage, p]));
    if (at >= 0) pages[at].push(p);
    else pages.push([p]);
  }
  return pages.map((onPage, i) => {
    const spots = packSkyline(onPage, pageW, PANEL_GAP);
    return page(i + 1, onPage.map((p, j) => ({ ...p, ...spots[j] })), opts.budget);
  });
}

function page(number: number, placed: PagePiece[], budget: { w: number; h: number }): CompletePage {
  return {
    number,
    pieces: placed,
    width: Math.max(...placed.map((p) => p.x + p.w)),
    height: Math.max(...placed.map((p) => p.y + p.h)),
    oversized: placed.some((p) => p.w > budget.w + 0.5 || p.h > budget.h + 0.5),
  };
}

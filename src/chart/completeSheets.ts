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
// Pure: no React, no DOM.

import type { CompleteTree } from "./completeTree";
import { PANEL_GAP, PANEL_TITLE_H, packSkyline } from "./completeTree";
import type { TreeNode } from "./personTree";
import { splitIntoSheets, type SheetSplitOptions } from "./sheets";
import { layout, layoutGrid } from "./treeLayout";

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
      const label = sheet.number === 1 ? String(n) : markerLabel(sheet.number);
      const piece = {
        label,
        top: sheet.number === 1 ? panel.tree : sheet.root,
        root: sheet.root,
        from: sheet.from ? (sheet.from.sheet === 1 ? String(n) : markerLabel(sheet.from.sheet)) : undefined,
        markerLabel,
        ...size(sheet.root),
      };
      if (piece.w <= opts.budget.w && piece.h <= opts.budget.h) {
        out.push(piece);
        continue;
      }
      // Still too big: a family whose children alone outgrow the page, which
      // the split never parts. Its children go over several pieces instead,
      // the couple repeated on each: 15.3, then 15.3/2, 15.3/3 …
      const fits = (root: TreeNode) => {
        const s = size(root);
        return s.w <= opts.budget.w && s.h <= opts.budget.h;
      };
      splitFamily(sheet.root, fits).forEach((root, i) => {
        out.push(i === 0 ? { ...piece, root, ...size(root) } : { ...piece, label: `${label}/${i + 1}`, top: root, root, from: label, ...size(root) });
      });
    }
  }
  return out;
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
  const list = pieces(tree, opts, plain);
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

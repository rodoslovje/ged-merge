// The Complete Tree: everyone connected to a person — blood relatives, the
// people they married, and those spouses' own families — drawn as a set of
// descendant trees ("panels") on one canvas, each person's line exactly once.
//
// The first panel hangs from the root's topmost ancestor (up the father's side
// first), so it carries the root, their ancestors' line and all its cousins. A
// spouse in it whose parents are in the file has a family of their own the
// panel can't show without crossing lines: that family becomes the next panel,
// hung from the spouse's own topmost ancestor not drawn yet. And so on, until
// every connected person's line is drawn. The spouse box then carries the
// number of the panel their line is in — the classic "separated tree" cross
// reference of large paper charts.
//
// One tree builder (`treeBuilder`) builds every panel, so its guards hold for
// the whole chart: a key is unique across panels, and a union whose children
// one panel already drew is a repeat in the next, pointing back.
//
// Pure: no React, no DOM.

import type { Dataset, Individual } from "../gedcom/types";
import { emptyDataset } from "../gedcom/builder";
import type { Translate } from "../locales/i18n";
import { firstParent, nodeKey, treeBuilder, type NameFormatter, type TreeNode } from "./personTree";
import {
  COL_STEP,
  PAD,
  flatten,
  layout,
  layoutGrid,
  type ChartAlignment,
  type ChartConnector,
  type Flat,
  type Placed,
} from "./treeLayout";

/** One descendant tree of the Complete Tree. */
export interface CompletePanel {
  /** 1, 2, 3 … in build order; what the cross-reference badges say. */
  number: number;
  /** The panel's topmost person, the tree hanging from them. */
  tree: TreeNode;
}

export interface CompleteTree {
  panels: CompletePanel[];
  /** Key of the root person's own (line-carrying) position. */
  rootKey?: string;
  /** People drawn, each counted once however many boxes they have. */
  people: number;
  /** The people cap stopped the walk before every connected family had its
   *  panel: some spouses' lines are not drawn. */
  truncated: boolean;
}

/** Past this many people no further panel starts — an SVG of tens of thousands
 *  of boxes is past what a browser pans smoothly, and past what anyone reads. */
export const COMPLETE_MAX_PEOPLE = 5000;

const EMPTY_DS = emptyDataset();
const EMPTY_MAPS = { mainToCompare: new Map<string, string>(), compareToMain: new Map<string, string>() };

/** Every node of a panel's tree with whether it is a partner (a spouse box)
 *  rather than a blood member of the tree. */
function walkTree(root: TreeNode, fn: (n: TreeNode, partner: boolean) => void): void {
  const visit = (n: TreeNode, partner: boolean) => {
    fn(n, partner);
    // A spouse box has no spouses of its own; its children are the union's.
    for (const p of n.partners) {
      fn(p, true);
      p.children.forEach((c) => visit(c, false));
    }
    n.children.forEach((c) => visit(c, false));
  };
  visit(root, false);
}

export function buildCompleteTree(
  t: Translate,
  root: Individual,
  ds: Dataset,
  nameOf?: NameFormatter,
  maxPeople = COMPLETE_MAX_PEOPLE,
): CompleteTree {
  const b = treeBuilder(t, ds, EMPTY_DS, EMPTY_MAPS, undefined, nameOf);
  const drawn = (p: Individual) => b.expanded.has(nodeKey(p, undefined));

  /** The person a panel for `p` hangs from: up through the parents whose line
   *  no panel draws yet, the father's side first. */
  const topOf = (p: Individual): Individual => {
    const seen = new Set<string>([p.id]);
    let cur = p;
    for (;;) {
      const up = (["husband", "wife"] as const)
        .map((role) => firstParent(cur, ds, role))
        .find((x): x is Individual => !!x && !drawn(x) && !seen.has(x.id));
      if (!up) return cur;
      seen.add(up.id);
      cur = up;
    }
  };
  /** Would a panel hung from `top` draw anyone new? A person with no family
   *  above them is worth a panel only for a union no panel has drawn. */
  const worthAPanel = (top: Individual): boolean =>
    !drawn(top) && (top.childOf.length > 0 || top.spouseOf.some((f) => !b.expandedFams.has(`m:${f}`)));

  const panels: CompletePanel[] = [];
  /** Node key → its panel number; person id → their line's key. */
  const panelOf = new Map<string, number>();
  const lineKey = new Map<string, string>();
  const queue: Individual[] = [root];
  let people = 0;
  let truncated = false;

  for (let i = 0; i < queue.length; i++) {
    const top = topOf(queue[i]);
    // The root's own panel is drawn whatever it holds, even the root alone.
    if (i > 0 && !worthAPanel(top)) continue;
    if (people >= maxPeople) {
      truncated = true;
      break;
    }
    const tree = b.build(top);
    if (!tree) continue;
    const number = panels.length + 1;
    panels.push({ number, tree });
    walkTree(tree, (n, partner) => {
      panelOf.set(n.key, number);
      if (!n.main) return;
      if (partner) {
        // A spouse: their own family is somewhere else — queue it.
        if (!lineKey.has(n.main.id)) queue.push(n.main);
      } else if (!n.repeat && !lineKey.has(n.main.id)) {
        lineKey.set(n.main.id, n.key);
        people++;
      }
    });
  }

  // Spouses drawn nowhere else count once, as the boxes they are.
  const spousesOnly = new Set<string>();
  for (const { tree } of panels) {
    walkTree(tree, (n, partner) => {
      if (!n.main) return;
      if (partner && !lineKey.has(n.main.id)) spousesOnly.add(n.main.id);
      // Cross references: a spouse whose line is drawn elsewhere points at it
      // (a union repeat keeps pointing at where its children are), and either
      // carries that panel's number when it is another panel.
      if (partner && !n.repeat) {
        const at = lineKey.get(n.main.id);
        if (at) {
          n.repeat = true;
          n.repeatOf = at;
        }
      }
      if (n.repeat && n.repeatOf) {
        const there = panelOf.get(n.repeatOf);
        if (there !== undefined && there !== panelOf.get(n.key)) n.continuesOn = there;
      }
    });
  }

  return { panels, rootKey: lineKey.get(root.id), people: people + spousesOnly.size, truncated };
}

// ─── Layout ───────────────────────────────────────────────────────────────────

/** Height of a panel's title band, above its tree. */
export const PANEL_TITLE_H = 40;
/** Inner padding between a panel's edge and its tree. */
export const PANEL_INSET = 16;
/** Gap between neighbouring panels. */
export const PANEL_GAP = 48;

/** A panel's frame on the canvas (content coordinates, as the nodes). */
export interface PanelBox {
  number: number;
  /** The panel's topmost person — its title. */
  top: TreeNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CompleteLaid {
  /** The root person's position — where the canvas opens. */
  root: Placed;
  /** Each panel's laid tree, in panel order. */
  trees: Placed[];
  panels: PanelBox[];
  width: number;
  height: number;
}

/** Lay every panel out as the direction charts do (tidy or grid), then pack the
 *  frames onto one canvas: in panel order, each into the lowest free spot of a
 *  roughly landscape sheet, so the numbers read left to right, top to bottom. */
export function layoutComplete(
  tree: CompleteTree,
  alignment: ChartAlignment = "lr",
  nodeH?: number,
  grid = false,
): CompleteLaid | undefined {
  if (tree.panels.length === 0) return undefined;
  const lay = grid ? layoutGrid : layout;
  const laid = tree.panels.map((p) => lay(p.tree, alignment, nodeH));
  // Each layout comes back padded by PAD on every side; the frame's own inset
  // replaces it.
  const sizes = laid.map((l) => ({
    w: l.width - PAD * 2 + PANEL_INSET * 2,
    h: l.height - PAD * 2 + PANEL_INSET * 2 + PANEL_TITLE_H,
  }));
  const area = sizes.reduce((s, r) => s + (r.w + PANEL_GAP) * (r.h + PANEL_GAP), 0);
  const sheetW = Math.max(...sizes.map((r) => r.w), Math.sqrt(area * 1.6), COL_STEP);
  const spots = packSkyline(sizes, sheetW, PANEL_GAP);

  const panels: PanelBox[] = tree.panels.map((p, i) => ({
    number: p.number,
    top: p.tree,
    ...spots[i],
    ...sizes[i],
  }));
  laid.forEach((l, i) => {
    const dx = panels[i].x + PANEL_INSET;
    const dy = panels[i].y + PANEL_INSET + PANEL_TITLE_H;
    const shift = (n: Placed): void => {
      n.x += dx;
      n.y += dy;
      n.partners.forEach(shift);
      n.children.forEach(shift);
    };
    shift(l.root);
  });
  const trees = laid.map((l) => l.root);
  let root: Placed = trees[0];
  if (tree.rootKey) {
    const find = (n: Placed): Placed | undefined =>
      n.key === tree.rootKey ? n : [...n.partners, ...n.children].reduce<Placed | undefined>((hit, c) => hit ?? find(c), undefined);
    root = trees.reduce<Placed | undefined>((hit, t) => hit ?? find(t), undefined) ?? root;
  }
  const width = Math.max(...panels.map((p) => p.x + p.w)) + PAD * 2;
  const height = Math.max(...panels.map((p) => p.y + p.h)) + PAD * 2;
  return { root, trees, panels, width, height };
}

/** Flatten every panel's tree into one draw list, as `flatten` does one tree. */
export function flattenComplete(
  laid: CompleteLaid,
  alignment: ChartAlignment = "lr",
  connector: ChartConnector = "curve",
  nodeH?: number,
  marriageLabel?: (node: TreeNode) => string | undefined,
): Flat {
  const parts = laid.trees.map((t) => flatten(t, alignment, connector, nodeH, marriageLabel));
  return { nodes: parts.flatMap((p) => p.nodes), edges: parts.flatMap((p) => p.edges) };
}

/**
 * Bottom-left skyline packing: each rectangle, in order, goes where its top
 * edge sits lowest across a sheet `sheetW` wide (leftmost on a tie). The
 * skyline is the height already filled at each x. Order is kept, so the
 * sheet reads in sequence; the lowest-spot rule fills the gaps beside a tall
 * panel with the small ones that follow it.
 */
export function packSkyline(
  sizes: { w: number; h: number }[],
  sheetW: number,
  gap: number,
): { x: number; y: number }[] {
  // Segments of equal fill, left to right, covering [0, ∞).
  let sky: { x: number; y: number }[] = [{ x: 0, y: 0 }];
  const segEnd = (i: number) => (i + 1 < sky.length ? sky[i + 1].x : Infinity);
  const out: { x: number; y: number }[] = [];
  for (const { w, h } of sizes) {
    const need = w + gap;
    let best: { x: number; y: number } | undefined;
    for (let i = 0; i < sky.length; i++) {
      const x = sky[i].x;
      if (x > 0 && x + w > sheetW) break;
      let y = 0;
      for (let j = i; j < sky.length && sky[j].x < x + need; j++) y = Math.max(y, sky[j].y);
      if (!best || y < best.y) best = { x, y };
    }
    const spot = best ?? { x: 0, y: Math.max(...sky.map((s) => s.y)) };
    out.push(spot);
    // Raise the skyline under the new rectangle (and its gap).
    const from = spot.x;
    const to = spot.x + need;
    const top = spot.y + h + gap;
    const next: { x: number; y: number }[] = [];
    for (let i = 0; i < sky.length; i++) {
      const s = sky[i];
      const end = segEnd(i);
      if (end <= from || s.x >= to) {
        next.push(s);
        continue;
      }
      if (s.x < from) next.push({ x: s.x, y: s.y });
      if (end > to) next.push({ x: to, y: s.y });
    }
    next.push({ x: from, y: top });
    next.sort((a, b) => a.x - b.x);
    // Merge neighbours of equal height.
    sky = next.filter((s, i) => i === 0 || s.y !== next[i - 1].y);
  }
  return out;
}

// Shared tree geometry for the full-page tree views (Edit Tree & Compare Tree).
// Pure, framework-free: node sizing, the left-to-right layered layout, and the
// SVG connector paths. Both views render different node contents on top of this
// identical skeleton, so the geometry lives here once.

import type { TreeNode } from "./compareTree";

// ─── Node / grid sizing ───────────────────────────────────────────────────────

export const NODE_W = 220;
// Box height matches the Edit-mode person card (a ~46px photo + padding).
export const NODE_H = 56;
export const PHOTO_SIZE = 46;
// Photo sits on the left, vertically centred.
export const PHOTO_X = 5;
export const PHOTO_Y = (NODE_H - PHOTO_SIZE) / 2;
// Text begins right of the photo column when a media folder is loaded (photos
// then occupy the reserved space); otherwise it starts at the left padding.
export const TEXT_X_PHOTO = PHOTO_X + PHOTO_SIZE + 8;
export const TEXT_X_PLAIN = 16;
export const COL_GAP = 80;
export const ROW_GAP = 18;
export const COL_STEP = NODE_W + COL_GAP;
export const ROW_STEP = NODE_H + ROW_GAP;
export const PAD = 24;

// ─── Layout types ─────────────────────────────────────────────────────────────

/** A tree node with absolute pixel coordinates assigned by `layout`. */
export interface Placed extends TreeNode {
  x: number;
  y: number;
  children: Placed[];
  partners: Placed[];
}

/** A laid-out tree flattened to a draw list: every node plus its connectors. */
export interface Flat {
  nodes: Placed[];
  edges: { id: string; d: string; partner?: boolean }[];
}

/** The visible window over the canvas, in canvas pixels. */
export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ─── Flattening & connectors ──────────────────────────────────────────────────

/** Collect every node plus its child and partner connectors from the laid-out tree. */
export function flatten(root: Placed): Flat {
  const nodes: Placed[] = [];
  const edges: Flat["edges"] = [];
  (function walk(n: Placed) {
    nodes.push(n);
    // Spouses sit in the same column, chained directly below the person; each
    // union's children branch from that spouse.
    let prev: Placed = n;
    for (const p of n.partners) {
      nodes.push(p);
      edges.push({ id: `${prev.key}~${p.key}`, d: partnerPath(prev, p), partner: true });
      prev = p;
      for (const c of p.children) {
        edges.push({ id: `${p.key}->${c.key}`, d: edgePath(p, c) });
        walk(c);
      }
    }
    // Children of a spouseless family connect to the person directly.
    for (const c of n.children) {
      edges.push({ id: `${n.key}->${c.key}`, d: edgePath(n, c) });
      walk(c);
    }
  })(root);
  return { nodes, edges };
}

function edgePath(parent: Placed, child: Placed): string {
  const x1 = parent.x + NODE_W;
  const y1 = parent.y + NODE_H / 2;
  const x2 = child.x;
  const y2 = child.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

/** A short vertical link between a person and their spouse (same column). */
function partnerPath(person: Placed, partner: Placed): string {
  const x = person.x + 18;
  return `M${x},${person.y + NODE_H} L${x},${partner.y}`;
}

// ─── Layout ───────────────────────────────────────────────────────────────────

/**
 * Left-to-right layered layout. Depth sets the column (x). A person and their
 * spouses are stacked in that column as a series of "anchors"; each anchor's own
 * children occupy the next column, so children sit beside the spouse they belong
 * to. Every anchor reserves `max(1, Σ child rows)` rows and is centred on its
 * children, so the whole person group spans the sum of its anchors' rows and no
 * two subtrees overlap.
 */
export function layout(root: TreeNode): { root: Placed; width: number; height: number } {
  const groupMemo = new Map<TreeNode, number>();
  const anchorRows = (children: TreeNode[]): number =>
    Math.max(1, children.reduce((s, c) => s + groupRows(c), 0));
  const groupRows = (node: TreeNode): number => {
    const cached = groupMemo.get(node);
    if (cached != null) return cached;
    let total = anchorRows(node.children);
    for (const p of node.partners) total += anchorRows(p.children);
    const v = Math.max(1, total);
    groupMemo.set(node, v);
    return v;
  };

  // Place one anchor's children (in the next column) and return where the anchor
  // itself should sit, vertically centred on them.
  const placeAnchor = (
    anchorChildren: TreeNode[],
    depth: number,
    top: number,
  ): { y: number; children: Placed[]; band: number } => {
    const childRows = anchorChildren.reduce((s, c) => s + groupRows(c), 0);
    const band = Math.max(1, childRows);
    let cursor = top + ((band - childRows) / 2) * ROW_STEP;
    const children = anchorChildren.map((c) => {
      const placed = place(c, depth, cursor);
      cursor += groupRows(c) * ROW_STEP;
      return placed;
    });
    const y =
      children.length > 0
        ? Math.max(
            top,
            Math.min(
              (children[0].y + children[children.length - 1].y) / 2,
              top + (band - 1) * ROW_STEP,
            ),
          )
        : top;
    return { y, children, band };
  };

  const place = (node: TreeNode, depth: number, top: number): Placed => {
    const x = depth * COL_STEP;
    let cursor = top;
    const self = placeAnchor(node.children, depth + 1, cursor);
    cursor += self.band * ROW_STEP;
    const partners: Placed[] = node.partners.map((p) => {
      const a = placeAnchor(p.children, depth + 1, cursor);
      cursor += a.band * ROW_STEP;
      return { ...p, x, y: a.y, children: a.children, partners: [] };
    });
    return { ...node, x, y: self.y, children: self.children, partners };
  };

  const placed = place(root, 0, 0);
  const total = groupRows(root);
  return {
    root: placed,
    width: maxDepth(root) * COL_STEP + NODE_W + PAD * 2,
    height: (total - 1) * ROW_STEP + NODE_H + PAD * 2,
  };
}

/** Generations deep: spouses share the person's column, but their children don't. */
function maxDepth(node: TreeNode): number {
  const kids = [...node.children, ...node.partners.flatMap((p) => p.children)];
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map(maxDepth));
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Shared tree geometry for the full-page tree views (Edit Tree & Compare Tree).
// Pure, framework-free: node sizing, the left-to-right layered layout, and the
// SVG connector paths. Both views render different node contents on top of this
// identical skeleton, so the geometry lives here once.

import type { TreeNode } from "./personTree";

/** Which way a layered diagram grows: left→right (default) or top→bottom. The
 *  canonical home for the type — the UI's ChartSettings re-exports it. */
export type ChartAlignment = "lr" | "tb";

// ─── Node / grid sizing ───────────────────────────────────────────────────────

export const NODE_W = 220;
// Box height matches the Edit-mode person card (a ~50px photo + padding).
export const NODE_H = 56;
// Each stacked detail line (lifespan, place, kinship) below the name is this tall.
export const DETAIL_ROW_H = 16;
// Baseline of the first detail row (beneath the name).
export const DETAIL_ROW_TOP = 40;

/** Which detail rows the current settings show — lifespan, place, and kinship each
 *  get their own stacked row beneath the name. */
export interface DetailToggles {
  showLifespan: boolean;
  /** Age folds into the lifespan row, or — with the lifespan hidden — stands on
   *  its own in that same row, so either toggle reserves the one row. */
  showAge: boolean;
  showPlace: boolean;
  showKinship: boolean;
}

/** How many detail rows are enabled (0–3). */
export function detailRowCount(o: DetailToggles): number {
  return (o.showLifespan || o.showAge ? 1 : 0) + (o.showPlace ? 1 : 0) + (o.showKinship ? 1 : 0);
}

/** The node-box height for the current display settings: the base box holds the
 *  name plus one detail row; each additional enabled detail row makes it taller.
 *  Threaded into the layout fns and the box renderers so spacing, connectors, and
 *  rects all agree. */
export function nodeHeight(o: DetailToggles): number {
  return NODE_H + Math.max(0, detailRowCount(o) - 1) * DETAIL_ROW_H;
}
export const PHOTO_SIZE = 50;
// Photo sits on the left, vertically centred, ~3px inside the box border.
export const PHOTO_X = 3;
export const PHOTO_Y = (NODE_H - PHOTO_SIZE) / 2;
// Text begins right of the photo column when a media folder is loaded (photos
// then occupy the reserved space); otherwise it starts at the left padding.
export const TEXT_X_PHOTO = PHOTO_X + PHOTO_SIZE + 8;
export const TEXT_X_PLAIN = 16;
export const COL_GAP = 80;
export const ROW_GAP = 18;
export const COL_STEP = NODE_W + COL_GAP;
export const ROW_STEP = NODE_H + ROW_GAP;
// Top→bottom diagrams advance generations along the vertical (NODE_H) axis. The
// slim ROW_GAP that stacks siblings in LR leaves almost no room for the
// parent→child connectors, which fan out sideways across the box width — in a
// family with many children they collapse into a barely-visible smear. So TB
// gets a much larger generation gap of its own.
export const ROW_GAP_TB = 70;
export const ROW_STEP_TB = NODE_H + ROW_GAP_TB;
export const PAD = 24;

// ─── Layout types ─────────────────────────────────────────────────────────────

/** The minimal node shape the shared canvas machinery (useTreeCanvas,
 *  TreeMinimap, selection) needs: a selection key plus a position in native
 *  (pre-zoom) canvas px. Every chart's nodes satisfy it structurally — layered
 *  `Placed` boxes, fan segments, relationship boxes, timeline rows. */
export interface ChartNode {
  key: string;
  x: number;
  y: number;
}

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
  edges: {
    id: string;
    d: string;
    partner?: boolean;
    /** Marriage label centred on a partner connector (when enabled + recorded). */
    label?: { x: number; y: number; text: string };
  }[];
}

/** Connector shape: smooth Béziers for the tidy tree, right-angle "elbows" for
 *  the grid (where parent→child can span many lanes, so a curve reads poorly). */
export type ChartConnector = "curve" | "elbow";

/** The visible window over the canvas, in canvas pixels. */
export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Whether the minimap should start expanded for a diagram of `contentW`×`contentH`
 * shown through `viewport`. It only earns the space when the chart is much larger
 * than the screen — i.e. at most a quarter of its area is visible at once. Once
 * more than 25% already fits, the minimap defaults to collapsed (the small "show"
 * toggle stays available). Returns `false` until the viewport has been measured.
 */
export function minimapDefaultOpen(contentW: number, contentH: number, viewport: Viewport): boolean {
  if (viewport.width <= 0 || contentW <= 0 || contentH <= 0) return false;
  const shownFraction =
    (Math.min(viewport.width, contentW) * Math.min(viewport.height, contentH)) / (contentW * contentH);
  return shownFraction < 0.25;
}

/** Fraction of the visible canvas the minimap box may occupy on each axis —
   kept small so the overview stays a corner aid rather than covering the chart. */
const MINIMAP_MAX_W_FRACTION = 0.32;
const MINIMAP_MAX_H_FRACTION = 0.24;
/** Hard pixel floor for the box caps, so a tiny tree still renders a usable,
   clickable map on a small screen. */
const MINIMAP_MIN = 120;
/** Thinnest the map may get on its short axis before that axis is stretched on
   its own. A deep top-down tree runs ~70:1 (256 leaf boxes wide, 9 rows tall),
   which a uniform fit would squash to a 6px thread — visible but unreadable. */
const MINIMAP_MIN_THICKNESS = 80;

/** Box size and per-axis scales for the overview map of a `cw`×`ch` diagram (in
 *  on-screen pixels, i.e. zoom already applied) shown through `viewport`.
 *
 *  The tree is fitted with one uniform scale — the constraining axis fills its
 *  cap, the other takes only what it needs, so proportions stay true. Extreme
 *  aspect ratios are the exception: when that leaves the short axis under
 *  {@link MINIMAP_MIN_THICKNESS}, only that axis is scaled up to the floor. The
 *  map then reads as a navigation ribbon (rows spread apart, the long axis
 *  untouched) instead of a hairline. Callers must use `scaleX`/`scaleY`
 *  separately for node dots, the viewport rectangle and click mapping alike, so
 *  navigation stays exact under the stretch.
 */
export function minimapFit(cw: number, ch: number, viewport: Viewport) {
  const maxW = Math.max(MINIMAP_MIN, viewport.width * MINIMAP_MAX_W_FRACTION);
  const maxH = Math.max(MINIMAP_MIN, viewport.height * MINIMAP_MAX_H_FRACTION);
  const fit = Math.min(maxW / cw, maxH / ch);
  // Only the non-constraining axis can fall under the floor: the constraining
  // one sits at its cap, which is never below MINIMAP_MIN (> the floor).
  const scaleX = Math.max(fit, Math.min(maxW, MINIMAP_MIN_THICKNESS) / cw);
  const scaleY = Math.max(fit, Math.min(maxH, MINIMAP_MIN_THICKNESS) / ch);
  return { scaleX, scaleY, w: cw * scaleX, h: ch * scaleY };
}

// ─── Flattening & connectors ──────────────────────────────────────────────────

/** Collect every node plus its child and partner connectors from the laid-out tree. */
export function flatten(
  root: Placed,
  alignment: ChartAlignment = "lr",
  connector: ChartConnector = "curve",
  nodeH: number = NODE_H,
  /** When set, label each couple's connector with their marriage (year / place).
   *  Descendant mode reads a partner node's marriage; ancestor mode reads a node's
   *  parents' marriage (bracketed between that node's two parent children). */
  marriageLabel?: (node: TreeNode) => string | undefined,
  /** True in ancestor mode (children are parents) — switches the marriage label
   *  from the partner connector to a bracket between a node's two parents. */
  ancestors = false,
): Flat {
  const nodes: Placed[] = [];
  const edges: Flat["edges"] = [];
  (function walk(n: Placed) {
    nodes.push(n);
    // Spouses sit alongside the person (in the breadth direction), chained off
    // them; each union's children branch from that spouse.
    let prev: Placed = n;
    for (const p of n.partners) {
      nodes.push(p);
      const text = marriageLabel?.(p);
      edges.push({
        id: `${prev.key}~${p.key}`,
        d: partnerPath(prev, p, alignment, nodeH),
        partner: true,
        label: text ? { ...partnerMidpoint(prev, p, alignment, nodeH), text } : undefined,
      });
      prev = p;
      for (const c of p.children) {
        // Every child of the union leaves from the same box, so they share one
        // trunk that branches to each of them — including the child grid
        // compaction hoists onto the person's own lane, which used to get its
        // own straight line from the person and so read as that person's alone
        // while its siblings hung off the spouse.
        edges.push({ id: `${p.key}->${c.key}`, d: edgePath(p, c, alignment, connector, nodeH) });
        walk(c);
      }
    }
    // Ancestor mode: link the node's two parents (its children) with a partner line
    // and hang the marriage label between them — the couple have no line of their own.
    if (ancestors && n.children.length >= 2) {
      const text = marriageLabel?.(n);
      if (text) {
        const b = parentBracket(n.children, alignment, nodeH);
        edges.push({ id: `${n.key}=m`, d: b.d, partner: true, label: { x: b.x, y: b.y, text } });
      }
    }
    // Children of a spouseless family connect to the person directly.
    for (const c of n.children) {
      edges.push({ id: `${n.key}->${c.key}`, d: edgePath(n, c, alignment, connector, nodeH) });
      walk(c);
    }
  })(root);
  return { nodes, edges };
}

/** Parent→child connector: a smooth Bézier from the parent's trailing edge (right
 *  in LR, bottom in TB) to the child's leading edge, curving along the depth axis.
 *  In `"elbow"` mode it's instead a right-angle path that drops down a shared
 *  trunk just inside the parent and turns into each child — the indented-tree look
 *  that keeps the grid legible when children sit many lanes below their parent. */
function edgePath(
  parent: Placed,
  child: Placed,
  alignment: ChartAlignment,
  connector: ChartConnector = "curve",
  nodeH: number = NODE_H,
): string {
  if (connector === "elbow") {
    if (alignment === "tb") {
      // Depth runs down: drop from the parent's bottom, run across, drop in. A
      // child on the parent's own lane (same x) just gets the straight drop.
      const x1 = parent.x + NODE_W / 2;
      const y1 = parent.y + nodeH;
      const x2 = child.x + NODE_W / 2;
      const y2 = child.y;
      const my = (y1 + y2) / 2;
      return `M${x1},${y1} V${my} H${x2} V${y2}`;
    }
    // Depth runs right. Every child of a node forks from one shared point — the
    // parent box's right edge, mid-height: a short stem to a junction in the
    // column gap, a vertical bus to the child's lane (up or down), then a stub
    // into its left edge. A child on the parent's own lane needs no bus, so its
    // path collapses to a straight line.
    const startX = parent.x + NODE_W;
    const startY = parent.y + nodeH / 2;
    const junctionX = parent.x + NODE_W + COL_GAP / 2;
    const y2 = child.y + nodeH / 2;
    return `M${startX},${startY} H${junctionX} V${y2} H${child.x}`;
  }
  if (alignment === "tb") {
    const x1 = parent.x + NODE_W / 2;
    const y1 = parent.y + nodeH;
    const x2 = child.x + NODE_W / 2;
    const y2 = child.y;
    const my = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
  }
  const x1 = parent.x + NODE_W;
  const y1 = parent.y + nodeH / 2;
  const x2 = child.x;
  const y2 = child.y + nodeH / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

/** Connector + label anchor joining two boxes that form a couple, drawn box-centre
 *  to box-centre across the gap between them: bottom→top in LR (stacked), right→left
 *  in TB (side by side). Robust to which box comes first. */
function coupleLink(
  a: Placed,
  b: Placed,
  alignment: ChartAlignment,
  nodeH: number = NODE_H,
): { d: string; x: number; y: number } {
  if (alignment === "tb") {
    // Side by side: link the inner (facing) edges at each box's vertical centre.
    const [l, r] = a.x <= b.x ? [a, b] : [b, a];
    const x1 = l.x + NODE_W;
    const x2 = r.x;
    const y1 = l.y + nodeH / 2;
    const y2 = r.y + nodeH / 2;
    return { d: `M${x1},${y1} L${x2},${y2}`, x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }
  // Stacked: link the inner edges at each box's horizontal centre.
  const [hi, lo] = a.y <= b.y ? [a, b] : [b, a];
  const x1 = hi.x + NODE_W / 2;
  const x2 = lo.x + NODE_W / 2;
  const y1 = hi.y + nodeH;
  const y2 = lo.y;
  return { d: `M${x1},${y1} L${x2},${y2}`, x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
}

/** Partner connector between a person and their spouse (descendant mode). */
function partnerPath(person: Placed, partner: Placed, alignment: ChartAlignment, nodeH: number = NODE_H): string {
  return coupleLink(person, partner, alignment, nodeH).d;
}

/** Midpoint of the {@link partnerPath} connector — where the marriage label rides. */
function partnerMidpoint(
  person: Placed,
  partner: Placed,
  alignment: ChartAlignment,
  nodeH: number = NODE_H,
): { x: number; y: number } {
  const { x, y } = coupleLink(person, partner, alignment, nodeH);
  return { x, y };
}

/** Marriage line between a node's two parents (ancestor mode): joins their boxes
 *  through their centres, with the label at the midpoint — sitting between husband
 *  and wife, exactly like a descendant partner line. */
function parentBracket(
  parents: Placed[],
  alignment: ChartAlignment,
  nodeH: number = NODE_H,
): { d: string; x: number; y: number } {
  return coupleLink(parents[0], parents[parents.length - 1], alignment, nodeH);
}

// ─── Layout ───────────────────────────────────────────────────────────────────

/**
 * Layered layout. Depth (generation) advances along one axis; siblings and
 * spouses spread along the other ("breadth"). A person and their spouse(s) occupy
 * one depth slot, their children the next. With a single union the couple sits
 * together, centred over their shared children. With several unions each spouse
 * is instead placed over its own union's children (the person beside the first),
 * so a later marriage spreads out far enough for its connectors to read clearly.
 * The exact breadth arrangement lives in `arrange`; every group reserves enough
 * rows for both its children and its couple, so no two subtrees overlap.
 *
 * The algorithm runs in left→right space (depth = x, breadth = y); for "tb" the
 * placed coordinates are transposed at the end. Because the box is much wider
 * than tall, the depth and breadth step sizes differ per alignment so generations
 * and siblings each get spacing matched to the box dimension they advance along.
 */
export function layout(
  root: TreeNode,
  alignment: ChartAlignment = "lr",
  nodeH: number = NODE_H,
): { root: Placed; width: number; height: number } {
  const lr = alignment === "lr";
  // Step along generations (depth) and along siblings/spouses (breadth). In LR
  // depth runs horizontally (NODE_W wide), breadth vertically (nodeH tall); in
  // TB they swap, so the breadth step must clear the box width and vice versa.
  const depthStep = lr ? COL_STEP : nodeH + ROW_GAP_TB;
  const breadthStep = lr ? nodeH + ROW_GAP : COL_STEP;

  // Per-node breadth arrangement, in row units (alignment-independent): the
  // breadth row of the person and each spouse ("members", person first), where
  // the children block starts, and the total rows the group reserves. A single
  // union centres the couple over its shared children; multiple unions instead
  // give each spouse its own children to sit over — with the person adjacent to
  // the first — so a later marriage spreads out and its connectors stay legible.
  interface Arrange { memberY: number[]; childStart: number; band: number }
  const arrangeMemo = new Map<TreeNode, Arrange>();
  const arrange = (node: TreeNode): Arrange => {
    const cached = arrangeMemo.get(node);
    if (cached) return cached;
    // Child rows per "group": the person's spouseless children first, then each
    // union's children, in couple order. w[0] is the person, w[i>0] the spouses.
    const w = [
      node.children.reduce((s, c) => s + groupRows(c), 0),
      ...node.partners.map((p) => p.children.reduce((s, c) => s + groupRows(c), 0)),
    ];
    const childRows = w.reduce((s, n) => s + n, 0);
    const coupleSize = w.length;

    let result: Arrange;
    if (node.partners.length <= 1) {
      // Couple centred over the (shared) children block.
      const band = Math.max(1, childRows, coupleSize);
      const coupleTop = (band - coupleSize) / 2;
      result = {
        memberY: w.map((_, i) => coupleTop + i),
        childStart: (band - childRows) / 2,
        band,
      };
    } else {
      // Spread: place each member over the centre of its own children (the
      // person over its spouseless children, each spouse over that union's),
      // pushed right only as far as needed to stay clear of the previous member.
      const start: number[] = [];
      let acc = 0;
      for (const width of w) { start.push(acc); acc += width; }
      const memberY: number[] = [];
      let prev = -Infinity;
      w.forEach((width, i) => {
        const own = width > 0 ? start[i] + (width - 1) / 2 : prev + 1;
        const y = Math.max(prev === -Infinity ? 0 : prev + 1, own);
        memberY.push(y);
        prev = y;
      });
      result = {
        memberY,
        childStart: 0,
        band: Math.max(1, childRows, memberY[memberY.length - 1] + 1),
      };
    }
    arrangeMemo.set(node, result);
    return result;
  };
  const groupRows = (node: TreeNode): number => arrange(node).band;

  const place = (node: TreeNode, depth: number, top: number): Placed => {
    const x = depth * depthStep;
    const { memberY, childStart } = arrange(node);

    // Children (direct first, then each union's, in couple order) laid out
    // contiguously from the block start. `y` is the breadth coordinate; it
    // becomes `x` after the transpose for "tb".
    let cursor = top + childStart * breadthStep;
    const placeKids = (kids: TreeNode[]): Placed[] =>
      kids.map((c) => {
        const placed = place(c, depth + 1, cursor);
        cursor += groupRows(c) * breadthStep;
        return placed;
      });
    const directChildren = placeKids(node.children);
    const partnerChildren = node.partners.map((p) => placeKids(p.children));

    const partners: Placed[] = node.partners.map((p, i) => ({
      ...p,
      x,
      y: top + memberY[i + 1] * breadthStep,
      children: partnerChildren[i],
      partners: [],
    }));
    return { ...node, x, y: top + memberY[0] * breadthStep, children: directChildren, partners };
  };

  const placed = place(root, 0, 0);
  const total = groupRows(root);
  // Computed in LR space; for TB swap each node's axes so depth runs down.
  if (!lr) transpose(placed);

  // Extents along each axis, then mapped to width/height by alignment.
  const depthExtent = maxDepth(root) * depthStep + (lr ? NODE_W : nodeH);
  const breadthExtent = (total - 1) * breadthStep + (lr ? nodeH : NODE_W);
  return {
    root: placed,
    width: (lr ? depthExtent : breadthExtent) + PAD * 2,
    height: (lr ? breadthExtent : depthExtent) + PAD * 2,
  };
}

/**
 * Grid layout — the "Excel columns" diagram. Generations form aligned columns
 * (the depth axis) exactly like the tidy tree, but each person snaps to a regular
 * lane on the breadth axis so boxes line up like a spreadsheet.
 *
 * It's compact: a node shares its lane with its *first* next-column child —
 * whether a direct child or its first union's first child — so an only-child
 * lineage stays on a single row and merely steps one column per generation: the
 * start person sits top-left and the direct line runs straight across. The
 * spouse sits pinned on the lane right below the person (same column, so it
 * can't share the row) and the union's second child shares *that* lane in turn.
 * A lane is only spent on further siblings and on each spouse. The result reads
 * like an indented spreadsheet.
 *
 * Same `{ root, width, height }` contract as `layout`, so `flatten`, the
 * connectors, the minimap and the SVG export consume it unchanged. Pair it with
 * the `"elbow"` connector in `flatten`: branches that drop several lanes below
 * their parent need the right-angle routing to stay legible.
 */
export function layoutGrid(
  root: TreeNode,
  alignment: ChartAlignment = "lr",
  nodeH: number = NODE_H,
): { root: Placed; width: number; height: number } {
  const lr = alignment === "lr";
  const depthStep = lr ? COL_STEP : nodeH + ROW_GAP_TB;
  const breadthStep = lr ? nodeH + ROW_GAP : COL_STEP;

  // Running lane index. It only ever advances, so its final value is the last
  // lane used. Computed in LR space — depth → x, lane → y — then transposed for TB.
  let lane = 0;
  const place = (node: TreeNode, depth: number): Placed => {
    const x = depth * depthStep;
    const myLane = lane; // this node sits on the current lane…

    // …which its first spouseless child shares; each later child steps down one.
    let claimed = false;
    const children = node.children.map((c) => {
      if (claimed) lane++;
      claimed = true;
      return place(c, depth + 1);
    });

    // Spouses share the person's column, so each takes a fresh lane below; a
    // spouse in turn shares its lane with its own first child.
    const partners: Placed[] = node.partners.map((p, pi) => {
      // The first union's first child rises onto the person's still-free lane,
      // so the direct line runs straight across and the union spends no lane on
      // it. The spouse stays pinned right below the person, and the second
      // child shares the spouse's lane (when the first child's subtree allows).
      if (pi === 0 && !claimed && p.children.length > 0) {
        claimed = true;
        const pLane = myLane + 1;
        const first = place(p.children[0], depth + 1);
        const rest = p.children.slice(1).map((c) => {
          lane = Math.max(lane + 1, pLane);
          return place(c, depth + 1);
        });
        lane = Math.max(lane, pLane); // the spouse's lane is spent either way
        return { ...p, x, y: pLane * breadthStep, children: [first, ...rest], partners: [] };
      }
      const pLane = ++lane;
      let pClaimed = false;
      const pChildren = p.children.map((c) => {
        if (pClaimed) lane++;
        pClaimed = true;
        return place(c, depth + 1);
      });
      return { ...p, x, y: pLane * breadthStep, children: pChildren, partners: [] };
    });

    return { ...node, x, y: myLane * breadthStep, children, partners };
  };

  const placed = place(root, 0);
  if (!lr) transpose(placed);

  const laneCount = lane + 1;
  const depthExtent = maxDepth(root) * depthStep + (lr ? NODE_W : nodeH);
  const breadthExtent = (laneCount - 1) * breadthStep + (lr ? nodeH : NODE_W);
  return {
    root: placed,
    width: (lr ? depthExtent : breadthExtent) + PAD * 2,
    height: (lr ? breadthExtent : depthExtent) + PAD * 2,
  };
}

/** Swap x/y on a placed node and its whole subtree (spouses and their children
 *  included) — turns the left→right placement into top→bottom. */
function transpose(n: Placed): void {
  [n.x, n.y] = [n.y, n.x];
  n.partners.forEach(transpose);
  n.children.forEach(transpose);
}

/** Generations deep: spouses share the person's column, but their children don't. */
function maxDepth(node: TreeNode): number {
  const kids = [...node.children, ...node.partners.flatMap((p) => p.children)];
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map(maxDepth));
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Average glyph width of the 12px/600 node-name font, for overflow detection. */
const NAME_CHAR_W = 7;

/** SVG `<text>` props that squeeze an overflowing person name into the box's
 *  text area (glyphs compress horizontally); a name that fits renders
 *  naturally. Names are never ellipsized — the chart, and its SVG/PDF exports,
 *  always carry the full name. */
export function nameFit(
  name: string,
  textX: number,
): { textLength?: number; lengthAdjust?: "spacingAndGlyphs" } {
  const available = NODE_W - textX - 12;
  return name.length * NAME_CHAR_W > available
    ? { textLength: available, lengthAdjust: "spacingAndGlyphs" }
    : {};
}


// The radial bowtie: one full circle, the ancestor fan on its upper arc and the
// descendant fan on its lower arc, sharing the root disk in the middle. Each
// half is the ordinary chart of its direction (fanLayout.ts / descendantFan.ts)
// drawn on an arc of its own; the split between the two follows how much each
// side has to draw, and a notch at either side keeps them visibly apart.

import { PAD, ANCESTOR_KEY_PREFIX } from "./treeLayout";
import { countTreePeople, type TreeNode } from "./personTree";
import {
  FONT_BY_GEN,
  HALF,
  PHOTO_RING_W,
  ROOT_R,
  TAU,
  buildFanChart,
  fanResolvers,
  labelBand,
  labelTexts,
  round,
  sectorPath,
  type FanChart,
  type FanChartOptions,
  type FanSegment,
} from "./fanLayout";
import { buildDescendantFanChart } from "./descendantFan";
import type { Sibling, SiblingRow } from "./siblingRow";

/** The empty notch between the two halves, on each side of the circle. */
export const BUTTERFLY_GAP = (8 / 360) * TAU;
/** The ancestors' share of the drawable circle stays between these, so a side
 *  with almost nobody still gets a readable arc and the other never squeezes
 *  it into a sliver. */
const MIN_SHARE = 0.3;
const MAX_SHARE = 0.7;

/** Brothers and sisters ride the two notches: one wedge each, this wide… */
export const SIBLING_STEP = (11 / 360) * TAU;
/** …until a side holds this much, when its wedges narrow to share it. */
export const SIBLING_SIDE_MAX = (66 / 360) * TAU;
/** The gap either side of a notch's sibling wedges. */
const SIBLING_GAP = (4 / 360) * TAU;
/** The sibling wedges run out across the first two rings: nobody else is
 *  drawn there, and the outward-reading name needs the depth. */
export const SIBLING_R_OUT = ROOT_R + 2 * PHOTO_RING_W;
/** Prefix on a sibling segment's key, so it never meets a tree position. */
export const SIBLING_KEY_PREFIX = "sib:";

/** The sweep a notch takes: the bare gap, or its siblings' wedges with a gap
 *  each side. */
export function notchSweep(siblings: number): number {
  return siblings === 0 ? BUTTERFLY_GAP : Math.min(siblings * SIBLING_STEP, SIBLING_SIDE_MAX) + 2 * SIBLING_GAP;
}

/** How the circle is shared: each half's sweep in radians, from the head-counts
 *  of the two directions (the root excluded), around the two notches. */
export function butterflySplit(
  ancestors: number,
  descendants: number,
  notches = 2 * BUTTERFLY_GAP,
): { ancestors: number; descendants: number } {
  const avail = TAU - notches;
  const a = Math.max(ancestors, 1);
  const d = Math.max(descendants, 1);
  const share = Math.min(MAX_SHARE, Math.max(MIN_SHARE, a / (a + d)));
  return { ancestors: share * avail, descendants: avail - share * avail };
}

/** Build the radial bowtie from the root's ancestor and descendant trees —
 *  and, when given, the root's brothers and sisters in the two notches: the
 *  older on the right, the younger on the left. Clockwise from the top of the
 *  right notch the whole row then reads oldest to youngest, as the children
 *  below do. */
export function buildButterflyChart(
  ancestors: TreeNode,
  descendants: TreeNode,
  opts: FanChartOptions = {},
  siblings?: SiblingRow,
): FanChart {
  const right = notchSweep(siblings?.older.length ?? 0);
  const left = notchSweep(siblings?.younger.length ?? 0);
  const sweeps = butterflySplit(countTreePeople(ancestors), countTreePeople(descendants), right + left);
  // The ancestors centred on the top; clockwise from them the right notch,
  // the descendants and the left notch. With notches of one width the
  // descendants centre on the bottom, else they lean to the narrower notch.
  const arcA = { start: -HALF - sweeps.ancestors / 2, sweep: sweeps.ancestors };
  const rightStart = arcA.start + arcA.sweep;
  const arcD = { start: rightStart + right, sweep: sweeps.descendants };
  const leftStart = arcD.start + arcD.sweep;
  // The "circle" shape, so labels in the lower half flip upright as on a circle.
  let a = buildFanChart(ancestors, "circle", { ...opts, arc: arcA });
  let d = buildDescendantFanChart(descendants, "circle", { ...opts, arc: arcD });
  // The deeper half sets the radius and the font rules: both are rebuilt
  // around one centre, and ring for ring their labels are sized and weighted
  // alike, so a descendant never reads larger or bolder than an ancestor at
  // the same remove.
  const hasSiblings = !!siblings && siblings.older.length + siblings.younger.length > 0;
  const r = Math.max(a.cx, d.cx, hasSiblings ? SIBLING_R_OUT : 0);
  const rings = Math.max(a.rings, d.rings);
  a = buildFanChart(ancestors, "circle", { ...opts, arc: arcA, radius: r, fontRings: rings });
  d = buildDescendantFanChart(descendants, "circle", { ...opts, arc: arcD, radius: r, fontRings: rings });
  // The root disk comes from the descendant half (its spouse bands ride there);
  // the ancestor half's positions are prefixed so no key meets its twin.
  return {
    segments: [
      ...d.segments.map((s) => ({ ...s, cap: d.maxGen })),
      ...a.segments.filter((s) => s.gen > 0).map((s) => ({ ...s, key: ANCESTOR_KEY_PREFIX + s.key, cap: a.maxGen })),
      ...(siblings ? siblingSegments(siblings.older, rightStart, right, r, opts, "o") : []),
      ...(siblings ? siblingSegments(siblings.younger, leftStart, left, r, opts, "y") : []),
    ],
    marriages: [...d.marriages, ...a.marriages.map((m) => ({ ...m, key: ANCESTOR_KEY_PREFIX + m.key }))],
    cx: r,
    cy: r,
    r0: d.r0,
    rootKey: d.rootKey,
    maxGen: Math.max(a.maxGen, d.maxGen),
    rings,
    width: 2 * r + PAD * 2,
    height: 2 * r + PAD * 2,
  };
}

/** One notch's sibling wedges, laid clockwise from `start` inside its gaps.
 *  Their labels read outward, as the deep rings' do — at the notches, which
 *  sit near the horizontal, that is nearly level text. */
function siblingSegments(
  row: Sibling[],
  start: number,
  sweep: number,
  r: number,
  opts: FanChartOptions,
  side: "o" | "y",
): FanSegment[] {
  if (row.length === 0) return [];
  const { dispOf, titleOf } = fanResolvers(opts);
  const delta = (sweep - 2 * SIBLING_GAP) / row.length;
  const cx = r;
  const cy = r;
  const rIn = ROOT_R + 6;
  const rOut = SIBLING_R_OUT;
  const rMid = (rIn + rOut) / 2;
  const fontPx = FONT_BY_GEN[2];
  const band = labelBand(rIn, rOut);
  return row.map(({ node, half }, i) => {
    const a0 = start + SIBLING_GAP + i * delta;
    const a1 = a0 + delta;
    const mid = (a0 + a1) / 2;
    const disp = dispOf(node);
    const texts = labelTexts(disp, disp.name.length * fontPx * 0.5 > band.depth);
    const n = texts.length;
    const gap = Math.min(round(fontPx * 1.22), Math.max(1, (band.mid * delta - 2) / n));
    const flip = Math.cos(mid) < 0;
    const deg = (mid * 180) / Math.PI + (flip ? 180 : 0);
    return {
      key: `${SIBLING_KEY_PREFIX}${side}${i}`,
      node,
      gen: 0,
      slot: i,
      title: titleOf(node),
      d: sectorPath(cx, cy, rIn, rOut, a0, a1),
      x: cx + rMid * Math.cos(mid),
      y: cy + rMid * Math.sin(mid),
      fontPx,
      curved: false,
      labelTransform: `translate(${round(cx + band.mid * Math.cos(mid))},${round(cy + band.mid * Math.sin(mid))}) rotate(${round(deg)})`,
      lines: texts.map((l, j) => ({ ...l, dy: round((j - (n - 1) / 2) * gap) })),
      badge: { x: round(cx + (rIn + 12) * Math.cos(mid)), y: round(cy + (rIn + 12) * Math.sin(mid)) },
      ...(half ? { half } : null),
    };
  });
}

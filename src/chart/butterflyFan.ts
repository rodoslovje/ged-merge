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
export const SIBLING_STEP = (14 / 360) * TAU;
/** …until a side holds this much, when its wedges narrow to share it. */
export const SIBLING_SIDE_MAX = (70 / 360) * TAU;
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
 *  older on the left, the younger on the right. Counter-clockwise from the top
 *  of the left notch the whole row then reads oldest to youngest, as the
 *  children below do from left to right. */
export function buildButterflyChart(
  ancestors: TreeNode,
  descendants: TreeNode,
  opts: FanChartOptions = {},
  siblings?: SiblingRow,
): FanChart {
  const right = notchSweep(siblings?.younger.length ?? 0);
  const left = notchSweep(siblings?.older.length ?? 0);
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
  const sibs = siblings ? siblingLabels([...siblings.older, ...siblings.younger], opts) : undefined;
  const r = Math.max(a.cx, d.cx, sibs?.rOut ?? 0);
  const rings = Math.max(a.rings, d.rings);
  a = buildFanChart(ancestors, "circle", { ...opts, arc: arcA, radius: r, fontRings: rings });
  d = buildDescendantFanChart(descendants, "circle", { ...opts, arc: arcD, radius: r, fontRings: rings });
  // The root disk comes from the descendant half (its spouse bands ride there);
  // the ancestor half's positions are prefixed so no key meets its twin.
  return {
    segments: [
      ...d.segments.map((s) => ({ ...s, cap: d.maxGen })),
      ...a.segments.filter((s) => s.gen > 0).map((s) => ({ ...s, key: ANCESTOR_KEY_PREFIX + s.key, cap: a.maxGen })),
      ...(siblings && sibs ? siblingSegments(siblings.older, leftStart, left, r, opts, sibs.rOut, "o") : []),
      ...(siblings && sibs ? siblingSegments(siblings.younger, rightStart, right, r, opts, sibs.rOut, "y") : []),
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

const SIBLING_R_IN = ROOT_R + 8;
const SIBLING_FONT = FONT_BY_GEN[2];
/** Room between a sibling's label and its wedge's inner end… */
const SIBLING_PAD = 12;
/** …and its outer end, where the label sits. */
const SIBLING_PAD_OUT = 6;

/** A label line's rough length in px — wide enough for the bold name face;
 *  the lifespan line is set smaller (see FanChartBody). */
const lineLength = (text: string, kind: "name" | "years" = "name") =>
  text.length * SIBLING_FONT * 0.56 * (kind === "years" ? 0.85 : 1);

/** The sibling wedges' outer radius: as deep as the longest one-line label
 *  needs, at least the first ring and at most the first two — so the wedges
 *  end where their names do instead of trailing off empty. */
function siblingLabels(row: Sibling[], opts: FanChartOptions): { rOut: number } | undefined {
  if (row.length === 0) return undefined;
  const { dispOf } = fanResolvers(opts);
  const longest = Math.max(...row.flatMap(({ node }) => labelTexts({ ...dispOf(node), place: undefined }, false).map((l) => lineLength(l.text, l.kind))));
  const rOut = Math.min(SIBLING_R_OUT, Math.max(ROOT_R + PHOTO_RING_W, SIBLING_R_IN + longest + SIBLING_PAD + SIBLING_PAD_OUT + 6));
  return { rOut };
}

/** One notch's sibling wedges inside its gaps, the first of `row` at the
 *  counter-clockwise end's far side — the top of the left notch, the bottom
 *  of the right one. Their labels read outward, as the deep rings' do — at
 *  the notches, which sit near the horizontal, that is nearly level text —
 *  and every line ends flush at the outer end, where the wedge is widest. */
function siblingSegments(
  row: Sibling[],
  start: number,
  sweep: number,
  r: number,
  opts: FanChartOptions,
  rOut: number,
  side: "o" | "y",
): FanSegment[] {
  if (row.length === 0) return [];
  const { dispOf, titleOf } = fanResolvers(opts);
  const delta = (sweep - 2 * SIBLING_GAP) / row.length;
  const cx = r;
  const cy = r;
  const rIn = SIBLING_R_IN;
  const rMid = (rIn + rOut) / 2;
  const fontPx = SIBLING_FONT;
  const lo = rIn + SIBLING_PAD;
  const hi = rOut - SIBLING_PAD_OUT;
  return row.map(({ node, half }, i) => {
    // Counter-clockwise: the first sibling takes the wedge at the far end.
    const a0 = start + SIBLING_GAP + (row.length - 1 - i) * delta;
    const a1 = a0 + delta;
    const mid = (a0 + a1) / 2;
    // Name and lifespan only: like the descendants, a sibling drops the place.
    const disp = { ...dispOf(node), place: undefined };
    const texts = labelTexts(disp, lineLength(disp.name) > hi - lo);
    const n = texts.length;
    const lens = texts.map((l) => Math.min(hi - lo, lineLength(l.text, l.kind)));
    const len = Math.max(...lens);
    // The label's centre: its outer end at the wedge's outer padding.
    const rLabel = hi - len / 2;
    const gap = Math.min(round(fontPx * 1.22), Math.max(1, (rLabel * delta - 2) / n));
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
      labelTransform: `translate(${round(cx + rLabel * Math.cos(mid))},${round(cy + rLabel * Math.sin(mid))}) rotate(${round(deg)})`,
      // Each line shifted outward to end flush with the longest: the rotated
      // frame's x runs outward, or inward where the label is flipped.
      lines: texts.map((l, j) => ({
        ...l,
        dy: round((j - (n - 1) / 2) * gap),
        dx: round(((len - lens[j]) / 2) * (flip ? -1 : 1)),
      })),
      badge: { x: round(cx + (rIn + 12) * Math.cos(mid)), y: round(cy + (rIn + 12) * Math.sin(mid)) },
      ...(half ? { half } : null),
    };
  });
}

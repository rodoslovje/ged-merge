// The radial bowtie: one full circle, the ancestor fan on its upper arc and the
// descendant fan on its lower arc, sharing the root disk in the middle. Each
// half is the ordinary chart of its direction (fanLayout.ts / descendantFan.ts)
// drawn on an arc of its own; the split between the two follows how much each
// side has to draw, and a notch at either side keeps them visibly apart.

import { PAD, ANCESTOR_KEY_PREFIX } from "./treeLayout";
import { countTreePeople, type TreeNode } from "./personTree";
import { HALF, TAU, buildFanChart, type FanChart, type FanChartOptions } from "./fanLayout";
import { buildDescendantFanChart } from "./descendantFan";

/** The empty notch between the two halves, on each side of the circle. */
export const BUTTERFLY_GAP = (8 / 360) * TAU;
/** The ancestors' share of the drawable circle stays between these, so a side
 *  with almost nobody still gets a readable arc and the other never squeezes
 *  it into a sliver. */
const MIN_SHARE = 0.3;
const MAX_SHARE = 0.7;

/** How the circle is shared: each half's sweep in radians, from the head-counts
 *  of the two directions (the root excluded). */
export function butterflySplit(ancestors: number, descendants: number): { ancestors: number; descendants: number } {
  const avail = TAU - 2 * BUTTERFLY_GAP;
  const a = Math.max(ancestors, 1);
  const d = Math.max(descendants, 1);
  const share = Math.min(MAX_SHARE, Math.max(MIN_SHARE, a / (a + d)));
  return { ancestors: share * avail, descendants: avail - share * avail };
}

/** Build the radial bowtie from the root's ancestor and descendant trees. */
export function buildButterflyChart(ancestors: TreeNode, descendants: TreeNode, opts: FanChartOptions = {}): FanChart {
  const sweeps = butterflySplit(countTreePeople(ancestors), countTreePeople(descendants));
  // Each half centred on its vertical: ancestors up, descendants down. The
  // notches fall where the two arcs meet, at the left and the right.
  const arcA = { start: -HALF - sweeps.ancestors / 2, sweep: sweeps.ancestors };
  const arcD = { start: HALF - sweeps.descendants / 2, sweep: sweeps.descendants };
  // The "circle" shape, so labels in the lower half flip upright as on a circle.
  let a = buildFanChart(ancestors, "circle", { ...opts, arc: arcA });
  let d = buildDescendantFanChart(descendants, "circle", { ...opts, arc: arcD });
  // The deeper half sets the radius and the font rules: both are rebuilt
  // around one centre, and ring for ring their labels are sized and weighted
  // alike, so a descendant never reads larger or bolder than an ancestor at
  // the same remove.
  const r = Math.max(a.cx, d.cx);
  const rings = Math.max(a.rings, d.rings);
  a = buildFanChart(ancestors, "circle", { ...opts, arc: arcA, radius: r, fontRings: rings });
  d = buildDescendantFanChart(descendants, "circle", { ...opts, arc: arcD, radius: r, fontRings: rings });
  // The root disk comes from the descendant half (its spouse bands ride there);
  // the ancestor half's positions are prefixed so no key meets its twin.
  return {
    segments: [
      ...d.segments.map((s) => ({ ...s, cap: d.maxGen })),
      ...a.segments.filter((s) => s.gen > 0).map((s) => ({ ...s, key: ANCESTOR_KEY_PREFIX + s.key, cap: a.maxGen })),
    ],
    marriages: [...d.marriages, ...a.marriages.map((m) => ({ ...m, key: ANCESTOR_KEY_PREFIX + m.key }))],
    cx: r,
    cy: r,
    r0: d.r0,
    rootKey: d.rootKey,
    maxGen: Math.max(a.maxGen, d.maxGen),
    rings,
    branches: d.branches,
    width: 2 * r + PAD * 2,
    height: 2 * r + PAD * 2,
  };
}

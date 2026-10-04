import { describe, expect, it } from "vitest";
import { BUTTERFLY_GAP, buildButterflyChart, butterflySplit } from "./butterflyFan";
import { TAU } from "./fanLayout";
import { ANCESTOR_KEY_PREFIX } from "./treeLayout";
import type { TreeNode } from "./personTree";
import type { Sex } from "../gedcom/types";

let seq = 0;
function person(sex: Sex, children: TreeNode[] = [], partners: TreeNode[] = [], name = `p${seq++}`): TreeNode {
  return { key: name, status: "main-only", name, years: "", living: false, sex, detail: "", children, partners };
}
function pedigree(gen: number, sex: Sex = "M"): TreeNode {
  if (gen === 0) return person(sex);
  return person(sex, [pedigree(gen - 1, "M"), pedigree(gen - 1, "F")]);
}
/** The root with a spouse and `n` children, each with two children of their own. */
function offspring(n: number): TreeNode {
  const kids = Array.from({ length: n }, () => person("M", [], [person("F", [person("M"), person("F")])]));
  return person("M", [], [person("F", kids)]);
}
/** How far round the circle a segment's centroid sits from the angle `from`,
 *  in [0, π] — so an arc check needs no wrap-around bookkeeping. */
function angleFrom(cx: number, cy: number, s: { x: number; y: number }, from: number): number {
  const d = Math.atan2(s.y - cy, s.x - cx) - from;
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
}

describe("butterflySplit", () => {
  it("shares the circle by head-count, within bounds, leaving the two notches", () => {
    const even = butterflySplit(10, 10);
    expect(even.ancestors).toBeCloseTo(even.descendants);
    expect(even.ancestors + even.descendants + 2 * BUTTERFLY_GAP).toBeCloseTo(TAU);
    const lopsided = butterflySplit(100, 1);
    expect(lopsided.ancestors).toBeCloseTo(0.7 * (TAU - 2 * BUTTERFLY_GAP));
    expect(butterflySplit(1, 100).descendants).toBeCloseTo(0.7 * (TAU - 2 * BUTTERFLY_GAP));
    expect(butterflySplit(0, 0).ancestors).toBeCloseTo(even.ancestors);
  });
});

describe("buildButterflyChart", () => {
  it("draws the ancestors on the upper arc and the descendants on the lower, root once", () => {
    const chart = buildButterflyChart(pedigree(2), offspring(2));
    // The root's spouse band shares generation 0; the disk itself is drawn once.
    const roots = chart.segments.filter((s) => s.gen === 0 && !s.band);
    expect(roots).toHaveLength(1);
    expect(roots[0].key).toBe("0:0");
    expect(chart.rootKey).toBe("0:0");
    const anc = chart.segments.filter((s) => s.key.startsWith(ANCESTOR_KEY_PREFIX));
    const desc = chart.segments.filter((s) => !s.key.startsWith(ANCESTOR_KEY_PREFIX) && (s.gen > 0 || s.band));
    expect(anc).toHaveLength(6);
    expect(desc.length).toBeGreaterThan(0);
    const split = butterflySplit(6, 7);
    // Every ancestor sits within its half's arc about the top, every
    // descendant within theirs about the bottom.
    for (const s of anc) expect(angleFrom(chart.cx, chart.cy, s, -Math.PI / 2)).toBeLessThan(split.ancestors / 2);
    for (const s of desc) expect(angleFrom(chart.cx, chart.cy, s, Math.PI / 2)).toBeLessThan(split.descendants / 2);
    // Every position has a key of its own, and each half names its own cap.
    expect(new Set(chart.segments.map((s) => s.key)).size).toBe(chart.segments.length);
    expect(anc.every((s) => s.cap !== undefined)).toBe(true);
  });

  it("gives both halves one centre, sized by the deeper half", () => {
    const deep = buildButterflyChart(pedigree(4), offspring(1));
    const shallow = buildButterflyChart(pedigree(1), offspring(1));
    expect(deep.cx).toBe(deep.cy);
    expect(deep.width).toBe(deep.height);
    expect(deep.cx).toBeGreaterThan(shallow.cx);
    // The shallower descendant half was rebuilt around the shared centre: its
    // first ring sits at the same distance from the centre as before.
    const rDesc = (c: typeof deep) => {
      const s = c.segments.find((x) => x.gen === 1 && !x.key.startsWith(ANCESTOR_KEY_PREFIX))!;
      return Math.hypot(s.x - c.cx, s.y - c.cy);
    };
    expect(rDesc(deep)).toBeCloseTo(rDesc(shallow), 0);
  });
});

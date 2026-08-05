import { describe, expect, it } from "vitest";
import type { TreeNode } from "./personTree";
import { COL_STEP, NODE_H, NODE_W, ROW_STEP, flatten, layout, layoutGrid, minimapFit } from "./treeLayout";

/** Minimal TreeNode for geometry tests — only the layout-relevant fields matter. */
function node(key: string, children: TreeNode[] = [], partners: TreeNode[] = []): TreeNode {
  return { key, status: "main-only", name: key, years: "", living: false, sex: "U", detail: "", children, partners };
}

describe("layout alignment", () => {
  // A root with two children: one generation deep, two breadth rows.
  const root = () => node("root", [node("a"), node("b")]);

  it("grows along x for left→right and along y for top→bottom", () => {
    const lr = layout(root(), "lr");
    const tb = layout(root(), "tb");

    // Root is pinned to the leading edge of the depth axis (x in LR, y in TB).
    expect(lr.root.x).toBe(0);
    expect(tb.root.y).toBe(0);

    // The next generation advances along the depth axis only.
    const [lrA] = lr.root.children;
    const [tbA] = tb.root.children;
    expect(lrA.x).toBeGreaterThan(lr.root.x); // LR: children to the right
    expect(tbA.y).toBeGreaterThan(tb.root.y); // TB: children below
  });

  it("centres the parent on its children across the breadth axis", () => {
    const lr = layout(root(), "lr");
    const tb = layout(root(), "tb");

    const [lrA, lrB] = lr.root.children;
    expect(lr.root.y).toBeCloseTo((lrA.y + lrB.y) / 2); // breadth = y in LR

    const [tbA, tbB] = tb.root.children;
    expect(tb.root.x).toBeCloseTo((tbA.x + tbB.x) / 2); // breadth = x in TB
  });

  it("keeps siblings in the same generation: aligned on the depth axis", () => {
    const lr = layout(root(), "lr");
    const tb = layout(root(), "tb");

    const [lrA, lrB] = lr.root.children;
    // LR: same depth column (x), different breadth rows (y).
    expect(lrA.x).toBe(lrB.x);
    expect(lrA.y).not.toBe(lrB.y);

    const [tbA, tbB] = tb.root.children;
    // TB: same depth row (y), different breadth columns (x).
    expect(tbA.y).toBe(tbB.y);
    expect(tbA.x).not.toBe(tbB.x);
  });

  it("keeps a spouse adjacent to the person, centred over their shared children", () => {
    // Descendants couple: person A married to B with three children.
    const kids = [node("c"), node("d"), node("e")];
    const couple = () => node("A", [], [node("B", kids)]);

    const lr = layout(couple(), "lr");
    const [lrB] = lr.root.partners;
    // LR breadth is vertical: spouse one row below the person (not pushed away).
    expect(Math.abs(lrB.y - lr.root.y)).toBeCloseTo(ROW_STEP);

    const tb = layout(couple(), "tb");
    const [tbB] = tb.root.partners;
    // TB breadth is horizontal: spouse in the adjacent column.
    expect(Math.abs(tbB.x - tb.root.x)).toBeCloseTo(COL_STEP);
    // The couple straddles the centre of the children.
    const kidXs = tbB.children.map((k) => k.x);
    const kidsCentre = (Math.min(...kidXs) + Math.max(...kidXs)) / 2;
    expect((tb.root.x + tbB.x) / 2).toBeCloseTo(kidsCentre);
  });

  it("spreads later spouses over their own children when there are several unions", () => {
    // Person A with two marriages: P1 (kids a, b) and P2 (kids e, f).
    const a = () =>
      node("A", [], [
        node("P1", [node("a"), node("b")]),
        node("P2", [node("e"), node("f")]),
      ]);

    const tb = layout(a(), "tb");
    const [P1, P2] = tb.root.partners;
    const centre = (ps: typeof P1[]) => {
      const xs = ps.map((p) => p.x);
      return (Math.min(...xs) + Math.max(...xs)) / 2;
    };

    // The person sits beside the first spouse; the couple straddles its children.
    const firstGap = Math.abs(P1.x - tb.root.x);
    expect(firstGap).toBeCloseTo(COL_STEP);
    expect((tb.root.x + P1.x) / 2).toBeCloseTo(centre(P1.children));

    // The second spouse is pushed out over its own children — clearly separated.
    expect(P2.x).toBeCloseTo(centre(P2.children));
    expect(Math.abs(P2.x - P1.x)).toBeGreaterThan(firstGap + 1);
  });

  it("emits one connector per parent→child edge in both orientations", () => {
    expect(flatten(layout(root(), "lr").root, "lr").edges).toHaveLength(2);
    expect(flatten(layout(root(), "tb").root, "tb").edges).toHaveLength(2);
  });

  it("labels the partner connector with the marriage when requested", () => {
    const spouse = node("spouse");
    spouse.marriage = { year: "1900", place: "Ljubljana" };
    const couple = () => node("person", [], [spouse]);
    const label = (n: TreeNode) => (n.marriage ? `⚭ ${n.marriage.year}` : undefined);

    const partnerEdge = flatten(layout(couple(), "lr").root, "lr", "curve", NODE_H, label).edges.find(
      (e) => e.partner,
    )!;
    expect(partnerEdge.label?.text).toBe("⚭ 1900");
    // The label rides the connector at the boxes' horizontal centre in LR.
    expect(partnerEdge.label?.x).toBe(NODE_W / 2);

    // No callback → no label.
    const plain = flatten(layout(couple(), "lr").root, "lr").edges.find((e) => e.partner)!;
    expect(plain.label).toBeUndefined();
  });

  it("brackets the two parents with the marriage label in ancestor mode", () => {
    // Ancestor: child whose marriage = its parents' union.
    const child = node("child", [node("father"), node("mother")]);
    child.marriage = { year: "1900", place: "Ljubljana" };
    const label = (n: TreeNode) => (n.marriage ? `⚭ ${n.marriage.year}` : undefined);

    const { edges } = flatten(layout(child, "lr").root, "lr", "curve", NODE_H, label, true);
    const bracket = edges.find((e) => e.id.endsWith("=m"))!;
    expect(bracket.partner).toBe(true);
    expect(bracket.label?.text).toBe("⚭ 1900");
    expect(bracket.d).toMatch(/^M/); // a real line between the two parents

    // Without the ancestor flag there's no bracket (descendant treatment only).
    const desc = flatten(layout(child, "lr").root, "lr", "curve", NODE_H, label, false);
    expect(desc.edges.some((e) => e.id.endsWith("=m"))).toBe(false);
  });
});

describe("grid layout", () => {
  it("starts the root top-left and steps one column per generation", () => {
    // Ancestors: child → father (FF, FM), mother.
    const root = node("child", [node("father", [node("FF"), node("FM")]), node("mother")]);
    const { root: placed } = layoutGrid(root, "lr");
    // Root pinned to the top-left corner.
    expect(placed.x).toBe(0);
    expect(placed.y).toBe(0);
    const [father, mother] = placed.children;
    const [FF, FM] = father.children;
    // Each generation is a fixed column one COL_STEP further right.
    expect(father.x).toBe(COL_STEP);
    expect(mother.x).toBe(COL_STEP);
    expect(FF.x).toBe(2 * COL_STEP);
    expect(FM.x).toBe(2 * COL_STEP);
  });

  it("keeps an only-child lineage on one lane, spending a lane only on extra siblings", () => {
    // child → father (FF, FM), mother. The father line stays inline with the
    // child; FM is the first extra sibling, then the mother.
    const root = node("child", [node("father", [node("FF"), node("FM")]), node("mother")]);
    const { root: placed } = layoutGrid(root, "lr");
    const [father, mother] = placed.children;
    const [FF, FM] = father.children;
    // The direct father line shares the top lane; siblings step down one each.
    expect([placed, father, FF].map((n) => n.y)).toEqual([0, 0, 0]);
    expect(FM.y).toBe(ROW_STEP);
    expect(mother.y).toBe(2 * ROW_STEP);
  });

  it("hoists the union's first child onto the person's lane; the second shares the spouse's", () => {
    // Descendants: A, spouse B, children c and d.
    const root = node("A", [], [node("B", [node("c"), node("d")])]);
    const { root: placed } = layoutGrid(root, "lr");
    const [B] = placed.partners;
    const [c, d] = B.children;
    // c rises to A's own lane; spouse B sits pinned below A; d shares B's lane.
    expect([placed.y, B.y, c.y, d.y]).toEqual([0, ROW_STEP, 0, ROW_STEP]);
    expect(B.x).toBe(placed.x);
    expect(c.x).toBe(placed.x + COL_STEP);
    expect(d.x).toBe(c.x);
  });

  it("connects a hoisted first child from the person with a straight horizontal line", () => {
    const root = node("A", [], [node("B", [node("c"), node("d")])]);
    const { edges } = flatten(layoutGrid(root, "lr").root, "lr", "elbow");
    // The inline child hangs off A (not the spouse) and its path never leaves mid-height.
    const toC = edges.find((e) => e.id === "A->c")!;
    expect(toC.d).toBe(`M${NODE_W},${NODE_H / 2} H${NODE_W + 40} V${NODE_H / 2} H${COL_STEP}`);
    // The second child still hangs off the spouse — horizontal too, on the shared lane.
    expect(edges.some((e) => e.id === "B->d")).toBe(true);
  });

  it("drops the second child below the first child's whole subtree", () => {
    // c's own union (spouse S, kids g and h) occupies lanes 0–1, so d lands on lane 2.
    const c = node("c", [], [node("S", [node("g"), node("h")])]);
    const root = node("A", [], [node("B", [c, node("d")])]);
    const { root: placed } = layoutGrid(root, "lr");
    const [B] = placed.partners;
    const [placedC, d] = B.children;
    const [S] = placedC.partners;
    const [g, h] = S.children;
    expect([placedC.y, S.y, g.y, h.y]).toEqual([0, ROW_STEP, 0, ROW_STEP]);
    expect(d.y).toBe(2 * ROW_STEP);
  });

  it("leaves later unions on their own lanes, first child sharing the spouse's", () => {
    const root = node("A", [], [
      node("P1", [node("a"), node("b")]),
      node("P2", [node("e"), node("f")]),
    ]);
    const { root: placed } = layoutGrid(root, "lr");
    const [P1, P2] = placed.partners;
    const [a, b] = P1.children;
    const [e, f] = P2.children;
    // First union compacted; the second keeps the classic spouse-lane sharing.
    expect([a.y, P1.y, b.y]).toEqual([0, ROW_STEP, ROW_STEP]);
    expect([P2.y, e.y, f.y]).toEqual([2 * ROW_STEP, 2 * ROW_STEP, 3 * ROW_STEP]);
  });

  it("transposes to top→bottom: depth runs down, lanes run across", () => {
    const root = node("child", [node("father"), node("mother")]);
    const tb = layoutGrid(root, "tb").root;
    const [father, mother] = tb.children;
    // Parents are one generation deeper → further down (y); each in its own lane (x).
    expect(father.y).toBeGreaterThan(tb.y);
    expect(father.y).toBe(mother.y);
    expect(father.x).not.toBe(mother.x);
  });

  it("forks both parent connectors from one point on the box's right edge", () => {
    const root = node("child", [node("father"), node("mother")]);
    const { edges } = flatten(layoutGrid(root, "lr").root, "lr", "elbow");
    expect(edges).toHaveLength(2);
    // Right-angle paths, never a cubic (C) curve.
    for (const e of edges) expect(e.d).not.toContain("C");
    // Both edges start at the same point — the parent box's right edge, mid-height.
    const start = (d: string) => d.split(" ")[0];
    const [toFather, toMother] = edges;
    expect(start(toFather.d)).toBe(`M${NODE_W},${NODE_H / 2}`);
    expect(start(toMother.d)).toBe(start(toFather.d));
  });
});

describe("minimap fit", () => {
  const viewport = { left: 0, top: 0, width: 1400, height: 800 };

  it("scales an ordinary chart uniformly inside the box caps", () => {
    // 3:1 chart — the width cap (32%) binds first, the height follows in step.
    const fit = minimapFit(3000, 1000, viewport);
    expect(fit.scaleX).toBeCloseTo(fit.scaleY, 10);
    expect(fit.w).toBeCloseTo(1400 * 0.32, 6);
    expect(fit.h).toBeCloseTo(fit.w / 3, 6);
  });

  it("stretches only the short axis when a uniform fit would leave a hairline", () => {
    // 9 generations top-down: ~256 leaf boxes across, 9 rows down (~68:1).
    const cw = 256 * COL_STEP;
    const ch = 9 * (NODE_H + 70);
    const fit = minimapFit(cw, ch, viewport);
    expect(fit.w).toBeCloseTo(1400 * 0.32, 6); // long axis untouched, still at its cap
    expect(fit.h).toBeCloseTo(80, 6); // short axis lifted to the thickness floor
    expect(minimapFit(cw, ch, viewport).scaleX).toBeLessThan(fit.scaleY);
  });

  it("applies the same floor to a tall, narrow chart", () => {
    const fit = minimapFit(300, 40000, viewport);
    expect(fit.h).toBeCloseTo(800 * 0.24, 6);
    expect(fit.w).toBeCloseTo(80, 6);
  });

  it("leaves an axis alone once the uniform fit already clears the floor", () => {
    // 3:1 again, whose uniform height (149px) is comfortably over the floor.
    const fit = minimapFit(3000, 1000, viewport);
    expect(fit.h).toBeGreaterThan(80);
    expect(fit.scaleX).toBeCloseTo(fit.scaleY, 10); // so no stretch is applied
  });
});

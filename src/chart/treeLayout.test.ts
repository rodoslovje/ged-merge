import { describe, expect, it } from "vitest";
import type { TreeNode } from "./personTree";
import { COL_STEP, NODE_H, NODE_W, ROW_STEP, flatten, layout, layoutGrid } from "./treeLayout";

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

  it("seats a spouse on its own lane and shares it with the union's first child", () => {
    // Descendants: A, spouse B, children c and d.
    const root = node("A", [], [node("B", [node("c"), node("d")])]);
    const { root: placed } = layoutGrid(root, "lr");
    const [B] = placed.partners;
    const [c, d] = B.children;
    // A on lane 0; spouse B on its own lane (same column); c shares B's lane, d steps down.
    expect([placed.y, B.y, c.y, d.y]).toEqual([0, ROW_STEP, ROW_STEP, 2 * ROW_STEP]);
    expect(B.x).toBe(placed.x);
    expect(c.x).toBe(placed.x + COL_STEP);
    expect(d.x).toBe(c.x);
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

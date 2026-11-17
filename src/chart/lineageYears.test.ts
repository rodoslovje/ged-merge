import { describe, expect, it } from "vitest";
import { GENERATION_YEARS, layoutLineage } from "./lineageYears";
import type { TreeNode } from "./personTree";

/** A bare tree node: `children` are parents above the root, offspring below. */
function node(key: string, sex: "M" | "F", children: TreeNode[] = []): TreeNode {
  return {
    key, name: key, years: "", living: false, sex, status: "main", detail: "",
    children, partners: [],
  } as unknown as TreeNode;
}

const YEARS: Record<string, number | undefined> = {
  root: 1900, dad: 1870, mum: 1875, gfD: 1840, gmD: 1845, gfM: undefined,
  kid1: 1930, kid2: 1935, grandkid: 1960,
};
const yearOf = (n: TreeNode) => YEARS[n.key.replace(/^d:/, "")];

describe("layoutLineage", () => {
  const ancestors = node("root", "M", [
    node("mum", "F", [node("gfM", "M")]),
    node("dad", "M", [node("gfD", "M"), node("gmD", "F")]),
  ]);

  it("keeps pedigree order and stands a child between its parents", () => {
    const l = layoutLineage(ancestors, undefined, yearOf);
    const slot = (k: string) => l.points.find((p) => p.key === k)!.slot;
    // Father's side left, mother's right, whatever order the tree lists them.
    expect(slot("gfD")).toBe(0);
    expect(slot("gmD")).toBe(1);
    expect(slot("gfM")).toBe(2);
    expect(slot("dad")).toBe(0.5);
    expect(slot("mum")).toBe(2);
    expect(slot("root")).toBe(1.25);
    expect(l.slots).toBe(3);
    expect(l.links).toContainEqual({ from: "dad", to: "root" });
  });

  it("estimates a missing year a generation from a dated relative", () => {
    const l = layoutLineage(ancestors, undefined, yearOf);
    const gfM = l.points.find((p) => p.key === "gfM")!;
    expect(gfM.year).toBe(1875 - GENERATION_YEARS);
    expect(gfM.estimated).toBe(true);
    expect(l.minYear).toBe(1840);
  });

  it("hangs the descendants under the same root dot", () => {
    const descendants = node("root", "M", [node("kid1", "F", [node("grandkid", "M")]), node("kid2", "M")]);
    const l = layoutLineage(ancestors, descendants, yearOf);
    expect(l.points.filter((p) => p.gen === 0)).toHaveLength(1);
    const root = l.points.find((p) => p.key === "root")!;
    const kids = l.points.filter((p) => p.gen === -1);
    expect(kids.map((k) => k.key)).toEqual(["d:kid1", "d:kid2"]);
    // The root stands midway over its children, at its ancestor-side slot.
    expect((kids[0].slot + kids[1].slot) / 2).toBeCloseTo(root.slot);
    expect(l.links).toContainEqual({ from: "root", to: "d:kid1" });
    expect(l.maxYear).toBe(1960);
    expect(Math.min(...l.points.map((p) => p.slot))).toBeGreaterThanOrEqual(0);
  });
});

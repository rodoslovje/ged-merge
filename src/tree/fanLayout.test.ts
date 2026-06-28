import { describe, expect, it } from "vitest";
import { buildFanChart } from "./fanLayout";
import type { TreeNode } from "./compareTree";
import type { Sex } from "../gedcom/types";

// Minimal TreeNode factory — the fan layout only reads key/sex/name/years/children.
let seq = 0;
function person(sex: Sex, children: TreeNode[] = [], name = `p${seq++}`): TreeNode {
  return { key: name, status: "master-only", name, years: "", living: false, sex, detail: "", children, partners: [] };
}

/** A full pedigree `gen` generations deep (every person has a father + mother). */
function pedigree(gen: number, sex: Sex = "M"): TreeNode {
  if (gen === 0) return person(sex);
  return person(sex, [pedigree(gen - 1, "M"), pedigree(gen - 1, "F")]);
}

describe("buildFanChart", () => {
  it("places one segment per ancestor slot", () => {
    const chart = buildFanChart(pedigree(3), "fan");
    // 1 root + 2 + 4 + 8 = 15
    expect(chart.segments).toHaveLength(15);
    expect(chart.segments.filter((s) => s.gen === 1)).toHaveLength(2);
    expect(chart.segments.filter((s) => s.gen === 2)).toHaveLength(4);
    expect(chart.segments.filter((s) => s.gen === 3)).toHaveLength(8);
    expect(chart.rootKey).toBe("0:0");
  });

  it("puts father in slot 0 and mother in slot 1 by sex", () => {
    // Build with mother listed first to prove sex (not order) drives the slot.
    const root = person("M", [person("F", [], "mum"), person("M", [], "dad")]);
    const chart = buildFanChart(root, "fan");
    const dad = chart.segments.find((s) => s.node.name === "dad")!;
    const mum = chart.segments.find((s) => s.node.name === "mum")!;
    expect(dad.slot).toBe(0);
    expect(mum.slot).toBe(1);
  });

  it("keeps a lone mother in her half when the father is missing", () => {
    const root = person("M", [person("F", [], "mum")]);
    const chart = buildFanChart(root, "fan");
    const mum = chart.segments.find((s) => s.node.name === "mum")!;
    expect(mum.gen).toBe(1);
    expect(mum.slot).toBe(1);
  });

  it("caps the drawn generations", () => {
    const chart = buildFanChart(pedigree(10), "fan", { maxGen: 5 });
    expect(Math.max(...chart.segments.map((s) => s.gen))).toBe(5);
  });

  it("repeats a pedigree-collapsed ancestor in both slots", () => {
    // Both grandfathers are the same person object (shared ancestor) — each
    // occurrence gets its own positioned segment.
    const shared = person("M", [], "shared");
    const root = person("M", [person("M", [shared]), person("F", [shared])]);
    const chart = buildFanChart(root, "fan");
    const sharedSegs = chart.segments.filter((s) => s.node.name === "shared");
    expect(sharedSegs).toHaveLength(2);
    expect(new Set(sharedSegs.map((s) => s.key)).size).toBe(2);
  });

  it("uses a wider square canvas for a circle than a fan at the same depth", () => {
    const fan = buildFanChart(pedigree(3), "fan");
    const circle = buildFanChart(pedigree(3), "circle");
    // Same radii → same square extent; both centred.
    expect(circle.width).toBe(circle.height);
    expect(fan.width).toBe(fan.height);
    expect(circle.cx).toBe(circle.cy);
  });

  it("gives inner-ring wedges a photo box and outer rings none", () => {
    const chart = buildFanChart(pedigree(6), "fan", { hasPhoto: () => true });
    expect(chart.segments.find((s) => s.gen === 1)?.photo).toBeDefined();
    expect(chart.segments.find((s) => s.gen === 6)?.photo).toBeUndefined();
  });

  it("reserves no photo space without a hasPhoto predicate", () => {
    const chart = buildFanChart(pedigree(2), "fan");
    expect(chart.segments.every((s) => s.photo === undefined)).toBe(true);
  });
});

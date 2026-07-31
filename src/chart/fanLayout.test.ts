import { describe, expect, it } from "vitest";
import { buildFanChart } from "./fanLayout";
import { ALL_DISPLAY } from "./nodeDisplay";
import type { TreeNode } from "./personTree";
import type { Sex } from "../gedcom/types";

// Minimal TreeNode factory — the fan layout only reads key/sex/name/years/children.
let seq = 0;
function person(sex: Sex, children: TreeNode[] = [], name = `p${seq++}`): TreeNode {
  return { key: name, status: "main-only", name, years: "", living: false, sex, detail: "", children, partners: [] };
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
    // Each carries the outer anchor the repeat marker hangs on — outside the
    // status badge's inner one, and inside its own ring.
    for (const s of sharedSegs) {
      const rBadge = Math.hypot(s.badge.x - chart.cx, s.badge.y - chart.cy);
      const rOuter = Math.hypot(s.outerBadge!.x - chart.cx, s.outerBadge!.y - chart.cy);
      expect(rOuter).toBeGreaterThan(rBadge);
    }
    // The root disk has no ring to hang it on.
    expect(chart.segments.find((s) => s.gen === 0)!.outerBadge).toBeUndefined();
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

  it("emits a marriage collar (year + place) for a couple under their child", () => {
    const root = person("M", [person("M", [], "dad"), person("F", [], "mum")]);
    root.marriage = { year: "1900", place: "Ljubljana" };
    const chart = buildFanChart(root, "fan");
    expect(chart.marriages).toHaveLength(1);
    expect(chart.marriages[0].lines.map((l) => l.text)).toEqual(["⚭ 1900 Ljubljana"]);
    expect(chart.marriages[0].lines[0].arc).toMatch(/^M/);
    expect(chart.marriages[0].d).toMatch(/^M/);
  });

  it("shows only the year when just the date field is on", () => {
    const root = person("M", [person("M", [], "dad"), person("F", [], "mum")]);
    root.marriage = { year: "1900", place: "Ljubljana" };
    const chart = buildFanChart(root, "fan", {
      display: { ...ALL_DISPLAY, showMarriageDate: true, showMarriagePlace: false },
    });
    expect(chart.marriages[0].lines.map((l) => l.text)).toEqual(["⚭ 1900"]);
  });

  it("stacks the year over the place on a deep ring (level 6+)", () => {
    // A 6-generation pedigree: the couple at gen 6 (the leaves' parents) get a
    // two-line collar.
    const root = pedigree(6);
    // Attach a marriage to one gen-5 person (its parents are the gen-6 couple).
    const gen5 = (function find(n: TreeNode, g: number): TreeNode {
      return g === 0 ? n : find(n.children[0], g - 1);
    })(root, 5);
    gen5.marriage = { year: "1700", place: "Kranj" };
    const chart = buildFanChart(root, "fan");
    const collar = chart.marriages.find((m) => m.lines.length === 2);
    expect(collar?.lines.map((l) => l.text)).toEqual(["⚭ 1700", "Kranj"]);
  });

  it("draws the root's-parents collar as a full ring in a circle chart", () => {
    // In a circle the gen-0 collar spans the whole 360° (a0 ≡ a1); it must still
    // render a band + baseline rather than degenerating to a zero-length arc.
    const root = person("M", [person("M", [], "dad"), person("F", [], "mum")]);
    root.marriage = { year: "1962", place: "Ljubljana" };
    const chart = buildFanChart(root, "circle");
    const collar = chart.marriages[0];
    expect(collar.lines.map((l) => l.text)).toEqual(["⚭ 1962 Ljubljana"]);
    // Two full-circle arcs in the baseline (so the textPath has real length).
    expect(collar.lines[0].arc.match(/A/g)?.length).toBe(2);
    expect(collar.d).toContain("M"); // full donut band, not an empty sector
  });

  it("omits collars when no marriage field is on", () => {
    const root = person("M", [person("M", [], "dad"), person("F", [], "mum")]);
    root.marriage = { year: "1900", place: "Ljubljana" };
    const chart = buildFanChart(root, "fan", {
      display: { ...ALL_DISPLAY, showMarriageDate: false, showMarriagePlace: false },
    });
    expect(chart.marriages).toHaveLength(0);
  });

  it("draws no collar for a childless (leaf) ancestor even if a marriage is set", () => {
    const root = person("M", [], "solo");
    root.marriage = { year: "1900" };
    const chart = buildFanChart(root, "fan");
    expect(chart.marriages).toHaveLength(0);
  });
});

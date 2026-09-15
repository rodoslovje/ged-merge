import { describe, expect, it } from "vitest";
import { buildDescendantFanChart, nameForms } from "./descendantFan";
import { ALL_DISPLAY } from "./nodeDisplay";
import type { TreeNode } from "./personTree";
import type { Sex } from "../gedcom/types";

// Minimal descendant TreeNode factory: a person with their spouses (each
// carrying that union's children) and any children of a union with no
// recorded spouse.
let seq = 0;
function person(
  sex: Sex,
  name = `p${seq++}`,
  opts: { partners?: TreeNode[]; children?: TreeNode[] } = {},
): TreeNode {
  return {
    key: name,
    status: "main-only",
    name,
    years: "",
    living: false,
    sex,
    detail: "",
    children: opts.children ?? [],
    partners: opts.partners ?? [],
  };
}

/** A spouse node carrying the union's children (and optionally its marriage). */
function spouse(sex: Sex, name: string, children: TreeNode[], marriage?: { year?: string; place?: string }): TreeNode {
  const s = person(sex, name, { children });
  if (marriage) s.marriage = marriage;
  return s;
}

/** A person with `n` childless children through one spouse. */
function family(name: string, n: number): TreeNode {
  const kids = Array.from({ length: n }, (_, i) => person("M", `${name}-${i}`));
  return person("M", name, { partners: [spouse("F", `${name}-wife`, kids)] });
}

/** Angular width of a segment's wedge, read off the centroid of its neighbours
 *  is awkward — instead compare the arc lengths of the sector path's outer
 *  edge via the centroid radius and the angle between the wedge's own outer
 *  corners, both encoded in the path. */
function wedgeAngle(d: string, cx: number, cy: number): number {
  // `M x0,y0 A r,r 0 large sweep x1,y1 L …` — the first two points are the
  // outer corners.
  const m = /^M([-\d.]+),([-\d.]+) A[-\d.]+,[-\d.]+ 0 (\d) 1 ([-\d.]+),([-\d.]+)/.exec(d)!;
  const a0 = Math.atan2(+m[2] - cy, +m[1] - cx);
  const a1 = Math.atan2(+m[5] - cy, +m[4] - cx);
  let a = a1 - a0;
  if (a < 0) a += Math.PI * 2;
  if (m[3] === "1" && a < Math.PI) a += Math.PI * 2;
  return a;
}

describe("buildDescendantFanChart", () => {
  it("draws the root, one wedge per descendant and one band per marriage", () => {
    const root = person("M", "root", {
      partners: [spouse("F", "wife", [family("a", 2), person("F", "b"), family("c", 1)], { year: "1900", place: "Kranj" })],
    });
    const chart = buildDescendantFanChart(root, "fan");
    const people = chart.segments.filter((s) => !s.band);
    const bands = chart.segments.filter((s) => s.band);
    // root + 3 children + 3 grandchildren
    expect(people).toHaveLength(7);
    // the root's wife, a's wife, c's wife
    expect(bands.map((s) => s.node.name).sort()).toEqual(["a-wife", "c-wife", "wife"]);
    expect(chart.rootKey).toBe("0:0");
    expect(new Set(chart.segments.map((s) => s.key)).size).toBe(chart.segments.length);
  });

  it("gives a wedge as many end lines as the branch it heads, in the tree's order", () => {
    const root = person("M", "root", {
      partners: [spouse("F", "wife", [family("big", 6), person("F", "solo"), family("small", 2)])],
    });
    const chart = buildDescendantFanChart(root, "circle");
    const angle = (name: string) => {
      const s = chart.segments.find((x) => x.node.name === name)!;
      return wedgeAngle(s.d, chart.cx, chart.cy);
    };
    expect(angle("big")).toBeGreaterThan(angle("small"));
    expect(angle("small")).toBeGreaterThan(angle("solo"));
    // Six leaves against two: three times the arc (the floor only widens solo).
    expect(angle("big") / angle("small")).toBeCloseTo(3, 1);
    // Clockwise in the tree's order, from the sweep's start.
    const slotOf = (name: string) => chart.segments.find((x) => x.node.name === name)!.slot;
    expect(slotOf("big")).toBeLessThan(slotOf("solo"));
    expect(slotOf("solo")).toBeLessThan(slotOf("small"));
  });

  it("keeps a childless sibling's wedge wide enough for a name beside a huge branch", () => {
    // One end line against sixty: a plain share would be 6° of a fan — too
    // narrow for its name on the innermost ring. The floor hands it a label.
    const root = person("M", "root", {
      partners: [spouse("F", "wife", [family("big", 60), person("F", "Marija Kranjec")])],
    });
    const chart = buildDescendantFanChart(root, "fan");
    const solo = chart.segments.find((s) => s.node.name === "Marija Kranjec")!;
    expect(solo.lines.length).toBeGreaterThan(0);
    expect(solo.lines[0].text).toContain("Marija");
  });

  it("names the spouse on the band and never draws the marriage there", () => {
    const root = person("M", "root", {
      partners: [spouse("F", "Ana Novak", [person("M", "kid")], { year: "1900", place: "Ljubljana" })],
    });
    const plain = buildDescendantFanChart(root, "fan", {
      display: { ...ALL_DISPLAY, showMarriageDate: false, showMarriagePlace: false },
    });
    const band = plain.segments.find((s) => s.band)!;
    expect(band.node.name).toBe("Ana Novak");
    expect(band.lines.map((l) => l.text)).toEqual(["Ana Novak"]);
    expect(band.lines[0].kind).toBe("name");
    expect(band.curved).toBe(true);

    // The marriage toggles apply to the other charts; a band carries the name
    // alone, and the lane is no deeper for them.
    const withMarriage = buildDescendantFanChart(root, "fan");
    const band2 = withMarriage.segments.find((s) => s.band)!;
    expect(band2.lines.map((l) => l.text)).toEqual(["Ana Novak"]);
    expect(withMarriage.width).toBe(plain.width);
  });

  it("shortens a name by dropping parts, never by an initial or an ellipsis", () => {
    const wife = person("F", "Ana Novak (Kovač)");
    expect(nameForms(wife, wife.name)).toEqual(["Ana Novak (Kovač)", "Ana Novak", "Ana"]);
    const husband = person("M", "Janez Peter Novak");
    expect(nameForms(husband, husband.name)).toEqual(["Janez Peter Novak", "Janez Peter"]);
    // A redacted living person has only their placeholder.
    expect(nameForms(husband, "Living")).toEqual(["Living"]);
    // The record's own name parts win over the displayed order.
    const structured: TreeNode = {
      ...husband,
      name: "Novak Janez",
      main: { id: "@I1@", names: [{ given: "Janez", surname: "Novak", full: "Janez /Novak/" }], sex: "M", events: [], childOf: [], spouseOf: [], raw: { level: 0, tag: "INDI", children: [] } } as unknown as TreeNode["main"],
    };
    expect(nameForms(structured, structured.name)).toEqual(["Novak Janez", "Janez"]);
  });

  it("gives a childless marriage a band that names the spouse, narrower than a line with children", () => {
    const root = person("M", "root", {
      partners: [
        spouse("F", "first", [family("x", 3), family("y", 3)]),
        spouse("F", "second", []),
      ],
    });
    const chart = buildDescendantFanChart(root, "fan");
    const second = chart.segments.find((s) => s.node.name === "second")!;
    expect(second.band).toBe(true);
    const first = chart.segments.find((s) => s.node.name === "first")!;
    expect(wedgeAngle(first.d, chart.cx, chart.cy)).toBeGreaterThan(wedgeAngle(second.d, chart.cx, chart.cy));
    expect(wedgeAngle(second.d, chart.cx, chart.cy)).toBeGreaterThan(0);
    // The band fits the given name: it is written, not reduced to the glyph.
    expect(second.lines.map((l) => l.text)).toEqual(["second"]);
    // A longer given name earns a wider band; an absurd one is capped.
    const wide = person("M", "root", {
      partners: [spouse("F", "first", [family("x", 3)]), spouse("F", "Maximiliana Theresia", [])],
    });
    const wideChart = buildDescendantFanChart(wide, "fan");
    const wideBand = wideChart.segments.find((s) => s.node.name === "Maximiliana Theresia")!;
    expect(wedgeAngle(wideBand.d, wideChart.cx, wideChart.cy)).toBeGreaterThan(wedgeAngle(second.d, chart.cx, chart.cy));
    expect(wedgeAngle(wideBand.d, wideChart.cx, wideChart.cy)).toBeLessThan(wedgeAngle(first.d, chart.cx, chart.cy));
  });

  it("splits a person's wedge between two marriages by their children", () => {
    const root = person("M", "root", {
      partners: [spouse("F", "wife", [
        person("M", "janez", { partners: [spouse("F", "neza", [person("M", "j1")]), spouse("F", "marija", [person("M", "m1"), person("F", "m2"), person("F", "m3")])] }),
      ])],
    });
    const chart = buildDescendantFanChart(root, "circle");
    const a = (name: string) => wedgeAngle(chart.segments.find((s) => s.node.name === name)!.d, chart.cx, chart.cy);
    expect(a("marija") / a("neza")).toBeCloseTo(3, 1);
    expect(a("janez")).toBeCloseTo(a("neza") + a("marija"), 5);
  });

  it("draws the root's only marriage in a circle as a full ring", () => {
    const root = person("M", "root", { partners: [spouse("F", "wife", [person("M", "kid")])] });
    const chart = buildDescendantFanChart(root, "circle");
    const band = chart.segments.find((s) => s.band)!;
    // A donut is two closed rings; a sector is one path with one M.
    expect(band.d.match(/M/g)?.length).toBe(2);
    expect(band.lines[0].arc!.match(/A/g)?.length).toBe(2);
  });

  it("colours every line by the child of the root it descends from", () => {
    const root = person("M", "root", {
      partners: [spouse("F", "wife", [family("a", 2), family("b", 1)])],
    });
    const chart = buildDescendantFanChart(root, "fan");
    const branch = (name: string) => chart.segments.find((s) => s.node.name === name)!.branch;
    expect(branch("root")).toBeUndefined();
    expect(branch("wife")).toBeUndefined();
    expect(branch("a")).toBe(0);
    expect(branch("a-wife")).toBe(0);
    expect(branch("a-1")).toBe(0);
    expect(branch("b")).toBe(1);
    expect(branch("b-0")).toBe(1);
    expect(chart.branches).toBe(2);
  });

  it("pales the fill outward, ring by ring", () => {
    const root = person("M", "root", { partners: [spouse("F", "w", [family("a", 1)])] });
    const chart = buildDescendantFanChart(root, "fan");
    const tint = (name: string) => chart.segments.find((s) => s.node.name === name)!.tint!;
    expect(tint("a")).toBeGreaterThan(tint("a-0"));
  });

  it("caps the rings and counts the rest onto the last ring", () => {
    // A single line twelve generations long.
    let n = person("M", "leaf");
    for (let g = 11; g >= 1; g--) n = person("M", `g${g}`, { children: [n] });
    const root = person("M", "root", { children: [n] });
    const chart = buildDescendantFanChart(root, "fan", { maxGen: 4 });
    expect(chart.maxGen).toBe(4);
    const last = chart.segments.filter((s) => s.gen === 4);
    expect(last).toHaveLength(1);
    expect(last[0].hidden).toBeGreaterThan(0);
    expect(chart.segments.every((s) => s.gen <= 4)).toBe(true);
    // The default cap (eight rings) cuts it too; a line that fits is not marked.
    expect(buildDescendantFanChart(root, "fan").maxGen).toBe(8);
    expect(buildDescendantFanChart(root, "fan", { maxGen: 12 }).segments.every((s) => s.hidden === undefined)).toBe(true);
  });

  it("stops adding rings once a generation has no room for a name per person", () => {
    // Sixty-four grandchildren cannot each have a name line on ring 2 of a
    // 230° fan; the chart stops at the children and marks the cut.
    const kids = Array.from({ length: 4 }, (_, i) => family(`c${i}`, 16));
    const root = person("M", "root", { partners: [spouse("F", "wife", kids)] });
    const chart = buildDescendantFanChart(root, "fan");
    expect(chart.maxGen).toBe(1);
    expect(chart.segments.filter((s) => !s.band && s.gen === 1).every((s) => (s.hidden ?? 0) > 0)).toBe(true);
    // The wider circle has room for them.
    expect(buildDescendantFanChart(root, "circle").maxGen).toBe(2);
  });

  it("gives an inner-ring wedge a photo box when it is wide enough, and outer rings none", () => {
    const root = person("M", "root", { partners: [spouse("F", "w", [family("a", 2)])] });
    const chart = buildDescendantFanChart(root, "fan", { hasPhoto: () => true });
    expect(chart.segments.find((s) => s.node.name === "root")?.photo).toBeDefined();
    expect(chart.segments.find((s) => s.node.name === "a")?.photo).toBeDefined();
    expect(chart.segments.find((s) => s.band)?.photo).toBeUndefined();
  });

  it("uses a square canvas centred on the root for both shapes", () => {
    const root = person("M", "root", { partners: [spouse("F", "w", [family("a", 2)])] });
    const fan = buildDescendantFanChart(root, "fan");
    const circle = buildDescendantFanChart(root, "circle");
    expect(fan.width).toBe(fan.height);
    expect(circle.width).toBe(circle.height);
    expect(circle.cx).toBe(circle.cy);
  });

  it("draws a root with no descendants as the centre disk alone", () => {
    const chart = buildDescendantFanChart(person("F", "alone"), "fan");
    expect(chart.segments).toHaveLength(1);
    expect(chart.maxGen).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import { chartViewOf, chartViewWords, type ChartViewSettings } from "./chartRoute";

const DEFAULTS: ChartViewSettings = { treeLayout: "tidy", fanShape: "fan", reportNarrative: false, kinLayout: "wheel", kinScope: "contemporaries" };

describe("chart view words", () => {
  it("leave every default out", () => {
    for (const kind of ["tree", "fan", "timeline", "relationship", "kin", "map", "report"] as const) {
      expect(chartViewWords(kind, DEFAULTS, "both")).toEqual([]);
    }
  });

  it("name the view a kind is drawn in", () => {
    expect(chartViewWords("tree", { ...DEFAULTS, treeLayout: "grid" }, "ancestors")).toEqual(["grid", "ancestors"]);
    expect(chartViewWords("fan", { ...DEFAULTS, fanShape: "circle" }, "descendants")).toEqual(["circle", "descendants"]);
    expect(chartViewWords("report", { ...DEFAULTS, reportNarrative: true }, "descendants")).toEqual(["narrative", "descendants"]);
    expect(chartViewWords("kin", { ...DEFAULTS, kinLayout: "surnames", kinScope: "all" }, "both")).toEqual(["surnames", "all"]);
    expect(chartViewWords("map", DEFAULTS, "ancestors")).toEqual(["ancestors"]);
    // Kinds without a direction, or a setting of another kind, say nothing of it.
    expect(chartViewWords("timeline", { ...DEFAULTS, treeLayout: "grid" }, "ancestors")).toEqual([]);
  });

  it("read back into the same view", () => {
    const cases = [
      ["tree", { ...DEFAULTS, treeLayout: "grid" }, "ancestors"],
      ["fan", { ...DEFAULTS, fanShape: "circle" }, "both"],
      ["report", { ...DEFAULTS, reportNarrative: true }, "descendants"],
      ["kin", { ...DEFAULTS, kinLayout: "map", kinScope: "all" }, "both"],
      ["map", DEFAULTS, "descendants"],
    ] as const;
    for (const [kind, s, dir] of cases) {
      const view = chartViewOf(kind, chartViewWords(kind, s, dir));
      expect(view.direction).toBe(dir);
      expect({ ...s, ...view.settings }).toEqual(s);
    }
  });

  it("open the defaults for an address that names none, and ignore stray words", () => {
    expect(chartViewOf("tree", [])).toEqual({ settings: { treeLayout: "tidy" }, direction: "both" });
    expect(chartViewOf("kin", ["nonsense"])).toEqual({ settings: { kinLayout: "wheel", kinScope: "contemporaries" }, direction: "both" });
    expect(chartViewOf("timeline", ["ancestors"]).direction).toBe("both");
  });

  it("name the relationship's other person, and only on the relationship", () => {
    expect(chartViewWords("relationship", DEFAULTS, "both", "p12x")).toEqual(["p12x"]);
    expect(chartViewWords("relationship", DEFAULTS, "both")).toEqual([]);
    expect(chartViewWords("fan", DEFAULTS, "both", "p12x")).toEqual([]);
  });
});

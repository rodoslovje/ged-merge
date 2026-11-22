import { describe, expect, it } from "vitest";
import { needsFit, scatteredLayout, tidyLayout, type PhotoRect } from "./collage";

const inside = (r: PhotoRect) => r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= 100 + 1e-6 && r.y + r.h <= 100 + 1e-6;

describe("needsFit", () => {
  it("shows a portrait whole in a wide area, and fills when the shapes agree", () => {
    expect(needsFit(2 / 3, 16 / 9)).toBe(true);
    expect(needsFit(3 / 2, 16 / 9)).toBe(false);
  });
});

describe("tidyLayout", () => {
  const area = 16 / 9;
  it("keeps every photo's own shape and stays inside the area", () => {
    const aspects = [3 / 2, 2 / 3, 2 / 3, 4 / 3];
    const rects = tidyLayout(aspects, area);
    rects.forEach((r, i) => {
      expect(inside(r)).toBe(true);
      // Width is in percent of 100 wide, height in percent of 100/area tall.
      expect((r.w / (r.h / area)) ).toBeCloseTo(aspects[i], 5);
    });
  });

  it("puts two portraits side by side in a wide area", () => {
    const [a, b] = tidyLayout([2 / 3, 2 / 3], area);
    expect(a.y).toBeCloseTo(b.y, 5);
    expect(b.x).toBeGreaterThan(a.x + a.w);
  });

  it("stacks two wide photos in a tall area", () => {
    const [a, b] = tidyLayout([16 / 9, 16 / 9], 2 / 3);
    expect(b.y).toBeGreaterThan(a.y + a.h);
  });
});

describe("scatteredLayout", () => {
  it("leans every print a little and keeps its shape", () => {
    const aspects = [0.8, 1.2, 0.8];
    const rects = scatteredLayout(aspects, 16 / 9);
    expect(rects).toHaveLength(3);
    rects.forEach((r, i) => {
      expect(Math.abs(r.rotate!)).toBeGreaterThan(0);
      expect(r.w / (r.h / (16 / 9))).toBeCloseTo(aspects[i], 5);
    });
  });
});

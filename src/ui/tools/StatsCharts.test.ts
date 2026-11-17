import { describe, expect, it } from "vitest";
import { gridValues } from "./StatsCharts";

describe("gridValues", () => {
  it("puts up to three guide lines on round values below the tallest column", () => {
    expect(gridValues(69)).toEqual([20, 40, 60]); // ages
    expect(gridValues(41)).toEqual([20, 40]); // percentages
    expect(gridValues(3.3)).toEqual([1, 2, 3]); // children per family
    expect(gridValues(2.7)).toEqual([1, 2]);
    expect(gridValues(1200)).toEqual([500, 1000]);
    expect(gridValues(100)).toEqual([25, 50, 75]); // none on the top itself
  });

  it("draws none for an empty chart", () => {
    expect(gridValues(0)).toEqual([]);
  });
});

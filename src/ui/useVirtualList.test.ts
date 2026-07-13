import { describe, expect, it } from "vitest";
import { VirtualModel } from "./useVirtualList";

function make(count: number, estimate = 34, gap = 0): VirtualModel {
  const m = new VirtualModel(estimate);
  m.setCount(count);
  m.setGap(gap);
  return m;
}

describe("VirtualModel", () => {
  it("uses the estimate for unmeasured rows", () => {
    const m = make(1000, 34);
    expect(m.offsetOf(0)).toBe(0);
    expect(m.offsetOf(10)).toBe(340);
    expect(m.totalHeight()).toBe(34000);
    expect(m.heightOf(500)).toBe(34);
  });

  it("includes the flex gap in the row pitch", () => {
    const m = make(100, 40, 3);
    expect(m.offsetOf(10)).toBe(430);
    expect(m.totalHeight()).toBe(4300);
  });

  it("keeps exact offsets for rows that deviate from the base", () => {
    const m = make(1000, 34);
    m.measure(5, 340); // an expanded row, 10× the others
    expect(m.offsetOf(5)).toBe(5 * 34);
    expect(m.offsetOf(6)).toBe(5 * 34 + 340);
    expect(m.offsetOf(100)).toBe(100 * 34 + 306);
    expect(m.totalHeight()).toBe(1000 * 34 + 306);
  });

  it("accumulates multiple deviations in index order", () => {
    const m = make(100, 10);
    m.measure(50, 30);
    m.measure(20, 20); // out of order on purpose
    expect(m.offsetOf(20)).toBe(200);
    expect(m.offsetOf(21)).toBe(210 + 10);
    expect(m.offsetOf(50)).toBe(500 + 10);
    expect(m.offsetOf(51)).toBe(510 + 10 + 20);
  });

  it("ignores sub-pixel remeasurements", () => {
    const m = make(10, 34);
    expect(m.measure(3, 34.2)).toBe(true);
    expect(m.measure(3, 34.4)).toBe(false);
    expect(m.measure(3, 40)).toBe(true);
  });

  it("rejects unmeasurable heights and out-of-range indices", () => {
    const m = make(10, 34);
    expect(m.measure(3, 0)).toBe(false);
    expect(m.measure(-1, 34)).toBe(false);
    expect(m.measure(10, 34)).toBe(false);
    expect(m.totalHeight()).toBe(340);
  });

  it("finds the row containing a y coordinate", () => {
    const m = make(1000, 34);
    expect(m.indexAt(0)).toBe(0);
    expect(m.indexAt(-50)).toBe(0);
    expect(m.indexAt(33.9)).toBe(0);
    expect(m.indexAt(34)).toBe(1);
    expect(m.indexAt(34 * 500 + 1)).toBe(500);
    expect(m.indexAt(1e9)).toBe(999); // clamped to the last row
  });

  it("indexAt accounts for deviating rows", () => {
    const m = make(1000, 34);
    m.measure(10, 334); // 300px taller than the base
    expect(m.indexAt(10 * 34 + 100)).toBe(10); // inside the tall row
    expect(m.indexAt(10 * 34 + 334)).toBe(11);
    expect(m.indexAt(20 * 34 + 300)).toBe(20);
  });

  it("computes an overscan-padded, clamped range", () => {
    const m = make(1000, 34);
    expect(m.range(0, 340, 5)).toEqual({ start: 0, end: 16 });
    expect(m.range(34 * 100, 34 * 110, 5)).toEqual({ start: 95, end: 116 });
    expect(m.range(34 * 995, 34 * 2000, 5)).toEqual({ start: 990, end: 1000 });
  });

  it("returns an empty range for an empty list", () => {
    const m = make(0, 34);
    expect(m.range(0, 500, 5)).toEqual({ start: 0, end: 0 });
    expect(m.totalHeight()).toBe(0);
  });

  it("rebase adopts the new common height and drops stale measurements", () => {
    const m = make(100, 34);
    m.measure(1, 34);
    m.measure(2, 60);
    expect(m.rebase(50)).toBe(true);
    expect(m.base).toBe(50);
    expect(m.heightOf(2)).toBe(50); // old measurement dropped
    expect(m.totalHeight()).toBe(5000);
    expect(m.rebase(50.2)).toBe(false); // sub-pixel: no thrash
  });

  it("clear drops measurements but keeps the learned base", () => {
    const m = make(100, 34);
    m.rebase(40);
    m.measure(5, 400);
    m.clear();
    expect(m.totalHeight()).toBe(4000);
    expect(m.heightOf(5)).toBe(40);
  });

  it("ignores measurements beyond a shrunken count", () => {
    const m = make(100, 10);
    m.measure(90, 50);
    m.setCount(50);
    expect(m.totalHeight()).toBe(500);
  });
});

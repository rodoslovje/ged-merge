import { describe, expect, it } from "vitest";
import { CALENDAR_FORMATS, DEFAULT_PAPER, PAPER, printGeometry } from "./CalendarPage";

describe("printGeometry", () => {
  it("prints a format at its designed size on the paper it is designed on", () => {
    for (const [format, paper] of [["wallTop", "a4"], ["wallMiddle", "a4"], ["desk", "a5"]] as const) {
      const g = printGeometry(format, paper);
      expect(g.sheet).toEqual({ w: PAPER[format].w, h: PAPER[format].h });
      expect(g.page).toEqual(PAPER[format]);
      expect(g.scale).toBe(1);
    }
  });

  it("fills its default paper edge to edge", () => {
    for (const format of CALENDAR_FORMATS) {
      const g = printGeometry(format, DEFAULT_PAPER[format]);
      expect(g.sheet.w - g.page.w).toBeLessThan(0.5);
      expect(g.sheet.h - g.page.h).toBeLessThan(0.5);
    }
  });

  it("enlarges the page and its em together on a larger paper", () => {
    const g = printGeometry("wallTop", "a3");
    expect(g.sheet).toEqual({ w: 297, h: 420 });
    expect(g.scale).toBeCloseTo(Math.SQRT2, 2);
    expect(g.page.em / g.page.w).toBeCloseTo(PAPER.wallTop.em / PAPER.wallTop.w, 3);
  });

  it("turns a named paper the way the format lies", () => {
    expect(printGeometry("desk", "a4").sheet).toEqual({ w: 297, h: 210 });
  });

  it("keeps the page's proportions, and inside the sheet, on a paper of another shape", () => {
    for (const paper of ["letter", { wMm: 300, hMm: 300 }] as const) {
      const g = printGeometry("wallMiddle", paper);
      expect(g.page.w).toBeLessThanOrEqual(g.sheet.w);
      expect(g.page.h).toBeLessThanOrEqual(g.sheet.h);
      expect(g.page.w / g.page.h).toBeCloseTo(PAPER.wallMiddle.w / PAPER.wallMiddle.h, 2);
    }
  });
});

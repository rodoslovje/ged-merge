import { describe, expect, it } from "vitest";
import { parseZoomPercent } from "./ZoomControls";

describe("parseZoomPercent", () => {
  it("reads a typed percentage as a zoom factor", () => {
    expect(parseZoomPercent("85")).toBe(0.85);
    expect(parseZoomPercent(" 120 % ")).toBe(1.2);
    expect(parseZoomPercent("62,5")).toBe(0.625);
  });
  it("rejects anything else", () => {
    for (const s of ["", "0", "abc", "-50", "1e3"]) expect(parseZoomPercent(s)).toBeUndefined();
  });
});

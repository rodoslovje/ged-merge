import { describe, expect, it } from "vitest";
import { cropFit } from "./cropFit";

describe("cropFit", () => {
  it("scales the crop up to fill the box and centres it", () => {
    // 100×100 crop in the middle of a 400×400 photo, shown at 50 px.
    const box = cropFit({ w: 400, h: 400 }, { left: 150, top: 150, width: 100, height: 100 }, 50);
    expect(box).toEqual({ x: -75, y: -75, w: 200, h: 200 });
  });

  it("covers the box when the crop is not square (scale from the shorter side)", () => {
    const box = cropFit({ w: 200, h: 200 }, { left: 0, top: 0, width: 100, height: 50 }, 50);
    // scale = max(50/100, 50/50) = 1 → the wider crop dimension overflows
    expect(box.w).toBe(200);
    expect(box.h).toBe(200);
  });

  it("clamps to the image edges so no blank shows", () => {
    // Crop hugs the top-left corner: centring it would push the image right/down.
    const box = cropFit({ w: 400, h: 400 }, { left: 0, top: 0, width: 100, height: 100 }, 50);
    expect(box).toEqual({ x: 0, y: 0, w: 200, h: 200 });

    // …and the bottom-right corner: the offset stops at `size - scaled size`.
    const far = cropFit({ w: 400, h: 400 }, { left: 300, top: 300, width: 100, height: 100 }, 50);
    expect(far).toEqual({ x: -150, y: -150, w: 200, h: 200 });
  });

  it("keeps a scaled image smaller than the box flush at the corner", () => {
    // A crop larger than the image itself scales the photo below box size.
    const box = cropFit({ w: 40, h: 40 }, { left: 0, top: 0, width: 200, height: 200 }, 50);
    expect(box).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

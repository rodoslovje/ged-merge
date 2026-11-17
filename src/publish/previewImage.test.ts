import { describe, expect, it } from "vitest";
import { previewCrop } from "./previewImage";

describe("previewCrop", () => {
  it("takes the whole width of a photo tall enough, a little above its middle", () => {
    // 3000×2000: 3000 wide, 1575 tall at 1200:630; 425 spare rows, 40 % above.
    expect(previewCrop(3000, 2000)).toEqual({ sx: 0, sy: 170, sw: 3000, sh: 1575, width: 1200, height: 630 });
  });

  it("takes the whole height of a wider photo, centred", () => {
    expect(previewCrop(4000, 1000)).toEqual({ sx: 1048, sy: 0, sw: 1905, sh: 1000, width: 1200, height: 630 });
  });

  it("never enlarges a small photo", () => {
    expect(previewCrop(800, 600)).toMatchObject({ sw: 800, width: 800, height: 420 });
  });
});

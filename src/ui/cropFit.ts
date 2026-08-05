import type { CropRegion } from "../gedcom/source";

/** Where to draw a source image so that just `crop` (in source-image pixels)
 *  fills a `size`×`size` thumbnail box: offsets are relative to the box's
 *  top-left corner and clamped so the box never shows past the image edges.
 *  Shared by the HTML thumbnails (`CroppedImg`) and the SVG chart-node photos,
 *  which draw the same fit with different primitives. */
export function cropFit(
  nat: { w: number; h: number },
  crop: CropRegion,
  size: number,
): { x: number; y: number; w: number; h: number } {
  const scale = Math.max(size / crop.width, size / crop.height);
  const w = nat.w * scale;
  const h = nat.h * scale;
  // Centre the crop in the box, then pull back inside the image bounds. `min` is
  // negative whenever the scaled image is bigger than the box (the normal case);
  // when it isn't, the image sits flush at the top-left.
  const clamp = (centred: number, min: number) => Math.min(0, Math.max(min, centred));
  return {
    x: clamp(size / 2 - (crop.left + crop.width / 2) * scale, size - w),
    y: clamp(size / 2 - (crop.top + crop.height / 2) * scale, size - h),
    w,
    h,
  };
}

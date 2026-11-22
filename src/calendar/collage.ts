// Where a page's photos go inside its picture area. Pure geometry: every
// rectangle is in percent of the area, so the same layout holds on screen and
// on paper. Aspects are width / height.

export type CollageStyle = "tidy" | "scattered";
export const COLLAGE_STYLES: CollageStyle[] = ["tidy", "scattered"];

/** The most photos one page takes. */
export const MAX_PHOTOS = 5;

export interface PhotoRect {
  /** Left, top, width, height — percent of the area. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees; only a scattered photo leans. */
  rotate?: number;
}

/** A photo whose shape is this far from the area's (either way) is shown whole
 *  on a blurred copy of itself, rather than cropped to fill. */
export const FIT_THRESHOLD = 1.25;

export function needsFit(photoAspect: number, areaAspect: number): boolean {
  const r = photoAspect / areaAspect;
  return r > FIT_THRESHOLD || r < 1 / FIT_THRESHOLD;
}

/**
 * Tidy: the photos in rows, in order, each row as tall as it must be for its
 * photos to fill the width at their own shapes — nothing cropped. Of every way
 * to break the sequence into rows, the one that covers most of the area wins;
 * the block is then scaled to fit and centred.
 */
export function tidyLayout(aspects: number[], areaAspect: number, gap = 1.5): PhotoRect[] {
  const n = aspects.length;
  if (!n) return [];
  // Work in a box 100 wide; its height follows the area's shape.
  const W = 100;
  const H = W / areaAspect;
  let best: { rows: number[][]; scale: number; total: number; cover: number } | undefined;
  for (const rows of partitions(n)) {
    const heights = rows.map((r) => (W - gap * (r.length - 1)) / r.reduce((s, i) => s + aspects[i], 0));
    const total = heights.reduce((s, h) => s + h, 0) + gap * (rows.length - 1);
    const scale = Math.min(1, H / total);
    const cover = (scale * scale * total) / H;
    if (!best || cover > best.cover + 1e-9) best = { rows, scale, total, cover };
  }
  const { rows, scale, total } = best!;
  const blockW = W * scale;
  const x0 = (W - blockW) / 2;
  const y0 = (H - total * scale) / 2;
  const out: PhotoRect[] = new Array(n);
  let y = y0;
  for (const r of rows) {
    const h = ((W - gap * (r.length - 1)) / r.reduce((s, i) => s + aspects[i], 0)) * scale;
    let x = x0;
    for (const i of r) {
      const w = aspects[i] * h;
      out[i] = { x, y: (y / H) * 100, w, h: (h / H) * 100 };
      x += w + gap * scale;
    }
    y += h + gap * scale;
  }
  return out;
}

/** Every way to cut 0..n-1 into consecutive rows. */
function partitions(n: number): number[][][] {
  const out: number[][][] = [];
  for (let mask = 0; mask < 1 << (n - 1); mask++) {
    const rows: number[][] = [[0]];
    for (let i = 1; i < n; i++) {
      if (mask & (1 << (i - 1))) rows.push([i]);
      else rows[rows.length - 1].push(i);
    }
    out.push(rows);
  }
  return out;
}

/** Scattered: where each photo's centre sits (percent), how big its slot may
 *  be (percent of the area's width and height) and how far it leans. */
const SLOTS: [number, number, number, number, number][][] = [
  [[50, 50, 78, 88, -2]],
  [[29, 48, 50, 84, -5], [71, 53, 50, 84, 4]],
  [[21, 46, 38, 78, -6], [50, 54, 38, 78, 3], [79, 46, 38, 78, -3]],
  [[27, 29, 46, 50, -4], [72, 31, 46, 50, 5], [29, 72, 46, 50, 3], [71, 71, 46, 50, -5]],
  [[19, 31, 33, 50, -6], [50, 27, 33, 50, 3], [81, 32, 33, 50, -3], [33, 72, 33, 50, 4], [67, 72, 33, 50, -4]],
];

/**
 * Scattered: the photos as prints dropped on the page — each leans a little,
 * keeps its own shape inside its slot and overlaps its neighbours slightly.
 * `aspects` are the framed prints' shapes (the photo with its white border).
 */
export function scatteredLayout(aspects: number[], areaAspect: number): PhotoRect[] {
  const slots = SLOTS[Math.min(aspects.length, MAX_PHOTOS) - 1] ?? [];
  return aspects.slice(0, MAX_PHOTOS).map((a, i) => {
    const [cx, cy, wMax, hMax, rotate] = slots[i];
    // Width in percent of the area's width; height follows the print's shape.
    const w = Math.min(wMax, (hMax * a) / areaAspect);
    const h = (w * areaAspect) / a;
    return { x: cx - w / 2, y: cy - h / 2, w, h, rotate };
  });
}

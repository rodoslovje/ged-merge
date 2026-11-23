// How sharp a calendar's photos come out on paper. A photo goes into the print
// document as the file it is, never resampled, so its sharpness is decided by
// two things only: how many pixels the file has, and how large the chosen
// paper makes its place on the page. The print dialog warns about the ones
// that fall below what a print needs.

/** Below this a photo starts to look soft at reading distance. */
export const PRINT_DPI = 300;

const MM_PER_INCH = 25.4;

/**
 * How many of a photo's own pixels would span the full page width, at the
 * density it is drawn with — a figure that holds for any paper.
 *
 * `nat` is the file's size, `box` the element's, `pageW` the page's width in
 * the same units as `box`. A photo that covers its box is scaled by the larger
 * of the two ratios, one that sits whole inside it by the smaller.
 */
export function photoPxPerPage(
  nat: { w: number; h: number },
  box: { w: number; h: number },
  pageW: number,
  fit: "cover" | "contain",
): number {
  const [sx, sy] = [box.w / nat.w, box.h / nat.h];
  return pageW / (fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy));
}

/** The density that figure comes to on a page `pageMm` wide. */
export function printDpi(pxPerPage: number, pageMm: number): number {
  return pxPerPage / (pageMm / MM_PER_INCH);
}

/**
 * Every photo in the picture areas of the pages under `root`, as drawn: which
 * sheet it is on (its index among `root`'s `.cal-sheet` children) and its
 * {@link photoPxPerPage}. The blurred backdrop of a fitted photo is left out —
 * it is meant to be soft.
 */
export function measurePhotos(root: HTMLElement): { sheet: number; px: number }[] {
  const found: { sheet: number; px: number }[] = [];
  Array.from(root.querySelectorAll<HTMLElement>(":scope > .cal-sheet")).forEach((sheet, index) => {
    for (const img of sheet.querySelectorAll<HTMLImageElement>(".cal-photo img:not(.cal-photo-blur)")) {
      const page = img.closest<HTMLElement>(".cal-page");
      // Layout sizes, not the bounding box: a scattered print is rotated.
      if (!page?.offsetWidth || !img.naturalWidth || !img.offsetWidth || !img.offsetHeight) continue;
      found.push({
        sheet: index,
        px: photoPxPerPage(
          { w: img.naturalWidth, h: img.naturalHeight },
          { w: img.offsetWidth, h: img.offsetHeight },
          page.offsetWidth,
          getComputedStyle(img).objectFit === "contain" ? "contain" : "cover",
        ),
      });
    }
  });
  return found;
}

/** The pages with a photo under {@link PRINT_DPI} on a page `pageMm` wide, in
 *  page order, each with its softest photo's density. */
export function softPages(photos: { label: string; px: number }[], pageMm: number): { label: string; dpi: number }[] {
  const worst = new Map<string, number>();
  for (const p of photos) {
    const dpi = Math.round(printDpi(p.px, pageMm));
    if (dpi < PRINT_DPI) worst.set(p.label, Math.min(dpi, worst.get(p.label) ?? Infinity));
  }
  return Array.from(worst, ([label, dpi]) => ({ label, dpi }));
}

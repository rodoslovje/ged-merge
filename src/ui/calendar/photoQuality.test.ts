import { describe, expect, it } from "vitest";
import { photoPxPerPage, printDpi, softPages } from "./photoQuality";

describe("photo print quality", () => {
  it("counts a photo filling the page width at its own width", () => {
    expect(photoPxPerPage({ w: 3000, h: 2000 }, { w: 600, h: 400 }, 600, "cover")).toBe(3000);
    // Half the page wide: the same file is twice as dense.
    expect(photoPxPerPage({ w: 3000, h: 2000 }, { w: 300, h: 200 }, 600, "cover")).toBe(6000);
  });

  it("follows the side that sets the scale: the larger when covering, the smaller when fitted", () => {
    // A tall photo in a wide box is cropped to the width, or shrunk to the height.
    const nat = { w: 1000, h: 2000 };
    const box = { w: 600, h: 300 };
    expect(photoPxPerPage(nat, box, 600, "cover")).toBe(1000);
    expect(photoPxPerPage(nat, box, 600, "contain")).toBe(4000);
  });

  it("turns that into dots per inch on the chosen paper", () => {
    expect(Math.round(printDpi(2480, 210))).toBe(300);
    expect(Math.round(printDpi(2480, 297))).toBe(212);
  });

  it("lists the pages with a soft photo once, by their softest", () => {
    const photos = [
      { label: "Cover", px: 4000 },
      { label: "March", px: 1500 },
      { label: "March", px: 1200 },
      { label: "May", px: 2000 },
    ];
    expect(softPages(photos, 210)).toEqual([{ label: "March", dpi: 145 }, { label: "May", dpi: 242 }]);
    expect(softPages(photos, 100)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { centreOffset, clampScroll, maxScroll, scrollForZoom } from "./treeLayout";

// The canvas scrolls a chart that is laid out at native size and rendered at
// `zoom`. A pinch paints its target as a CSS transform and only hands it over as
// a real zoom + scroll when the fingers lift, so these three have to agree
// exactly — a target the scroll range cannot reproduce is a target the chart
// visibly snaps back from.

/** Where a content point (native px) lands on screen, measured from the canvas's
 *  own left edge, at a given scale and scroll. */
const onScreen = (point: number, client: number, content: number, zoom: number, scroll: number) =>
  point * zoom + centreOffset(client, content, zoom) - scroll;

describe("centreOffset", () => {
  it("centres a chart smaller than the canvas", () => {
    expect(centreOffset(1000, 400, 1)).toBe(300);
  });

  it("is zero once the scaled chart overflows", () => {
    expect(centreOffset(1000, 400, 3)).toBe(0);
    expect(centreOffset(1000, 2000, 1)).toBe(0);
  });
});

describe("maxScroll / clampScroll", () => {
  it("gives an overflowing chart its scrollable remainder", () => {
    expect(maxScroll(1000, 2000, 1)).toBe(1000);
    expect(maxScroll(1000, 2000, 2)).toBe(3000);
  });

  it("leaves nothing to scroll while the chart fits", () => {
    expect(maxScroll(1000, 400, 1)).toBe(0);
    expect(clampScroll(250, 1000, 400, 1)).toBe(0);
  });

  it("keeps a scroll offset inside the range", () => {
    expect(clampScroll(-40, 1000, 2000, 1)).toBe(0);
    expect(clampScroll(4000, 1000, 2000, 1)).toBe(1000);
    expect(clampScroll(600, 1000, 2000, 1)).toBe(600);
  });
});

describe("scrollForZoom", () => {
  it("holds the point under the focus while zooming in", () => {
    const [client, content, from, to, scroll, focus] = [1000, 2000, 1, 2, 0, 500];
    const point = (scroll + focus - centreOffset(client, content, from)) / from;
    const next = scrollForZoom(scroll, focus, client, content, from, to);
    expect(onScreen(point, client, content, to, next)).toBeCloseTo(focus, 6);
  });

  it("holds the point under the focus while zooming out", () => {
    const [client, content, from, to, scroll, focus] = [1000, 3000, 2, 1.2, 1800, 700];
    const point = (scroll + focus - centreOffset(client, content, from)) / from;
    const next = scrollForZoom(scroll, focus, client, content, from, to);
    expect(onScreen(point, client, content, to, next)).toBeCloseTo(focus, 6);
  });

  it("accounts for the centring of a chart that does not fill the canvas", () => {
    // 400px chart in a 1000px canvas: 300px of auto margin at 1×, 100px at 2×.
    const [client, content, from, to, scroll, focus] = [1000, 400, 1, 2, 0, 500];
    const point = (scroll + focus - centreOffset(client, content, from)) / from; // 200
    expect(point).toBeCloseTo(200, 6);
    const next = scrollForZoom(scroll, focus, client, content, from, to);
    expect(next).toBe(0); // still fits: nothing to scroll
    expect(onScreen(point, client, content, to, next)).toBeCloseTo(focus, 6);
  });

  it("never returns a scroll the canvas cannot reach", () => {
    const client = 1000;
    const content = 2000;
    // Zoom in hard at the far left edge: the honest answer is negative.
    expect(scrollForZoom(0, 0, client, content, 1, 3)).toBe(0);
    // …and at the far right edge it would run past the end.
    expect(scrollForZoom(1000, 1000, client, content, 1, 3)).toBe(maxScroll(client, content, 3));
  });

  it("is its own inverse over a zoom round trip in the interior", () => {
    const [client, content, scroll, focus] = [1000, 4000, 1200, 480];
    const inward = scrollForZoom(scroll, focus, client, content, 1, 1.8);
    const back = scrollForZoom(inward, focus, client, content, 1.8, 1);
    expect(back).toBeCloseTo(scroll, 6);
  });

  it("survives a run of small steps the way a trackpad delivers them", () => {
    const [client, content, focus] = [1000, 5000, 620];
    let zoom = 1;
    let scroll = 900;
    const point = (scroll + focus - centreOffset(client, content, zoom)) / zoom;
    for (let i = 0; i < 60; i++) {
      const next = zoom * 1.01;
      scroll = scrollForZoom(scroll, focus, client, content, zoom, next);
      zoom = next;
    }
    // 60 ticks of 1% each — the focus must not have crept.
    expect(onScreen(point, client, content, zoom, scroll)).toBeCloseTo(focus, 4);
  });
});

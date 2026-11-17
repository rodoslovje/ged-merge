import { describe, expect, it } from "vitest";
import { forceLayout } from "./forceLayout";

const W = 800;
const H = 500;

function network(n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({ r: 6 + (i % 5) * 4 }));
  const edges = Array.from({ length: n - 1 }, (_, i) => ({ a: i % 7, b: i + 1, weight: 1 + (i % 4) }));
  return { nodes, edges };
}

describe("forceLayout", () => {
  it("lays out the same way every time", () => {
    const { nodes, edges } = network(30);
    expect(forceLayout(nodes, edges, W, H)).toEqual(forceLayout(nodes, edges, W, H));
  });

  it("keeps every circle inside the box, with room for its label", () => {
    const { nodes, edges } = network(40);
    const pos = forceLayout(nodes, edges, W, H, { below: 16 });
    pos.forEach((p, i) => {
      const r = nodes[i].r;
      expect(p.x - r).toBeGreaterThanOrEqual(0);
      expect(p.x + r).toBeLessThanOrEqual(W);
      expect(p.y - r).toBeGreaterThanOrEqual(0);
      expect(p.y + r + 16).toBeLessThanOrEqual(H);
    });
  });

  it("lets no two circles overlap", () => {
    const { nodes, edges } = network(40);
    const pos = forceLayout(nodes, edges, W, H);
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        expect(Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y)).toBeGreaterThan(nodes[i].r + nodes[j].r);
      }
    }
  });

  it("draws linked circles closer than unlinked ones", () => {
    const nodes = Array.from({ length: 6 }, () => ({ r: 8 }));
    const pos = forceLayout(nodes, [{ a: 0, b: 1, weight: 5 }, { a: 2, b: 3, weight: 5 }, { a: 4, b: 5, weight: 5 }], W, H);
    const d = (i: number, j: number) => Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y);
    expect(d(0, 1)).toBeLessThan(d(0, 2));
    expect(d(2, 3)).toBeLessThan(d(2, 4));
  });

  it("handles no circles and one circle", () => {
    expect(forceLayout([], [], W, H)).toEqual([]);
    expect(forceLayout([{ r: 10 }], [], W, H)).toHaveLength(1);
  });
});

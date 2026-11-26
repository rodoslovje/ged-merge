import { describe, expect, it } from "vitest";
import type { Dataset } from "../gedcom/types";
import { ALL_DISPLAY, familyCounts, familyCountsText, nodeDisplay, type NodeDisplayOptions } from "./nodeDisplay";
import { detailRowCount } from "./treeLayout";

const opts = (patch: Partial<NodeDisplayOptions> = {}): NodeDisplayOptions => ({ ...ALL_DISPLAY, ...patch });
const base = { name: "Janez Novak", years: "1817–1890", livingLabel: "Living" };

describe("familyCounts", () => {
  // F1: A + B → me, s1. F2: A + C → h1 (a half-sibling through the father).
  // F3: D + B → h2, and s1 again (listed twice, counted once). F4, F5: my two unions.
  const fam = (id: string, husband: string, wife: string, children: string[]) => [id, { id, husband, wife, children, events: [] }] as const;
  const indi = (id: string, childOf: string[], spouseOf: string[]) => [id, { id, childOf, spouseOf, events: [], names: [], sex: "U" }] as const;
  const ds = {
    individuals: new Map([
      indi("me", ["F1"], ["F4", "F5"]),
      indi("A", [], ["F1", "F2"]),
      indi("B", [], ["F1", "F3"]),
      indi("s1", ["F1"], []),
      indi("alone", [], []),
    ]),
    families: new Map([
      fam("F1", "A", "B", ["me", "s1"]),
      fam("F2", "A", "C", ["h1"]),
      fam("F3", "D", "B", ["h2", "s1"]),
      fam("F4", "me", "X", ["c1", "c2"]),
      fam("F5", "me", "Y", ["c3"]),
    ]),
  } as unknown as Dataset;
  const t = ((key: string, o: { n: number }) => `${key.replace("tree.node.", "")}=${o.n}`) as never;

  it("counts full and half siblings once each, and the children of every union", () => {
    expect(familyCounts(ds.individuals.get("me"), ds)).toEqual({ siblings: 3, children: 3 });
    expect(familyCounts(ds.individuals.get("alone"), ds)).toEqual({ siblings: 0, children: 0 });
    expect(familyCounts(undefined, ds)).toBeUndefined();
  });

  it("writes only the counts there are", () => {
    expect(familyCountsText(t, { siblings: 3, children: 2 })).toEqual({
      parts: [{ kind: "siblings", n: 3 }, { kind: "children", n: 2 }],
      full: "siblingsCount=3 · childrenCount=2",
    });
    expect(familyCountsText(t, { siblings: 0, children: 2 })?.parts).toEqual([{ kind: "children", n: 2 }]);
    expect(familyCountsText(t, { siblings: 0, children: 0 })).toBeUndefined();
  });

  it("reaches the node only when shown, never for a redacted person, and keeps the lifespan row", () => {
    const input = { ...base, familyCounts: { siblings: 3, children: 2 } };
    expect(nodeDisplay(opts(), input).familyCounts).toBeUndefined();
    expect(nodeDisplay(opts({ showFamilyCounts: true }), input).familyCounts).toEqual({ siblings: 3, children: 2 });
    expect(nodeDisplay(opts({ showFamilyCounts: true, privacyLiving: true }), { ...input, living: true }).familyCounts).toBeUndefined();
    const bare = { showLifespan: false, showAge: false, showPlace: false, showAddress: false, showKinship: false };
    expect(detailRowCount({ ...bare, showFamilyCounts: true })).toBe(1);
  });
});

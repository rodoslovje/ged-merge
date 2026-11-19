import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildFamilyGraph, SPOUSE_LINE } from "./familyGraph";
import { createLayout3d, LAYER, treeAnchors } from "./forceLayout3d";
import { OWN_BRANCH } from "./kinshipWheel";

const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const indi = (id: string, famc: string[], fams: string[]) =>
  `0 @${id}@ INDI\n1 NAME ${id} /X/\n` + famc.map((f) => `1 FAMC @${f}@\n`).join("") + fams.map((f) => `1 FAMS @${f}@\n`).join("");
const fam = (id: string, h: string | undefined, w: string | undefined, kids: string[]) =>
  `0 @${id}@ FAM\n` + (h ? `1 HUSB @${h}@\n` : "") + (w ? `1 WIFE @${w}@\n` : "") + kids.map((k) => `1 CHIL @${k}@\n`).join("");

// Root R: parents F, M; F's parents FF, FM with another son U and his child C
// (R's cousin); M's parents MF, MM. R is married to S, whose father is SF.
// A separate tree: A married to B.
const FILE = wrap(
  indi("R", ["F1"], ["F9"]) +
    indi("F", ["F2"], ["F1"]) + indi("M", ["F3"], ["F1"]) +
    indi("FF", [], ["F2"]) + indi("FM", [], ["F2"]) + indi("U", ["F2"], ["F4"]) + indi("C", ["F4"], []) +
    indi("MF", [], ["F3"]) + indi("MM", [], ["F3"]) +
    indi("S", ["F5"], ["F9"]) + indi("SF", [], ["F5"]) +
    indi("A", [], ["F6"]) + indi("B", [], ["F6"]) +
    fam("F1", "F", "M", ["R"]) + fam("F2", "FF", "FM", ["F", "U"]) + fam("F3", "MF", "MM", ["M"]) +
    fam("F4", "U", undefined, ["C"]) + fam("F5", "SF", undefined, ["S"]) + fam("F9", "R", "S", []) +
    fam("F6", "A", "B", []),
);

describe("buildFamilyGraph", () => {
  const ds = dataset(FILE);
  const byId = (g: ReturnType<typeof buildFamilyGraph>, id: string) => g.nodes.find((n) => n.id === `@${id}@`)!;

  it("walks the root's tree with generations and grandparent lines", () => {
    const g = buildFamilyGraph(ds, "@R@", "connected", 100);
    expect(g.nodes).toHaveLength(11);
    expect(g.trees).toBe(1);
    expect(byId(g, "R").pos).toEqual({ gen: 0, branch: OWN_BRANCH });
    expect(byId(g, "F").pos).toEqual({ gen: 1, branch: OWN_BRANCH });
    expect(byId(g, "FF").pos).toEqual({ gen: 2, branch: "@FF@" });
    expect(byId(g, "C").pos).toEqual({ gen: 0, branch: "@FF@" });
    expect(byId(g, "MM").pos?.branch).toBe("@MM@");
    expect(byId(g, "SF").pos).toEqual({ gen: 1, branch: SPOUSE_LINE });
    expect(g.lines.map((l) => [l.ancestorId, l.index])).toEqual([["@FF@", 0], ["@FM@", 1], ["@MF@", 2], ["@MM@", 3]]);
    // A hub for each of the six families; partners and children hang on it.
    expect(g.families).toHaveLength(6);
    expect(g.edges.filter((e) => e.kind === "partner")).toHaveLength(2 + 2 + 2 + 1 + 1 + 2);
    expect(g.edges.filter((e) => e.kind === "child")).toHaveLength(1 + 2 + 1 + 1 + 1);
    const f2 = g.families.find((f) => f.partners.includes(g.nodes.indexOf(byId(g, "FF"))))!;
    expect(f2.children.map((c) => g.nodes[c].id).sort()).toEqual(["@F@", "@U@"]);
    // Each person keeps the node the walk came from: the cousin via the uncle.
    expect(g.nodes[byId(g, "C").via].id).toBe("@U@");
    expect(byId(g, "R").via).toBe(-1);
  });

  it("keeps only blood relatives, partners and their families left out", () => {
    const g = buildFamilyGraph(ds, "@R@", "blood", 100);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["@C@", "@F@", "@FF@", "@FM@", "@M@", "@MF@", "@MM@", "@R@", "@U@"]);
    expect(byId(g, "C").pos).toEqual({ gen: 0, branch: "@FF@" });
    expect(g.lines).toHaveLength(4);
    // The partner's family is gone, and so is the root's marriage: one person
    // of it is left, no family to show.
    expect(g.families).toHaveLength(4);
  });

  it("stops the walk at the generation limit", () => {
    // One generation: parents, partner, partner's father — no grandparents,
    // so no uncle or cousin either.
    const g = buildFamilyGraph(ds, "@R@", "connected", 100, 1);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["@F@", "@M@", "@R@", "@S@", "@SF@"]);
    // Two: the grandparents, and the cousin through them (generation 0).
    const two = buildFamilyGraph(ds, "@R@", "connected", 100, 2);
    expect(two.nodes.some((n) => n.id === "@C@")).toBe(true);
  });

  it("adds the file's other trees, without a position", () => {
    const g = buildFamilyGraph(ds, "@R@", "file", 100);
    expect(g.nodes).toHaveLength(13);
    expect(g.trees).toBe(2);
    expect(byId(g, "A").pos).toBeUndefined();
    expect(byId(g, "A").tree).toBe(1);
  });

  it("keeps the nearest people under a limit and counts the rest", () => {
    const g = buildFamilyGraph(ds, "@R@", "connected", 4);
    expect(g.nodes.map((n) => n.id)).toEqual(["@R@", "@F@", "@M@", "@S@"]);
    expect(g.total).toBe(11);
    expect(g.edges.every((e) => e.a < 4 + g.families.length && e.b < 4 + g.families.length)).toBe(true);
  });
});

describe("treeAnchors", () => {
  it("keeps the root's tree in the middle and the others apart, outside it", () => {
    // Tree 0 of 200 people, then 30 small trees of 2.
    const trees = Int32Array.from([...Array(200).fill(0), ...Array.from({ length: 60 }, (_, i) => 1 + (i >> 1))]);
    const a = treeAnchors(trees);
    expect([a[0], a[1]]).toEqual([0, 0]);
    const spots: [number, number][] = [];
    for (let t = 1; t <= 30; t++) spots.push([a[t * 2], a[t * 2 + 1]]);
    expect(Math.min(...spots.map(([x, z]) => Math.hypot(x, z)))).toBeGreaterThan(150);
    let closest = Infinity;
    for (let i = 0; i < spots.length; i++)
      for (let j = i + 1; j < spots.length; j++)
        closest = Math.min(closest, Math.hypot(spots[i][0] - spots[j][0], spots[i][1] - spots[j][1]));
    expect(closest).toBeGreaterThan(40);
  });
});

describe("createLayout3d", () => {
  it("settles linked people near each other and holds generations to layers", () => {
    const gen = Float64Array.from([0, 1, 1, -1, NaN]);
    const hops = Int32Array.from([0, 1, 1, 1, 0]);
    const edges = [{ a: 1, b: 0, length: 30 }, { a: 2, b: 0, length: 30 }, { a: 0, b: 3, length: 30 }];
    const layout = createLayout3d(5, edges, gen, hops);
    let steps = 0;
    while (layout.step() && steps < 2000) steps++;
    expect(steps).toBeLessThan(2000);
    const p = layout.pos;
    for (const [i, g] of [[0, 0], [1, 1], [3, -1]] as const) expect(p[i * 3 + 1]).toBeCloseTo(g * LAYER, 0);
    const dist = (a: number, b: number) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
    // A generation apart, and not much further sideways.
    expect(dist(0, 1)).toBeLessThan(LAYER + 60);
    expect(Number.isFinite(p[4 * 3])).toBe(true);
  });

  it("starts a node beside its via, in any index order, and survives a loop", () => {
    // 2 hangs from 3 (a later index), 0 and 1 hang from each other.
    const l = createLayout3d(4, [], Float64Array.from([NaN, NaN, NaN, NaN]), new Int32Array(4), undefined, Int32Array.from([1, 0, 3, -1]));
    const p = l.pos;
    expect(Math.hypot(p[6] - p[9], p[7] - p[10], p[8] - p[11])).toBeLessThan(40);
    expect([...p].every(Number.isFinite)).toBe(true);
  });

  it("is deterministic", () => {
    const run = () => {
      const l = createLayout3d(3, [{ a: 0, b: 1, length: 30 }], Float64Array.from([0, 1, NaN]), Int32Array.from([0, 1, 0]));
      for (let i = 0; i < 50; i++) l.step();
      return [...l.pos];
    };
    expect(run()).toEqual(run());
  });
});

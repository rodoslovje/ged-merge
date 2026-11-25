import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildCompleteTree } from "./completeTree";
import { planCompletePages, splitFamily } from "./completeSheets";
import { splitIntoSheets } from "./sheets";
import { NODE_H } from "./treeLayout";
import type { TreeNode } from "./personTree";

const tr = (key: string) => key;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));

// A patriarch with `kids` children, each married to a wife whose father is
// in the file — so one wide tree plus one small tree per wife.
function family(kids: number) {
  let s = "0 @P@ INDI\n1 NAME Peter /Kos/\n1 SEX M\n1 FAMS @FP@\n0 @FP@ FAM\n1 HUSB @P@\n";
  for (let i = 0; i < kids; i++) {
    s += `1 CHIL @C${i}@\n`;
  }
  for (let i = 0; i < kids; i++) {
    s +=
      `0 @C${i}@ INDI\n1 NAME Child${i} /Kos/\n1 SEX M\n1 FAMC @FP@\n1 FAMS @M${i}@\n` +
      `0 @W${i}@ INDI\n1 NAME Wife${i} /Novak${i}/\n1 SEX F\n1 FAMC @WF${i}@\n1 FAMS @M${i}@\n` +
      `0 @D${i}@ INDI\n1 NAME Dad${i} /Novak${i}/\n1 SEX M\n1 FAMS @WF${i}@\n` +
      `0 @G${i}@ INDI\n1 NAME Grand${i} /Kos/\n1 SEX M\n1 FAMC @M${i}@\n` +
      `0 @M${i}@ FAM\n1 HUSB @C${i}@\n1 WIFE @W${i}@\n1 CHIL @G${i}@\n` +
      `0 @WF${i}@ FAM\n1 HUSB @D${i}@\n1 CHIL @W${i}@\n`;
  }
  const ds = dataset(wrap(s));
  return buildCompleteTree(tr, ds.individuals.get("@C0@")!, ds);
}

const opts = (w: number, h: number) => ({ grid: false, alignment: "lr" as const, nodeH: NODE_H, budget: { w, h } });

describe("planCompletePages", () => {
  const tree = family(6);

  it("puts several small trees on one page", () => {
    const pages = planCompletePages(tree, opts(1400, 1000));
    const pieces = pages.flatMap((p) => p.pieces);
    expect(pieces.map((p) => p.label)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(pages.length).toBeLessThan(pieces.length);
    for (const page of pages) {
      for (const p of page.pieces) {
        expect(p.x + p.w).toBeLessThanOrEqual(1400.5);
        expect(p.y + p.h).toBeLessThanOrEqual(1000.5);
      }
    }
  });

  it("cuts a tree too big for the page into numbered parts", () => {
    const pages = planCompletePages(tree, opts(700, 1200));
    const labels = pages.flatMap((p) => p.pieces.map((x) => x.label));
    expect(labels[0]).toBe("1");
    expect(labels.some((l) => l.startsWith("1."))).toBe(true);
    const part = pages.flatMap((p) => p.pieces).find((x) => x.label.startsWith("1."))!;
    expect(part.from).toBe("1");
    expect(part.markerLabel(3)).toBe("1.3");
  });

  it("packs everything onto one page when the print may shrink to fit", () => {
    const pages = planCompletePages(tree, opts(Infinity, Infinity));
    expect(pages).toHaveLength(1);
    expect(pages[0].pieces).toHaveLength(7);
  });

  it("parts a family taller than the page over several pieces, none printing smaller", () => {
    // Fifteen children of one couple: taller than a short page, and the
    // sheet split never parts a family's children.
    let s = "0 @H@ INDI\n1 NAME Jakob /Kos/\n1 SEX M\n1 FAMS @F@\n0 @W@ INDI\n1 NAME Ana /Kos/\n1 SEX F\n1 FAMS @F@\n0 @F@ FAM\n1 HUSB @H@\n1 WIFE @W@\n";
    for (let i = 0; i < 15; i++) s += `1 CHIL @K${i}@\n`;
    for (let i = 0; i < 15; i++) s += `0 @K${i}@ INDI\n1 NAME Kid${i} /Kos/\n1 SEX F\n1 FAMC @F@\n`;
    const ds = dataset(wrap(s));
    const big = buildCompleteTree(tr, ds.individuals.get("@H@")!, ds);
    const pages = planCompletePages(big, opts(1400, 600));
    const pieces = pages.flatMap((p) => p.pieces);
    expect(pieces.map((p) => p.label)).toEqual(["1", "1/2", "1/3", "1/4"].slice(0, pieces.length));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[1].from).toBe("1");
    expect(pages.some((p) => p.oversized)).toBe(false);
    // Every child is on exactly one piece, in order.
    const kids = pieces.flatMap((p) => p.root.partners.flatMap((q) => q.children.map((c) => c.name)));
    expect(kids).toEqual(Array.from({ length: 15 }, (_, i) => `Kid${i} Kos`));
  });
});

describe("planCompletePages for a single tree", () => {
  const node = (key: string, children: TreeNode[] = []): TreeNode =>
    ({ key, status: "main-only", name: key, years: "", living: false, sex: "U", detail: "", children, partners: [] });
  // Three generations, 64 grandchildren: left→right a strip some 800 px wide
  // and several thousand tall — the shape a descendants chart takes.
  const strip = { panels: [{ number: 1, tree: node("r", Array.from({ length: 8 }, (_, i) =>
    node(`c${i}`, Array.from({ length: 8 }, (_, j) => node(`c${i}g${j}`))))) }] };
  const page = opts(3000, 1500);

  it("sets the cut branches side by side, on fewer sheets than one each", () => {
    const pages = planCompletePages(strip, page, true);
    const pieces = pages.flatMap((p) => p.pieces);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pages.length).toBeLessThan(splitIntoSheets(strip.panels[0].tree, page).length);
    // The strip no longer runs down the left edge of a wide sheet.
    expect(pages[0].pieces.some((p) => p.x > 0)).toBe(true);
    expect(pages[0].width).toBeGreaterThan(1500);
    expect(pages.some((p) => p.oversized)).toBe(false);
  });

  it("numbers the parts plainly", () => {
    const pieces = planCompletePages(strip, page, true).flatMap((p) => p.pieces);
    expect(pieces.map((p) => p.label)).toEqual(pieces.map((_, i) => String(i + 1)));
    expect(pieces[1].from).toBe("1");
    expect(pieces[0].markerLabel(2)).toBe("2");
  });
});

describe("splitFamily", () => {
  it("keeps the person and spouses on every copy, the children in runs", () => {
    const kid = (name: string) => ({ key: name, name, children: [], partners: [] }) as unknown as TreeNode;
    const root = {
      key: "r", name: "R", children: [kid("a")],
      partners: [{ key: "s1", name: "S1", children: [kid("b"), kid("c")], partners: [] }, { key: "s2", name: "S2", children: [kid("d")], partners: [] }],
    } as unknown as TreeNode;
    // Two children per copy.
    const count = (n: TreeNode) => n.children.length + n.partners.reduce((s, p) => s + p.children.length, 0);
    const parts = splitFamily(root, (n) => count(n) <= 2);
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.partners.length)).toEqual([2, 2]);
    expect(parts[0].children.map((c) => c.key)).toEqual(["a"]);
    expect(parts[0].partners[0].children.map((c) => c.key)).toEqual(["b"]);
    expect(parts[1].partners[0].children.map((c) => c.key)).toEqual(["c"]);
    expect(parts[1].partners[1].children.map((c) => c.key)).toEqual(["d"]);
  });
});

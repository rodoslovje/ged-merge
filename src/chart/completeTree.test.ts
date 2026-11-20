import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import type { TreeNode } from "./personTree";
import { buildCompleteTree, connectedCount, layoutComplete, packSkyline } from "./completeTree";

const tr = (key: string) => key;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));

const indi = (id: string, name: string, sex: string, links = "") =>
  `0 @${id}@ INDI\n1 NAME ${name}\n1 SEX ${sex}\n${links}`;

// Rok's father's line goes up to a grandfather; his mother's family, his
// wife's family, and his aunt's husband's other marriage each need a panel.
const DS = dataset(
  wrap(
    indi("GF", "Gregor /Kos/", "M", "1 FAMS @F0@\n") +
      indi("F", "France /Kos/", "M", "1 FAMC @F0@\n1 FAMS @F1@\n") +
      indi("M", "Marija /Novak/", "F", "1 FAMC @F2@\n1 FAMS @F1@\n") +
      indi("MF", "Matija /Novak/", "M", "1 FAMS @F2@\n") +
      indi("MM", "Mojca /Zupan/", "F", "1 FAMS @F2@\n") +
      indi("A", "Ana /Novak/", "F", "1 FAMC @F2@\n1 FAMS @F4@\n") +
      indi("W", "Viktor /Hribar/", "M", "1 FAMS @F4@\n1 FAMS @F5@\n") +
      indi("X", "Xenija /Bizjak/", "F", "1 FAMS @F5@\n") +
      indi("H", "Helena /Hribar/", "F", "1 FAMC @F5@\n") +
      indi("R", "Rok /Kos/", "M", "1 FAMC @F1@\n1 FAMS @F3@\n") +
      indi("S", "Sara /Golob/", "F", "1 FAMC @F6@\n1 FAMS @F3@\n") +
      indi("SF", "Stane /Golob/", "M", "1 FAMS @F6@\n") +
      indi("C", "Cene /Kos/", "M", "1 FAMC @F3@\n") +
      "0 @F0@ FAM\n1 HUSB @GF@\n1 CHIL @F@\n" +
      "0 @F1@ FAM\n1 HUSB @F@\n1 WIFE @M@\n1 CHIL @R@\n" +
      "0 @F2@ FAM\n1 HUSB @MF@\n1 WIFE @MM@\n1 CHIL @M@\n1 CHIL @A@\n" +
      "0 @F3@ FAM\n1 HUSB @R@\n1 WIFE @S@\n1 CHIL @C@\n" +
      "0 @F4@ FAM\n1 HUSB @W@\n1 WIFE @A@\n" +
      "0 @F5@ FAM\n1 HUSB @W@\n1 WIFE @X@\n1 CHIL @H@\n" +
      "0 @F6@ FAM\n1 HUSB @SF@\n1 CHIL @S@\n",
  ),
);

function nodes(root: TreeNode): { n: TreeNode; partner: boolean }[] {
  const out: { n: TreeNode; partner: boolean }[] = [];
  const visit = (n: TreeNode, partner: boolean) => {
    out.push({ n, partner });
    for (const p of n.partners) {
      out.push({ n: p, partner: true });
      p.children.forEach((c) => visit(c, false));
    }
    n.children.forEach((c) => visit(c, false));
  };
  visit(root, false);
  return out;
}

describe("buildCompleteTree", () => {
  const tree = buildCompleteTree(tr, DS.individuals.get("@R@")!, DS);
  const tops = tree.panels.map((p) => p.tree.main?.id);
  const inPanel = (n: number) => nodes(tree.panels[n - 1].tree);

  it("starts from the root's topmost ancestor, then each spouse's family in turn", () => {
    expect(tops).toEqual(["@GF@", "@MF@", "@SF@", "@W@"]);
  });

  it("draws every person's line once, and counts everyone connected", () => {
    const lines = tree.panels.flatMap((p) => nodes(p.tree)).filter((x) => !x.partner && !x.n.repeat);
    const ids = lines.map((x) => x.n.main!.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(tree.people).toBe(DS.individuals.size);
    expect(tree.truncated).toBe(false);
    expect(tree.rootKey).toBe("@R@|");
  });

  it("numbers a spouse box with the panel that carries their line", () => {
    const spouse = (panel: number, id: string) =>
      inPanel(panel).find((x) => x.partner && x.n.main?.id === id)!.n;
    expect(spouse(1, "@M@").continuesOn).toBe(2);
    expect(spouse(1, "@S@").continuesOn).toBe(3);
    // Back the other way: the union already drawn in panel 1.
    expect(spouse(2, "@F@").continuesOn).toBe(1);
    expect(spouse(2, "@W@").continuesOn).toBe(4);
    expect(spouse(4, "@A@").continuesOn).toBe(2);
    // A spouse with no family of their own carries no number.
    expect(spouse(2, "@MM@").continuesOn).toBeUndefined();
    expect(spouse(2, "@MM@").repeat).toBeFalsy();
  });

  it("keeps the union's children with the first panel to reach it", () => {
    expect(inPanel(1).some((x) => x.n.main?.id === "@C@")).toBe(true);
    expect(inPanel(3).some((x) => x.n.main?.id === "@C@")).toBe(false);
    expect(inPanel(4).some((x) => x.n.main?.id === "@H@")).toBe(true);
  });

  it("stops starting panels at the people cap", () => {
    const capped = buildCompleteTree(tr, DS.individuals.get("@R@")!, DS, undefined, 3);
    expect(capped.panels).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it("draws a person with no relatives as a panel of one", () => {
    const lone = dataset(wrap(indi("L", "Luka /Sam/", "M")));
    const t = buildCompleteTree(tr, lone.individuals.get("@L@")!, lone);
    expect(t.panels).toHaveLength(1);
    expect(t.people).toBe(1);
  });
});

describe("connectedCount", () => {
  it("counts the people the uncapped chart draws", () => {
    expect(connectedCount(DS, "@R@")).toBe(buildCompleteTree(tr, DS.individuals.get("@R@")!, DS).people);
    expect(connectedCount(DS, "@nobody@")).toBe(0);
  });
});

describe("layoutComplete", () => {
  it("frames each panel apart and opens on the root", () => {
    const laid = layoutComplete(buildCompleteTree(tr, DS.individuals.get("@R@")!, DS))!;
    expect(laid.panels).toHaveLength(4);
    expect(laid.root.main?.id).toBe("@R@");
    const overlap = (a: (typeof laid.panels)[number], b: (typeof laid.panels)[number]) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (let i = 0; i < laid.panels.length; i++)
      for (let j = i + 1; j < laid.panels.length; j++) expect(overlap(laid.panels[i], laid.panels[j])).toBe(false);
    // Every node sits inside its own panel's frame.
    laid.trees.forEach((t, i) => {
      const f = laid.panels[i];
      for (const { n } of nodes(t)) {
        const p = n as unknown as { x: number; y: number };
        expect(p.x).toBeGreaterThanOrEqual(f.x);
        expect(p.y).toBeGreaterThanOrEqual(f.y);
        expect(p.x).toBeLessThan(f.x + f.w);
        expect(p.y).toBeLessThan(f.y + f.h);
      }
    });
  });
});

describe("packSkyline", () => {
  it("fills the gap beside a tall rectangle before starting below it", () => {
    const spots = packSkyline([{ w: 100, h: 300 }, { w: 100, h: 100 }, { w: 100, h: 100 }, { w: 100, h: 100 }], 210, 10);
    expect(spots).toEqual([
      { x: 0, y: 0 },
      { x: 110, y: 0 },
      { x: 110, y: 110 },
      { x: 110, y: 220 },
    ]);
  });

  it("never overlaps, whatever the sizes", () => {
    const sizes = Array.from({ length: 40 }, (_, i) => ({ w: 50 + ((i * 37) % 200), h: 40 + ((i * 53) % 300) }));
    const spots = packSkyline(sizes, 600, 8);
    for (let i = 0; i < sizes.length; i++)
      for (let j = i + 1; j < sizes.length; j++) {
        const a = { ...spots[i], ...sizes[i] };
        const b = { ...spots[j], ...sizes[j] };
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
  });
});

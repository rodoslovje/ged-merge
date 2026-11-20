import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildCompleteTree } from "./completeTree";
import { planCompletePages } from "./completeSheets";
import { NODE_H } from "./treeLayout";

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
});

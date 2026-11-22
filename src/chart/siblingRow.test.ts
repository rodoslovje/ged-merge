import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildSiblingRow } from "./siblingRow";
import { buildPersonTree } from "./personTree";
import { buildButterflyChart, SIBLING_KEY_PREFIX } from "./butterflyFan";
import type { Translate } from "../locales/i18n";

const tr = ((key: string) => key) as Translate;
const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;
const dataset = (text: string) => buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));

// Root Janez (1900) between an older sister (1898) and a younger brother
// (1903); an undated brother listed after the root stays right after him. The
// father remarried: a half-brother (1936). The mother had a daughter (1890)
// from an earlier union: an older half-sister.
const DS = dataset(
  wrap(
    "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n1 FAMC @F1@\n" +
      "0 @I2@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 FAMS @F1@\n1 FAMS @F3@\n" +
      "0 @I3@ INDI\n1 NAME Marija /Novak/\n1 SEX F\n1 FAMS @F1@\n1 FAMS @F4@\n" +
      "0 @I4@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1898\n1 FAMC @F1@\n" +
      "0 @I5@ INDI\n1 NAME Franc /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1903\n1 FAMC @F1@\n" +
      "0 @I6@ INDI\n1 NAME Jože /Novak/\n1 SEX M\n1 FAMC @F1@\n" +
      "0 @I10@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1936\n1 FAMC @F3@\n" +
      "0 @I11@ INDI\n1 NAME Vida /Kovac/\n1 SEX F\n1 BIRT\n2 DATE 1890\n1 FAMC @F4@\n" +
      "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I4@\n1 CHIL @I1@\n1 CHIL @I6@\n1 CHIL @I5@\n" +
      "0 @F3@ FAM\n1 HUSB @I2@\n1 CHIL @I10@\n" +
      "0 @F4@ FAM\n1 WIFE @I3@\n1 CHIL @I11@\n",
  ),
);
const root = DS.individuals.get("@I1@")!;

describe("buildSiblingRow", () => {
  it("splits full and half siblings at the root by birth order", () => {
    const row = buildSiblingRow(tr, root, DS);
    expect(row.older.map((s) => [s.node.name, s.half])).toEqual([
      ["Vida Kovac", "mother"],
      ["Ana Novak", undefined],
    ]);
    expect(row.younger.map((s) => [s.node.name, s.half])).toEqual([
      ["Jože Novak", undefined],
      ["Franc Novak", undefined],
      ["Tone Novak", "father"],
    ]);
  });

  it("is empty for an only child with no parents", () => {
    const lone = dataset(wrap("0 @I1@ INDI\n1 NAME Lone /One/\n"));
    expect(buildSiblingRow(tr, lone.individuals.get("@I1@")!, lone)).toEqual({ older: [], younger: [] });
  });
});

describe("buildButterflyChart with siblings", () => {
  const anc = buildPersonTree(tr, root, undefined, DS, DS, { mainToCompare: new Map(), compareToMain: new Map() }, "ancestors")!;
  const desc = buildPersonTree(tr, root, undefined, DS, DS, { mainToCompare: new Map(), compareToMain: new Map() }, "descendants")!;
  const chart = buildButterflyChart(anc, desc, {}, buildSiblingRow(tr, root, DS));
  const sibs = chart.segments.filter((s) => s.key.startsWith(SIBLING_KEY_PREFIX));

  it("puts the older on the right and the younger on the left", () => {
    expect(sibs).toHaveLength(5);
    for (const s of sibs) {
      const right = s.x > chart.cx;
      expect(right).toBe(s.key.startsWith(`${SIBLING_KEY_PREFIX}o`));
    }
  });

  it("marks half-siblings and keeps every key unique", () => {
    expect(sibs.filter((s) => s.half).map((s) => s.node.name).sort()).toEqual(["Tone Novak", "Vida Kovac"]);
    expect(new Set(chart.segments.map((s) => s.key)).size).toBe(chart.segments.length);
  });
});

import { describe, expect, it } from "vitest";
import { parseGedcom } from "../gedcom/parser";
import { buildDataset } from "../gedcom/builder";
import type { Individual } from "../gedcom/types";
import type { TreeNode } from "./personTree";
import { OWN_BRANCH } from "./kinshipWheel";
import { LINE_COLORS, createNodeColorer, indexPositions, sanitizeColorAxis, type ColorContext } from "./nodeColor";

const GED = `0 HEAD
1 GEDC
2 VERS 5.5.1
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 1950
2 PLAC Kranj, Slovenija
2 SOUR @S1@
1 FAMC @F1@
1 FAMS @F2@
0 @I2@ INDI
1 NAME Franc /Novak/
1 SEX M
1 BIRT
2 DATE 1920
2 PLAC Graz, Österreich
1 DEAT
2 DATE 1990
1 FAMS @F1@
0 @I3@ INDI
1 NAME Ana /Kovač/
1 SEX F
1 BIRT
2 DATE 1925
2 PLAC Kranj
1 DEAT
2 DATE 2010
1 FAMS @F1@
0 @I4@ INDI
1 NAME Maja /Novak/
1 SEX F
1 BIRT
2 DATE 1980
1 FAMC @F2@
0 @I5@ INDI
1 NAME Petra /Zupan/
1 SEX F
1 FAMS @F2@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
1 MARR
2 DATE 1948
2 SOUR @S1@
0 @F2@ FAM
1 HUSB @I1@
1 WIFE @I5@
1 CHIL @I4@
0 @S1@ SOUR
1 TITL Matične knjige
0 TRLR
`;

const ds = buildDataset(parseGedcom(new TextEncoder().encode(GED).buffer as ArrayBuffer));
const indi = (id: string): Individual => ds.individuals.get(`@${id}@`)!;
const t = ((key: string, opts?: Record<string, unknown>) => (opts?.n !== undefined ? `${key}:${opts.n}` : key)) as ColorContext["t"];
const ctx: ColorContext = { ds, t, lang: "en", home: "si", now: 2026 };

function node(key: string, id: string | undefined, sex: "M" | "F" | "U", children: TreeNode[] = [], partners: TreeNode[] = []): TreeNode {
  return { key, main: id ? indi(id) : undefined, status: "main-only", name: key, years: "", living: false, sex, detail: "", children, partners };
}

describe("indexPositions", () => {
  it("signs generations by direction and names the lines by grandparent / child", () => {
    // Ancestors: root ← father (I2) ← [gf, gm]; mother (I3) ← [mgm only].
    const anc = node("R", "I1", "M", [
      node("F", "I2", "M", [node("FF", undefined, "M", [node("FFF", undefined, "M")]), node("FM", undefined, "F")]),
      node("M", "I3", "F", [node("MM", undefined, "F")]),
    ]);
    const { positions, branches } = indexPositions(anc, "ancestors");
    expect(positions.get("R")).toEqual({ gen: 0, branch: OWN_BRANCH });
    expect(positions.get("F")).toEqual({ gen: 1, branch: OWN_BRANCH });
    expect(positions.get("FF")).toEqual({ gen: 2, branch: "FF" });
    expect(positions.get("FFF")).toEqual({ gen: 3, branch: "FF" });
    // A lone grandmother on the mother's side keeps the mother's-mother colour.
    expect(positions.get("MM")).toEqual({ gen: 2, branch: "MM" });
    expect(branches.get("FF")?.color).toBe(LINE_COLORS[0]);
    expect(branches.get("FM")?.color).toBe(LINE_COLORS[1]);
    expect(branches.get("MM")?.color).toBe(LINE_COLORS[3]);
    expect(branches.get("FF")?.label).toBe("FF");

    // Descendants: root + spouse → child (I4) → grandchild; a spouseless child.
    const desc = node("R", "I1", "M", [node("C2", undefined, "M")], [node("S", "I5", "F", [node("C1", "I4", "F", [node("G", undefined, "M")])])]);
    const d = indexPositions(desc, "descendants", "a:");
    expect(d.positions.get("a:R")).toEqual({ gen: 0, branch: OWN_BRANCH });
    expect(d.positions.get("a:S")).toEqual({ gen: 0, branch: OWN_BRANCH });
    // The child's line is keyed by their id; a union's children come first.
    expect(d.positions.get("a:C1")).toEqual({ gen: -1, branch: "@I4@" });
    expect(d.positions.get("a:G")).toEqual({ gen: -2, branch: "@I4@" });
    expect(d.positions.get("a:C2")).toEqual({ gen: -1, branch: "C2" });
    expect([...d.branches.keys()]).toEqual(["@I4@", "C2"]);
  });
});

describe("createNodeColorer", () => {
  const subjects = ["I1", "I2", "I3", "I4", "I5"].map((id) => ({ indi: indi(id) }));

  it("is silent on the plain axis", () => {
    const c = createNodeColorer("plain", ctx, subjects);
    expect(c.colorOf(c.categoryOf(indi("I1")))).toBeUndefined();
    expect(c.legend).toEqual([]);
  });

  it("reads sex and living, in a fixed legend order", () => {
    const sex = createNodeColorer("sex", ctx, subjects);
    expect(sex.legend.map((e) => [e.key, e.count])).toEqual([["M", 2], ["F", 3]]);
    expect(sex.colorOf("F")).toBe("var(--sex-female)");
    const living = createNodeColorer("living", ctx, subjects);
    expect(living.categoryOf(indi("I2"))).toBe("deceased");
    expect(living.categoryOf(indi("I4"))).toBe("living");
    expect(living.legend.map((e) => e.key)).toEqual(["living", "deceased"]);
  });

  it("takes the country from the first placed event, the home country for a bare place", () => {
    const c = createNodeColorer("country", ctx, subjects);
    expect(c.categoryOf(indi("I1"))).toBe("si");
    expect(c.categoryOf(indi("I2"))).toBe("at");
    expect(c.categoryOf(indi("I3"))).toBe("si"); // "Kranj" names no country
    expect(c.categoryOf(indi("I4"))).toBe(""); // no place at all
    expect(c.legend.map((e) => [e.key, e.count])).toEqual([["si", 2], ["at", 1]]);
    expect(c.legend[0].label).toContain("Slovenia");
  });

  it("folds a long tail of surnames into other", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      indi: { ...indi("I1"), names: [{ given: "X", surname: `S${i}`, full: `X S${i}` }] } as Individual,
    }));
    const c = createNodeColorer("surname", ctx, [...many, ...many.slice(0, 3)]);
    expect(c.legend).toHaveLength(12);
    expect(c.legend[11].label).toBe("chartColor.other");
    expect(c.legend[11].count).toBe(9);
    expect(c.categoryOf(many[19].indi)).toBe(c.legend[11].key);
    expect(c.categoryOf(many[0].indi)).toBe("S0");
  });

  it("buckets a parent's age at birth and the sourced share", () => {
    const mother = createNodeColorer("motherAge", ctx, subjects);
    // Ana (1925) was 25 at Janez's birth (1950); Maja's mother has no birth date.
    expect(mother.categoryOf(indi("I1"))).toBe("25");
    expect(mother.categoryOf(indi("I4"))).toBe("");
    expect(mother.legend.map((e) => e.label)).toEqual(["25–29"]);
    const father = createNodeColorer("fatherAge", ctx, subjects);
    expect(father.categoryOf(indi("I1"))).toBe("30");
    const sources = createNodeColorer("sources", ctx, subjects);
    // Janez: birth cited, marriage F2 has no MARR → 1 of 1; Franc: birth, death
    // uncited, marriage F1 cited → 1 of 3.
    expect(sources.categoryOf(indi("I1"))).toBe("all");
    expect(sources.categoryOf(indi("I2"))).toBe("some");
    expect(sources.categoryOf(indi("I5"))).toBe("");
  });

  it("colours generations from the position, scaled to the chart's span", () => {
    const subjectsWithPos = [
      { indi: indi("I1"), pos: { gen: 0, branch: OWN_BRANCH } },
      { indi: indi("I2"), pos: { gen: 1, branch: OWN_BRANCH } },
      { indi: indi("I4"), pos: { gen: -1, branch: "@I4@" } },
      { indi: indi("I3"), pos: { gen: 7, branch: "x" } },
    ];
    const c = createNodeColorer("generation", ctx, subjectsWithPos);
    expect(c.legend.map((e) => e.key)).toEqual(["7", "1", "0", "-1"]);
    expect(c.legend[0].label).toBe("kin.gen.up.n:7");
    expect(c.colorOf("0")).toBe("var(--kin-gen-0)");
    expect(c.colorOf("1")).toContain("--kin-anc-near");
    expect(c.legend[3].label).toBe("kin.gen.down.1");
  });

  it("sanitizes a stored axis", () => {
    expect(sanitizeColorAxis("country")).toBe("country");
    expect(sanitizeColorAxis("nope")).toBe("plain");
  });
});

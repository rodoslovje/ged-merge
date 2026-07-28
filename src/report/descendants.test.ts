import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { displayName, primaryName } from "../match/relatives";
import type { Individual } from "../gedcom/types";
import { buildDescendants } from "./descendants";
import { reportToText } from "./text";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** Identity translator: tests assert on keys, not localized labels. */
const tr = (key: string) => key;
const nameOf = (indi: Individual) => displayName(primaryName(indi));

const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Root Janez (1870–1940) with two unions: first Marija (⚭ 1895; children
// Peter 1896 and Ana 1899), then Neža (⚭ 1920; child Tone 1921). Peter ⚭ Eva
// (1925) has Ivan (1926, recorded before his older sister) and Mira (1924);
// Ana ⚭ Franc (1930) has Vida (1931). Tone is childless. Spouses are not
// descendants and must not be numbered.
const DESCENDANTS = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 DEAT\n2 DATE 1940\n1 FAMS @F1@\n1 FAMS @F2@\n" +
    "0 @I2@ INDI\n1 NAME Marija /Oblak/\n1 SEX F\n1 BIRT\n2 DATE 1872\n1 DEAT\n2 DATE 1918\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Peter /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1896\n1 DEAT\n2 DATE 1960\n1 FAMC @F1@\n1 FAMS @F3@\n" +
    "0 @I4@ INDI\n1 NAME Ana /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1899\n1 DEAT\n2 DATE 1970\n1 FAMC @F1@\n1 FAMS @F4@\n" +
    "0 @I5@ INDI\n1 NAME Neza /Kovac/\n1 SEX F\n1 BIRT\n2 DATE 1890\n1 DEAT\n2 DATE 1950\n1 FAMS @F2@\n" +
    "0 @I6@ INDI\n1 NAME Tone /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1921\n1 DEAT\n2 DATE 1980\n1 FAMC @F2@\n" +
    "0 @I7@ INDI\n1 NAME Eva /Zajc/\n1 SEX F\n1 BIRT\n2 DATE 1900\n1 DEAT\n2 DATE 1970\n1 FAMS @F3@\n" +
    "0 @I8@ INDI\n1 NAME Ivan /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1926\n1 DEAT\n2 DATE 1990\n1 FAMC @F3@\n" +
    "0 @I9@ INDI\n1 NAME Mira /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1924\n1 DEAT\n2 DATE 1995\n1 FAMC @F3@\n" +
    "0 @I10@ INDI\n1 NAME Franc /Kos/\n1 SEX M\n1 BIRT\n2 DATE 1898\n1 DEAT\n2 DATE 1975\n1 FAMS @F4@\n" +
    "0 @I11@ INDI\n1 NAME Vida /Kos/\n1 SEX F\n1 BIRT\n2 DATE 1931\n1 DEAT\n2 DATE 2010\n1 FAMC @F4@\n" +
    "0 @F1@ FAM\n1 HUSB @I1@\n1 WIFE @I2@\n1 CHIL @I3@\n1 CHIL @I4@\n1 MARR\n2 DATE 1895\n2 PLAC Kranj\n" +
    "0 @F2@ FAM\n1 HUSB @I1@\n1 WIFE @I5@\n1 CHIL @I6@\n1 MARR\n2 DATE 1920\n" +
    "0 @F3@ FAM\n1 HUSB @I3@\n1 WIFE @I7@\n1 CHIL @I8@\n1 CHIL @I9@\n1 MARR\n2 DATE 1922\n" +
    "0 @F4@ FAM\n1 HUSB @I10@\n1 WIFE @I4@\n1 CHIL @I11@\n1 MARR\n2 DATE 1930\n",
);

const NOW = 2000;

describe("buildDescendants", () => {
  const ds = dataset(DESCENDANTS);
  const data = buildDescendants(ds, "@I1@", nameOf, NOW)!;
  const all = data.generations.flatMap((g) => g.entries);

  it("numbers descendants sequentially in order of appearance", () => {
    expect(all.map((e) => `${e.num}:${e.id}`)).toEqual([
      "1:@I1@",
      "2:@I3@", "3:@I4@", "4:@I6@", // children: union order, birth order within
      "5:@I9@", "6:@I8@", "7:@I11@", // grandchildren: Mira (1924) before Ivan (1926)
    ]);
    expect(data.total).toBe(7);
  });

  it("groups each generation's children per union, naming both parents", () => {
    const gen2 = data.generations[2].entries;
    expect(gen2.map((e) => `${e.num}<${e.parentNum}`)).toEqual(["5<2", "6<2", "7<3"]);
    // Parents carry name, sex and lifespan so the heading renders them like
    // any other name.
    expect(gen2[0].parent).toMatchObject({ name: "Peter Novak", sex: "M", years: "1896–1960" });
    expect(gen2[0].parentSpouse).toMatchObject({ name: "Eva Zajc", sex: "F", years: "1900–1970" });
    expect(gen2[0].parentFam).toBe("@F3@");
    expect(gen2[2].parent).toMatchObject({ name: "Ana Novak" });
    expect(gen2[2].parentSpouse).toMatchObject({ name: "Franc Kos" });
    // The root's two unions are two separate groups in generation 1.
    const gen1 = data.generations[1].entries;
    expect(gen1.map((e) => `${e.parentFam}:${e.parentSpouse?.name}`)).toEqual([
      "@F1@:Marija Oblak", "@F1@:Marija Oblak", "@F2@:Neza Kovac",
    ]);
  });

  it("indexes a union's children with roman numerals in birth order", () => {
    const all2 = data.generations.flatMap((g) => g.entries);
    expect(all2.map((e) => `${e.num}:${e.childIndex ?? "-"}`)).toEqual([
      "1:-", // the root has no child index
      "2:1", "3:2", "4:1", // Peter i, Ana ii (F1); Tone i (F2)
      "5:1", "6:2", "7:1", // Mira i, Ivan ii (F3); Vida i (F4)
    ]);
  });

  it("lists every union as its own ⚭ line, spouses named but not numbered", () => {
    const root = all.find((e) => e.num === 1)!;
    expect(root.facts.map((f) => `${f.tag}${f.spouse ? ":" + f.spouse : ""}`)).toEqual([
      "BIRT", "MARR:Marija Oblak", "MARR:Neza Kovac", "DEAT",
    ]);
    // No spouse ever appears as an entry.
    for (const spouseId of ["@I2@", "@I5@", "@I7@", "@I10@"]) {
      expect(all.some((e) => e.id === spouseId)).toBe(false);
    }
  });

  it("keeps the original number for a child reached through both parents", () => {
    // First cousins Ivan (6) and Vida (7) marry; their daughter appears under
    // both, keeping one register number.
    const cousins = dataset(
      DESCENDANTS
        .replace("2 DATE 1926\n1 DEAT\n2 DATE 1990\n1 FAMC @F3@\n", "2 DATE 1926\n1 DEAT\n2 DATE 1990\n1 FAMC @F3@\n1 FAMS @F5@\n")
        .replace("2 DATE 1931\n1 DEAT\n2 DATE 2010\n1 FAMC @F4@\n", "2 DATE 1931\n1 DEAT\n2 DATE 2010\n1 FAMC @F4@\n1 FAMS @F5@\n")
        .replace(
          "0 TRLR\n",
          "0 @I12@ INDI\n1 NAME Iva /Novak/\n1 SEX F\n1 BIRT\n2 DATE 1955\n1 DEAT\n2 DATE 1999\n1 FAMC @F5@\n" +
            "0 @F5@ FAM\n1 HUSB @I8@\n1 WIFE @I11@\n1 CHIL @I12@\n1 MARR\n2 DATE 1954\n0 TRLR\n",
        ),
    );
    const data = buildDescendants(cousins, "@I1@", nameOf, NOW)!;
    const entries = data.generations.flatMap((g) => g.entries);
    const occurrences = entries.filter((e) => e.id === "@I12@");
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]).toMatchObject({ num: 8, dupOf: undefined });
    expect(occurrences[1]).toMatchObject({ num: 8, dupOf: 8, facts: [] });
    // …and the head-count stays a count of people: the cross-reference entry is
    // the same Iva, so 8 descendants and 9 entries.
    expect(entries).toHaveLength(9);
    expect(data.total).toBe(8);
  });

  it("returns undefined for an unknown root", () => {
    expect(buildDescendants(ds, "@NOPE@", nameOf, NOW)).toBeUndefined();
  });

  it("handles a childless root", () => {
    const solo = dataset(wrap("0 @I1@ INDI\n1 NAME Solo /One/\n1 BIRT\n2 DATE 1950\n"));
    const d = buildDescendants(solo, "@I1@", nameOf, NOW)!;
    expect(d.generations).toHaveLength(1);
    expect(d.total).toBe(1);
  });
});

describe("reportToText (descendants)", () => {
  const ds = dataset(DESCENDANTS);
  const data = buildDescendants(ds, "@I1@", nameOf, NOW)!;

  it("renders register generation headings and both-parent children groups", () => {
    const text = reportToText(tr, data, "descendants", "Janez Novak — Register");
    expect(text).toContain("register.gen.1");
    expect(text).toContain("register.gen.2");
    expect(text).toContain("register.childrenOfBoth"); // both parents known
    expect(text).toContain("2 I. Peter Novak (1896–1960)"); // register no. + roman child index
    expect(text).toContain("     ⚭ 1922 — Eva Zajc");
  });
});

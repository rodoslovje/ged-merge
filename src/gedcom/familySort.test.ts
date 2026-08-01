import { describe, expect, it } from "vitest";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";
import { familiesByMarriage, marriageSortKey } from "./familySort";
import { marriedSurnamesOf } from "../match/relatives";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Ana's FAMS come in file order F1, F2, F3 but the marriages happened in the
// order F3 (children born 1888/1890, no MARR), F2 (⚭ 1895), F1 (⚭ 1902).
// A fourth union F4 has neither a MARR date nor dated children.
const UNIONS = wrap(
  "0 @I1@ INDI\n1 NAME Ana /Zupan/\n1 SEX F\n1 FAMS @F1@\n1 FAMS @F2@\n1 FAMS @F3@\n1 FAMS @F4@\n" +
    "0 @I2@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Franc /Kovac/\n1 SEX M\n1 FAMS @F2@\n" +
    "0 @I4@ INDI\n1 NAME Peter /Oblak/\n1 SEX M\n1 FAMS @F3@\n" +
    "0 @I5@ INDI\n1 NAME Tone /Kos/\n1 SEX M\n1 FAMS @F4@\n" +
    "0 @I6@ INDI\n1 NAME Mira /Oblak/\n1 SEX F\n1 BIRT\n2 DATE 1890\n1 FAMC @F3@\n" +
    "0 @I7@ INDI\n1 NAME Ivan /Oblak/\n1 SEX M\n1 BIRT\n2 DATE 1888\n1 FAMC @F3@\n" +
    "0 @I8@ INDI\n1 NAME Vida /Kos/\n1 SEX F\n1 FAMC @F4@\n" +
    "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I1@\n1 MARR\n2 DATE 1902\n" +
    "0 @F2@ FAM\n1 HUSB @I3@\n1 WIFE @I1@\n1 MARR\n2 DATE 1895\n" +
    "0 @F3@ FAM\n1 HUSB @I4@\n1 WIFE @I1@\n1 CHIL @I7@\n1 CHIL @I6@\n" +
    "0 @F4@ FAM\n1 HUSB @I5@\n1 WIFE @I1@\n1 CHIL @I8@\n",
);

describe("familiesByMarriage", () => {
  const ds = dataset(UNIONS);
  const ana = ds.individuals.get("@I1@")!;

  it("orders unions by MARR date, estimating undated ones from children's births", () => {
    expect(familiesByMarriage(ds, ana.spouseOf).map((f) => f.id)).toEqual([
      "@F3@", // earliest child born 1888
      "@F2@", // ⚭ 1895
      "@F1@", // ⚭ 1902
      "@F4@", // nothing dated → keeps file order at the end
    ]);
  });

  it("keys a dated marriage by its date, an undated one by its earliest child", () => {
    expect(marriageSortKey(ds.families.get("@F2@")!, ds)).toBe(1895_9000);
    expect(marriageSortKey(ds.families.get("@F3@")!, ds)).toBe(1888_0000);
    expect(marriageSortKey(ds.families.get("@F4@")!, ds)).toBe(Infinity);
  });

  it("drops dangling family refs", () => {
    expect(familiesByMarriage(ds, ["@F9@", "@F1@"]).map((f) => f.id)).toEqual(["@F1@"]);
  });
});

describe("marriedSurnamesOf", () => {
  it("collects the inline _MARNM and every TYPE married record, deduplicated", () => {
    const ds = dataset(
      wrap(
        "0 @I1@ INDI\n1 NAME Ana /Zupan/\n2 _MARNM Novak\n1 NAME Ana /Kovac/\n2 TYPE married\n1 NAME Ana /novak/\n2 TYPE married\n",
      ),
    );
    expect(marriedSurnamesOf(ds.individuals.get("@I1@")!)).toEqual(["Novak", "Kovac"]);
  });

  it("orders multiple married surnames like the person's unions", () => {
    const ds = dataset(UNIONS);
    const ana = ds.individuals.get("@I1@")!;
    // Record order says Novak (F1, ⚭ 1902) before Oblak (F3, children 1888) —
    // union order must flip them and leave the unmatched name last.
    ana.names.push(
      { full: "Ana Novak", surname: "Novak", type: "married" },
      { full: "Ana Vidmar", surname: "Vidmar", type: "married" },
      { full: "Ana Oblak", surname: "Oblak", type: "married" },
    );
    expect(marriedSurnamesOf(ana, ds)).toEqual(["Oblak", "Novak", "Vidmar"]);
  });
});

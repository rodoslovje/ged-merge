import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { widerFamily, type WiderFamilyDepth } from "./widerFamily";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const indi = (id: string, name: string, sex: string, born: number, links: string) =>
  `0 @${id}@ INDI\n1 NAME ${name}\n1 SEX ${sex}\n1 BIRT\n2 DATE ${born}\n${links}`;

// R (Rok) is the root. Father F × mother M (F0). F's parents GF × GM (F1),
// GF's father GGF (F2). F's brother U married UW (F3), son C — R's first
// cousin. M's sister A (child of MGF, F4). R's sister S has a son N (F5).
// R married P (F6): son K, whose son GK (F7) has a son GGK (F8).
const TREE = "0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n" +
  indi("R", "Rok /Novak/", "M", 1900, "1 FAMC @F0@\n1 FAMS @F6@\n") +
  indi("F", "Franc /Novak/", "M", 1870, "1 FAMC @F1@\n1 FAMS @F0@\n") +
  indi("M", "Mojca /Kos/", "F", 1875, "1 FAMC @F4@\n1 FAMS @F0@\n") +
  indi("S", "Sara /Novak/", "F", 1902, "1 FAMC @F0@\n1 FAMS @F5@\n") +
  indi("N", "Nik /Zupan/", "M", 1925, "1 FAMC @F5@\n") +
  indi("GF", "Gregor /Novak/", "M", 1840, "1 FAMC @F2@\n1 FAMS @F1@\n") +
  indi("GM", "Gala /Novak/", "F", 1845, "1 FAMS @F1@\n") +
  indi("GGF", "Gal /Novak/", "M", 1810, "1 FAMS @F2@\n") +
  indi("U", "Urban /Novak/", "M", 1872, "1 FAMC @F1@\n1 FAMS @F3@\n") +
  indi("UW", "Urša /Lah/", "F", 1874, "1 FAMS @F3@\n") +
  indi("C", "Cene /Novak/", "M", 1898, "1 FAMC @F3@\n") +
  indi("MGF", "Marko /Kos/", "M", 1845, "1 FAMS @F4@\n") +
  indi("A", "Ana /Kos/", "F", 1878, "1 FAMC @F4@\n") +
  indi("P", "Pia /Rus/", "F", 1903, "1 FAMS @F6@\n") +
  indi("K", "Klemen /Novak/", "M", 1925, "1 FAMC @F6@\n1 FAMS @F7@\n") +
  indi("GK", "Gašper /Novak/", "M", 1950, "1 FAMC @F7@\n1 FAMS @F8@\n") +
  indi("GGK", "Gorazd /Novak/", "M", 1975, "1 FAMC @F8@\n") +
  "0 @F0@ FAM\n1 HUSB @F@\n1 WIFE @M@\n1 CHIL @R@\n1 CHIL @S@\n" +
  "0 @F1@ FAM\n1 HUSB @GF@\n1 WIFE @GM@\n1 CHIL @F@\n1 CHIL @U@\n" +
  "0 @F2@ FAM\n1 HUSB @GGF@\n1 CHIL @GF@\n" +
  "0 @F3@ FAM\n1 HUSB @U@\n1 WIFE @UW@\n1 CHIL @C@\n" +
  "0 @F4@ FAM\n1 HUSB @MGF@\n1 CHIL @M@\n1 CHIL @A@\n" +
  "0 @F5@ FAM\n1 WIFE @S@\n1 CHIL @N@\n" +
  "0 @F6@ FAM\n1 HUSB @R@\n1 WIFE @P@\n1 CHIL @K@\n" +
  "0 @F7@ FAM\n1 HUSB @K@\n1 CHIL @GK@\n" +
  "0 @F8@ FAM\n1 HUSB @GK@\n1 CHIL @GGK@\n" +
  "0 TRLR\n";

const ds = dataset(TREE);
const at = (d: Partial<WiderFamilyDepth>) =>
  widerFamily(ds, "@R@", { ancestors: 2, descendants: 1, others: 1, partners: false, ...d });
/** Each group as "up:down" → its members' ids, without the @s. */
const shape = (d: Partial<WiderFamilyDepth>) =>
  Object.fromEntries(at(d).map((g) => [`${g.up}:${g.down}`, g.members.map((m) => m.id.replace(/@/g, ""))]));

describe("widerFamily", () => {
  it("shows grandparents and uncles/aunts at the defaults, nearest first", () => {
    expect(at({}).map((g) => `${g.up}:${g.down}`)).toEqual(["2:0", "2:1"]);
    expect(shape({})).toEqual({ "2:0": ["GF", "GM", "MGF"], "2:1": ["U", "A"] });
  });

  it("leaves out everyone the Edit cards already show", () => {
    const ids = at({ ancestors: 4, descendants: 3, others: 3 }).flatMap((g) => g.members.map((m) => m.id));
    for (const onCard of ["@R@", "@F@", "@M@", "@S@", "@K@", "@P@"]) expect(ids).not.toContain(onCard);
  });

  it("tags each relative with the parent's line they are on", () => {
    const uncles = at({}).find((g) => g.up === 2 && g.down === 1)!.members;
    expect(uncles.map((m) => m.side)).toEqual(["father", "mother"]);
  });

  it("follows other relatives down as far as asked: cousins and nephews at 2", () => {
    expect(shape({ others: 2 })).toMatchObject({ "2:2": ["C"], "1:2": ["N"] });
    expect(at({ others: 2 }).find((g) => g.up === 1)!.members[0].side).toBe("own");
    expect(shape({ others: 0 })).toEqual({ "2:0": ["GF", "GM", "MGF"] });
  });

  it("goes up and down by the ancestor and descendant depths", () => {
    expect(shape({ ancestors: 3 })).toMatchObject({ "3:0": ["GGF"] });
    expect(shape({ descendants: 3 })).toMatchObject({ "0:2": ["GK"], "0:3": ["GGK"] });
    expect(shape({ ancestors: 1, descendants: 1 })).toEqual({});
  });

  it("orders groups by blood distance, elders first", () => {
    const order = at({ ancestors: 3, descendants: 3, others: 2 }).map((g) => `${g.up}:${g.down}`);
    expect(order).toEqual(["2:0", "0:2", "3:0", "2:1", "1:2", "0:3", "2:2"]);
  });

  it("lists a relative's partner beside them when asked", () => {
    const uncles = at({ partners: true }).find((g) => g.up === 2 && g.down === 1)!.members;
    expect(uncles.map((m) => [m.id, m.partnerOf])).toEqual([["@U@", undefined], ["@UW@", "@U@"], ["@A@", undefined]]);
  });

  it("returns nothing for an unknown person", () => {
    expect(widerFamily(ds, "@X@", { ancestors: 4, descendants: 3, others: 3, partners: true })).toEqual([]);
  });
});

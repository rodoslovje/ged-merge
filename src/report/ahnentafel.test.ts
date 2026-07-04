import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { displayName, primaryName } from "../match/relatives";
import type { Individual } from "../gedcom/types";
import { buildAhnentafel, type AhnEntry } from "./ahnentafel";
import { ahnentafelToText } from "./text";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** Identity translator: tests assert on keys, not localized labels. */
const tr = (key: string) => key;
const nameOf = (indi: Individual) => displayName(primaryName(indi));

const wrap = (body: string) => `0 HEAD\n1 GEDC\n2 VERS 5.5.1\n1 CHAR UTF-8\n${body}0 TRLR\n`;

// Root Janez (1900–1970) with three known generations above: parents Anton ⚭
// Marija (1895), paternal grandparents Jožef ⚭ Ana (1865, Kranj), and only a
// great-grandfather (Franc, father of Jožef) plus a maternal grandmother
// (Neža, mother of Marija — her husband is unrecorded, so the 1870 marriage
// date must move to her entry). Anton has baptism and burial records too.
const ANCESTORS = wrap(
  "0 @I1@ INDI\n1 NAME Janez /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1900\n2 PLAC Kranj\n1 DEAT\n2 DATE 1970\n1 FAMC @F1@\n" +
    "0 @I2@ INDI\n1 NAME Anton /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 BAPM\n2 DATE 15 MAR 1870\n2 PLAC Kranj\n" +
    "1 DEAT\n2 DATE 1940\n1 BURI\n2 DATE 3 JAN 1940\n1 FAMC @F2@\n1 FAMS @F1@\n" +
    "0 @I3@ INDI\n1 NAME Marija /Oblak/\n1 SEX F\n1 BIRT\n2 DATE 1872\n1 FAMC @F3@\n1 FAMS @F1@\n" +
    "0 @I4@ INDI\n1 NAME Jozef /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1840\n1 FAMC @F4@\n1 FAMS @F2@\n" +
    "0 @I5@ INDI\n1 NAME Ana /Zajc/\n1 SEX F\n1 BIRT\n2 DATE 1845\n1 FAMS @F2@\n" +
    "0 @I6@ INDI\n1 NAME Neza /Kovac/\n1 SEX F\n1 BIRT\n2 DATE 1850\n1 FAMS @F3@\n" +
    "0 @I7@ INDI\n1 NAME Franc /Novak/\n1 SEX M\n1 BIRT\n2 DATE 1815\n1 FAMS @F4@\n" +
    "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n1 MARR\n2 DATE 1895\n" +
    "0 @F2@ FAM\n1 HUSB @I4@\n1 WIFE @I5@\n1 CHIL @I2@\n1 MARR\n2 DATE 1865\n2 PLAC Kranj\n" +
    "0 @F3@ FAM\n1 WIFE @I6@\n1 CHIL @I3@\n1 MARR\n2 DATE 1870\n" +
    "0 @F4@ FAM\n1 HUSB @I7@\n1 CHIL @I4@\n",
);

// A fixed "today" so the living window is reproducible.
const NOW = 2000;

function entry(entries: AhnEntry[], num: number): AhnEntry {
  const e = entries.find((x) => x.num === num);
  expect(e, `entry ${num}`).toBeDefined();
  return e!;
}

function flat(dsText: string, rootId: string): AhnEntry[] {
  const data = buildAhnentafel(dataset(dsText), rootId, nameOf, NOW);
  expect(data).toBeDefined();
  return data!.generations.flatMap((g) => g.entries);
}

describe("buildAhnentafel", () => {
  const ds = dataset(ANCESTORS);
  const data = buildAhnentafel(ds, "@I1@", nameOf, NOW)!;
  const all = data.generations.flatMap((g) => g.entries);

  it("numbers ancestors 2n / 2n+1, leaving gaps for missing parents", () => {
    expect(all.map((e) => `${e.num}:${e.id}`)).toEqual([
      "1:@I1@",
      "2:@I2@", "3:@I3@",
      "4:@I4@", "5:@I5@", "7:@I6@", // 6 missing: Marija's father is unrecorded
      "8:@I7@", // Franc, father of no. 4
    ]);
  });

  it("groups entries by generation", () => {
    expect(data.generations.map((g) => [g.gen, g.entries.map((e) => e.num)])).toEqual([
      [0, [1]],
      [1, [2, 3]],
      [2, [4, 5, 7]],
      [3, [8]],
    ]);
    expect(data.total).toBe(7);
  });

  it("builds the root's vitals as glyph fact lines", () => {
    const root = entry(all, 1);
    expect(root.years).toBe("1900–1970");
    expect(root.facts).toEqual([
      { tag: "BIRT", glyph: "*", date: "1900", place: "Kranj" },
      { tag: "DEAT", glyph: "†", date: "1970", place: undefined },
    ]);
  });

  it("adds baptism and burial as their own lines when recorded", () => {
    const anton = entry(all, 2);
    expect(anton.facts.map((f) => f.tag)).toEqual(["BIRT", "BAPM", "MARR", "DEAT", "BURI"]);
    expect(anton.facts[1]).toMatchObject({ glyph: "~", date: "15 MAR 1870", place: "Kranj" });
    expect(anton.facts[4]).toMatchObject({ glyph: "▭", date: "3 JAN 1940" });
  });

  it("puts the union's ⚭ on the father's entry, naming the mother", () => {
    const anton = entry(all, 2);
    expect(anton.facts.find((f) => f.tag === "MARR")).toEqual({
      tag: "MARR", glyph: "⚭", date: "1895", place: undefined, spouse: "Marija Oblak",
    });
    // The mother herself carries no ⚭ line — it lives on entry 2.
    expect(entry(all, 3).facts.some((f) => f.tag === "MARR")).toBe(false);
  });

  it("moves the ⚭ to the mother when the father is unrecorded", () => {
    const neza = entry(all, 7);
    expect(neza.facts.find((f) => f.tag === "MARR")).toMatchObject({ date: "1870", spouse: undefined });
  });

  it("drops a ⚭ line when the family has no dated or placed MARR", () => {
    // Franc's family @F4@ has no MARR at all.
    expect(entry(all, 8).facts.some((f) => f.tag === "MARR")).toBe(false);
  });

  it("marks pedigree collapse with dupOf and stops expanding there", () => {
    // The same man is recorded as both grandfathers (father of both parents).
    const collapsed = wrap(
      "0 @I1@ INDI\n1 NAME Root /X/\n1 SEX M\n1 FAMC @F1@\n" +
        "0 @I2@ INDI\n1 NAME Father /X/\n1 SEX M\n1 FAMC @F2@\n1 FAMS @F1@\n" +
        "0 @I3@ INDI\n1 NAME Mother /Y/\n1 SEX F\n1 FAMC @F3@\n1 FAMS @F1@\n" +
        "0 @I4@ INDI\n1 NAME Shared /Z/\n1 SEX M\n1 BIRT\n2 DATE 1840\n1 FAMS @F2@\n1 FAMS @F3@\n1 FAMC @F4@\n" +
        "0 @I5@ INDI\n1 NAME Deep /Z/\n1 SEX M\n1 FAMS @F4@\n" +
        "0 @F1@ FAM\n1 HUSB @I2@\n1 WIFE @I3@\n1 CHIL @I1@\n" +
        "0 @F2@ FAM\n1 HUSB @I4@\n1 CHIL @I2@\n" +
        "0 @F3@ FAM\n1 HUSB @I4@\n1 CHIL @I3@\n" +
        "0 @F4@ FAM\n1 HUSB @I5@\n1 CHIL @I4@\n",
    );
    const entries = flat(collapsed, "@I1@");
    const first = entry(entries, 4);
    const dup = entry(entries, 6);
    expect(first.dupOf).toBeUndefined();
    expect(dup).toMatchObject({ id: "@I4@", dupOf: 4, facts: [] });
    // The shared man's own father appears once, continuing from the first number.
    expect(entries.filter((e) => e.id === "@I5@").map((e) => e.num)).toEqual([8]);
  });

  it("flags presumed-living people inside the 100-year window", () => {
    const recent = wrap(
      "0 @I1@ INDI\n1 NAME Young /X/\n1 BIRT\n2 DATE 1950\n1 FAMC @F1@\n" +
        "0 @I2@ INDI\n1 NAME Old /X/\n1 SEX M\n1 BIRT\n2 DATE 1870\n1 FAMS @F1@\n" +
        "0 @F1@ FAM\n1 HUSB @I2@\n1 CHIL @I1@\n",
    );
    const entries = flat(recent, "@I1@");
    expect(entry(entries, 1).living).toBe(true); // born 1950, NOW 2000
    expect(entry(entries, 2).living).toBe(false); // born 1870 — outside the window
  });

  it("returns undefined for an unknown root", () => {
    expect(buildAhnentafel(ds, "@NOPE@", nameOf, NOW)).toBeUndefined();
  });

  it("handles a root with no recorded parents", () => {
    const solo = dataset(wrap("0 @I1@ INDI\n1 NAME Solo /One/\n1 BIRT\n2 DATE 1950\n"));
    const d = buildAhnentafel(solo, "@I1@", nameOf, NOW)!;
    expect(d.generations).toHaveLength(1);
    expect(d.total).toBe(1);
  });
});

describe("ahnentafelToText", () => {
  const ds = dataset(ANCESTORS);
  const data = buildAhnentafel(ds, "@I1@", nameOf, NOW)!;

  it("renders the title, generation headings and indented fact lines", () => {
    const text = ahnentafelToText(tr, data, "Janez Novak — Ahnentafel");
    expect(text).toContain("Janez Novak — Ahnentafel\n========================");
    expect(text).toContain("ahnentafel.gen.0\n\n1. Janez Novak (1900–1970)\n   * 1900, Kranj\n   † 1970");
    expect(text).toContain("2. Anton Novak (1870–1940)");
    expect(text).toContain("   ⚭ 1895 — Marija Oblak");
    expect(text).toContain("ahnentafel.gen.3"); // Franc's generation heading
  });

  it("redacts presumed-living entries to number + name when asked", () => {
    const recent = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Young /X/\n1 BIRT\n2 DATE 1950\n2 PLAC Kranj\n",
    ));
    const d = buildAhnentafel(recent, "@I1@", nameOf, NOW)!;
    const text = ahnentafelToText(tr, d, "T", { privacyLiving: true });
    expect(text).toContain("1. Young X");
    expect(text).not.toContain("1950");
    expect(text).not.toContain("Kranj");
  });
});

import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { displayName, primaryName } from "../match/relatives";
import type { Individual } from "../gedcom/types";
import { buildAhnentafel } from "./ahnentafel";
import { generationHeading, sourceLine, type ReportEntry } from "./model";
import { reportToText } from "./text";

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

function entry(entries: ReportEntry[], num: number): ReportEntry {
  const e = entries.find((x) => x.num === num);
  expect(e, `entry ${num}`).toBeDefined();
  return e!;
}

function flat(dsText: string, rootId: string): ReportEntry[] {
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
    expect(root.facts).toMatchObject([
      { tag: "BIRT", glyph: "*", date: "1900", place: "Kranj" },
      { tag: "DEAT", glyph: "†", date: "1970", place: undefined },
    ]);
    // The structured date rides along for the narrative renderer.
    expect(root.facts[0].parsed).toMatchObject({ year: 1900, qualifier: "exact" });
  });

  it("adds baptism and burial as their own lines when recorded", () => {
    const anton = entry(all, 2);
    expect(anton.facts.map((f) => f.tag)).toEqual(["BIRT", "BAPM", "MARR", "DEAT", "BURI"]);
    expect(anton.facts[1]).toMatchObject({ glyph: "~", date: "15 MAR 1870", place: "Kranj" });
    expect(anton.facts[4]).toMatchObject({ glyph: "▭", date: "3 JAN 1940" });
  });

  it("puts the union's ⚭ on the father's entry, naming the mother", () => {
    const anton = entry(all, 2);
    expect(anton.facts.find((f) => f.tag === "MARR")).toMatchObject({
      tag: "MARR", glyph: "⚭", date: "1895", place: undefined, spouse: "Marija Oblak", fam: "@F1@",
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
    const data = buildAhnentafel(dataset(collapsed), "@I1@", nameOf, NOW)!;
    const entries = data.generations.flatMap((g) => g.entries);
    const first = entry(entries, 4);
    const dup = entry(entries, 6);
    expect(first.dupOf).toBeUndefined();
    expect(dup).toMatchObject({ id: "@I4@", dupOf: 4, facts: [] });
    // The shared man's own father appears once, continuing from the first number.
    expect(entries.filter((e) => e.id === "@I5@").map((e) => e.num)).toEqual([8]);
    // The head-count is people, not slots: the shared ancestor fills two slots.
    expect(entries).toHaveLength(6);
    expect(data.total).toBe(5);
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

  it("keeps the complete address and place hierarchy, unstripped", () => {
    const addressed = wrap(
      "0 @I1@ INDI\n1 NAME Solo /One/\n1 BIRT\n2 DATE 1900\n2 PLAC Kranj, Slovenija\n2 ADDR Dunajska 5\n" +
        "1 DEAT\n2 DATE 1970\n2 ADDR Glavni trg 1\n",
    );
    const entries = flat(addressed, "@I1@");
    expect(entry(entries, 1).facts).toMatchObject([
      { tag: "BIRT", glyph: "*", date: "1900", place: "Dunajska 5, Kranj, Slovenija" },
      { tag: "DEAT", glyph: "†", date: "1970", place: "Glavni trg 1" },
    ]);
  });

  it("adds optional ⚒/✎/⌂ occupation, education and residence lines between ⚭ and †", () => {
    const busy = wrap(
      "0 @I1@ INDI\n1 NAME Solo /One/\n1 BIRT\n2 DATE 1900\n1 DEAT\n2 DATE 1980\n" +
        "1 OCCU Farmer\n2 DATE 1930\n1 EDUC Gimnazija\n2 DATE 1918\n1 OCCU Miller\n" +
        "1 RESI\n2 DATE 1950\n2 PLAC Kranj\n2 ADDR Dunajska 5\n1 RESI\n", // the undated, placeless RESI is dropped
    );
    const ds2 = dataset(busy);
    // Off by default; each kind has its own toggle.
    expect(buildAhnentafel(ds2, "@I1@", nameOf, NOW)!.generations[0].entries[0].facts.map((f) => f.tag))
      .toEqual(["BIRT", "DEAT"]);
    expect(
      buildAhnentafel(ds2, "@I1@", nameOf, NOW, { education: true })!
        .generations[0].entries[0].facts.map((f) => f.tag),
    ).toEqual(["BIRT", "EDUC", "DEAT"]);
    const on = buildAhnentafel(ds2, "@I1@", nameOf, NOW, { occupation: true, education: true, residence: true })!;
    expect(on.generations[0].entries[0].facts).toMatchObject([
      { tag: "BIRT", glyph: "*", date: "1900", place: undefined },
      { tag: "OCCU", glyph: "⚒", value: "Farmer", date: "1930", place: undefined },
      { tag: "OCCU", glyph: "⚒", value: "Miller", date: undefined, place: undefined },
      { tag: "EDUC", glyph: "✎", value: "Gimnazija", date: "1918", place: undefined },
      { tag: "RESI", glyph: "⌂", date: "1950", place: "Dunajska 5, Kranj" },
      { tag: "DEAT", glyph: "†", date: "1980", place: undefined },
    ]);
    // The rendered line leads with the date, the value follows.
    const text = reportToText(tr, on, "ancestors", "T");
    expect(text).toContain("⚒ 1930, Farmer");
    expect(text).toContain("✎ 1918, Gimnazija");
  });

  it("carries person and event notes when the notes option is on", () => {
    const noted = wrap(
      "0 @I1@ INDI\n1 NAME Solo /One/\n1 NOTE Emigrated twice.\n" +
        "1 BIRT\n2 DATE 1900\n2 NOTE Born at home.\n1 DEAT\n2 DATE 1980\n",
    );
    const ds2 = dataset(noted);
    // Off by default.
    const off = buildAhnentafel(ds2, "@I1@", nameOf, NOW)!.generations[0].entries[0];
    expect(off.notes).toBeUndefined();
    expect(off.facts[0].note).toBeUndefined();
    const on = buildAhnentafel(ds2, "@I1@", nameOf, NOW, { notes: true })!.generations[0].entries[0];
    expect(on.notes).toEqual(["Emigrated twice."]);
    expect(on.facts[0].note).toBe("Born at home.");
    // Text: fact lines first (event note indented under its fact), then the
    // person note after the facts.
    const text = reportToText(tr, buildAhnentafel(ds2, "@I1@", nameOf, NOW, { notes: true })!, "ancestors", "T");
    expect(text).toContain("1. Solo One (1900–1980)\n   * 1900\n     Born at home.\n   † 1980\n   Emigrated twice.");
  });

  it("keeps URLs listed in notes in the report", () => {
    const linked = wrap(
      "0 @I1@ INDI\n1 NAME Solo /One/\n1 NOTE Zapis: https://data.matricula-online.eu/sl/test/?pg=1\n" +
        "1 BIRT\n2 DATE 1900\n2 NOTE https://example.com/birth-record\n1 DEAT\n2 DATE 1980\n",
    );
    const ds2 = dataset(linked);
    const on = buildAhnentafel(ds2, "@I1@", nameOf, NOW, { notes: true })!.generations[0].entries[0];
    expect(on.notes).toEqual(["Zapis: https://data.matricula-online.eu/sl/test/?pg=1"]);
    expect(on.facts[0].note).toBe("https://example.com/birth-record");
  });

  it("carries person and event source citations when the sources option is on", () => {
    const sourced = wrap(
      "0 @I1@ INDI\n1 NAME Solo /One/\n1 SOUR @S1@\n" +
        "1 BIRT\n2 DATE 1900\n2 SOUR @S1@\n3 PAGE fol. 12\n" +
        "0 @S1@ SOUR\n1 TITL Krstna knjiga Kranj\n",
    );
    const ds2 = dataset(sourced);
    const off = buildAhnentafel(ds2, "@I1@", nameOf, NOW)!.generations[0].entries[0];
    expect(off.sources).toBeUndefined();
    expect(off.facts[0].sources).toBeUndefined();
    const on = buildAhnentafel(ds2, "@I1@", nameOf, NOW, { sources: true })!.generations[0].entries[0];
    expect(on.sources).toEqual([{ text: "§ Krstna knjiga Kranj", page: undefined, url: undefined }]);
    expect(on.facts[0].sources).toEqual([{ text: "§ Krstna knjiga Kranj", page: "fol. 12", url: undefined }]);
  });

  it("formats a resolved citation link into the source line, page kept apart", () => {
    expect(
      sourceLine({ sourceId: "@S1@", title: "Krstna knjiga", page: "fol. 12", url: "https://x.si/p/12", exact: true }),
    ).toEqual({ text: "§ Krstna knjiga", page: "fol. 12", url: "https://x.si/p/12" });
  });

  it("composes generation band headings with the entries' number range", () => {
    // A translator that shows its interpolation values, so ranges are visible.
    const tri = (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}(${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(",")})` : key;
    expect(generationHeading(tri, data.generations[0], "ancestors")).toEqual({
      title: "report.gen.root",
    });
    expect(generationHeading(tri, data.generations[2], "ancestors")).toEqual({
      title: "report.gen.n(n=2) — ahnentafel.gen.2",
      range: "report.gen.nos(from=4,to=7)",
      coverage: "report.gen.known(known=3,of=4)", // no. 6 is unrecorded
    });
    expect(generationHeading(tri, data.generations[3], "ancestors")).toEqual({
      title: "report.gen.n(n=3) — ahnentafel.gen.3",
      range: "report.gen.no(n=8)", // a single-entry generation
      coverage: "report.gen.known(known=1,of=8)",
    });
    // Descendant generations are open-ended — no slot coverage.
    expect(generationHeading(tri, data.generations[1], "descendants").coverage).toBeUndefined();
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

describe("reportToText (ancestors)", () => {
  const ds = dataset(ANCESTORS);
  const data = buildAhnentafel(ds, "@I1@", nameOf, NOW)!;

  it("renders the title, generation headings and indented fact lines", () => {
    const text = reportToText(tr, data, "ancestors", "Janez Novak — Ahnentafel");
    expect(text).toContain("Janez Novak — Ahnentafel\n========================");
    expect(text).toContain("report.gen.root\n\n1. Janez Novak (1900–1970)\n   * 1900, Kranj\n   † 1970");
    expect(text).toContain("2. Anton Novak (1870–1940)");
    expect(text).toContain("   ⚭ 1895 — Marija Oblak");
    expect(text).toContain("ahnentafel.gen.3"); // Franc's generation heading
  });

  it("redacts presumed-living entries to number + name when asked", () => {
    const recent = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Young /X/\n1 BIRT\n2 DATE 1950\n2 PLAC Kranj\n",
    ));
    const d = buildAhnentafel(recent, "@I1@", nameOf, NOW)!;
    const text = reportToText(tr, d, "ancestors", "T", { privacyLiving: true });
    expect(text).toContain("1. Young X");
    expect(text).not.toContain("1950");
    expect(text).not.toContain("Kranj");
  });

  it("replaces a redacted living name with the injected kinship label", () => {
    const recent = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Young /X/\n1 SEX F\n1 BIRT\n2 DATE 1950\n",
    ));
    const d = buildAhnentafel(recent, "@I1@", nameOf, NOW)!;
    const text = reportToText(tr, d, "ancestors", "T", {
      privacyLiving: true,
      livingNameOf: (p) => `kinship-of-${p.id}-${p.sex}`,
    });
    expect(text).toContain("1. kinship-of-@I1@-F");
    expect(text).not.toContain("Young X");
  });

  it("orders an entry body: facts, then person notes, then person sources", () => {
    const full = dataset(wrap(
      "0 @I1@ INDI\n1 NAME Solo /One/\n1 NOTE A person note.\n1 SOUR @S1@\n" +
        "1 BIRT\n2 DATE 1900\n1 DEAT\n2 DATE 1980\n0 @S1@ SOUR\n1 TITL Krstna knjiga\n",
    ));
    const d = buildAhnentafel(full, "@I1@", nameOf, NOW, { notes: true, sources: true })!;
    const text = reportToText(tr, d, "ancestors", "T");
    expect(text).toContain("1. Solo One (1900–1980)\n   * 1900\n   † 1980\n   A person note.\n   § Krstna knjiga");
  });

  it("leads with the table of contents when asked, one row per generation", () => {
    const text = reportToText(tr, data, "ancestors", "T", { toc: true });
    expect(text).toContain(
      "report.toc\n  report.gen.root\n  report.gen.n — ahnentafel.gen.1 · report.gen.nos",
    );
    // Off by default.
    expect(reportToText(tr, data, "ancestors", "T")).not.toContain("report.toc");
  });
});

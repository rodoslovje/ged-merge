import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildStatsFacts } from "./facts";
import { applyCountry, DEFAULT_SCOPE, scopeFacts } from "./scope";
import { lineageStats, relatedCouples } from "./lineage";
import { migrationStats } from "./migration";
import { researchStats } from "./research";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** Adam (I1) and Eva (I2, who died in New York) have Jože (I3) and Ana (I4).
 *  Jože's son Tone (I5) marries Ana's daughter Neža (I6), his cousin, and they
 *  have Luka (I9) — whose great-grandparents Adam and Eva hold two places each. */
const FILE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Adam /Novak/
1 SEX M
1 BIRT
2 DATE 1800
2 PLAC Ljubljana, Slovenija
3 MAP
4 LATI N46.05
4 LONG E14.5
2 SOUR @S1@
1 DEAT
2 DATE 1870
2 PLAC Ljubljana, Slovenija
1 FAMS @F1@
0 @I2@ INDI
1 NAME Eva /Kos/
1 SEX F
1 BIRT
2 DATE 1805
2 PLAC Kranj, Slovenija
3 MAP
4 LATI N46.24
4 LONG E14.36
1 DEAT
2 DATE 1880
2 PLAC New York, USA
3 MAP
4 LATI N40.71
4 LONG W74.0
1 FAMS @F1@
0 @I3@ INDI
1 NAME Jože /Novak/
1 SEX M
1 BIRT
2 PLAC Ljubljana, Slovenija
1 FAMC @F1@
1 FAMS @F2@
0 @I4@ INDI
1 NAME Ana /Novak/
1 SEX F
1 BIRT
2 PLAC Ljubljana, Slovenija
1 FAMC @F1@
1 FAMS @F3@
0 @I5@ INDI
1 NAME Tone /Novak/
1 SEX M
1 FAMC @F2@
1 FAMS @F4@
0 @I6@ INDI
1 NAME Neža /Zupan/
1 SEX F
1 FAMC @F3@
1 FAMS @F4@
0 @I7@ INDI
1 NAME Marija /Kralj/
1 SEX F
1 FAMS @F2@
0 @I8@ INDI
1 NAME Jakob /Zupan/
1 SEX M
1 FAMS @F3@
0 @I9@ INDI
1 NAME Luka /Novak/
1 SEX M
1 FAMC @F4@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
1 MARR
2 DATE 1825
2 SOUR @S1@
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I7@
1 CHIL @I5@
0 @F3@ FAM
1 HUSB @I8@
1 WIFE @I4@
1 CHIL @I6@
0 @F4@ FAM
1 HUSB @I5@
1 WIFE @I6@
1 CHIL @I9@
0 @S1@ SOUR
1 TITL Matična knjiga
0 TRLR
`;

const facts = buildStatsFacts(dataset(FILE), "si", 2026);
const all = applyCountry(facts, scopeFacts(facts, DEFAULT_SCOPE, null, undefined), DEFAULT_SCOPE);

describe("lineageStats", () => {
  it("fills ancestor generations, counts pedigree collapse and descendants once", () => {
    const l = lineageStats(facts, "@I9@");
    expect(l.ancestors.map((g) => [g.gen, g.filled, g.slots])).toEqual([[1, 2, 2], [2, 4, 4], [3, 4, 8]]);
    expect(l.ancestors[2].ids.sort()).toEqual(["@I1@", "@I2@"]);
    // Tone (I5) opens the father's side, Neža (I6) the mother's: Adam and Eva stand on both.
    expect(l.ancestors.map((g) => [g.paternal.filled, g.maternal.filled])).toEqual([[1, 1], [2, 2], [2, 2]]);
    expect(l.ancestors[2].paternal.ids.sort()).toEqual(["@I1@", "@I2@"]);
    expect(l.distinctAncestors).toBe(8);
    expect(l.implex).toBeCloseTo(0.2);
    expect(l.repeated).toEqual([{ id: "@I1@", count: 2 }, { id: "@I2@", count: 2 }]);
    expect(l.livingAncestors).not.toContain("@I1@");
    expect(l.livingAncestors).not.toContain("@I2@");
    // Each ancestor counts once: Adam and Eva had two children, everyone else one.
    expect(l.ancestors.map((g) => g.childrenMean)).toEqual([1, 1, 2]);
    // Lines end at Marija and Jakob, then at Adam and Eva — each listed once.
    expect(l.walls.map((w) => [w.id, w.gen])).toEqual([["@I7@", 3], ["@I8@", 3], ["@I1@", 4], ["@I2@", 4]]);

    const d = lineageStats(facts, "@I1@");
    expect(d.descendants.map((g) => g.ids.length)).toEqual([2, 2, 1]);
    expect(d.descendantIds).toHaveLength(5);
  });
});

describe("relatedCouples", () => {
  it("finds the cousins who married, through their nearest common ancestor", () => {
    const r = relatedCouples(facts.byId, facts.families);
    expect(r.of).toBe(4);
    expect(r.byKind.cousin1).toEqual(["@F4@"]);
    expect(r.byKind.siblings).toEqual([]);
    expect(r.byKind.other).toEqual([]);
  });
});

describe("migrationStats", () => {
  it("measures birth-to-death moves and moves between countries", () => {
    const m = migrationStats(all);
    expect(m.distance.find((b) => b.key === "0")?.ids).toEqual(["@I1@"]);
    expect(m.distance.find((b) => b.key === "1000")?.ids).toEqual(["@I2@"]);
    expect(m.countryMoves).toEqual([{ key: "si>us", count: 1, ids: ["@I2@"] }]);
    expect(m.emigrants).toMatchObject({ n: 1, of: 2 });
    // Jože and Marija: Marija's birth place is unknown, so only Adam and Eva are compared.
    expect(m.samePlaceCouples).toMatchObject({ n: 0, of: 1 });
  });
});

describe("researchStats", () => {
  it("counts sourced events per type and citations per person", () => {
    const r = researchStats(all);
    const birth = r.byTag.find((t) => t.tag === "BIRT")!;
    expect(birth).toMatchObject({ events: 4, sourced: 1, families: false });
    expect(birth.missing).toEqual(["@I2@", "@I3@", "@I4@"]);
    expect(r.byTag.find((t) => t.tag === "MARR")).toMatchObject({ events: 1, sourced: 1, families: true });
    expect(r.citations.find((b) => b.key === "1")?.ids).toEqual(["@I1@"]);
    expect(r.noEvents).toEqual(["@I5@", "@I6@", "@I7@", "@I8@", "@I9@"]);
  });

  it("counts a family's residence apart from a person's", () => {
    const ds = dataset(`0 HEAD
0 @I1@ INDI
1 RESI
2 PLAC Kranj
2 SOUR @S1@
1 FAMS @F1@
0 @F1@ FAM
1 HUSB @I1@
1 RESI
2 PLAC Ljubljana
0 @S1@ SOUR
1 TITL Register
0 TRLR`);
    const f = buildStatsFacts(ds);
    const r = researchStats(applyCountry(f, scopeFacts(f, DEFAULT_SCOPE, null, undefined), DEFAULT_SCOPE));
    const resi = r.byTag.filter((t) => t.tag === "RESI");
    expect(resi.map((t) => [t.key, t.events, t.sourced, t.missing])).toEqual([
      ["I:RESI", 1, 1, []],
      ["F:RESI", 1, 0, ["@F1@"]],
    ]);
  });
});

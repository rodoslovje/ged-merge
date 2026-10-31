import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { computeKinship } from "../tools/batch";
import { buildStatsFacts } from "./facts";
import { applyCountry, DEFAULT_SCOPE, scopeFacts, type StatsScope } from "./scope";
import { familyStats, histogram, lifespanStats, namesStats, overview, rankNames } from "./aggregate";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** Grandfather Janez (I1) + Marija (I2) → son Janez (I3), married twice:
 *  first Ana (I4, F2) with a son Janez (I5) and a daughter Ana (I6) who died
 *  as an infant; then Neža (I7, F3), childless. Tone (I8) is unrelated, in Croatia. */
const FILE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 1800
2 PLAC Bled, Slovenija
1 DEAT
2 DATE 1870
1 FAMS @F1@
0 @I2@ INDI
1 NAME Marija /Kos/
1 SEX F
1 BIRT
2 DATE ABT 1805
1 DEAT
2 DATE 1860
2 CAUS jetika
1 FAMS @F1@
0 @I3@ INDI
1 NAME Janez Krstnik /NOVAK/
1 SEX M
1 BIRT
2 DATE 3 MAR 1830
2 PLAC Bled, Slovenija
1 DEAT
2 DATE 1900
1 FAMC @F1@
1 FAMS @F2@
1 FAMS @F3@
0 @I4@ INDI
1 NAME Ana /Zupan/
1 SEX F
1 BIRT
2 DATE 1835
1 DEAT
2 DATE 1862
1 FAMS @F2@
0 @I5@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 10 DEC 1855
1 FAMC @F2@
0 @I6@ INDI
1 NAME Ana /Novak/
1 SEX F
1 BIRT
2 DATE 1858
1 DEAT
2 DATE 1859
1 FAMC @F2@
0 @I7@ INDI
1 NAME Neža /Novák/
1 SEX F
1 BIRT
2 DATE 1840
1 FAMS @F3@
0 @I8@ INDI
1 NAME Tone /Horvat/
1 SEX M
1 BIRT
2 DATE 1900
2 PLAC Zagreb, Hrvatska
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 MARR
2 DATE 1828
0 @F2@ FAM
1 HUSB @I3@
1 WIFE @I4@
1 CHIL @I5@
1 CHIL @I6@
1 MARR
2 DATE 5 MAY 1855
0 @F3@ FAM
1 HUSB @I3@
1 WIFE @I7@
1 MARR
2 DATE 1863
0 TRLR
`;

const ds = dataset(FILE);
const facts = buildStatsFacts(ds, "si", 2026);
const scoped = (patch: Partial<StatsScope> = {}, start = "@I3@") => {
  const scope = { ...DEFAULT_SCOPE, ...patch };
  return applyCountry(facts, scopeFacts(facts, scope, computeKinship(ds, start), start), scope);
};

describe("buildStatsFacts", () => {
  it("reads one row per person with dates, places and kin", () => {
    const p = facts.byId.get("@I3@")!;
    expect(p).toMatchObject({ given: "Janez", givenCount: 2, surname: "NOVAK", birthYear: 1830, birthMonth: 3, ageAtDeath: 70, country: "si", father: "@I1@", mother: "@I2@" });
    expect(facts.byId.get("@I2@")).toMatchObject({ birthApprox: true, cause: "jetika" });
    expect(facts.byId.get("@I8@")!.country).toBe("hr");
    expect(facts.byId.get("@I5@")!.living).toBe(false); // born 1855, no death: past the living window
  });

  it("marks each spouse's earliest-dated union as their first", () => {
    const f2 = facts.families.find((f) => f.id === "@F2@")!;
    const f3 = facts.families.find((f) => f.id === "@F3@")!;
    expect(f2).toMatchObject({ husbandFirst: true, wifeFirst: true, husbandAge: 25, wifeAge: 20, firstChildMonths: 7 });
    expect(f3).toMatchObject({ husbandFirst: false, wifeFirst: true, husbandAge: 33 });
  });
});

describe("scope", () => {
  it("narrows to the start person's lines, sex, years and country", () => {
    expect(scoped().people).toHaveLength(8);
    expect(scoped({ who: "blood" }).ids).toEqual(new Set(["@I1@", "@I2@", "@I3@", "@I5@", "@I6@"]));
    expect(scoped({ who: "ancestors" }).ids).toEqual(new Set(["@I1@", "@I2@", "@I3@"]));
    expect(scoped({ who: "descendants" }).ids).toEqual(new Set(["@I3@", "@I5@", "@I6@"]));
    expect(scoped({ sex: "F" }).people.every((p) => p.sex === "F")).toBe(true);
    expect(scoped({ country: "hr" }).ids).toEqual(new Set(["@I8@"]));
    expect(scoped({ place: "bled" }).ids).toEqual(new Set(["@I1@", "@I3@"]));
    // An approximate birth year falls outside a bounded range unless asked for.
    expect(scoped({ from: 1801, to: 1810 }).people).toHaveLength(0);
    expect(scoped({ from: 1801, to: 1810, approx: true }).ids).toEqual(new Set(["@I2@"]));
  });

  it("keeps the families of the people in scope", () => {
    expect(scoped({ who: "ancestors" }).families.map((f) => f.id).sort()).toEqual(["@F1@", "@F2@", "@F3@"]);
  });
});

describe("aggregates", () => {
  it("ranks names accent- and case-blind under the commonest spelling", () => {
    const ranked = rankNames(facts.people, "surname");
    expect(ranked[0]).toMatchObject({ label: "Novak", count: 5 });
  });

  it("bins values with open ends and keeps empty bins", () => {
    const bins = histogram([3, 12, 40, -2], (v) => v, String, { start: 0, width: 10, end: 30, under: true });
    expect(bins.map((b) => b.count)).toEqual([1, 1, 1, 0, 1]);
  });

  it("builds the overview over the scope", () => {
    const o = overview(scoped());
    expect(o.people).toBe(8);
    expect(o.male).toHaveLength(4);
    expect(o.firstBirth).toEqual({ year: 1800, id: "@I1@" });
    expect(o.oldest).toEqual({ id: "@I1@", age: 70 });
    expect(o.largestFamily).toEqual({ id: "@F2@", children: 2 });
    expect(o.mostChildrenMale).toEqual({ id: "@I3@", children: 2 });
    expect(o.mostChildrenFemale).toEqual({ id: "@I4@", children: 2 });
    expect(o.completeness.birthPlace.n).toBe(3);
    expect(o.countries).toBe(2);
    expect(o.places).toBe(2);
    expect(o.completeness.place.n).toBe(3);
    expect(o.completeness.mapped.n).toBe(0);
    expect(o.topBirthPlaces[0]).toMatchObject({ label: "Bled, Slovenija", count: 2 });
    expect(o.topBirthCountries.map((b) => [b.key, b.count])).toEqual([["si", 2], ["hr", 1]]);
    expect(overview(scoped({ country: "hr" })).places).toBe(1);
  });

  it("counts namesakes of parents and grandparents", () => {
    const n = namesStats(scoped());
    expect(n.namesakes.sonFather).toMatchObject({ n: 2, of: 2 });
    expect(n.namesakes.sonGrandfather).toMatchObject({ n: 1, of: 1 });
    expect(n.givenCount.map((b) => b.count)).toEqual([7, 1, 0]);
  });

  it("measures lifespans, leaving approximate ages out by default", () => {
    const l = lifespanStats(scoped());
    expect(l.all?.n).toBe(4); // I1, I3, I4, I6 — I2's birth is ABT
    expect(lifespanStats(scoped({ approx: true })).all?.n).toBe(5);
    expect(l.childDeaths.find((c) => c.century === 1800)).toMatchObject({ n: 4, ids: ["@I6@"] });
    expect(l.oldest[0]).toEqual({ id: "@I1@", age: 70 });
  });

  it("measures marriages and families", () => {
    const f = familyStats(scoped());
    expect(f.firstMarriageMale.find((b) => b.ids.includes("@I3@"))?.lo).toBe(25);
    expect(f.firstMarriageFemale.flatMap((b) => b.ids).sort()).toEqual(["@I4@", "@I7@"]);
    expect(f.unionsPerPerson.map((b) => b.count)).toEqual([4, 1, 0]);
    expect(f.marriageMonth[4].ids).toEqual(["@F2@"]);
    expect(f.firstChild.find((b) => b.key === "0")?.ids).toEqual(["@F2@"]);
    expect(f.children[0].ids).toEqual(["@F3@"]);
    expect(f.mostUnions).toEqual({ id: "@I3@", count: 2 });
    expect(f.childrenMean).toEqual({ value: 1, n: 3 });
  });
});

describe("map completeness", () => {
  it("puts a person on the map through a place whose coordinates another event carries", () => {
    const mapped = buildStatsFacts(dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jože /Novak/
1 BIRT
2 PLAC Bled
3 MAP
4 LATI N46.3683
4 LONG E14.1146
0 @I2@ INDI
1 NAME Ana /Novak/
1 RESI
2 PLAC Bled
0 @I3@ INDI
1 NAME Tone /Novak/
1 DEAT
2 PLAC Kranj
0 @I4@ INDI
1 NAME Neža /Novak/
0 TRLR
`));
    expect([...mapped.byId.values()].map((p) => [p.id, p.hasPlace, p.mapped])).toEqual([
      ["@I1@", true, true],
      ["@I2@", true, true],
      ["@I3@", true, false],
      ["@I4@", false, false],
    ]);
  });
});

describe("name completeness", () => {
  it("needs a given name and a surname, and counts neither stand-in for an unknown one", () => {
    const named = buildStatsFacts(dataset(`0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
0 @I2@ INDI
1 NAME NN /Novak/
0 @I3@ INDI
1 NAME Ana //
0 @I4@ INDI
1 NAME Jože /N.N./
0 TRLR
`));
    expect([...named.byId.values()].map((p) => p.hasName)).toEqual([true, false, false, false]);
    // A stand-in is no name, so it is not ranked either.
    expect(rankNames(named.people, "surname").map((b) => [b.label, b.count])).toEqual([["Novak", 2]]);
    expect(rankNames(named.people, "given").map((b) => b.label)).toEqual(["Ana", "Janez", "Jože"]);
  });
});

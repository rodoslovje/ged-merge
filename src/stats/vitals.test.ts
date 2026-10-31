import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildStatsFacts } from "./facts";
import { applyCountry, DEFAULT_SCOPE, scopeFacts, type StatsScope } from "./scope";
import { rankText } from "./aggregate";
import { birthStats, byPeriod, deathStats, occupationStats } from "./vitals";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

/** Father Jože (I1, kmet, died of jetika) and mother Ana (I2, died of Jetika);
 *  twin sons Jakob and Janez (I3, I4) born the same day, baptised the next;
 *  Jakob a kmet like his father, Janez a kovač. */
const FILE = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jože /Novak/
1 SEX M
1 OCCU kmet
1 BIRT
2 DATE 1820
1 DEAT
2 DATE 12 MAR 1880
2 PLAC Bled
2 CAUS jetika
1 FAMS @F1@
0 @I2@ INDI
1 NAME Ana /Kos/
1 SEX F
1 BIRT
2 DATE 1825
1 DEAT
2 DATE 1885
2 PLAC Bled
2 CAUS Jetika
1 FAMS @F1@
0 @I3@ INDI
1 NAME Jakob /Novak/
1 SEX M
1 OCCU Kmet
1 BIRT
2 DATE 4 JUL 1850
2 PLAC Bled
1 BAPM
2 DATE 5 JUL 1850
1 FAMC @F1@
0 @I4@ INDI
1 NAME Janez /Novak/
1 SEX M
1 OCCU kovač, kmet
1 EDUC osnovna šola
1 BIRT
2 DATE 4 JUL 1850
2 PLAC Bled
1 FAMC @F1@
0 @F1@ FAM
1 HUSB @I1@
1 WIFE @I2@
1 CHIL @I3@
1 CHIL @I4@
0 TRLR
`;

const ds = dataset(FILE);
const facts = buildStatsFacts(ds, "si", 2026);
const scoped = (patch: Partial<StatsScope> = {}) => {
  const scope = { ...DEFAULT_SCOPE, ...patch };
  return applyCountry(facts, scopeFacts(facts, scope, null, undefined), scope);
};

describe("vitals helpers", () => {
  it("ranks free text once per row, accent- and case-blind", () => {
    const ranked = rankText([{ id: "a", v: ["Kmet", "kmet"] }, { id: "b", v: ["kmet"] }], (r) => r.v, (r) => r.id);
    expect(ranked).toEqual([{ key: "kmet", label: "Kmet", count: 2, ids: ["a", "b"] }]);
  });

  it("counts per decade with the empty decades between kept, and coarser periods over a long span", () => {
    const decades = byPeriod([1801, 1835], (y) => y, String);
    expect(decades.map((d) => [d.key, d.count])).toEqual([["1800", 1], ["1810", 0], ["1820", 0], ["1830", 1]]);
    // 710–1990 is 128 decades: it is counted by half-century instead.
    const long = byPeriod([710, 1990], (y) => y, String);
    expect(long).toHaveLength(26);
    expect(long[0]).toMatchObject({ lo: 700, hi: 749, count: 1 });
  });
});

describe("birthStats", () => {
  it("finds twins, baptism delays, months and places", () => {
    const b = birthStats(scoped());
    expect(b.twins).toEqual({ sets: 1, families: ["@F1@"] });
    expect(b.multiples).toEqual({ sets: 0, families: [] });
    expect(b.baptism.find((x) => x.key === "1")?.ids).toEqual(["@I3@"]);
    expect(b.baptismMean).toEqual({ value: 1, n: 1 });
    expect(b.byMonth[6].count).toBe(2);
    expect(b.places[0]).toMatchObject({ label: "Bled", count: 2 });
  });
});

describe("deathStats", () => {
  it("groups causes as written and averages their ages", () => {
    const d = deathStats(scoped());
    expect(d.causes[0]).toMatchObject({ key: "jetika", count: 2 });
    expect(d.withCause).toMatchObject({ n: 2, of: 2 });
    expect(d.ageByCause).toEqual([]); // two deaths are fewer than a cause needs
    expect(d.byMonth[2].ids).toEqual(["@I1@"]);
    expect(d.perPeriod.map((x) => x.key)).toEqual(["1880"]);
  });
});

describe("occupationStats", () => {
  it("ranks occupations, splitting a value that lists several, and education", () => {
    const o = occupationStats(scoped());
    expect(o.occupations[0]).toMatchObject({ key: "kmet", count: 3 });
    expect(o.occupations.map((b) => b.key)).toEqual(["kmet", "kovac"]);
    expect(o.withOccupation).toMatchObject({ n: 3, of: 4 });
    expect(o.education).toEqual([{ key: "osnovna sola", label: "osnovna šola", count: 1, ids: ["@I4@"] }]);
    expect(o.withEducation).toMatchObject({ n: 1, of: 4 });
    expect(o.byCentury.map((c) => c.century)).toEqual([1800]);
  });
});

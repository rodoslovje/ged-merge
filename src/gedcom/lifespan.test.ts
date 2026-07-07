import { describe, expect, it } from "vitest";
import { formatLifespan, deathYear, isDeceased, isPresumedLiving } from "./lifespan";
import type { Individual } from "./types";
import { buildDataset } from "./builder";
import { parseGedcom } from "./parser";

describe("formatLifespan", () => {
  it("shows a full range when both years are known", () => {
    expect(formatLifespan(1817, 1921, true)).toBe("1817–1921");
  });

  it("shows a trailing dash when dead but the death year is unknown", () => {
    expect(formatLifespan(1817, undefined, true)).toBe("1817–");
  });

  it("shows just the birth year when presumed living", () => {
    expect(formatLifespan(1817, undefined, false)).toBe("1817");
  });

  it("shows a leading dash when only the death year is known", () => {
    expect(formatLifespan(undefined, 1921, true)).toBe("–1921");
  });

  it("is empty when nothing is dated", () => {
    expect(formatLifespan(undefined, undefined, false)).toBe("");
    expect(formatLifespan(undefined, undefined, true)).toBe("");
  });
});

const indi = (events: Individual["events"]): Individual => ({
  id: "@I1@",
  names: [],
  sex: "U",
  events,
  childOf: [],
  spouseOf: [],
  raw: { level: 0, tag: "INDI", children: [] },
});

describe("isDeceased / deathYear", () => {
  it("treats a dated death event as deceased with a year", () => {
    const p = indi([{ tag: "DEAT", date: { raw: "1921", qualifier: "exact", year: 1921 } }]);
    expect(isDeceased(p)).toBe(true);
    expect(deathYear(p)).toBe(1921);
  });

  it("treats an undated death/burial event as deceased with no year", () => {
    expect(isDeceased(indi([{ tag: "DEAT" }]))).toBe(true);
    expect(deathYear(indi([{ tag: "DEAT" }]))).toBeUndefined();
    expect(isDeceased(indi([{ tag: "BURI" }]))).toBe(true);
  });

  it("treats someone with no death event as living", () => {
    const p = indi([{ tag: "BIRT", date: { raw: "1817", qualifier: "exact", year: 1817 } }]);
    expect(isDeceased(p)).toBe(false);
    expect(deathYear(p)).toBeUndefined();
  });
});

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

const NOW = 2026;

// I1 dated ancestor (deceased); I2 his son with a recent dated birth and no
// death; I3 his grandchild with NO birth date at all (1-hop estimate from I2,
// born ~2026 → recent); I5 a great-grandchild whose own parent (I3) is ALSO
// undated, so only reachable via I2 two hops up (tests the transitive walk).
// I4 an old dated birth with no death (too old on its own); I8 I4's undated
// child (tests a network estimate that comes out old). I6 is fully isolated —
// no family links, so the network search finds nothing at all.
const FAMILY = `0 HEAD
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Jože /Novak/
1 SEX M
1 BIRT
2 DATE 1900
1 DEAT
2 DATE 1970
1 FAMS @F1@
0 @I2@ INDI
1 NAME Anton /Novak/
1 SEX M
1 BIRT
2 DATE 1960
1 FAMC @F1@
1 FAMS @F2@
0 @I3@ INDI
1 NAME Maja /Novak/
1 SEX F
1 FAMC @F2@
1 FAMS @F3@
0 @I4@ INDI
1 NAME Stari /Mož/
1 SEX M
1 BIRT
2 DATE 1850
1 FAMS @F4@
0 @I5@ INDI
1 NAME Nina /Novak/
1 SEX F
1 FAMC @F3@
0 @I6@ INDI
1 NAME Osamljen /Nihče/
1 SEX M
0 @I8@ INDI
1 NAME Vnuk /Star/
1 SEX M
1 FAMC @F4@
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@
0 @F2@ FAM
1 HUSB @I2@
1 CHIL @I3@
0 @F3@ FAM
1 HUSB @I3@
1 CHIL @I5@
0 @F4@ FAM
1 HUSB @I4@
1 CHIL @I8@
`;

describe("isPresumedLiving", () => {
  const ds = dataset(FAMILY);
  const get = (id: string) => ds.individuals.get(id);

  it("is false for someone with a dated death event", () => {
    expect(isPresumedLiving(get("@I1@"), ds, NOW)).toBe(false);
  });

  it("is true for someone with a recent dated birth and no death", () => {
    expect(isPresumedLiving(get("@I2@"), ds, NOW)).toBe(true);
  });

  it("estimates a birth from a parent when the person has no birth date, and is living if that estimate is recent", () => {
    expect(isPresumedLiving(get("@I3@"), ds, NOW)).toBe(true);
  });

  it("is not living when the person has no death event but an old dated birth", () => {
    expect(isPresumedLiving(get("@I4@"), ds, NOW)).toBe(false);
  });

  it("reaches a dated relative transitively when the direct parent is also undated", () => {
    expect(isPresumedLiving(get("@I5@"), ds, NOW)).toBe(true);
  });

  it("is not living when the only reachable dated relative implies an old birth", () => {
    expect(isPresumedLiving(get("@I8@"), ds, NOW)).toBe(false);
  });

  it("presumes living when no death event and no datable relative exist anywhere in reach", () => {
    expect(isPresumedLiving(get("@I6@"), ds, NOW)).toBe(true);
  });

  it("without a Dataset, presumes living too (no way to disprove it)", () => {
    expect(isPresumedLiving(get("@I3@"), undefined, NOW)).toBe(true);
  });
});

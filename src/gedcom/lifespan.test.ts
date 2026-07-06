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
// death; I3 a grandchild with NO birth date at all (estimable from I2, born
// ~2026 → recent); I4 a person with no death and an old dated birth (too old
// to be estimated as living even indirectly).
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
0 @I4@ INDI
1 NAME Stari /Mož/
1 SEX M
1 BIRT
2 DATE 1850
0 @F1@ FAM
1 HUSB @I1@
1 CHIL @I2@
0 @F2@ FAM
1 HUSB @I2@
1 CHIL @I3@
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

  it("without a Dataset, falls back to the birth-only rule (undated ⇒ not living)", () => {
    expect(isPresumedLiving(get("@I3@"), undefined, NOW)).toBe(false);
  });
});

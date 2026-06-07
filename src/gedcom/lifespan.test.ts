import { describe, expect, it } from "vitest";
import { formatLifespan, deathYear, isDeceased } from "./lifespan";
import type { Individual } from "./types";

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

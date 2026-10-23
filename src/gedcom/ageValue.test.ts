import { describe, expect, it } from "vitest";
import { ageWholeYears, ageYearsRange, formatAge, parseAge, writeAgeValue } from "./ageValue";

describe("parseAge", () => {
  it("reads the 5.5.1 grammar: bound, YYy MMm DDDd, any subset in order", () => {
    expect(parseAge("25y")).toEqual({ years: 25 });
    expect(parseAge("25y 3m 10d")).toEqual({ years: 25, months: 3, days: 10 });
    expect(parseAge("3m")).toEqual({ months: 3 });
    expect(parseAge("120d")).toEqual({ days: 120 });
    expect(parseAge("<1y")).toEqual({ bound: "<", years: 1 });
    expect(parseAge(">60y")).toEqual({ bound: ">", years: 60 });
  });

  it("reads the 5.5.1 keywords in any case", () => {
    expect(parseAge("CHILD")).toEqual({ keyword: "CHILD" });
    expect(parseAge("infant")).toEqual({ keyword: "INFANT" });
    expect(parseAge("Stillborn")).toEqual({ keyword: "STILLBORN" });
  });

  it("reads the 7.0 grammar: spaced bound and weeks", () => {
    expect(parseAge("< 8y")).toEqual({ bound: "<", years: 8 });
    expect(parseAge("2y 3m 1w 2d")).toEqual({ years: 2, months: 3, weeks: 1, days: 2 });
    expect(parseAge("> 3w")).toEqual({ bound: ">", weeks: 3 });
  });

  it("is lenient about case and spacing, and takes a bare number as years", () => {
    expect(parseAge("25Y")).toEqual({ years: 25 });
    expect(parseAge("25Y3M")).toEqual({ years: 25, months: 3 });
    expect(parseAge(" 42 ")).toEqual({ years: 42 });
    expect(parseAge("> 42")).toEqual({ bound: ">", years: 42 });
  });

  it("refuses what the grammar has no place for", () => {
    expect(parseAge("")).toBeUndefined();
    expect(parseAge(undefined)).toBeUndefined();
    expect(parseAge("about thirty")).toBeUndefined();
    expect(parseAge("3m 25y")).toBeUndefined(); // out of order
    expect(parseAge("2y 2y")).toBeUndefined(); // repeated unit
    expect(parseAge("< CHILD")).toBeUndefined();
    expect(parseAge("25 years")).toBeUndefined();
  });
});

describe("formatAge / writeAgeValue", () => {
  it("writes 7.0 with a spaced bound, and a keyword as its bound plus a PHRASE", () => {
    expect(writeAgeValue(">60y", "7.0")).toEqual({ value: "> 60y" });
    expect(writeAgeValue("child", "7.0")).toEqual({ value: "< 8y", phrase: "Child" });
    expect(writeAgeValue("INFANT", "7.0")).toEqual({ value: "< 1y", phrase: "Infant" });
    expect(writeAgeValue("stillborn", "7.0")).toEqual({ value: "0y", phrase: "Stillborn" });
    expect(writeAgeValue("1w 2d", "7.0")).toEqual({ value: "1w 2d" });
  });

  it("writes 5.5.1 with keywords kept and weeks folded into days", () => {
    expect(writeAgeValue("child", "5.5.1")).toEqual({ value: "CHILD" });
    expect(writeAgeValue("1w 2d", "5.5.1")).toEqual({ value: "9d" });
    expect(writeAgeValue("2y 3w", "5.5.1")).toEqual({ value: "2y 21d" });
    expect(writeAgeValue("25", "5.5.1")).toEqual({ value: "25y" });
    expect(writeAgeValue("25Y 3M", "5.5.1")).toEqual({ value: "25y 3m" });
  });

  it("keeps a 5.5.1 bound's spacing as typed", () => {
    expect(writeAgeValue(">60y", "5.5.1")).toEqual({ value: ">60y" });
    expect(writeAgeValue("> 60y", "5.5.1")).toEqual({ value: "> 60y" });
    expect(formatAge({ bound: "<", years: 1 }, "unknown")).toBe("<1y");
  });

  it("writes unreadable text as typed", () => {
    expect(writeAgeValue("  about thirty ", "7.0")).toEqual({ value: "about thirty" });
  });
});

describe("ageYearsRange", () => {
  it("gives an exact age the span of its finest unit", () => {
    expect(ageYearsRange({ years: 25 })).toEqual({ min: 25, max: 26 });
    const r = ageYearsRange({ years: 25, months: 3 })!;
    expect(r.min).toBeCloseTo(25.25);
    expect(r.max).toBeCloseTo(25 + 4 / 12);
    expect(ageYearsRange({ days: 10 })!.max).toBeCloseTo(11 / 365.25);
  });

  it("opens a bound at one end", () => {
    expect(ageYearsRange({ bound: "<", years: 8 })).toEqual({ min: 0, max: 8 });
    expect(ageYearsRange({ bound: ">", years: 60 })).toEqual({ min: 60, max: 125 });
  });

  it("reads the keywords as the bounds they stand for", () => {
    expect(ageYearsRange({ keyword: "CHILD" })).toEqual({ min: 0, max: 8 });
    expect(ageYearsRange({ keyword: "INFANT" })).toEqual({ min: 0, max: 1 });
    expect(ageYearsRange({ keyword: "STILLBORN" })).toEqual({ min: 0, max: 0 });
  });

  it("refuses an impossible age", () => {
    expect(ageYearsRange({ years: 300 })).toBeUndefined();
  });
});

describe("ageWholeYears", () => {
  it("states whole years only for an exact age given in years", () => {
    expect(ageWholeYears({ years: 25, months: 3 })).toBe(25);
    expect(ageWholeYears({ bound: ">", years: 60 })).toBeUndefined();
    expect(ageWholeYears({ keyword: "CHILD" })).toBeUndefined();
    expect(ageWholeYears({ months: 3 })).toBeUndefined();
    expect(ageWholeYears(undefined)).toBeUndefined();
  });
});

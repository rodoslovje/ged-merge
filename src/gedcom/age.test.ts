import { describe, expect, it } from "vitest";
import {
  ageBetween,
  agePartsBetween,
  coupleAgesDisplay,
  fullAgeBetween,
  lifespanAge,
  lifespanTooltipOf,
  lifespanWithAge,
} from "./age";
import type { GedDate, Individual } from "./types";
import type { Translate } from "../locales/i18n";

/** Minimal translator for the unit-letter/label keys used by the formatters. */
const t: Translate = (key) =>
  ({ "age.y": "y", "age.m": "m", "age.d": "d", "age.label": "age" })[key] ?? key;

const d = (year?: number, month?: number, day?: number): GedDate => ({
  raw: "",
  qualifier: "exact",
  year,
  month,
  day,
});

describe("ageBetween", () => {
  it("computes the year difference for bare years", () => {
    expect(ageBetween(d(1850), d(1885))).toBe(35);
  });

  it("subtracts a year when the anniversary hasn't been reached", () => {
    expect(ageBetween(d(1850, 6, 15), d(1885, 6, 14))).toBe(34);
    expect(ageBetween(d(1850, 6, 15), d(1885, 5, 20))).toBe(34);
  });

  it("keeps the full year on or after the anniversary", () => {
    expect(ageBetween(d(1850, 6, 15), d(1885, 6, 15))).toBe(35);
    expect(ageBetween(d(1850, 6, 15), d(1885, 7, 1))).toBe(35);
  });

  it("uses the year difference when only one side has a month", () => {
    expect(ageBetween(d(1850, 6, 15), d(1885))).toBe(35);
    expect(ageBetween(d(1850), d(1885, 2, 1))).toBe(35);
  });

  it("is undefined without both years", () => {
    expect(ageBetween(d(1850), d())).toBeUndefined();
    expect(ageBetween(undefined, d(1885))).toBeUndefined();
  });

  it("suppresses implausible ages (negative or beyond human lifespan)", () => {
    expect(ageBetween(d(1885), d(1850))).toBeUndefined();
    expect(ageBetween(d(1700), d(1885))).toBeUndefined();
  });

  it("allows age zero (event in the birth year)", () => {
    expect(ageBetween(d(1850), d(1850))).toBe(0);
  });
});

describe("agePartsBetween / fullAgeBetween", () => {
  it("gives the full Y/M/D breakdown for full dates", () => {
    expect(agePartsBetween(d(1908, 1, 26), d(1970, 3, 3))).toEqual({ years: 62, months: 1, days: 5 });
    expect(fullAgeBetween(d(1908, 1, 26), d(1970, 3, 3), t)).toBe("62y 1m 5d");
  });

  it("borrows days from the month before the end date", () => {
    // 15 Jun → 14 Jun next year: one day short of the anniversary (May has 31 days).
    expect(agePartsBetween(d(1900, 6, 15), d(1901, 6, 14))).toEqual({ years: 0, months: 11, days: 30 });
    // End in March: borrows February's 28 days.
    expect(agePartsBetween(d(1900, 1, 30), d(1901, 3, 1))).toEqual({ years: 1, months: 1, days: 1 });
  });

  it("stops at year+month precision when a day is missing", () => {
    expect(agePartsBetween(d(1900, 6), d(1935, 3, 10))).toEqual({ years: 34, months: 9 });
    expect(fullAgeBetween(d(1900, 6), d(1935, 3, 10), t)).toBe("34y 9m");
  });

  it("stops at year precision when a month is missing", () => {
    expect(agePartsBetween(d(1900), d(1935, 3, 10))).toEqual({ years: 35 });
    expect(fullAgeBetween(d(1900), d(1935, 3, 10), t)).toBe("35y");
  });

  it("agrees with ageBetween on the whole years", () => {
    const cases: [GedDate, GedDate][] = [
      [d(1900, 6, 15), d(1935, 6, 14)],
      [d(1900, 6, 15), d(1935, 6, 15)],
      [d(1900, 6), d(1935, 3)],
      [d(1900), d(1935)],
    ];
    for (const [b, a] of cases) {
      expect(agePartsBetween(b, a)?.years).toBe(ageBetween(b, a));
    }
  });

  it("is undefined for implausible spans", () => {
    expect(agePartsBetween(d(1935), d(1900))).toBeUndefined();
    expect(agePartsBetween(d(1900, 6), d(1900, 3))).toBeUndefined();
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

describe("lifespanAge / lifespanWithAge", () => {
  const dead = indi([
    { tag: "BIRT", date: d(1850, 3, 1) },
    { tag: "DEAT", date: d(1920, 2, 1) },
  ]);

  it("is the age at death for the deceased", () => {
    expect(lifespanAge(dead)).toBe(69);
    expect(lifespanWithAge(dead, true)).toBe("1850–1920 (69)");
  });

  it("is the current age for the presumed living", () => {
    const now = new Date(2026, 6, 6); // 6 July 2026
    const living = indi([{ tag: "BIRT", date: d(1980, 8, 1) }]);
    expect(lifespanAge(living, now)).toBe(45); // birthday not yet reached
    expect(lifespanAge(indi([{ tag: "BIRT", date: d(1980, 6, 1) }]), now)).toBe(46);
  });

  it("shows nothing for a dateless-death ancient ancestor", () => {
    const ancient = indi([{ tag: "BIRT", date: d(1817) }]);
    expect(lifespanAge(ancient)).toBeUndefined();
    expect(lifespanWithAge(ancient, true)).toBe("1817");
  });

  it("shows nothing when dead without a dated death", () => {
    expect(lifespanAge(indi([{ tag: "BIRT", date: d(1900) }, { tag: "DEAT" }]))).toBeUndefined();
  });

  it("leaves the plain lifespan when the toggle is off", () => {
    expect(lifespanWithAge(dead, false)).toBe("1850–1920");
  });
});

describe("lifespanTooltipOf", () => {
  it("appends the labelled full-precision age to the dates tooltip", () => {
    const p = indi([
      { tag: "BIRT", date: { ...d(1908, 1, 26), raw: "26 JAN 1908" } },
      { tag: "DEAT", date: { ...d(1970, 3, 3), raw: "3 MAR 1970" } },
    ]);
    expect(lifespanTooltipOf(p, true, t)).toBe("26 JAN 1908 – 3 MAR 1970 (age 62y 1m 5d)");
    expect(lifespanTooltipOf(p, false, t)).toBe("26 JAN 1908 – 3 MAR 1970");
  });
});

describe("coupleAgesDisplay", () => {
  const labels = { husband: "H", wife: "W" };
  const husband = indi([{ tag: "BIRT", date: d(1850, 1, 10) }]);
  const wife = indi([{ tag: "BIRT", date: d(1855, 6, 1) }]);

  it("returns one glyph-tagged badge per known age, each with its own tooltip", () => {
    expect(coupleAgesDisplay(husband, wife, d(1885, 5, 20), labels, t)).toEqual([
      { text: "♂35", title: "H: 35y 4m 10d" },
      { text: "♀29", title: "W: 29y 11m 19d" },
    ]);
  });

  it("skips the side with no computable age", () => {
    expect(coupleAgesDisplay(husband, undefined, d(1885, 5, 20), labels, t)).toEqual([
      { text: "♂35", title: "H: 35y 4m 10d" },
    ]);
    expect(coupleAgesDisplay(undefined, undefined, d(1885, 5, 20), labels, t)).toBeUndefined();
  });
});

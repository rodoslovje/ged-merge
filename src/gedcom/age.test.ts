import { describe, expect, it } from "vitest";
import { ageBetween, formatCoupleAges, lifespanAge, lifespanWithAge } from "./age";
import type { GedDate, Individual } from "./types";

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

describe("formatCoupleAges", () => {
  it("tags each known age with the sex glyph", () => {
    expect(formatCoupleAges(32, 28)).toBe("♂32 ♀28");
    expect(formatCoupleAges(32, undefined)).toBe("♂32");
    expect(formatCoupleAges(undefined, 28)).toBe("♀28");
    expect(formatCoupleAges(undefined, undefined)).toBe("");
  });
});

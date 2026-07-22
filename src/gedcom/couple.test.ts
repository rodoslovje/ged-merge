import { describe, expect, it } from "vitest";
import type { Individual } from "./types";
import { isSameSexCouple } from "./couple";

const person = (sex: Individual["sex"]): Individual => ({
  id: "@I@",
  names: [],
  sex,
  events: [],
  childOf: [],
  spouseOf: [],
  raw: { level: 0, tag: "INDI", children: [] },
});

describe("isSameSexCouple", () => {
  it("is true for two people of the same known sex", () => {
    expect(isSameSexCouple(person("M"), person("M"))).toBe(true);
    expect(isSameSexCouple(person("F"), person("F"))).toBe(true);
  });

  it("is false for an opposite-sex couple", () => {
    expect(isSameSexCouple(person("M"), person("F"))).toBe(false);
  });

  it("is false when either sex is unknown or a partner is missing", () => {
    expect(isSameSexCouple(person("U"), person("U"))).toBe(false);
    expect(isSameSexCouple(person("M"), person("U"))).toBe(false);
    expect(isSameSexCouple(person("M"), undefined)).toBe(false);
    expect(isSameSexCouple(undefined, undefined)).toBe(false);
  });
});

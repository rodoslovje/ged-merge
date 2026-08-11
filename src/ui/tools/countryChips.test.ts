import { describe, expect, it } from "vitest";
import { visibleCountryChips, type CountryChip } from "./CountryChips";

const chips: CountryChip[] = [
  { code: "SI", count: 451 },
  { code: "HR", count: 67 },
  { code: "KH", count: 0 },
  { code: "", count: 0 },
];

describe("visibleCountryChips", () => {
  it("drops the countries the other filters have emptied", () => {
    expect(visibleCountryChips(chips, null).map((c) => c.code)).toEqual(["SI", "HR"]);
  });

  it("keeps the chosen country even when it shows nothing", () => {
    expect(visibleCountryChips(chips, "KH").map((c) => c.code)).toEqual(["SI", "HR", "KH"]);
    // "No country named" is a chip like any other, and can be the chosen one.
    expect(visibleCountryChips(chips, "").map((c) => c.code)).toEqual(["SI", "HR", ""]);
  });

  it("leaves the caller's list untouched", () => {
    const given = [...chips];
    visibleCountryChips(given, null);
    expect(given).toEqual(chips);
  });
});

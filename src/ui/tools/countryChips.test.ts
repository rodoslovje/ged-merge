import { describe, expect, it } from "vitest";
import { countryFacet, visibleCountryChips, type CountryChip } from "./CountryChips";

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

describe("countryFacet", () => {
  const rows = [
    { place: "Kranj, Slovenija", open: true },
    { place: "Bled, Slovenija", open: false },
    { place: "Rijeka, Hrvaska", open: true },
    { place: "Mengeš", open: true },
  ];
  const facet = (filter: string | null, counted = rows) =>
    countryFacet(rows, counted, (r) => r.place, "", filter);

  it("chips every country the page holds, counted by what the other filters leave", () => {
    const { chips, all } = facet(null, rows.filter((r) => r.open));
    expect(chips.map((c) => c.code)).toEqual(["si", "hr", ""]);
    expect(chips.map((c) => c.count)).toEqual([1, 1, 1]);
    expect(all).toBe(3);
  });

  it("keeps a country the other filters emptied, at zero", () => {
    const { chips } = facet(null, rows.filter((r) => !r.open));
    expect(chips.find((c) => c.code === "hr")).toEqual({ code: "hr", count: 0 });
  });

  it("filters by the country in force, and falls back to all for one the page has lost", () => {
    const chosen = facet("hr");
    expect(chosen.active).toBe("hr");
    expect(rows.filter(chosen.inCountry).map((r) => r.place)).toEqual(["Rijeka, Hrvaska"]);
    const gone = countryFacet(
      rows.filter((r) => r.place !== "Rijeka, Hrvaska"),
      rows,
      (r) => r.place,
      "",
      "hr",
    );
    expect(gone.active).toBeNull();
    expect(rows.every(gone.inCountry)).toBe(true);
  });

  it("files a place naming no country under the home country when there is one", () => {
    const home = countryFacet(rows, rows, (r) => r.place, "si", null);
    expect(home.chips.map((c) => c.code)).toEqual(["si", "hr"]);
    expect(home.chips[0].count).toBe(3);
  });
});

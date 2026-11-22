import { describe, expect, it } from "vitest";
import { easterSunday, holidaysFor } from "./holidays";

describe("easterSunday", () => {
  it.each([
    [2024, 3, 31],
    [2025, 4, 20],
    [2026, 4, 5],
    [2027, 3, 28],
    [2038, 4, 25],
  ])("%i → %i/%i", (year, month, day) => {
    expect(easterSunday(year)).toEqual({ month, day });
  });
});

describe("holidaysFor", () => {
  it("places the movable Slovenian feasts in 2027", () => {
    const si = holidaysFor("si", 2027);
    expect(si.find((h) => h.key === "easterMonday")).toMatchObject({ month: 3, day: 29 });
    expect(si.find((h) => h.key === "pentecost")).toMatchObject({ month: 5, day: 16 });
    expect(si.some((h) => h.key === "corpusChristi")).toBe(false);
  });

  it("gives Croatia Corpus Christi and its own statehood day", () => {
    const hr = holidaysFor("hr", 2027);
    expect(hr.find((h) => h.key === "corpusChristi")).toMatchObject({ month: 5, day: 27 });
    expect(hr.find((h) => h.key === "hr.statehood")).toMatchObject({ month: 5, day: 30 });
  });

  it("comes back in date order", () => {
    const keys = holidaysFor("si", 2027).map((h) => h.month * 100 + h.day);
    expect(keys).toEqual([...keys].sort((a, b) => a - b));
  });
});

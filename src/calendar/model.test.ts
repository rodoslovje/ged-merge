/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { buildCalendar, isRoundAnniversary, monthWeeks, relativesInScope, type CalendarOptions } from "./model";

function dataset(text: string) {
  return buildDataset(parseGedcom(new TextEncoder().encode(text).buffer));
}

// I4 ⚭ I5 (grandparents; I4 died 1927, before I1 was born)
//  ├─ I2 ⚭ I3 → I1 (recipient, b. 1990) ⚭ I9 → I8
//  └─ I6 (uncle) → I7 (first cousin) → I10 (first cousin once removed)
// I11 married I6 (aunt by marriage).
const GED = readFileSync(new URL("../__fixtures__/calendar-family.ged", import.meta.url), "utf-8");

const ds = dataset(GED);
const base: CalendarOptions = { year: 2027, scope: 1, partners: true, memorial: "off" };
const NOW = 2026;

describe("relativesInScope", () => {
  it("keeps the descendants only", () => {
    expect([...relativesInScope(ds, "@I1@", "descendants").keys()].sort()).toEqual(["@I1@", "@I8@"]);
  });

  it("stops before cousins at degree 0", () => {
    const ids = [...relativesInScope(ds, "@I1@", 0).keys()];
    expect(ids).toContain("@I6@");
    expect(ids).not.toContain("@I7@");
  });

  it("reaches first cousins (and their children) at degree 1", () => {
    const rel = relativesInScope(ds, "@I1@", 1);
    expect(rel.get("@I7@")).toEqual({ up: 2, down: 2 });
    expect(rel.get("@I10@")).toEqual({ up: 2, down: 3 });
    expect(rel.get("@I2@")).toEqual({ up: 1, down: 0 });
  });
});

describe("buildCalendar", () => {
  const cal = buildCalendar(ds, "@I1@", base, NOW);
  const entries = (month: number) => cal.months[month - 1].entries;

  it("puts living relatives' birthdays on their day, with the age turned", () => {
    expect(entries(3)).toEqual(expect.arrayContaining([
      { kind: "birthday", day: 14, ids: ["@I1@"], years: 37 },
      { kind: "birthday", day: 10, ids: ["@I8@"], years: 7 },
      { kind: "birthday", day: 21, ids: ["@I3@"], years: 65 },
    ]));
  });

  it("writes no age in the year of the birth itself", () => {
    const born = buildCalendar(ds, "@I1@", { ...base, year: 2020 }, NOW).months[2].entries;
    expect(born).toContainEqual({ kind: "birthday", day: 10, ids: ["@I8@"], years: undefined });
  });

  it("leaves out the dead, and a birthday known only roughly", () => {
    const all = cal.months.flatMap((m) => m.entries).flatMap((e) => e.ids);
    expect(all).not.toContain("@I2@");
    expect(all).not.toContain("@I11@");
  });

  it("keeps 29 February on the 28th in a common year", () => {
    expect(entries(2)).toContainEqual({ kind: "birthday", day: 28, ids: ["@I7@"], years: 39 });
  });

  it("names a living couple's anniversary, not a widowed one's", () => {
    expect(entries(9)).toContainEqual({ kind: "anniversary", day: 8, ids: ["@I9@", "@I1@"], years: 10 });
    expect(entries(5).some((e) => e.kind === "anniversary")).toBe(false);
  });

  it("adds partners only when asked — the recipient's own always", () => {
    const without = buildCalendar(ds, "@I1@", { ...base, partners: false }, NOW);
    const ids = without.months.flatMap((m) => m.entries).flatMap((e) => e.ids);
    expect(ids).toContain("@I9@");
  });

  it("marks memorial days for those who died in the recipient's lifetime", () => {
    const life = buildCalendar(ds, "@I1@", { ...base, memorial: "lifetime" }, NOW);
    const mem = life.months.flatMap((m) => m.entries).filter((e) => e.kind === "memorial").map((e) => e.ids[0]);
    expect(mem.sort()).toEqual(["@I2@", "@I5@"]);
    // A memorial carries the year of the death, never the years since it.
    const father = life.months[10].entries.find((e) => e.kind === "memorial" && e.ids[0] === "@I2@");
    expect(father).toMatchObject({ day: 9, deathYear: 2010 });
    expect(father?.years).toBeUndefined();
  });

  it("marks memorial days up to a degree of kinship, however long ago", () => {
    const deg1 = buildCalendar(ds, "@I1@", { ...base, memorial: 1 }, NOW);
    const deg2 = buildCalendar(ds, "@I1@", { ...base, memorial: 2 }, NOW);
    const mem = (c: typeof deg1) => c.months.flatMap((m) => m.entries).filter((e) => e.kind === "memorial").map((e) => e.ids[0]).sort();
    expect(mem(deg1)).toEqual(["@I2@"]);
    expect(mem(deg2)).toEqual(["@I2@", "@I4@", "@I5@"]);
  });

  it("tells a round anniversary from the family's past", () => {
    const june = cal.months[5].facts;
    // The 1927 death is a centenary in 2027; the 1925 wedding shares a person with it.
    expect(june[0]).toMatchObject({ kind: "death", ids: ["@I4@"], yearsAgo: 100 });
    expect(june).toHaveLength(1);
    const jan = cal.months[0].facts;
    expect(jan[0]).toMatchObject({ kind: "birth", ids: ["@I5@"], yearsAgo: 125 });
  });

  it("never tells a living person's life as history", () => {
    const factIds = cal.months.flatMap((m) => m.facts).flatMap((f) => f.ids);
    expect(factIds).not.toContain("@I3@");
  });

  it("tells an ancestor's life though no death is on record", () => {
    // Grandmother Neža, born 1902, with her death left out of the file.
    const noDeath = GED.replace("1 DEAT\n2 DATE 3 MAR 1999\n", "");
    const jan = buildCalendar(dataset(noDeath), "@I1@", base, NOW).months[0].candidates;
    expect(jan).toContainEqual(expect.objectContaining({ kind: "birth", ids: ["@I5@"], yearsAgo: 125 }));
  });
});

describe("partners", () => {
  // Uncle Peter (I6) and Vera (I11), with a full birth date for Vera — then
  // the same couple divorced, or living apart.
  const dated = GED.replace("2 DATE ABT 1960", "2 DATE 4 MAY 1960");
  const ended = (tag: string) => dated.replace("0 @F4@ FAM\n", `0 @F4@ FAM\n1 ${tag} Y\n`);
  const named = (text: string) =>
    buildCalendar(dataset(text), "@I1@", { ...base, scope: 0 }, NOW).months.flatMap((m) => m.entries).flatMap((e) => e.ids);

  it("leaves out a partner the file records as divorced or living apart", () => {
    expect(named(dated)).toContain("@I11@");
    expect(named(ended("DIV"))).not.toContain("@I11@");
    expect(named(ended("SEPA"))).not.toContain("@I11@");
  });
});

describe("isRoundAnniversary", () => {
  it("marks round birthdays and jubilee weddings, never a memorial day", () => {
    expect(isRoundAnniversary({ kind: "birthday", day: 1, ids: ["a"], years: 80 })).toBe(true);
    expect(isRoundAnniversary({ kind: "birthday", day: 1, ids: ["a"], years: 37 })).toBe(false);
    expect(isRoundAnniversary({ kind: "birthday", day: 1, ids: ["a"] })).toBe(false);
    expect(isRoundAnniversary({ kind: "anniversary", day: 1, ids: ["a", "b"], years: 25 })).toBe(true);
    expect(isRoundAnniversary({ kind: "anniversary", day: 1, ids: ["a", "b"], years: 15 })).toBe(false);
    expect(isRoundAnniversary({ kind: "memorial", day: 1, ids: ["a"], years: 50 })).toBe(false);
  });
});

describe("monthWeeks", () => {
  it("starts the week on Monday", () => {
    // 1 March 2027 is a Monday; 1 February 2027 too.
    expect(monthWeeks(2027, 3)[0]).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const nov = monthWeeks(2026, 11); // 1 Nov 2026 is a Sunday
    expect(nov[0]).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(nov.at(-1)).toEqual([30, 0, 0, 0, 0, 0, 0]);
  });
});

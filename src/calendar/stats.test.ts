/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildDataset } from "../gedcom/builder";
import { parseGedcom } from "../gedcom/parser";
import { familyStats } from "./stats";

const ds = buildDataset(parseGedcom(new TextEncoder().encode(
  readFileSync(new URL("../__fixtures__/calendar-family.ged", import.meta.url), "utf-8"),
).buffer));

describe("familyStats", () => {
  it("counts a grandmother's family from her side", () => {
    // Neža (I5): children Janez and Peter, grandchildren Ana and Luka,
    // great-grandchildren Eva and Tim.
    const s = familyStats(ds, "@I5@", 2026);
    expect(s.descendantsByGen).toEqual([2, 2, 2]);
    expect(s.descendants).toBe(6);
    expect(s.ancestors).toBe(0);
  });

  it("counts the recipient's ancestors and blood relatives", () => {
    const s = familyStats(ds, "@I1@", 2026);
    expect(s.descendantsByGen).toEqual([1]);
    expect(s.ancestors).toBe(4); // parents Janez, Marija; grandparents Jože, Neža
    expect(s.ancestorGens).toBe(2);
    // Ancestors 4, uncle Peter, cousin Luka, his son Tim, her daughter Eva.
    expect(s.bloodRelatives).toBe(8);
    // Of them alive: Marija, Peter, Luka, Tim, Eva.
    expect(s.livingBloodRelatives).toBe(5);
    expect(s.oldestAncestor).toEqual({ id: "@I4@", year: 1900 });
    expect(s.commonSurname).toEqual({ name: "Novak", count: 6 });
  });
});

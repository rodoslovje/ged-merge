import { describe, expect, it } from "vitest";
import type { GedEvent, Individual, PersonName } from "../gedcom/types";
import { buildFindEntries, findHits, findOffChart } from "./chartFind";

let seq = 0;
const indi = (names: PersonName[], events: Individual["events"] = []): Individual => ({
  id: `@I${++seq}@`,
  names,
  sex: "U",
  events,
  childOf: [],
  spouseOf: [],
  raw: { level: 0, tag: "INDI", children: [] },
});
const named = (full: string, extra: Partial<PersonName> = {}) => indi([{ full, ...extra } as PersonName]);
const birth = (year: number): GedEvent => ({ tag: "BIRT", date: { raw: String(year), qualifier: "exact", year } });
const toMap = (list: Individual[]) => new Map(list.map((i) => [i.id, i]));

describe("buildFindEntries", () => {
  it("indexes every name form of everyone a node draws, in layout order", () => {
    const main = indi([{ full: "Marija Kovačič", given: "Marija", surname: "Kovačič", married: "Novak" } as PersonName]);
    const incoming = named("Maria Kovacic");
    const entries = buildFindEntries([
      { key: "a", people: [main, incoming] },
      { key: "b", people: [named("Janez Kovačič")] },
    ]);
    expect(entries.map((e) => e.key)).toEqual(["a", "b"]);
    expect(entries[0].id).toBe(main.id);
    // Married name and the compare-side spelling both land in the haystack,
    // folded free of diacritics.
    expect(entries[0].text).toContain("novak");
    expect(entries[0].text).toContain("maria kovacic");
  });

  it("skips nodes that draw nobody", () => {
    expect(buildFindEntries([{ key: "gap", people: [undefined] }])).toEqual([]);
  });
});

describe("findHits", () => {
  const entries = buildFindEntries([
    { key: "n1", people: [named("Marija Kovačič")] },
    { key: "n2", people: [named("Janez Kovačič")] },
    // The same person drawn twice — pedigree collapse.
    { key: "n3", people: [named("Marija Kovačič")] },
  ]);

  it("returns every position matching all terms, in layout order", () => {
    expect(findHits(entries, "marija").map((e) => e.key)).toEqual(["n1", "n3"]);
  });

  it("matches terms in any order and without diacritics", () => {
    expect(findHits(entries, "kovacic janez").map((e) => e.key)).toEqual(["n2"]);
  });

  it("matches nothing on a blank query", () => {
    expect(findHits(entries, "   ")).toEqual([]);
  });
});

describe("findOffChart", () => {
  it("offers the file's oldest match that the chart doesn't draw", () => {
    const drawn = named("Ana Novak");
    const younger = indi([{ full: "Ana Novak" } as PersonName], [birth(1902)]);
    const older = indi([{ full: "Ana Novak" } as PersonName], [birth(1841)]);
    const people = toMap([drawn, younger, older]);
    expect(findOffChart(people, "ana novak", new Set([drawn.id]))?.id).toBe(older.id);
  });

  it("is undefined when every match is already on the chart", () => {
    const drawn = named("Ana Novak");
    expect(findOffChart(toMap([drawn]), "ana", new Set([drawn.id]))).toBeUndefined();
  });

  it("is undefined for a blank query", () => {
    expect(findOffChart(toMap([named("Ana Novak")]), "  ", new Set())).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import type { GedEvent, Individual, PersonName } from "../gedcom/types";
import type { MatchDecisionStatus } from "../review/types";
import {
  buildSearchRows,
  searchPeople,
  hasActiveFilters,
  NO_FILTERS,
  MAX_RESULTS,
  type FilterContext,
  type GlobalFilters,
} from "./globalSearch";

let seq = 0;
const indi = (names: PersonName[], events: Individual["events"] = [], extra: Partial<Individual> = {}): Individual => ({
  id: `@I${++seq}@`,
  names,
  sex: "U",
  events,
  childOf: [],
  spouseOf: [],
  raw: { level: 0, tag: "INDI", children: [] },
  ...extra,
});

const birth = (year: number, place?: string): GedEvent => ({
  tag: "BIRT",
  date: { raw: String(year), qualifier: "exact", year },
  ...(place ? { place: { raw: place, parts: place.split(", ") } } : {}),
});
const death = (year: number): GedEvent => ({ tag: "DEAT", date: { raw: String(year), qualifier: "exact", year } });

const nameOf = (i: Individual) => i.names[0]?.full ?? "";
const toMap = (list: Individual[]) => new Map(list.map((i) => [i.id, i]));
const noCtx: FilterContext = { isEdited: () => false, decisionOf: () => undefined, kinshipHops: () => undefined };
const filters = (over: Partial<GlobalFilters> = {}): GlobalFilters => ({ ...NO_FILTERS, ...over });

describe("buildSearchRows", () => {
  it("projects name, lifespan, birth year, place, and attachment flags", () => {
    const p = indi(
      [{ full: "Marija Kovačič", given: "Marija", surname: "Kovačič" }],
      [birth(1841, "Šentvid, Kranj"), death(1902)],
      { sex: "F", links: ["https://example.org"], notes: ["a note"] },
    );
    const [row] = buildSearchRows(toMap([p]), nameOf);
    expect(row.name).toBe("Marija Kovačič");
    expect(row.span).toBe("1841–1902");
    expect(row.birthYear).toBe(1841);
    expect(row.sex).toBe("F");
    expect(row.placeText).toContain("šentvid");
    expect(row.hasLinks).toBe(true);
    expect(row.hasNotes).toBe(true);
    expect(row.hasSources).toBe(false);
  });

  it("sorts rows by display name", () => {
    const rows = buildSearchRows(
      toMap([indi([{ full: "Zora" }]), indi([{ full: "Ana" }]), indi([{ full: "Marko" }])]),
      nameOf,
    );
    expect(rows.map((r) => r.name)).toEqual(["Ana", "Marko", "Zora"]);
  });
});

describe("searchPeople — query", () => {
  const rows = buildSearchRows(
    toMap([
      indi([{ full: "Marija Kovačič", given: "Marija", surname: "Kovačič" }], [birth(1841)]),
      indi([{ full: "Marko Novak", given: "Marko", surname: "Novak" }], [birth(1870)]),
    ]),
    nameOf,
  );

  it("returns all rows for an empty query and no facets", () => {
    expect(searchPeople(rows, "   ", NO_FILTERS, noCtx)).toHaveLength(2);
  });

  it("requires every term to match, in any order", () => {
    expect(searchPeople(rows, "kov marija", NO_FILTERS, noCtx).map((r) => r.name)).toEqual(["Marija Kovačič"]);
    expect(searchPeople(rows, "marija novak", NO_FILTERS, noCtx)).toHaveLength(0);
  });

  it("caps the result count", () => {
    const many = buildSearchRows(
      toMap(Array.from({ length: MAX_RESULTS + 10 }, () => indi([{ full: "Ana Test" }]))),
      nameOf,
    );
    expect(searchPeople(many, "ana", NO_FILTERS, noCtx)).toHaveLength(MAX_RESULTS);
  });
});

describe("searchPeople — facets", () => {
  const male = indi([{ full: "Marko Novak" }], [birth(1870, "Kranj")], { sex: "M" });
  const female = indi([{ full: "Marija Kovačič" }], [birth(1841, "Šentvid")], { sex: "F", sources: [{ sourceId: "@S1@", exact: false }] });
  const rows = buildSearchRows(toMap([male, female]), nameOf);

  it("filters by sex", () => {
    expect(searchPeople(rows, "", filters({ sex: "F" }), noCtx).map((r) => r.name)).toEqual(["Marija Kovačič"]);
  });

  it("filters by birth-year range (excludes people with no birth year)", () => {
    const undated = buildSearchRows(toMap([indi([{ full: "No Dates" }])]), nameOf);
    expect(searchPeople(rows, "", filters({ bornFrom: 1850 }), noCtx).map((r) => r.name)).toEqual(["Marko Novak"]);
    expect(searchPeople(rows, "", filters({ bornTo: 1850 }), noCtx).map((r) => r.name)).toEqual(["Marija Kovačič"]);
    expect(searchPeople(undated, "", filters({ bornFrom: 1800 }), noCtx)).toHaveLength(0);
  });

  it("filters by place substring", () => {
    expect(searchPeople(rows, "", filters({ place: "šentvid" }), noCtx).map((r) => r.name)).toEqual(["Marija Kovačič"]);
  });

  it("filters by attachments", () => {
    expect(searchPeople(rows, "", filters({ hasSources: true }), noCtx).map((r) => r.name)).toEqual(["Marija Kovačič"]);
  });

  it("filters by edit status via context", () => {
    const ctx: FilterContext = { isEdited: (id) => id === female.id, decisionOf: () => undefined, kinshipHops: () => undefined };
    expect(searchPeople(rows, "", filters({ edited: true }), ctx).map((r) => r.name)).toEqual(["Marija Kovačič"]);
  });

  it("filters by decision status via context", () => {
    const decision: MatchDecisionStatus = "confirmed";
    const ctx: FilterContext = { isEdited: () => false, decisionOf: (id) => (id === male.id ? decision : undefined), kinshipHops: () => undefined };
    expect(searchPeople(rows, "", filters({ decision }), ctx).map((r) => r.name)).toEqual(["Marko Novak"]);
  });

  it("filters by max kinship hops (excludes unreachable people)", () => {
    const ctx: FilterContext = {
      isEdited: () => false,
      decisionOf: () => undefined,
      kinshipHops: (id) => (id === male.id ? 2 : id === female.id ? 6 : undefined),
    };
    expect(searchPeople(rows, "", filters({ maxKinship: 4 }), ctx).map((r) => r.name)).toEqual(["Marko Novak"]);
    expect(searchPeople(rows, "", filters({ maxKinship: 8 }), ctx).map((r) => r.name)).toEqual(["Marija Kovačič", "Marko Novak"]);
  });

  it("combines a query with facets", () => {
    expect(searchPeople(rows, "mar", filters({ sex: "M" }), noCtx).map((r) => r.name)).toEqual(["Marko Novak"]);
  });
});

describe("hasActiveFilters", () => {
  it("is false for the default filters", () => {
    expect(hasActiveFilters(NO_FILTERS)).toBe(false);
  });
  it("is true when any facet is set", () => {
    expect(hasActiveFilters(filters({ sex: "M" }))).toBe(true);
    expect(hasActiveFilters(filters({ place: "kranj" }))).toBe(true);
    expect(hasActiveFilters(filters({ edited: true }))).toBe(true);
    expect(hasActiveFilters(filters({ maxKinship: 4 }))).toBe(true);
  });
});

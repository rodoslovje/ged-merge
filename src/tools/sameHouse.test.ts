import { describe, expect, it } from "vitest";
import { findSameHouse } from "./sameHouse";
import type { AddressRow } from "./addresses";

function row(over: Partial<AddressRow> & Pick<AddressRow, "place" | "address">): AddressRow {
  return {
    key: `${over.place}\0${over.address}`,
    rawKeys: [`${over.place}\0${over.address}`],
    queries: [],
    count: 1,
    covered: 0,
    people: [],
    ...over,
  };
}

/** The joins as "written → what it would become". */
function joins(rows: AddressRow[]): string[] {
  const found = findSameHouse(rows);
  return rows.filter((r) => found.has(r.key)).map((r) => `${r.address} → ${found.get(r.key)!.address}`);
}

const BREG = "Breg ob Savi, Kranj, Slovenija";

describe("findSameHouse", () => {
  it("reads a house name in brackets as the same house", () => {
    // The case that raised this: ten events at the house and two at the house
    // with the farm name the researcher noted, on two lines that never said
    // they were one door.
    const plain = row({ place: BREG, address: "Breg ob Savi 26", count: 10 });
    const noted = row({ place: BREG, address: "Breg ob Savi 26 (pd Mlinar)", count: 2 });
    expect(joins([plain, noted])).toEqual(["Breg ob Savi 26 → Breg ob Savi 26 (pd Mlinar)"]);
  });

  it("joins a house recorded under one of its names to the one under both", () => {
    // A street Kranj renamed: the fuller value keeps the name the parish wrote
    // and the name the register knows, and a row naming only one of them is
    // that same house recorded once in passing.
    const both = row({ place: "Kranj, Kranj, Slovenija", address: "Labore 4 / Škofjeloška 4", count: 3 });
    const old = row({ place: "Kranj, Kranj, Slovenija", address: "Labore 4", count: 1 });
    const now = row({ place: "Kranj, Kranj, Slovenija", address: "Škofjeloška 4", count: 1 });
    expect(joins([both, old, now]).sort()).toEqual([
      "Labore 4 → Labore 4 / Škofjeloška 4",
      "Škofjeloška 4 → Labore 4 / Škofjeloška 4",
    ]);
  });

  it("joins one street written short, and one written in another case", () => {
    const short = row({ place: "Kranj, Kranj, Slovenija", address: "Kidričeva 38", count: 1 });
    const full = row({ place: "Kranj, Kranj, Slovenija", address: "Kidričeva cesta 38", count: 4 });
    const lower = row({ place: BREG, address: "breg ob savi 26", count: 1 });
    const proper = row({ place: BREG, address: "Breg ob Savi 26", count: 9 });
    expect(joins([short, full]).concat(joins([lower, proper]))).toEqual([
      "Kidričeva 38 → Kidričeva cesta 38",
      // Equal in every other way, so the spelling the file mostly uses wins:
      // nine events are the house's name, one is the slip.
      "breg ob savi 26 → Breg ob Savi 26",
    ]);
  });

  it("never joins across places, however alike the houses read", () => {
    const here = row({ place: "Loka, Tržič, Slovenija", address: "Loka 4" });
    const there = row({ place: "Loka, Starše, Slovenija", address: "Loka 4 (pd Kovač)" });
    expect(joins([here, there])).toEqual([]);
  });

  it("leaves two different notes alone", () => {
    // Which name the house went by is a question for the researcher, not a
    // spelling to sweep up — and joining either way would lose one of them.
    const mill = row({ place: BREG, address: "Breg ob Savi 26 (pd Mlinar)", count: 2 });
    const smith = row({ place: BREG, address: "Breg ob Savi 26 (pd Kovač)", count: 2 });
    expect(joins([mill, smith])).toEqual([]);
  });

  it("does not join two houses that merely share a street", () => {
    const four = row({ place: "Kranj, Kranj, Slovenija", address: "Kidričeva cesta 4" });
    const forty = row({ place: "Kranj, Kranj, Slovenija", address: "Kidričeva cesta 40" });
    expect(joins([four, forty])).toEqual([]);
  });

  it("follows a chain to the fullest spelling", () => {
    // "26" is the same house as "26 (pd Mlinar)", which is the same house as
    // the value naming both of the street's names — every row answers with the
    // one the file writes most fully, not with the next rung.
    const fullest = row({ place: BREG, address: "Breg ob Savi 26 / Mlinska 26 (pd Mlinar)", count: 1 });
    const noted = row({ place: BREG, address: "Breg ob Savi 26 (pd Mlinar)", count: 2 });
    const plain = row({ place: BREG, address: "Breg ob Savi 26", count: 10 });
    const found = findSameHouse([plain, noted, fullest]);
    expect(found.get(plain.key)?.address).toBe("Breg ob Savi 26 / Mlinska 26 (pd Mlinar)");
    expect(found.get(noted.key)?.address).toBe("Breg ob Savi 26 / Mlinska 26 (pd Mlinar)");
    expect(found.has(fullest.key)).toBe(false);
  });
});

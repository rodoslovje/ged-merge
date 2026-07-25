import { describe, expect, it } from "vitest";
import { buildRnFilter, parseHouseNumbers, rnFeaturesToResults, rnQueriesFrom } from "./rn";

describe("rnQueriesFrom", () => {
  it("reads village numbering out of PLAC alone", () => {
    // The common Slovenian shape: the hišna številka is in PLAC, no ADDR at all.
    // No street — the register hangs such numbers off the settlement.
    expect(rnQueriesFrom("Šentvid pri Stični 23, Slovenija", undefined)).toEqual([{
      settlement: "Šentvid pri Stični",
      number: 23,
    }]);
    expect(rnQueriesFrom("Bled 4a", undefined)).toEqual([{ settlement: "Bled", number: 4, suffix: "a" }]);
  });

  it("combines a settlement from PLAC with a street from ADDR", () => {
    expect(rnQueriesFrom("Kranj, Slovenija", "Kidričeva cesta 38/a")).toEqual([{
      settlement: "Kranj",
      street: "Kidričeva cesta",
      number: 38,
      suffix: "a",
    }]);
    // A bare number in ADDR still resolves against PLAC's settlement.
    expect(rnQueriesFrom("Šentvid pri Stični, Slovenija", "23")).toEqual([{
      settlement: "Šentvid pri Stični",
      number: 23,
    }]);
  });

  it("separates street from settlement however they are packed", () => {
    // Brother's Keeper packed form: street lands in `.street`.
    expect(rnQueriesFrom("Kranj (Slovenija), Kidričeva 38/a", undefined)).toEqual([{
      settlement: "Kranj",
      street: "Kidričeva",
      number: 38,
      suffix: "a",
    }]);
    // Street first, town second: the street-shaped level must not become the
    // settlement, or the query matches every number 38 in the country.
    expect(rnQueriesFrom("Kidričeva cesta 38, Kranj, Slovenija", undefined)).toEqual([{
      settlement: "Kranj",
      street: "Kidričeva cesta",
      number: 38,
    }]);
    // Only jurisdiction levels beyond the first become fallbacks; the country is
    // never one of them.
    expect(rnQueriesFrom("Bled, Gorenjska, Slovenija", "Mlinska cesta 4")).toEqual([
      { settlement: "Bled", street: "Mlinska cesta", number: 4, altSettlements: ["Gorenjska"] },
    ]);
  });

  it("returns one query per number for a renumbered house", () => {
    // "Hafnarjeva pot 21a / 53" in Stražišče: both houses are offered, and the
    // researcher picks. The street is shared by both queries.
    // Kranj rides along as a fallback: the register files Hafnarjeva pot under
    // naselje Kranj, not the historical village Stražišče the record names.
    expect(rnQueriesFrom("Stražišče,Kranj,Slovenia", "Hafnarjeva pot 21a / 53")).toEqual([
      { settlement: "Stražišče", street: "Hafnarjeva pot", number: 21, suffix: "a", altSettlements: ["Kranj"] },
      { settlement: "Stražišče", street: "Hafnarjeva pot", number: 53, altSettlements: ["Kranj"] },
    ]);
  });

  it("declines when it cannot form a sound query", () => {
    expect(rnQueriesFrom("Bled, Slovenija", undefined)).toEqual([]); // no house number
    expect(rnQueriesFrom("Slovenska cesta 9", undefined)).toEqual([]); // street but no town
    expect(rnQueriesFrom("Wien, Austria", "Ringstrasse 1")).toEqual([]); // not Slovenia
    expect(rnQueriesFrom(undefined, undefined)).toEqual([]);
  });
});

describe("parseHouseNumbers", () => {
  it("splits a renumbered house into every number it names", () => {
    // The numbering changed over the years and the record keeps both; which is
    // which isn't recorded, so both are looked up.
    expect(parseHouseNumbers("21a / 53")).toEqual([{ number: 21, suffix: "a" }, { number: 53 }]);
    expect(parseHouseNumbers("82 / 63 / 11")).toEqual([{ number: 82 }, { number: 63 }, { number: 11 }]);
  });

  it("keeps a subdivision suffix with its own number", () => {
    // A slash before a letter is part of the number, not a separator.
    expect(parseHouseNumbers("38/a")).toEqual([{ number: 38, suffix: "a" }]);
    expect(parseHouseNumbers("23")).toEqual([{ number: 23 }]);
    expect(parseHouseNumbers("12a")).toEqual([{ number: 12, suffix: "a" }]);
  });

  it("drops duplicates and unusable values", () => {
    expect(parseHouseNumbers("7 / 7")).toEqual([{ number: 7 }]);
    expect(parseHouseNumbers("")).toEqual([]);
    expect(parseHouseNumbers("brez")).toEqual([]);
  });
});

describe("buildRnFilter", () => {
  it("matches settlement and number exactly, street as a prefix", () => {
    // Files abbreviate ("Kidričeva" for the register's "Kidričeva cesta"), so
    // the street is a prefix match while the rest is exact.
    expect(buildRnFilter({ settlement: "Kranj", street: "Kidričeva", number: 38, suffix: "a" })).toBe(
      "NASELJE_NAZIV='Kranj' AND HS_STEVILKA=38 AND ULICA_NAZIV LIKE 'Kidričeva%' AND HS_DODATEK='a'",
    );
  });

  it("requires village numbering and a null suffix when neither is given", () => {
    // ULICA_NAZIV IS NULL is what keeps "Bled 4" from matching house 4 on all
    // nine streets of Bled; the null suffix keeps it from matching 4a/4b/4c.
    expect(buildRnFilter({ settlement: "Bled", number: 4 })).toBe(
      "NASELJE_NAZIV='Bled' AND HS_STEVILKA=4 AND ULICA_NAZIV IS NULL AND HS_DODATEK IS NULL",
    );
  });

  it("drops the village-numbering clause only when explicitly widened", () => {
    expect(buildRnFilter({ settlement: "Bled", number: 4 }, { anyStreet: true })).toBe(
      "NASELJE_NAZIV='Bled' AND HS_STEVILKA=4 AND HS_DODATEK IS NULL",
    );
    // A known street already constrains the query, so anyStreet changes nothing.
    expect(buildRnFilter({ settlement: "Bled", street: "Mlinska", number: 4 }, { anyStreet: true })).toContain(
      "ULICA_NAZIV LIKE 'Mlinska%'",
    );
  });

  it("escapes quotes so an apostrophe cannot break the filter", () => {
    expect(buildRnFilter({ settlement: "O'Hara", number: 1 })).toContain("NASELJE_NAZIV='O''Hara'");
  });
});

describe("rnFeaturesToResults", () => {
  const feature = (props: Record<string, unknown>) => ({ properties: props });

  it("projects D96 coordinates and labels a village address", () => {
    const [r] = rnFeaturesToResults({
      features: [
        feature({
          NASELJE_NAZIV: "Šentvid pri Stični",
          ULICA_NAZIV: null,
          HS_STEVILKA: 23,
          HS_DODATEK: null,
          POSTNI_OKOLIS_SIFRA: 1296,
          POSTNI_OKOLIS_NAZIV: "Šentvid pri Stični",
          E: 487111,
          N: 90009,
        }),
      ],
    });
    expect(r.coord.lat).toBeCloseTo(45.949786, 5);
    expect(r.coord.lon).toBeCloseTo(14.833745, 5);
    // No street, so the settlement carries the number.
    expect(r.address).toBe("Šentvid pri Stični 23");
    expect(r.label).toBe("Šentvid pri Stični 23, 1296 Šentvid pri Stični");
  });

  it("collapses apartment rows sharing one building coordinate", () => {
    // Slovenska cesta 9 is 80 register rows — one per flat — at one coordinate.
    const rows = [2, 5, 13].map((flat) =>
      feature({
        NASELJE_NAZIV: "Ljubljana",
        ULICA_NAZIV: "Slovenska cesta",
        HS_STEVILKA: 9,
        ST_STANOVANJA: flat,
        POSTNI_OKOLIS_SIFRA: 1000,
        POSTNI_OKOLIS_NAZIV: "Ljubljana",
        E: 461390,
        N: 101020,
      }),
    );
    const results = rnFeaturesToResults({ features: rows });
    expect(results).toHaveLength(1);
    expect(results[0].address).toBe("Slovenska cesta 9");
    expect(results[0].label).toBe("Slovenska cesta 9, Ljubljana, 1000 Ljubljana");
  });

  it("drops rows with a missing or implausible coordinate", () => {
    expect(
      rnFeaturesToResults({
        features: [
          feature({ NASELJE_NAZIV: "Bled", HS_STEVILKA: 1, E: null, N: null }),
          feature({ NASELJE_NAZIV: "Bled", HS_STEVILKA: 1, E: 0, N: 0 }),
          feature({ NASELJE_NAZIV: "Bled", HS_STEVILKA: 1 }),
        ],
      }),
    ).toEqual([]);
  });
});

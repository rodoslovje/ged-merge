import { describe, expect, it } from "vitest";
import { buildRnFilter, rnFeaturesToResults, rnQueryFrom } from "./rn";

describe("rnQueryFrom", () => {
  it("reads village numbering out of PLAC alone", () => {
    // The common Slovenian shape: the hišna številka is in PLAC, no ADDR at all.
    // No street — the register hangs such numbers off the settlement.
    expect(rnQueryFrom("Šentvid pri Stični 23, Slovenija", undefined)).toEqual({
      settlement: "Šentvid pri Stični",
      number: 23,
    });
    expect(rnQueryFrom("Bled 4a", undefined)).toEqual({ settlement: "Bled", number: 4, suffix: "a" });
  });

  it("combines a settlement from PLAC with a street from ADDR", () => {
    expect(rnQueryFrom("Kranj, Slovenija", "Kidričeva cesta 38/a")).toEqual({
      settlement: "Kranj",
      street: "Kidričeva cesta",
      number: 38,
      suffix: "a",
    });
    // A bare number in ADDR still resolves against PLAC's settlement.
    expect(rnQueryFrom("Šentvid pri Stični, Slovenija", "23")).toEqual({
      settlement: "Šentvid pri Stični",
      number: 23,
    });
  });

  it("separates street from settlement however they are packed", () => {
    // Brother's Keeper packed form: street lands in `.street`.
    expect(rnQueryFrom("Kranj (Slovenija), Kidričeva 38/a", undefined)).toEqual({
      settlement: "Kranj",
      street: "Kidričeva",
      number: 38,
      suffix: "a",
    });
    // Street first, town second: the street-shaped level must not become the
    // settlement, or the query matches every number 38 in the country.
    expect(rnQueryFrom("Kidričeva cesta 38, Kranj, Slovenija", undefined)).toEqual({
      settlement: "Kranj",
      street: "Kidričeva cesta",
      number: 38,
    });
  });

  it("declines when it cannot form a sound query", () => {
    expect(rnQueryFrom("Bled, Slovenija", undefined)).toBeUndefined(); // no house number
    expect(rnQueryFrom("Slovenska cesta 9", undefined)).toBeUndefined(); // street but no town
    expect(rnQueryFrom("Wien, Austria", "Ringstrasse 1")).toBeUndefined(); // not Slovenia
    expect(rnQueryFrom(undefined, undefined)).toBeUndefined();
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

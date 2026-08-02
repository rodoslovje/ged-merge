import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRnFilter,
  hostAsSettlement,
  parseHouseNumbers,
  preferParentMunicipality,
  requireParentMunicipality,
  resultsForQuery,
  rnFeaturesToResults,
  rnQueriesFrom,
} from "./rn";

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
      {
        settlement: "Bled",
        street: "Mlinska cesta",
        number: 4,
        altSettlements: ["Gorenjska"],
        parents: ["Gorenjska"],
      },
    ]);
  });

  it("returns one query per number for a renumbered house", () => {
    // "Hafnarjeva pot 21a / 53" in Stražišče: both houses are offered, and the
    // researcher picks. The street is shared by both queries.
    // Kranj rides along as a fallback: the register files Hafnarjeva pot under
    // naselje Kranj, not the historical village Stražišče the record names.
    expect(rnQueriesFrom("Stražišče,Kranj,Slovenia", "Hafnarjeva pot 21a / 53")).toEqual([
      {
        settlement: "Stražišče",
        street: "Hafnarjeva pot",
        number: 21,
        suffix: "a",
        altSettlements: ["Kranj"],
        parents: ["Kranj"],
      },
      {
        settlement: "Stražišče",
        street: "Hafnarjeva pot",
        number: 53,
        altSettlements: ["Kranj"],
        parents: ["Kranj"],
      },
    ]);
  });

  it("declines when it cannot form a sound query", () => {
    expect(rnQueriesFrom("Bled, Slovenija", undefined)).toEqual([]); // no house number
    expect(rnQueriesFrom("Slovenska cesta 9", undefined)).toEqual([]); // street but no town
    expect(rnQueriesFrom("Wien, Austria", "Ringstrasse 1")).toEqual([]); // not Slovenia
    expect(rnQueriesFrom(undefined, undefined)).toEqual([]);
  });
});

describe("rnQueriesFrom and an abbreviated settlement", () => {
  it("reads the file's short form of the settlement as village numbering", () => {
    // The register calls it "Sadinja vas pri Dvoru"; the file writes the address
    // as "Sadinja vas 9". Read as a street that finds nothing — and the short
    // form is itself a different real settlement, so the fallback misses too.
    expect(rnQueriesFrom("Sadinja vas pri Dvoru, Žužemberk, Slovenija", "Sadinja vas 9")).toEqual([
      { settlement: "Sadinja vas pri Dvoru", number: 9, altSettlements: ["Žužemberk"], parents: ["Žužemberk"] },
    ]);
  });

  it("still calls a real street a street", () => {
    expect(rnQueriesFrom("Kranj, Slovenija", "Kidričeva cesta 38")).toEqual([
      { settlement: "Kranj", street: "Kidričeva cesta", number: 38 },
    ]);
    // A one-word prefix is not an abbreviation — "Zgornje" alone says nothing.
    expect(rnQueriesFrom("Zgornje Bitnje, Kranj, Slovenija", "Zgornje 4")[0]).toMatchObject({
      street: "Zgornje",
    });
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

describe("hostAsSettlement", () => {
  it("re-reads a settlement-shaped host as the settlement itself", () => {
    // "Klošter 12" filed under Gradac: no Gradac street is called Klošter —
    // Klošter is its own naselje, which is what the register is asked next.
    expect(hostAsSettlement({ settlement: "Gradac", street: "Klošter", number: 12, altSettlements: ["Metlika"] })).toEqual({
      settlement: "Klošter",
      number: 12,
    });
  });

  it("declines a real street and an address with no street at all", () => {
    expect(hostAsSettlement({ settlement: "Kranj", street: "Kidričeva cesta", number: 38 })).toBeUndefined();
    expect(hostAsSettlement({ settlement: "Bled", number: 4 })).toBeUndefined();
  });

  it("keeps the municipality the guess must answer to", () => {
    // Without this the guessed naselje is searched country-wide: "Klanec 2" of a
    // Kranj record comes back as Klanec near Komenda, 20 km away.
    expect(
      hostAsSettlement({ settlement: "Kranj", street: "Klanec", number: 2, parents: ["Kranj"] }),
    ).toEqual({ settlement: "Klanec", number: 2, parents: ["Kranj"] });
  });
});

describe("municipality scoping", () => {
  /** Names the stubbed register answers as real občine. */
  const municipalities = new Set<string>();
  const fetchMock = vi.fn(async (url: string | URL) => {
    const name = decodeURIComponent(String(url)).match(/OBCINA_NAZIV='([^']*)'/)?.[1] ?? "";
    return {
      ok: true,
      json: async () => ({ features: municipalities.has(name) ? [{ properties: {} }] : [] }),
    } as unknown as Response;
  });

  beforeEach(() => {
    municipalities.clear();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const hit = (settlement: string, municipality: string | undefined, lat: number) => ({
    coord: { lat, lon: 14.5 },
    address: `${settlement} 2`,
    label: `${settlement} 2`,
    settlement,
    ...(municipality ? { municipality } : {}),
    number: 2,
  });
  const klanecKomenda = hit("Klanec", "Komenda", 46.2109);
  const klanecKranj = hit("Klanec", "Kranj", 46.2409);

  it("keeps only the place's own municipality when the register offers both", () => {
    expect(preferParentMunicipality([klanecKomenda, klanecKranj], ["Kranj"])).toEqual([klanecKranj]);
    // Accent- and case-blind: the file's spelling need not be the register's.
    expect(preferParentMunicipality([klanecKomenda, klanecKranj], ["KRANJ"])).toEqual([klanecKranj]);
  });

  it("leaves the hits alone when the place names no municipality it knows", () => {
    // "Gorenjska" is a region, not an občina — it contradicts nothing, so a
    // preference must not turn it into a veto and lose the right house.
    expect(preferParentMunicipality([klanecKomenda], ["Gorenjska"])).toEqual([klanecKomenda]);
    expect(preferParentMunicipality([klanecKomenda], [])).toEqual([klanecKomenda]);
    expect(preferParentMunicipality([klanecKomenda], undefined)).toEqual([klanecKomenda]);
  });

  it("drops a namesake outright where the settlement name was our own guess", async () => {
    // A hit in the named občina answers without the register being consulted.
    expect(await requireParentMunicipality([klanecKomenda, klanecKranj], ["Kranj"])).toEqual([klanecKranj]);
    // Nothing named, nothing to check against — and no request made.
    expect(await requireParentMunicipality([klanecKomenda], undefined)).toEqual([klanecKomenda]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks the register whether the parent is an občina before discarding", async () => {
    // "Kranj" is one, so a Klanec filed under Komenda contradicts it and goes.
    municipalities.add("Kranj");
    expect(await requireParentMunicipality([klanecKomenda], ["Kranj"])).toEqual([]);
    // "Bela krajina" is a region the register does not keep, so it contradicts
    // nothing and the only hit there is stands.
    expect(await requireParentMunicipality([klanecKomenda], ["Bela krajina"])).toEqual([klanecKomenda]);
    // Each name is settled once for the session, however often it is asked.
    expect(await requireParentMunicipality([klanecKomenda], ["Bela krajina"])).toEqual([klanecKomenda]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("carries the municipality from a place value into the query", () => {
    expect(rnQueriesFrom("Kranj,Kranj,Slovenia", "Klanec 2")).toEqual([
      { settlement: "Kranj", street: "Klanec", number: 2, altSettlements: ["Kranj"], parents: ["Kranj"] },
    ]);
  });
});

describe("rnFeaturesToResults", () => {
  const feature = (props: Record<string, unknown>) => ({ properties: props });

  it("carries the register's settlement and municipality", () => {
    // What tells a misfiled hamlet apart: the register's own naselje/občina,
    // regardless of which post office (here Gradac) the file went by.
    const [r] = rnFeaturesToResults({
      features: [
        feature({
          OBCINA_NAZIV: "Metlika",
          NASELJE_NAZIV: "Klošter",
          ULICA_NAZIV: null,
          HS_STEVILKA: 12,
          POSTNI_OKOLIS_SIFRA: 8332,
          POSTNI_OKOLIS_NAZIV: "Gradac",
          E: 518682,
          N: 53264,
        }),
      ],
    });
    expect(r.settlement).toBe("Klošter");
    expect(r.municipality).toBe("Metlika");
  });

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

describe("resultsForQuery", () => {
  /** A pooled batch result, as rnFeaturesToResults produces them. */
  const hit = (number: number, suffix: string | undefined, lat: number) => ({
    coord: { lat, lon: 14.3 },
    address: `Srednje Bitnje ${number}${suffix ?? ""}`,
    label: `Srednje Bitnje ${number}${suffix ?? ""}, 4000 Kranj`,
    settlement: "Srednje Bitnje",
    number,
    ...(suffix ? { suffix } : {}),
  });

  // One batched request answers the whole place, so asking for "4" also brings
  // back 4a/4b — each row must take only the houses that are its own. The pool
  // is keyed by the settlement+street the group was fetched under.
  const pool = new Map([
    ["Srednje Bitnje\u0000", [hit(2, undefined, 46.21), hit(4, undefined, 46.22), hit(4, "a", 46.23), hit(5, "b", 46.24)]],
  ]);

  it("gives a row only the number and suffix it asked for", () => {
    expect(resultsForQuery([{ settlement: "Srednje Bitnje", number: 4 }], pool).map((r) => r.address)).toEqual([
      "Srednje Bitnje 4",
    ]);
    expect(resultsForQuery([{ settlement: "Srednje Bitnje", number: 4, suffix: "a" }], pool).map((r) => r.address)).toEqual([
      "Srednje Bitnje 4a",
    ]);
  });

  it("falls back to the bare number for a suffix the register lacks", () => {
    // The file says "2b"; the register knows only 2. Same retry the per-address
    // ladder makes, but without another request.
    expect(resultsForQuery([{ settlement: "Srednje Bitnje", number: 2, suffix: "b" }], pool).map((r) => r.address)).toEqual([
      "Srednje Bitnje 2",
    ]);
  });

  it("returns both houses of a renumbered address, deduplicated", () => {
    const rows = resultsForQuery(
      [
        { settlement: "Srednje Bitnje", number: 4 },
        { settlement: "Srednje Bitnje", number: 5, suffix: "b" },
        { settlement: "Srednje Bitnje", number: 4 },
      ],
      pool,
    );
    expect(rows.map((r) => r.address)).toEqual(["Srednje Bitnje 4", "Srednje Bitnje 5b"]);
  });

  it("returns nothing when the batch cannot answer the row", () => {
    expect(resultsForQuery([{ settlement: "Srednje Bitnje", number: 99 }], pool)).toEqual([]);
  });

  it("never answers a row with a house fetched for another settlement", () => {
    // The defect this keying exists for: one pool held every group's hits and
    // rows claimed them by house number alone, so "Sadinja Vas 5" was answered
    // by the "Vrtača 5" fetched for a different address of the same place.
    const mixed = new Map([
      ["Vrtača\u0000", [{ ...hit(5, undefined, 45.65), settlement: "Vrtača", address: "Vrtača 5" }]],
      ["Sadinja vas pri Dvoru\u0000", [{ ...hit(9, undefined, 45.83), settlement: "Sadinja vas pri Dvoru" }]],
    ]);
    expect(resultsForQuery([{ settlement: "Vrtača", street: "Sadinja Vas", number: 5 }], mixed)).toEqual([]);
    expect(resultsForQuery([{ settlement: "Vrtača", number: 5 }], mixed).map((r) => r.address)).toEqual(["Vrtača 5"]);
  });
});

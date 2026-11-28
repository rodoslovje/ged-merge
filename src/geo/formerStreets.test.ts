import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formerNameLabel,
  formerStreetPlaces,
  formerStreetsOf,
  mergeFormerStreets,
  parseFormerStreets,
  type FormerStreet,
} from "./formerStreets";

const TABLE: FormerStreet[] = [
  { settlement: "Ljubljana", former: "Aleksandrova cesta", from: 1919, to: 1941, current: "Cankarjeva cesta" },
  { settlement: "Ljubljana", former: "Šmartinska cesta", from: 1876, to: 1923, current: "Njegoševa cesta" },
  { settlement: "Ljubljana", former: "Bleiweisova cesta", from: 1897, to: 1941, current: "Prešernova cesta" },
  { settlement: "Ljubljana", former: "Bleiweisova cesta", from: 1954, to: 1991, current: "Slovenska cesta" },
];

vi.mock("./formerStreets", async (original) => ({
  ...(await original<typeof import("./formerStreets")>()),
  storedFormerStreets: async () => TABLE,
}));

const { searchAddress, searchAddresses, searchAddressBatch, resultsForQuery, searchStreet, streetQueryFrom, rnQueriesFrom } = await import("./rn");

describe("parseFormerStreets", () => {
  it("reads the table, whichever separator the file uses", () => {
    const rows = [
      "settlement;former_name;from;to;current_name",
      "Ljubljana;Aleksandrova cesta;1919;1941;Cankarjeva cesta",
      "Ljubljana;Skojevska ulica;;;Zelenova ulica",
    ];
    const expected = [
      { settlement: "Ljubljana", former: "Aleksandrova cesta", from: 1919, to: 1941, current: "Cankarjeva cesta" },
      { settlement: "Ljubljana", former: "Skojevska ulica", current: "Zelenova ulica" },
    ];
    expect(parseFormerStreets(rows.join("\n"))).toEqual(expected);
    expect(parseFormerStreets(rows.join("\r\n").replaceAll(";", ","))).toEqual(expected);
  });

  it("finds its columns by name, in any order, and skips a row missing a name", () => {
    expect(
      parseFormerStreets("Current_Name,note,Former_Name,Settlement\nCankarjeva cesta,x,Aleksandrova cesta,Ljubljana\n,x,Stara,Ljubljana\n"),
    ).toEqual([{ settlement: "Ljubljana", former: "Aleksandrova cesta", current: "Cankarjeva cesta" }]);
  });

  it("refuses a file that is not such a table", () => {
    expect(parseFormerStreets("")).toBeUndefined();
    expect(parseFormerStreets("name,latitude,longitude\nLjubljana,46,14.5\n")).toBeUndefined();
  });
});

describe("formerStreetsOf", () => {
  it("finds the street by its old name, written whole or short", () => {
    expect(formerStreetsOf(TABLE, "Aleksandrova cesta", ["Ljubljana"]).map((e) => e.current)).toEqual(["Cankarjeva cesta"]);
    expect(formerStreetsOf(TABLE, "aleksandrova", ["Ljubljana"]).map((e) => e.current)).toEqual(["Cankarjeva cesta"]);
  });

  it("answers with every street that bore the name", () => {
    expect(formerStreetsOf(TABLE, "Bleiweisova cesta", ["Ljubljana"]).map((e) => e.current)).toEqual([
      "Prešernova cesta",
      "Slovenska cesta",
    ]);
  });

  it("looks in any of the settlements the address may sit in, and in no other", () => {
    expect(formerStreetsOf(TABLE, "Aleksandrova cesta", ["Šiška", "Ljubljana"])).toHaveLength(1);
    expect(formerStreetsOf(TABLE, "Aleksandrova cesta", ["Maribor"])).toEqual([]);
  });

  it("leaves out the street the written name is today", () => {
    expect(formerStreetsOf(TABLE, "Cankarjeva cesta", ["Ljubljana"])).toEqual([]);
    expect(formerStreetsOf(TABLE, "Slovenska cesta", ["Ljubljana"])).toEqual([]);
  });
});

describe("mergeFormerStreets", () => {
  it("adds another town's table and replaces a town loaded again", () => {
    const kranj: FormerStreet[] = [{ settlement: "Kranj", former: "Titov trg", from: 1945, to: 1993, current: "Glavni trg" }];
    const both = mergeFormerStreets(TABLE, kranj);
    expect(both).toHaveLength(TABLE.length + 1);
    expect(formerStreetPlaces(both)).toBe("Ljubljana, Kranj");
    const corrected: FormerStreet[] = [{ settlement: "kranj", former: "Mestni trg", to: 1941, current: "Glavni trg" }];
    expect(mergeFormerStreets(both, corrected).filter((e) => e.current === "Glavni trg")).toEqual(corrected);
  });
});

describe("formerNameLabel", () => {
  it("shows the years as far as they are known", () => {
    expect(formerNameLabel({ name: "Aleksandrova cesta", from: 1919, to: 1941 })).toBe("Aleksandrova cesta (1919–1941)");
    expect(formerNameLabel({ name: "Aleksandrova cesta", from: 1919 })).toBe("Aleksandrova cesta (1919–)");
    expect(formerNameLabel({ name: "Skojevska ulica" })).toBe("Skojevska ulica");
  });
});

describe("an address written under a former street name", () => {
  const house = (street: string, number: number, E: number, N: number) => ({
    properties: { NASELJE_NAZIV: "Ljubljana", OBCINA_NAZIV: "Ljubljana", ULICA_NAZIV: street, HS_STEVILKA: number, E, N },
  });
  // Today's register: no Aleksandrova cesta at all, and a Šmartinska cesta that
  // is not the street that bore the name in 1876.
  const REGISTER = [
    house("Cankarjeva cesta", 5, 461800, 101300),
    house("Cankarjeva cesta", 7, 461820, 101310),
    house("Njegoševa cesta", 5, 463500, 101400),
    house("Šmartinska cesta", 5, 464200, 102500),
  ];
  const fetchMock = vi.fn(async (url: string | URL) => {
    const filter = decodeURIComponent(String(url));
    const street = filter.match(/ULICA_NAZIV LIKE '([^']*)%'/)?.[1];
    const numbers = filter.match(/HS_STEVILKA(?:=| IN \()([\d,]+)/)?.[1].split(",").map(Number);
    const features =
      street && filter.includes("NASELJE_NAZIV='Ljubljana'")
        ? REGISTER.filter(
            (f) => f.properties.ULICA_NAZIV.startsWith(street) && (!numbers || numbers.includes(f.properties.HS_STEVILKA)),
          )
        : [];
    return { ok: true, json: async () => ({ features }) } as unknown as Response;
  });
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("answers with the middle of the street's current name, and says under which name", async () => {
    const hits = await searchAddress({ settlement: "Ljubljana", street: "Aleksandrova cesta", number: 5 });
    expect(hits).toHaveLength(1);
    // The street, not its number 5: the street may have been renumbered since.
    expect(hits[0]).toMatchObject({
      address: "Cankarjeva cesta",
      street: "Cankarjeva cesta",
      number: 5,
      former: { name: "Aleksandrova cesta", from: 1919, to: 1941 },
    });
    expect(hits[0].label).toBe("Cankarjeva cesta, Ljubljana ← Aleksandrova cesta (1919–1941)");
    const [street] = await searchStreet({ settlement: "Ljubljana", street: "Cankarjeva cesta" });
    expect(street.houses).toBe(2);
    expect(hits[0].coord).toEqual(street.coord);
  });

  it("offers the house as written and the renamed street when the old name is another street's today", async () => {
    const hits = await searchAddress({ settlement: "Ljubljana", street: "Šmartinska cesta", number: 5 });
    expect(hits.map((h) => [h.address, h.former?.name])).toEqual([
      ["Šmartinska cesta 5", undefined],
      ["Njegoševa cesta", "Šmartinska cesta"],
    ]);
  });

  it("finds it for a suburb the file names under the town", async () => {
    const [query] = rnQueriesFrom("Šiška, Ljubljana, Slovenija", "Aleksandrova cesta 5");
    expect((await searchAddress(query)).map((h) => h.address)).toEqual(["Cankarjeva cesta"]);
  });

  it("answers a current street name exactly as before", async () => {
    const hits = await searchAddress({ settlement: "Ljubljana", street: "Cankarjeva cesta", number: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].former).toBeUndefined();
  });

  it("answers a whole batch the same way, every row of the street with its middle", async () => {
    const q5 = { settlement: "Ljubljana", street: "Aleksandrova cesta", number: 5 };
    const q9 = { settlement: "Ljubljana", street: "Aleksandrova cesta", number: 9, suffix: "a" };
    const pool = await searchAddressBatch([q5, q9]);
    expect(resultsForQuery([q5], pool).map((h) => h.address)).toEqual(["Cankarjeva cesta"]);
    // A number today's street does not have is on the street all the same.
    expect(resultsForQuery([q9], pool)).toMatchObject([
      { address: "Cankarjeva cesta", former: { name: "Aleksandrova cesta" } },
    ]);
  });

  it("finds a former street written short, with no house and under the town's own občina", async () => {
    const query = streetQueryFrom("Ljubljana, Ljubljana, Slovenija", "Aleksandrova");
    const streets = await searchStreet(query!);
    expect(streets).toHaveLength(1);
    expect(streets[0]).toMatchObject({ street: "Cankarjeva cesta", municipality: "Ljubljana" });
  });

  it("still finds the street once the address names both, the number on the former one", async () => {
    const queries = rnQueriesFrom("Ljubljana, Slovenija", "Cankarjeva cesta / Aleksandrova cesta 5");
    expect(queries).toMatchObject([{ settlement: "Ljubljana", street: "Aleksandrova cesta", number: 5 }]);
    expect((await searchAddress(queries[0])).map((h) => h.address)).toEqual(["Cankarjeva cesta"]);
  });

  it("answers with the house once the file writes its number on today's name too", async () => {
    const queries = rnQueriesFrom("Ljubljana, Slovenija", "Cankarjeva cesta 7 / Aleksandrova cesta 5");
    const hits = await searchAddresses(queries);
    // One answer: today's number 7, known to be the Aleksandrova cesta 5 of the record.
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      address: "Cankarjeva cesta 7",
      number: 5,
      former: { name: "Aleksandrova cesta", from: 1919, to: 1941 },
    });
    expect(hits[0].label).toContain("← Aleksandrova cesta (1919–1941)");
    const [asWritten] = await searchAddress({ settlement: "Ljubljana", street: "Cankarjeva cesta", number: 7 });
    expect(hits[0].coord).toEqual(asWritten.coord);
  });

  it("keeps to the street's middle for a number today's street does not have", async () => {
    const queries = rnQueriesFrom("Ljubljana, Slovenija", "Cankarjeva cesta 9 / Aleksandrova cesta 5");
    expect((await searchAddresses(queries)).map((h) => h.address)).toEqual(["Cankarjeva cesta"]);
  });

  it("reads a street written under both its names by the first of them", async () => {
    const query = streetQueryFrom("Ljubljana, Slovenija", "Cankarjeva cesta / Aleksandrova cesta");
    expect(query).toMatchObject({ settlement: "Ljubljana", street: "Cankarjeva cesta" });
    const streets = await searchStreet(query!);
    expect(streets.map((s) => [s.street, s.former])).toEqual([["Cankarjeva cesta", undefined]]);
  });

  it("places a former street that is named without a house", async () => {
    const streets = await searchStreet({ settlement: "Ljubljana", street: "Aleksandrova cesta" });
    expect(streets).toHaveLength(1);
    expect(streets[0]).toMatchObject({ street: "Cankarjeva cesta", houses: 2, former: { name: "Aleksandrova cesta" } });
  });
});

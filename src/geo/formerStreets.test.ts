import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formerNameLabel, formerStreetsOf, parseFormerStreets, type FormerStreet } from "./formerStreets";

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

const { searchAddress, searchAddressBatch, resultsForQuery, searchStreet, streetQueryFrom, rnQueriesFrom } = await import("./rn");

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

  it("finds the house on the street's current name and says under which name", async () => {
    const hits = await searchAddress({ settlement: "Ljubljana", street: "Aleksandrova cesta", number: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      address: "Cankarjeva cesta 5",
      street: "Cankarjeva cesta",
      former: { name: "Aleksandrova cesta", from: 1919, to: 1941 },
    });
    expect(hits[0].label).toBe("Cankarjeva cesta 5, Ljubljana ← Aleksandrova cesta (1919–1941)");
  });

  it("offers both houses when the old name is another street's name today", async () => {
    const hits = await searchAddress({ settlement: "Ljubljana", street: "Šmartinska cesta", number: 5 });
    expect(hits.map((h) => [h.address, h.former?.name])).toEqual([
      ["Šmartinska cesta 5", undefined],
      ["Njegoševa cesta 5", "Šmartinska cesta"],
    ]);
  });

  it("finds it for a suburb the file names under the town", async () => {
    const [query] = rnQueriesFrom("Šiška, Ljubljana, Slovenija", "Aleksandrova cesta 5");
    expect((await searchAddress(query)).map((h) => h.address)).toEqual(["Cankarjeva cesta 5"]);
  });

  it("answers a current street name exactly as before", async () => {
    const hits = await searchAddress({ settlement: "Ljubljana", street: "Cankarjeva cesta", number: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0].former).toBeUndefined();
  });

  it("answers a whole batch the same way, each row with its own number", async () => {
    const q5 = { settlement: "Ljubljana", street: "Aleksandrova cesta", number: 5 };
    const q7 = { settlement: "Ljubljana", street: "Aleksandrova cesta", number: 7 };
    const pool = await searchAddressBatch([q5, q7]);
    expect(resultsForQuery([q5], pool).map((h) => h.address)).toEqual(["Cankarjeva cesta 5"]);
    expect(resultsForQuery([q7], pool)[0]).toMatchObject({
      address: "Cankarjeva cesta 7",
      former: { name: "Aleksandrova cesta" },
    });
  });

  it("finds a former street written short, with no house and under the town's own občina", async () => {
    const query = streetQueryFrom("Ljubljana, Ljubljana, Slovenija", "Aleksandrova");
    const streets = await searchStreet(query!);
    expect(streets).toHaveLength(1);
    expect(streets[0]).toMatchObject({ street: "Cankarjeva cesta", municipality: "Ljubljana" });
  });

  it("places a former street that is named without a house", async () => {
    const streets = await searchStreet({ settlement: "Ljubljana", street: "Aleksandrova cesta" });
    expect(streets).toHaveLength(1);
    expect(streets[0]).toMatchObject({ street: "Cankarjeva cesta", houses: 2, former: { name: "Aleksandrova cesta" } });
  });
});

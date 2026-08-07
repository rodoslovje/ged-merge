import { afterEach, describe, expect, it, vi } from "vitest";
import { osmKindLabel, osmNamesPlace, osmShortLabel, parseNominatimResponse, searchNominatim } from "./nominatim";

describe("parseNominatimResponse", () => {
  it("maps jsonv2 rows to coordinates with short and full labels", () => {
    const rows = [
      { lat: "46.2389", lon: "14.3556", name: "Kranj", display_name: "Kranj, Gorenjska, Slovenija", type: "town" },
      { lat: "46.0511", lon: "14.5051", name: "", display_name: "Cesta 1, Ljubljana, Slovenija", type: "house" },
    ];
    expect(parseNominatimResponse(rows)).toEqual([
      // The chain's next level up rides along, so the row can show "Kranj
      // (Gorenjska)" rather than the whole line.
      { coord: { lat: 46.2389, lon: 14.3556 }, name: "Kranj", label: "Kranj, Gorenjska, Slovenija", admin: "Gorenjska", kind: "town" },
      // No own name: the display name's head becomes the pick label.
      { coord: { lat: 46.0511, lon: 14.5051 }, name: "Cesta 1", label: "Cesta 1, Ljubljana, Slovenija", admin: "Ljubljana", kind: "house" },
    ]);
  });

  it("shows a house's municipality, not its street, as the parent", () => {
    // For a house the display line's second segment is the road — putting it
    // in the slot the UI reserves for the administrative parent read like a
    // municipality named "Kidričeva cesta". The structured parts are the real
    // jurisdiction; the display line is only the fallback.
    const rows = [
      {
        lat: "46.2389",
        lon: "14.3556",
        name: "38",
        display_name: "38, Kidričeva cesta, Kranj, 4000 Kranj, Slovenija",
        type: "house",
        address: { house_number: "38", road: "Kidričeva cesta", city: "Kranj", municipality: "Kranj" },
      },
    ];
    expect(parseNominatimResponse(rows)[0].admin).toBe("Kranj");
  });

  it("leaves the parent off when there is none, or it repeats the name", () => {
    const rows = [
      { lat: "46", lon: "14", name: "Slovenija", display_name: "Slovenija" },
      { lat: "46", lon: "14", name: "Kranj", display_name: "Kranj, Kranj, Slovenija" },
    ];
    expect(parseNominatimResponse(rows).map((r) => r.admin)).toEqual([undefined, undefined]);
  });

  it("reads the structured address parts when the row carries them", () => {
    const rows = [
      {
        lat: "46.2456",
        lon: "14.3312",
        name: "21",
        display_name: "21, Hafnarjeva pot, Stražišče, Kranj, 4000 Kranj, Slovenija",
        type: "house",
        address: {
          house_number: "21",
          road: "Hafnarjeva pot",
          village: "Stražišče",
          municipality: "Kranj",
          postcode: "4000",
          country: "Slovenija",
          country_code: "si",
        },
      },
    ];
    expect(parseNominatimResponse(rows)[0].parts).toEqual({
      house: "21",
      road: "Hafnarjeva pot",
      locality: "Stražišče",
      admin: "Kranj",
      country: "Slovenija",
    });
  });

  it("leaves the parts off entirely when the row has no address block", () => {
    const rows = [{ lat: "46", lon: "14", name: "Kranj", display_name: "Kranj, Slovenija" }];
    expect(parseNominatimResponse(rows)[0].parts).toBeUndefined();
  });

  it("drops malformed rows and tolerates a non-array body", () => {
    expect(
      parseNominatimResponse([
        { lat: "not-a-number", lon: "14", display_name: "X" },
        { lat: "46", lon: "14", display_name: "" },
      ]),
    ).toEqual([]);
    expect(parseNominatimResponse({ error: "Unable to geocode" })).toEqual([]);
    expect(parseNominatimResponse(undefined)).toEqual([]);
  });
});

describe("osmShortLabel", () => {
  it("composes name and placing parts, skipping quarters, units and postcodes", () => {
    const [r] = parseNominatimResponse([
      {
        lat: "46.1",
        lon: "14.5",
        name: "Sv. Jakob",
        display_name:
          "Sv. Jakob, Stanežiče, Gunclje, Četrtna skupnost Šentvid, Stanežiče, Ljubljana, Upravna Enota Ljubljana, 1210, Slovenia",
        type: "chapel",
        address: { village: "Stanežiče", municipality: "Ljubljana", postcode: "1210", country: "Slovenia" },
      },
    ]);
    expect(osmShortLabel(r)).toBe("Sv. Jakob, Stanežiče, Ljubljana, Slovenia");
  });

  it("folds a house's own number into its street line, and collapses repeats", () => {
    const [r] = parseNominatimResponse([
      {
        lat: "46.2",
        lon: "14.3",
        name: "21",
        display_name: "21, Hafnarjeva pot, Stražišče, Kranj, Kranj, 4000, Slovenija",
        type: "house",
        address: {
          house_number: "21",
          road: "Hafnarjeva pot",
          village: "Stražišče",
          municipality: "Kranj",
          city: "Kranj",
          country: "Slovenija",
        },
      },
    ]);
    expect(osmShortLabel(r)).toBe("Hafnarjeva pot 21, Stražišče, Kranj, Slovenija");
  });

  it("falls back to the display line without structured parts", () => {
    const [r] = parseNominatimResponse([
      { lat: "46", lon: "14", name: "Kranj", display_name: "Kranj, Gorenjska, Slovenija" },
    ]);
    expect(osmShortLabel(r)).toBe("Kranj, Gorenjska, Slovenija");
  });
});

describe("osmKindLabel", () => {
  // The case this exists for: OpenStreetMap answers "Huje, Kranj" with the
  // suburb, the street named after it and a service road off that street —
  // three rows whose display lines are word for word identical.
  const raw = [
    { lat: "46.2424", lon: "14.3614", name: "Huje", display_name: "Huje, Kranj, 4000, Slovenija", category: "place", type: "suburb" },
    { lat: "46.2408", lon: "14.3591", name: "Huje", display_name: "Huje, Kranj, 4000, Slovenija", category: "highway", type: "residential" },
    { lat: "46.2423", lon: "14.3597", name: "Huje", display_name: "Huje, Kranj, 4000, Slovenija", category: "highway", type: "service" },
  ];
  // Stands in for i18next: the keys these entries would resolve, nothing else.
  const strings: Record<string, string> = {
    "osm.kind.suburb": "suburb",
    "osm.kind.highway.residential": "residential street",
    "osm.kind.highway.service": "service road",
  };
  const t = (key: string, opts?: Record<string, unknown>) =>
    strings[key] ?? (opts?.defaultValue as string) ?? key;

  it("names what each hit is, so identical display lines are told apart", () => {
    const results = parseNominatimResponse(raw);
    expect(results.map((r) => osmKindLabel(r, t))).toEqual(["suburb", "residential street", "service road"]);
  });

  it("falls back to OpenStreetMap's own words for a pair with no translation", () => {
    const [quarry] = parseNominatimResponse([
      { lat: "46", lon: "14", name: "X", display_name: "X", category: "landuse", type: "quarry" },
    ]);
    expect(osmKindLabel(quarry, t)).toBe("quarry");
    const [track] = parseNominatimResponse([
      { lat: "46", lon: "14", name: "Y", display_name: "Y", category: "highway", type: "byway" },
    ]);
    expect(osmKindLabel(track, t)).toBe("byway road");
    const [isolated] = parseNominatimResponse([
      { lat: "46", lon: "14", name: "Z", display_name: "Z", category: "place", type: "isolated_dwelling" },
    ]);
    expect(osmKindLabel(isolated, t)).toBe("isolated dwelling");
  });

  it("says nothing when the service gave no type", () => {
    const [bare] = parseNominatimResponse([{ lat: "46", lon: "14", name: "Q", display_name: "Q" }]);
    expect(osmKindLabel(bare, t)).toBe("");
  });
});

describe("osmNamesPlace", () => {
  // The real answer to "Čirče 5, Kranj, Slovenija": house number 5 of a village
  // on the other side of the municipality, with not a word of Čirče in it.
  const [stray] = parseNominatimResponse([
    {
      lat: "46.20983",
      lon: "14.38831",
      name: "5",
      display_name: "5, Breg ob Savi, Drulovka, Mavčiče, Kranj, 4211, Slovenija",
      category: "building",
      type: "yes",
      address: { house_number: "5", hamlet: "Breg ob Savi", municipality: "Kranj" },
    },
  ]);
  const [real] = parseNominatimResponse([
    {
      lat: "46.22566",
      lon: "14.37088",
      name: "Čirče",
      display_name: "Čirče, Kranj, 4000, Slovenija",
      category: "place",
      type: "suburb",
      address: { suburb: "Čirče", municipality: "Kranj" },
    },
  ]);

  it("rejects an answer that names none of the address asked for", () => {
    expect(osmNamesPlace(stray, "Čirče")).toBe(false);
    expect(osmNamesPlace(real, "Čirče")).toBe(true);
  });

  it("matches the name wherever the answer carries it, accents aside", () => {
    // The road, the locality and the display chain all count, folded.
    expect(osmNamesPlace(stray, "Breg ob Savi")).toBe(true);
    expect(osmNamesPlace(real, "circe")).toBe(true);
    expect(osmNamesPlace(real, "")).toBe(true);
  });
});

describe("searchNominatim failure paths", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("a failed request rejects its caller without wedging the shared queue", async () => {
    // All requests flow through one module-level throttle queue: the failure
    // must reject only its own caller, and the next request must still run.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue({ ok: true, json: async () => [] } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchNominatim("Kranj", "sl")).rejects.toThrow("network down");
    const second = searchNominatim("Bled", "sl");
    await vi.advanceTimersByTimeAsync(1500); // the 1 req/s spacing
    await expect(second).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an HTTP error retries once, then surfaces as a rejection", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 503, headers: new Headers() } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const p = searchNominatim("Kranj", "sl");
    // The queue spacing, then geoFetch's one polite retry pause.
    await vi.advanceTimersByTimeAsync(1500);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(p).rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a rate-limited request honours Retry-After and succeeds on the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "Retry-After": "2" }),
      } as unknown as Response)
      .mockResolvedValue({ ok: true, json: async () => [] } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    const p = searchNominatim("Kranj", "sl");
    await vi.advanceTimersByTimeAsync(1500); // queue spacing
    await vi.advanceTimersByTimeAsync(2000); // the server's own Retry-After
    await expect(p).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it } from "vitest";
import {
  GURS_REGISTER,
  HIGH_CONFIDENCE,
  attachAdmin1Names,
  buildGazetteerIndex,
  lookupPlace,
  mergeDivisions,
  osmRegister,
  overpassFailure,
  overpassSubdivisions,
  overpassToEntries,
  parseGeoNamesLine,
  rpeNaseljaToEntries,
  rpeObcinaNames,
  searchGazetteer,
  subdivisionAdmin1,
  type GazEntry,
} from "./gazetteer";
import { formatCoordValue } from "../gedcom/edit";

// A few realistic GeoNames rows (19 tab-separated columns).
const ROWS = [
  "3197378\tKranj\tKranj\tKranj,Krainburg\t46.23887\t14.35561\tP\tPPLA\tSI\t\t52\t\t\t\t37941\t\t388\tEurope/Ljubljana\t2019-09-05",
  "3190535\tŠkofja Loka\tSkofja Loka\tBischoflack\t46.16551\t14.30613\tP\tPPLA\tSI\t\t122\t\t\t\t11987\t\t354\tEurope/Ljubljana\t2019-09-05",
  "3239110\tLjubljana\tLjubljana\tLaibach,Lubiana\t46.05108\t14.50513\tP\tPPLC\tSI\t\t61\t\t\t\t272220\t\t299\tEurope/Ljubljana\t2019-09-05",
  "2778067\tGraz\tGraz\tGradec\t47.06667\t15.45\tP\tPPLA\tAT\t\t6\t\t\t\t222326\t\t363\tEurope/Vienna\t2019-09-05",
  "3199771\tBistrica\tBistrica\t\t46.29861\t14.16278\tP\tPPL\tSI\t\t52\t\t\t\t600\t\t420\tEurope/Ljubljana\t2019-09-05",
  "3204800\tBistrica\tBistrica\t\t45.95\t15.45\tP\tPPL\tSI\t\t9\t\t\t\t500\t\t150\tEurope/Ljubljana\t2019-09-05",
  "1000001\tKranj\tKranj\t\t46.239\t14.355\tA\tADM2\tSI\t\t52\t\t\t\t56000\t\t388\tEurope/Ljubljana\t2019-09-05",
  "9999999\tSomething\tSomething\t\t46.0\t14.0\tS\tCH\tSI\t\t52\t\t\t\t0\t\t300\tEurope/Ljubljana\t2019-09-05",
];

function entries(): GazEntry[] {
  return ROWS.map(parseGeoNamesLine).filter((e): e is GazEntry => !!e);
}

describe("parseGeoNamesLine", () => {
  it("parses P and A rows, skips other feature classes", () => {
    const es = entries();
    expect(es).toHaveLength(7); // the S/CH row is dropped
    const kranj = es[0];
    expect(kranj.name).toBe("Kranj");
    expect(kranj.lat).toBeCloseTo(46.23887);
    expect(kranj.country).toBe("SI");
    expect(kranj.population).toBe(37941);
    expect(kranj.alt).toContain("Krainburg");
  });

  it("rejects malformed rows", () => {
    expect(parseGeoNamesLine("garbage")).toBeUndefined();
    expect(parseGeoNamesLine("1\tX\tX\t\tnot-a-number\t14\tP\tPPL\tSI\t\t\t\t\t\t0\t\t\t\t")).toBeUndefined();
  });

  it("keeps the feature code on admin divisions only", () => {
    const es = entries();
    expect(es.find((e) => e.fclass === "A")?.fcode).toBe("ADM2");
    expect(es.filter((e) => e.fclass === "P").every((e) => e.fcode === undefined)).toBe(true);
  });
});

describe("attachAdmin1Names", () => {
  // A Croatian extract in miniature: the county (ADM1) row, a town inside it,
  // a town in another county whose ADM1 row is missing, and the county seat
  // sharing the county's name stem.
  const HR_ROWS = [
    "3337515\tPrimorsko-Goranska Županija\tPrimorsko-Goranska Zupanija\tPrimorje-Gorski Kotar,Primorsko-goranska\t45.31667\t14.81667\tA\tADM1\tHR\t\t12\t\t\t\t296195\t\t500\tEurope/Zagreb\t2019-09-05",
    "3191648\tRavna Gora\tRavna Gora\t\t45.37417\t14.93944\tP\tPPL\tHR\t\t12\t\t\t\t1709\t\t800\tEurope/Zagreb\t2019-09-05",
    "3186952\tZagreb\tZagreb\tAgram\t45.81444\t15.97798\tP\tPPLC\tHR\t\t21\t\t\t\t698966\t\t130\tEurope/Zagreb\t2019-09-05",
    "3191281\tDelnice\tDelnice\t\t45.39833\t14.79861\tA\tADM2\tHR\t\t12\t\t\t\t5952\t\t700\tEurope/Zagreb\t2019-09-05",
  ];

  it("labels places with their ADM1 division's name", () => {
    const es = HR_ROWS.map(parseGeoNamesLine).filter((e): e is GazEntry => !!e);
    const divisions = attachAdmin1Names(es);
    // Every name the division goes by, primary first — the alternate spellings
    // are what the file-side parent match reads.
    expect(divisions["12"]).toEqual([
      "Primorsko-Goranska Županija",
      "Primorsko-Goranska Zupanija",
      "Primorje-Gorski Kotar",
      "Primorsko-goranska",
    ]);
    expect(es.find((e) => e.name === "Ravna Gora")?.admin).toBe("Primorsko-Goranska Županija");
    // The ADM2 entry sits in the county too, and gets the same label.
    expect(es.find((e) => e.name === "Delnice")?.admin).toBe("Primorsko-Goranska Županija");
    // No ADM1 row for code 21 in the extract — left unlabelled, not guessed.
    expect(es.find((e) => e.name === "Zagreb")?.admin).toBeUndefined();
    // The division row itself repeats its own name — says nothing, left off.
    expect(es.find((e) => e.fcode === "ADM1")?.admin).toBeUndefined();
  });

  it("never overwrites an admin name another source set", () => {
    const es = HR_ROWS.map(parseGeoNamesLine).filter((e): e is GazEntry => !!e);
    const ravnaGora = es.find((e) => e.name === "Ravna Gora")!;
    ravnaGora.admin = "Gorski kotar";
    attachAdmin1Names(es);
    expect(ravnaGora.admin).toBe("Gorski kotar");
  });

  it("does nothing when the extract carries no ADM1 rows", () => {
    const es = entries();
    attachAdmin1Names(es);
    expect(es.every((e) => e.admin === undefined)).toBe(true);
  });

  it("lookupPlace recognizes the division under any of its names and answers in the file's spelling", () => {
    // Two same-named villages in different counties; the file names its county
    // in English ("Primorje-Gorski Kotar"), the entries store the Croatian
    // primary name — the divisions table is what connects the two.
    const es = HR_ROWS.map(parseGeoNamesLine).filter((e): e is GazEntry => !!e);
    es.push({ ...es.find((e) => e.name === "Ravna Gora")!, admin1: "21", admin: undefined, lat: 46.1 });
    const divisions = attachAdmin1Names(es);
    const index = buildGazetteerIndex(es, mergeDivisions([{ entries: es, divisions }]));
    const hits = lookupPlace(index, "Ravna Gora,Primorje-Gorski Kotar,Croatia");
    const [first, second] = hits.filter((h) => h.entry.name === "Ravna Gora");
    // The county's entry wins, labelled the way the file writes the county.
    expect(first.entry.admin1).toBe("12");
    expect(first.adminDisplay).toBe("Primorje-Gorski Kotar");
    expect(second.entry.admin1).toBe("21");
    expect(second.adminDisplay).toBeUndefined();
    expect(second.score).toBeLessThan(first.score);
  });
});

describe("lookupPlace", () => {
  const index = buildGazetteerIndex(entries());

  it("finds an exact name match with top score", () => {
    const c = lookupPlace(index, "Škofja Loka, Slovenija");
    expect(c[0].entry.name).toBe("Škofja Loka");
    expect(c[0].score).toBeGreaterThanOrEqual(0.95);
  });

  it("matches diacritic-insensitively via the ascii form", () => {
    const c = lookupPlace(index, "Skofja Loka");
    expect(c[0].entry.name).toBe("Škofja Loka");
  });

  it("matches historical exonyms via alternate names", () => {
    const c = lookupPlace(index, "Laibach");
    expect(c[0].entry.name).toBe("Ljubljana");
  });

  it("uses the locality part only (house numbers, hierarchy stripped)", () => {
    const c = lookupPlace(index, "Kranj 12, Kranj, Slovenija");
    expect(c[0].entry.name).toBe("Kranj");
  });

  it("excludes entries from a different stated country (hard gate)", () => {
    // Graz is Austrian; stated as being in Slovenia it must not match the
    // Austrian gazetteer entry — the country gate drops it entirely.
    expect(lookupPlace(index, "Graz, Slovenija")).toEqual([]);
    // The Austrian Graz is still found when the place agrees it's Austrian.
    expect(lookupPlace(index, "Graz, Austria")[0]?.entry.name).toBe("Graz");
  });

  it("does not fuzzy-match a foreign place onto a loaded country (Belfast → Bela)", () => {
    // "Northern Ireland" resolves to GB; with only SI/AT loaded, nothing
    // qualifies — better no proposal than a wrong Slovenian one.
    expect(lookupPlace(index, "Belfast, County Antrim, Northern Ireland")).toEqual([]);
  });

  it("fuzzy-matches misspellings when nothing matches exactly", () => {
    const c = lookupPlace(index, "Kranjj");
    expect(c[0]?.entry.name).toBe("Kranj");
    expect(c[0].score).toBeLessThan(0.95);
  });

  it("returns both same-named places, larger first", () => {
    const c = lookupPlace(index, "Bistrica");
    const bistricas = c.filter((x) => x.entry.name === "Bistrica");
    expect(bistricas).toHaveLength(2);
    expect(bistricas[0].entry.population).toBeGreaterThanOrEqual(bistricas[1].entry.population);
  });

  it("prefers the populated place over the same-named admin division", () => {
    const c = lookupPlace(index, "Kranj");
    expect(c[0].entry.fclass).toBe("P");
  });
});

describe("overpassToEntries", () => {
  it("converts place nodes with alternate-name tags, skips unnamed", () => {
    const { entries } = overpassToEntries(
      {
        elements: [
          { lat: 46.1655, lon: 14.3061, tags: { place: "town", name: "Škofja Loka", "name:de": "Bischoflack", population: "11987" } },
          { lat: 46.0, lon: 14.0, tags: { place: "hamlet" } },
          { lat: 46.2331, lon: 14.3308, tags: { place: "suburb", name: "Stražišče", old_name: "Strasisch;Straschische" } },
        ],
      },
      "SI",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: "Škofja Loka", alt: ["Bischoflack"], population: 11987, country: "SI", fclass: "P" });
    expect(entries[1].alt).toEqual(["Strasisch", "Straschische"]);
    // The converted entries match through the shared index like GeoNames rows.
    const index = buildGazetteerIndex(entries);
    expect(lookupPlace(index, "Bischoflack")[0].entry.name).toBe("Škofja Loka");
  });

  it("is stored under a key naming its source, leaving the entries' country alone", () => {
    // The storage key says where the directory came from, so an OSM download
    // sits beside a GeoNames "SI" import instead of overwriting it. The country
    // gate compares the entries' own country, which stays the bare ISO code.
    expect(osmRegister("SI")).toBe("SI-OSM");
    expect(osmRegister("at")).toBe("AT-OSM");
    expect(osmRegister("SI")).not.toBe(GURS_REGISTER);
    const [entry] = overpassToEntries(
      { elements: [{ lat: 46.05, lon: 14.5, tags: { place: "village", name: "Šentvid" } }] },
      "SI",
    ).entries;
    expect(entry.country).toBe("SI");
  });

  it("reads subdivision markers: places after one carry its name and code", () => {
    // The download queries emit each ISO 3166-2 boundary relation (no
    // coordinate) before its places; the names collected off the marker are
    // what lets a Croatian file say "Požega-Slavonia" and still match.
    const { entries, divisions } = overpassToEntries(
      {
        elements: [
          {
            tags: {
              "ISO3166-2": "HR-11",
              name: "Požeško-slavonska županija",
              "name:en": "Požega-Slavonia County",
              int_name: "Požega-Slavonia",
              boundary: "administrative",
            },
          },
          { lat: 45.4366, lon: 17.1936, tags: { place: "town", name: "Pakrac" } },
          { tags: { "ISO3166-2": "HR-08", name: "Primorsko-goranska županija", boundary: "administrative" } },
          { lat: 45.3742, lon: 14.9394, tags: { place: "town", name: "Ravna Gora" } },
        ],
      },
      "HR",
    );
    expect(entries[0]).toMatchObject({ name: "Pakrac", admin: "Požeško-slavonska županija", admin1: "11" });
    expect(entries[1]).toMatchObject({ name: "Ravna Gora", admin: "Primorsko-goranska županija", admin1: "08" });
    expect(divisions["11"]).toEqual(["Požeško-slavonska županija", "Požega-Slavonia", "Požega-Slavonia County"]);
  });
});

describe("a country too large for one Overpass query", () => {
  // Real shapes, shortened: this is exactly what the United States comes back
  // with. Both arrive as HTTP 200, and taken at face value both would import as
  // "a country with no places" — which is what the tool used to report.
  const TIMEOUT = `{"version": 0.6, "elements": [\n\n],\n"remark": "runtime error: Query timed out in \\"query\\" at line 1 after 201 seconds."}`;
  const BUSY = `<p><strong style="color:#FF0000">Error</strong>: runtime error: open64: 0 Success /osm3s_osm_base Dispatcher_Client::request_read_and_idx::timeout. The server is probably too busy to handle your request. </p>`;

  it("tells a timeout from a busy service, and both from a real answer", () => {
    // The distinction is what the caller acts on: too big means split it into
    // regions, busy means the same query will work later.
    expect(overpassFailure(TIMEOUT)).toBe("timeout");
    expect(overpassFailure(BUSY)).toBe("busy");
    expect(overpassFailure(`{"elements": [{"type":"node","lat":46,"lon":14,"tags":{"name":"Kranj"}}]}`)).toBeUndefined();
  });

  it("takes the coarsest subdivisions the country tags, named as tagged", () => {
    // France carries ISO codes on regions *and* departments; the offer is the
    // fewest downloads that still fit, so the regions win and the departments
    // under them are dropped.
    const list = overpassSubdivisions(
      {
        elements: [
          { tags: { "ISO3166-2": "FR-NOR", name: "Normandie", admin_level: "4" } },
          { tags: { "ISO3166-2": "FR-BRE", name: "Bretagne", admin_level: "4" } },
          { tags: { "ISO3166-2": "FR-14", name: "Calvados", admin_level: "6" } },
          { tags: { "ISO3166-2": "BE-VLG", name: "Vlaanderen", admin_level: "4" } },
          { tags: { name: "Unnamed code", admin_level: "4" } },
        ],
      },
      "FR",
    );
    expect(list).toEqual([
      { code: "FR-BRE", name: "Bretagne" },
      { code: "FR-NOR", name: "Normandie" },
    ]);
  });

  it("marks a region's entries with its own admin1 so a re-download replaces only itself", () => {
    expect(subdivisionAdmin1("US-CA")).toBe("CA");
    const [entry] = overpassToEntries(
      { elements: [{ lat: 34.05, lon: -118.24, tags: { place: "city", name: "Los Angeles" } }] },
      "US",
      subdivisionAdmin1("US-CA"),
    ).entries;
    // The country stays the bare ISO code — that is what the lookup gate reads,
    // so a region's places answer for "United States" like any other.
    expect(entry).toMatchObject({ country: "US", admin1: "CA" });
  });
});

describe("rpeNaseljaToEntries", () => {
  /** Closed ring of an axis-aligned box, in GeoJSON lon/lat order. */
  const box = (lon: number, lat: number, size: number) => [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ];

  it("reduces settlement polygons to their centroid and keeps the bilingual name", () => {
    const entries = rpeNaseljaToEntries({
      features: [
        { properties: { NAZIV: "Izola", NAZIV_DJ: "Isola" }, geometry: { type: "Polygon", coordinates: [box(13.6, 45.5, 0.2)] } },
        { properties: { NAZIV: "Bled", NAZIV_DJ: null }, geometry: { type: "Polygon", coordinates: [box(14.0, 46.3, 0.1)] } },
      ],
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: "Izola", alt: ["Isola"], country: "SI", fclass: "P", population: 0 });
    expect(entries[0].lon).toBeCloseTo(13.7, 6);
    expect(entries[0].lat).toBeCloseTo(45.6, 6);
    expect(entries[1].alt).toEqual([]);
    // The bilingual name resolves through the shared index, so an Italian
    // place string in an older record still finds the Slovenian settlement.
    expect(lookupPlace(buildGazetteerIndex(entries), "Isola")[0].entry.name).toBe("Izola");
  });

  it("ignores holes and picks the largest part of a multi-part settlement", () => {
    const [withHole, multi] = rpeNaseljaToEntries({
      features: [
        {
          properties: { NAZIV: "Luknja" },
          // Outer box plus an inner ring: the hole must not shift the centroid.
          geometry: { type: "Polygon", coordinates: [box(15.0, 46.0, 1), box(15.4, 46.4, 0.2)] },
        },
        {
          properties: { NAZIV: "Dvodelno" },
          geometry: {
            type: "MultiPolygon",
            coordinates: [[box(15.0, 46.0, 0.1)], [box(16.0, 46.0, 0.5)]],
          },
        },
      ],
    });
    expect(withHole.lon).toBeCloseTo(15.5, 6);
    expect(withHole.lat).toBeCloseTo(46.5, 6);
    // Centre of the bigger (0.5°) part, not of the small one or of both.
    expect(multi.lon).toBeCloseTo(16.25, 6);
    expect(multi.lat).toBeCloseTo(46.25, 6);
  });

  it("skips features without a usable name or geometry, and survives a degenerate ring", () => {
    const entries = rpeNaseljaToEntries({
      features: [
        { properties: { NAZIV: "  " }, geometry: { type: "Polygon", coordinates: [box(15, 46, 1)] } },
        { properties: { NAZIV: "Brez oblike" }, geometry: null },
        { properties: { NAZIV: "Točka" }, geometry: { type: "Point", coordinates: [15, 46] } },
        { properties: { NAZIV: "Pokvarjeno" }, geometry: { type: "Polygon", coordinates: [[[15, 46], ["x", 46], [15, 47]]] } },
        // Zero-area ring (collinear points) falls back to the vertex mean.
        {
          properties: { NAZIV: "Črta" },
          geometry: { type: "Polygon", coordinates: [[[15, 46], [15, 47], [15, 48], [15, 46]]] },
        },
      ],
    });
    expect(entries.map((e) => e.name)).toEqual(["Črta"]);
    expect(entries[0].lon).toBeCloseTo(15, 6);
    expect(entries[0].lat).toBeCloseTo(46.75, 6);
  });
});

describe("municipalities from the RPE join", () => {
  const box = (lon: number, lat: number, size: number) => [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ];
  /** The two Soteska the register really holds, with their EID_OBCINA. */
  const soteska = (obcine?: Map<string, string>) =>
    rpeNaseljaToEntries(
      {
        features: [
          {
            properties: { NAZIV: "Soteska", EID_OBCINA: "kamnik-id" },
            geometry: { type: "Polygon", coordinates: [box(14.64, 46.22, 0.01)] },
          },
          {
            properties: { NAZIV: "Soteska", EID_OBCINA: "dol-toplice-id" },
            geometry: { type: "Polygon", coordinates: [box(15.02, 45.78, 0.01)] },
          },
        ],
      },
      obcine,
    );

  const names = rpeObcinaNames({
    features: [
      { properties: { EID_OBCINA: "kamnik-id", NAZIV: "Kamnik" } },
      { properties: { EID_OBCINA: "dol-toplice-id", NAZIV: "Dolenjske Toplice" } },
      { properties: { EID_OBCINA: "no-name", NAZIV: "  " } },
      { properties: null },
    ],
  });

  it("reads the id→name table, skipping unusable rows", () => {
    expect([...names.entries()].sort()).toEqual([
      ["dol-toplice-id", "Dolenjske Toplice"],
      ["kamnik-id", "Kamnik"],
    ]);
  });

  it("names each settlement's municipality, and stays silent without the table", () => {
    expect(soteska(names).map((e) => e.admin)).toEqual(["Kamnik", "Dolenjske Toplice"]);
    expect(soteska().every((e) => e.admin === undefined)).toBe(true);
  });

  it("demotes the same name in a municipality the place does not mention", () => {
    const index = buildGazetteerIndex(soteska(names));
    // Both are perfect name matches, so without the municipality the row is
    // ambiguous and bulk-accept has to skip it.
    const blind = lookupPlace(buildGazetteerIndex(soteska()), "Soteska, Slovenija");
    expect(blind[0].score).toBeCloseTo(blind[1].score, 6);
    // Naming the občina settles it: the right one keeps its score, the other
    // drops clear of the ambiguity gap.
    const hits = lookupPlace(index, "Soteska, Kamnik, Slovenija");
    expect(hits[0].entry.admin).toBe("Kamnik");
    expect(hits[0].score).toBeGreaterThan(hits[1].score + 0.05);
  });

  it("leaves the tie alone when the place names neither municipality", () => {
    const hits = lookupPlace(buildGazetteerIndex(soteska(names)), "Soteska, Šentjakob ob Savi, Slovenija");
    expect(hits[0].score).toBeCloseTo(hits[1].score, 6);
  });
});

describe("searchGazetteer", () => {
  const entry = (name: string, over: Partial<GazEntry> = {}): GazEntry => ({
    name, ascii: "", alt: [], lat: 46, lon: 14, fclass: "P", country: "SI", admin1: "", population: 100, ...over,
  });

  it("offers prefix matches before merely contained ones", () => {
    const index = buildGazetteerIndex([
      entry("Spodnje Zabukovje"),
      entry("Zabukovje pri Sevnici"),
      entry("Zabukovje"),
    ]);
    // Exact first, then the prefix, then the name that only contains the text.
    expect(searchGazetteer(index, "Zabukovje").map((e) => e.name)).toEqual([
      "Zabukovje",
      "Zabukovje pri Sevnici",
      "Spodnje Zabukovje",
    ]);
  });

  it("matches diacritics and alternate names, and honours the limit", () => {
    const index = buildGazetteerIndex([
      entry("Škofja Loka", { alt: ["Bischoflack"] }),
      entry("Škocjan"),
      entry("Škale"),
    ]);
    expect(searchGazetteer(index, "skofja").map((e) => e.name)).toEqual(["Škofja Loka"]);
    expect(searchGazetteer(index, "Bischoflack").map((e) => e.name)).toEqual(["Škofja Loka"]);
    expect(searchGazetteer(index, "Šk", 2)).toHaveLength(2);
  });

  it("ranks the official register above a crowd-sourced twin and drops the duplicate", () => {
    const index = buildGazetteerIndex([
      entry("Bled", { lat: 46.368, lon: 14.108 }),
      entry("Bled", { lat: 46.369, lon: 14.109, register: GURS_REGISTER, admin: "Bled" }),
    ]);
    const hits = searchGazetteer(index, "Bled");
    expect(hits).toHaveLength(1);
    expect(hits[0].register).toBe(GURS_REGISTER);
  });

  it("keeps a named country out of another country's gazetteer, and ignores one-letter queries", () => {
    const index = buildGazetteerIndex([entry("Bela"), entry("Bela pri Ločah")]);
    expect(searchGazetteer(index, "Bela, Austria")).toHaveLength(0);
    expect(searchGazetteer(index, "Bela, Slovenija")).toHaveLength(2);
    expect(searchGazetteer(index, "B")).toHaveLength(0);
  });
});

describe("two gazetteers loaded for one country", () => {
  const osm = (name: string, lat: number, lon: number, population = 5000): GazEntry => ({
    name, ascii: "", alt: [], lat, lon, fclass: "P", country: "SI", admin1: "", population,
  });

  it("collapses the same settlement seen by both, keeping the authoritative coordinate", () => {
    // An OpenStreetMap "SI" import and the GURS register both carry Bled.
    const gurs = rpeNaseljaToEntries({
      features: [
        {
          properties: { NAZIV: "Bled" },
          geometry: { type: "Polygon", coordinates: [[[14.09, 46.36], [14.11, 46.36], [14.11, 46.38], [14.09, 46.38], [14.09, 46.36]]] },
        },
      ],
    });
    const index = buildGazetteerIndex([osm("Bled", 46.3683, 14.1132, 5181), ...gurs]);
    const hits = lookupPlace(index, "Bled");
    // One candidate, not two near-identical twins — otherwise the tied scores
    // make the row look ambiguous and bulk-accept skips it.
    expect(hits).toHaveLength(1);
    expect(hits[0].entry.register).toBe(GURS_REGISTER);
    expect(hits[0].entry.lon).toBeCloseTo(14.1, 6);
    expect(hits[0].score).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
  });

  it("keeps same-named places that are genuinely far apart", () => {
    const index = buildGazetteerIndex([osm("Log", 46.05, 14.3), osm("Log", 46.5, 15.6)]);
    expect(lookupPlace(index, "Log")).toHaveLength(2);
  });
});

describe("formatCoordValue", () => {
  it("writes hemisphere-prefixed trimmed decimals", () => {
    expect(formatCoordValue(46.23887, "lat")).toBe("N46.23887");
    expect(formatCoordValue(-12.5, "lat")).toBe("S12.5");
    expect(formatCoordValue(14.355610001, "lon")).toBe("E14.35561");
    expect(formatCoordValue(-70, "lon")).toBe("W70");
  });
});

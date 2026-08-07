import { describe, expect, it } from "vitest";
import {
  DGU_REGISTER,
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
  rgiCountyIndex,
  rgiPlacesToEntries,
  rpeNaseljaToEntries,
  rpeObcinaNames,
  searchGazetteer,
  storedEntries,
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

  it("storedEntries labels each entry with its directory's full id", () => {
    const entry = (name: string, country: string, register?: string): GazEntry => ({
      name, ascii: "", alt: [], lat: 45, lon: 15, fclass: "P", country, admin1: "", population: 0,
      ...(register ? { register } : {}),
    });
    const flat = storedEntries([
      { code: "HR", entries: [entry("Pakrac", "HR")] },
      { code: "HR-OSM", entries: [entry("Pakrac", "HR")] },
      { code: GURS_REGISTER, entries: [entry("Bled", "SI", GURS_REGISTER)] },
    ]);
    // GeoNames (store key = the bare country) keeps its plain country badge,
    // the OSM download is named in full, a register entry keeps its register.
    expect(flat.map((e) => e.register ?? e.source ?? e.country)).toEqual(["HR", "HR-OSM", GURS_REGISTER]);
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

/** One feature of the DGU register of geographical names. */
const row = (
  im_id: number | null,
  pisanje_imena: string,
  over: { jeziknaziv?: string; status_imena?: string; og_ime?: string; lon?: number; lat?: number } = {},
) => ({
  properties: {
    im_id,
    pisanje_imena,
    jeziknaziv: over.jeziknaziv ?? "Hrvatski",
    status_imena: over.status_imena ?? "službeno",
    og_ime: over.og_ime ?? "KONAVLE",
  },
  geometry: { type: "Point", coordinates: [over.lon ?? 18.36, over.lat ?? 42.51] },
});

describe("rgiPlacesToEntries", () => {
  it("takes each place's point, its municipality and its register mark", () => {
    const entries = rgiPlacesToEntries({ features: [row(1, "Mihatovići", { lon: 18.366, lat: 42.512 })] });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "Mihatovići",
      alt: [],
      country: "HR",
      fclass: "P",
      population: 0,
      register: DGU_REGISTER,
      // Recased from the register's "KONAVLE".
      admin: "Konavle",
    });
    expect(entries[0].lon).toBeCloseTo(18.366, 6);
    expect(entries[0].lat).toBeCloseTo(42.512, 6);
  });

  it("recases a shouted municipality, leaves a written-out one, drops one that repeats the place", () => {
    const [novigrad, sesvete, split] = rgiPlacesToEntries({
      features: [
        row(1, "Novigrad", { og_ime: "NOVIGRAD - CITTANOVA" }),
        row(2, "Sesvete", { og_ime: "Grad Zagreb" }),
        row(3, "Split", { og_ime: "SPLIT" }),
      ],
    });
    expect(novigrad.admin).toBe("Novigrad - Cittanova");
    expect(sesvete.admin).toBe("Grad Zagreb");
    expect(split.admin).toBeUndefined();
  });

  it("folds a place's several names into one entry, the official Croatian one leading", () => {
    const entries = rgiPlacesToEntries({
      features: [
        row(7, "Vörösmart", { jeziknaziv: "Mađarski" }),
        row(7, "Zmajevac"),
        row(7, "Змајевац", { jeziknaziv: "Srpski" }),
        row(7, "Zmajevac", { status_imena: "povijesno" }),
      ],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("Zmajevac");
    // Every other spelling stays reachable, without repeating the primary.
    expect(entries[0].alt).toEqual(["Vörösmart", "Змајевац"]);
    // …and resolves through the index, so a Hungarian place string in an older
    // record still finds the Croatian settlement.
    expect(lookupPlace(buildGazetteerIndex(entries), "Vörösmart")[0].entry.name).toBe("Zmajevac");
  });

  it("falls back through official-in-any-language to the first row", () => {
    const [italian, unofficial] = rgiPlacesToEntries({
      features: [
        row(1, "Antanel", { jeziknaziv: "Talijanski" }),
        row(2, "Stara Peć", { status_imena: "povijesno" }),
        row(2, "Nova Peć", { status_imena: "ostalo" }),
      ],
    });
    expect(italian.name).toBe("Antanel");
    expect(unofficial.name).toBe("Stara Peć");
    expect(unofficial.alt).toEqual(["Nova Peć"]);
  });

  it("skips rows with no name or no usable point, and never groups two under a missing id", () => {
    const entries = rgiPlacesToEntries({
      features: [
        row(1, "   "),
        { properties: { im_id: 2, pisanje_imena: "Bez oblika" }, geometry: null },
        { properties: { im_id: 3, pisanje_imena: "Poligon" }, geometry: { type: "Polygon", coordinates: [[[15, 46]]] } },
        { properties: { im_id: 4, pisanje_imena: "Pokvareno" }, geometry: { type: "Point", coordinates: ["x", 46] } },
        row(null, "Prvi"),
        row(null, "Drugi"),
      ],
    });
    expect(entries.map((e) => e.name)).toEqual(["Prvi", "Drugi"]);
  });
});

describe("rgiPlacesToEntries and the register's cities", () => {
  const city = (im_id: number, name: string, over: { og_ime?: string; lon?: number; lat?: number } = {}) => {
    const f = row(im_id, name, over);
    return { ...f, properties: { ...f.properties, vrstaobiljezjaid: 321 } };
  };
  const settlement = (im_id: number, name: string, over: { og_ime?: string; lon?: number; lat?: number } = {}) => {
    const f = row(im_id, name, over);
    return { ...f, properties: { ...f.properties, vrstaobiljezjaid: 234 } };
  };

  it("drops a city that repeats a settlement of its own name nearby", () => {
    // The register pins Samobor's city 5 km off its settlement, and parents the
    // two differently — one place, written twice.
    const entries = rgiPlacesToEntries({
      features: [
        city(1, "Samobor", { og_ime: "Zagrebačka županija", lon: 15.6462, lat: 45.788 }),
        settlement(2, "Samobor", { og_ime: "SAMOBOR", lon: 15.7092, lat: 45.8019 }),
      ],
    });
    expect(entries).toHaveLength(1);
    // The survivor is the settlement: pinned in the town, and parented by its
    // own municipality — which, repeating its name, shows no parent at all.
    expect(entries[0].lon).toBeCloseTo(15.7092, 6);
    expect(entries[0].admin).toBeUndefined();
  });

  it("keeps a city the register files under no settlement at all", () => {
    // Pula, Buje and Poreč are exactly this: only the city kind names them.
    const entries = rgiPlacesToEntries({
      features: [city(1, "Pula", { og_ime: "Istarska županija", lon: 13.8481, lat: 44.8666 })],
    });
    expect(entries.map((e) => e.name)).toEqual(["Pula"]);
  });

  it("keeps a city whose namesake settlement is a different place far away", () => {
    // The city of Otok in Vukovar-Srijem against the villages called Otok — 200
    // km apart, and both real.
    const entries = rgiPlacesToEntries({
      features: [
        city(1, "Otok", { og_ime: "Vukovarsko-srijemska županija", lon: 18.88, lat: 45.15 }),
        settlement(2, "Otok", { og_ime: "OTOK", lon: 16.7, lat: 43.49 }),
      ],
    });
    expect(entries).toHaveLength(2);
  });

  it("recovers the bare name of a bilingual one written as a single string", () => {
    const [buje, bale, tar] = rgiPlacesToEntries({
      features: [
        // The register holds the joined form and one half; the other half —
        // the name a file writes — appears nowhere.
        city(1, "Buje-Buie", { og_ime: "BUJE - BUIE" }),
        city(1, "Buie", { og_ime: "BUJE - BUIE" }),
        // Not even a half here: the spaced hyphen in the municipality is what
        // says this is a language pair and not a compound name.
        settlement(2, "Bale-Valle", { og_ime: "BALE - VALLE" }),
        settlement(3, "Tar-Tore", { og_ime: "TAR-VABRIGA - TORRE-ABREGA" }),
      ],
    });
    expect(buje.alt).toEqual(["Buie", "Buje"]);
    expect(bale.alt).toEqual(["Bale", "Valle"]);
    expect(tar.alt).toEqual(["Tar", "Tore"]);
  });

  it("leaves a genuinely hyphenated name alone", () => {
    const entries = rgiPlacesToEntries({
      features: [
        // A compound municipality name: one hyphen, no spaces, one language.
        settlement(1, "Ivanić-Grad", { og_ime: "IVANIĆ-GRAD" }),
        settlement(2, "Vojnić-Breg", { og_ime: "BEDEKOVČINA" }),
        settlement(3, "Sveti Vid-Miholjice", { og_ime: "MALINSKA-DUBAŠNICA" }),
        // A bilingual pair of compounds — which half belongs to which language
        // is not something the hyphens say, so it stays whole.
        settlement(4, "Kaštelir-Labinci-Castelliere-S.Domenica", {
          og_ime: "KAŠTELIR-LABINCI - CASTELLIERE-S. DOMENICA",
        }),
      ],
    });
    expect(entries.every((e) => e.alt.length === 0)).toBe(true);
  });

  it("treats a feature with no kind as a settlement", () => {
    const entries = rgiPlacesToEntries({ features: [row(1, "Bez vrste")] });
    expect(entries.map((e) => e.name)).toEqual(["Bez vrste"]);
  });
});

describe("the DGU county join", () => {
  const zupanije = {
    features: [
      { properties: { id: 8, naziv: "Primorsko-goranska županija", rb: 8 } },
      { properties: { id: 11, naziv: "Požeško-slavonska županija", rb: 11 } },
      { properties: { id: 21, naziv: "Grad Zagreb", rb: 21 } },
      { properties: { id: 99, naziv: "  " } },
    ],
  };
  const opcine = {
    features: [
      { properties: { og_ime: "RAVNA GORA", zupanija_id: 8 } },
      { properties: { og_ime: "LIPIK", zupanija_id: 11 } },
      // The same municipality name in two counties — the register really has
      // three of these, and neither county may claim it.
      { properties: { og_ime: "OTOK", zupanija_id: 8 } },
      { properties: { og_ime: "OTOK", zupanija_id: 11 } },
      { properties: { og_ime: "NEZNANO", zupanija_id: 404 } },
    ],
  };

  it("keys municipalities by county, drops the ambiguous ones, and knows the counties themselves", () => {
    const { byUnit, divisions } = rgiCountyIndex(opcine, zupanije);
    expect(byUnit.get("RAVNA GORA")).toBe("08");
    expect(byUnit.get("LIPIK")).toBe("11");
    expect(byUnit.has("OTOK")).toBe(false);
    expect(byUnit.has("NEZNANO")).toBe(false);
    // A city-county's places name the county where others name a municipality.
    expect(byUnit.get("GRAD ZAGREB")).toBe("21");
    // Official Croatian name first, then the forms an English-language file uses.
    expect(divisions["08"]).toEqual([
      "Primorsko-goranska županija",
      // The bare adjective a file is as likely to write as the full name.
      "Primorsko-goranska",
      "Primorje-Gorski Kotar",
      "Primorje-Gorski Kotar County",
    ]);
    // No "županija" to strip, so nothing extra.
    expect(divisions["21"]).toEqual(["Grad Zagreb", "City of Zagreb"]);
    expect(divisions["99"]).toBeUndefined();
  });

  it("resolves a county written in English, and demotes the same name elsewhere", () => {
    const { byUnit, divisions } = rgiCountyIndex(opcine, zupanije);
    const entries = rgiPlacesToEntries(
      {
        features: [
          row(1, "Stara Sušica", { og_ime: "RAVNA GORA", lon: 15.0028, lat: 45.3763 }),
          // A second Stara Sušica, two counties away: a perfect name match too.
          row(2, "Stara Sušica", { og_ime: "LIPIK", lon: 17.1, lat: 45.44 }),
        ],
      },
      byUnit,
    );
    expect(entries.map((e) => e.admin1)).toEqual(["08", "11"]);
    const index = buildGazetteerIndex(entries, mergeDivisions([{ entries, divisions }]));
    const hits = lookupPlace(index, "Stara Sušica, Primorje-Gorski Kotar, Croatia");
    expect(hits[0].entry.admin).toBe("Ravna Gora");
    // Clear of the ambiguity gap, so bulk-accept can take it.
    expect(hits[0].score).toBeGreaterThan(hits[1].score + 0.05);
    // …and the candidate is labelled with the file's own spelling of the county.
    expect(hits[0].adminDisplay).toBe("Primorje-Gorski Kotar");
    // The Croatian name of the same county does the same job.
    expect(lookupPlace(index, "Stara Sušica, Primorsko-goranska županija, Croatia")[0].entry.admin).toBe("Ravna Gora");
  });

  it("imports the places unchanged when the unit tables did not arrive", () => {
    const [entry] = rgiPlacesToEntries({ features: [row(1, "Stara Sušica", { og_ime: "RAVNA GORA" })] });
    expect(entry.admin1).toBe("");
    expect(entry.admin).toBe("Ravna Gora");
  });
});

describe("lookupPlace parent-qualified names", () => {
  const entry = (name: string, over: Partial<GazEntry> = {}): GazEntry => ({
    name, ascii: "", alt: [], lat: 46, lon: 15, fclass: "P", country: "SI", admin1: "", population: 100, ...over,
  });
  // The register's names for the file's "Vinji vrh, Semič": the settlement in
  // Semič is filed as "Vinji Vrh pri Semiču", while the plain name belongs to
  // other municipalities' settlements.
  const index = buildGazetteerIndex([
    entry("Vinji Vrh", { admin: "Brežice", lat: 45.85, lon: 15.53 }),
    entry("Vinji Vrh", { admin: "Šmarješke Toplice", lat: 45.88, lon: 15.28 }),
    entry("Vinji Vrh pri Semiču", { admin: "Semič", lat: 45.66, lon: 15.19 }),
  ]);

  it("offers the register's longer name when the written parent corroborates it", () => {
    const hits = lookupPlace(index, "Vinji vrh,Semič,Slovenia");
    expect(hits[0].entry.name).toBe("Vinji Vrh pri Semiču");
    expect(hits[0].score).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
    // The same-named settlements elsewhere drop clear of the ambiguity gap.
    expect(hits[1].score).toBeLessThanOrEqual(hits[0].score - 0.05);
  });

  it("corroborates through the inflected name alone when admin is missing", () => {
    const noAdmin = buildGazetteerIndex([
      entry("Kot", { lat: 46.54, lon: 16.39 }),
      entry("Kot", { lat: 45.95, lon: 14.52 }),
      entry("Kot pri Semiču", { lat: 45.64, lon: 15.2 }),
    ]);
    const hits = lookupPlace(noAdmin, "Kot, Semič, Slovenija");
    expect(hits[0].entry.name).toBe("Kot pri Semiču");
    expect(hits[0].score).toBeGreaterThanOrEqual(HIGH_CONFIDENCE);
  });

  it("never fires on the name alone", () => {
    // No parent written: the plain names tie and the longer name stays out.
    const blind = lookupPlace(index, "Vinji vrh, Slovenia");
    expect(blind.every((c) => c.entry.name === "Vinji Vrh")).toBe(true);
    expect(blind[0].score).toBeCloseTo(blind[1].score, 6);
    // A different parent written: its settlement wins outright, and the
    // longer name — uncorroborated — is not even offered.
    const brezice = lookupPlace(index, "Vinji vrh, Brežice, Slovenia");
    expect(brezice[0].entry.admin).toBe("Brežice");
    expect(brezice.every((c) => c.entry.name === "Vinji Vrh")).toBe(true);
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

  it("finds a misspelling only when asked to look wider", () => {
    // Nothing relates "Mrkopolje" to "Mrkopalj" by substring, so the default
    // search cannot reach it and the row is left saying the register has
    // nothing — which is what "Look wider" is for.
    const index = buildGazetteerIndex([
      entry("Mrkopalj", { country: "HR" }),
      entry("Vrbovsko", { country: "HR" }),
    ]);
    expect(searchGazetteer(index, "Mrkopolje, Croatia")).toEqual([]);
    expect(searchGazetteer(index, "Mrkopolje, Croatia", 12, true).map((e) => e.name)).toEqual(["Mrkopalj"]);
  });

  it("keeps a wider search inside the country the value names", () => {
    const index = buildGazetteerIndex([
      entry("Mrkopalj", { country: "HR" }),
      entry("Mrkopalje", { country: "SI" }),
    ]);
    expect(searchGazetteer(index, "Mrkopolje, Croatia", 12, true).map((e) => e.name)).toEqual(["Mrkopalj"]);
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

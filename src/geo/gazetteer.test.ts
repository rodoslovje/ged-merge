import { describe, expect, it } from "vitest";
import {
  HIGH_CONFIDENCE,
  buildGazetteerIndex,
  lookupPlace,
  overpassToEntries,
  parseGeoNamesLine,
  rpeNaseljaToEntries,
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
    const entries = overpassToEntries(
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
    expect(hits[0].entry.authoritative).toBe(true);
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

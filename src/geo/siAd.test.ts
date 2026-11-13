import { describe, expect, it } from "vitest";
import { AddressCollector, searchBucket } from "./addressRegister";
import { parseSiAddressPage, siAddressPageUrl, type SiFeatureCollection } from "./siAd";

// Fixtures in the shape of the cadastre's own GeoJSON (NASLOVI_HS, asked for in
// EPSG:4326 with only the fields the parser reads).

/** One address feature. GeoJSON order: longitude first. */
function address(opts: {
  number: number | null;
  letter?: string | null;
  lat: number;
  lon: number;
  municipality: string;
  settlement: string;
  settlementId: string;
  /** Null where the village numbers its houses directly. */
  street?: string | null;
  postCode?: number | null;
  post: string;
}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [opts.lon, opts.lat] },
    properties: {
      EID_NASELJE: opts.settlementId,
      NASELJE_NAZIV: opts.settlement,
      OBCINA_NAZIV: opts.municipality,
      ULICA_NAZIV: opts.street ?? null,
      POSTNI_OKOLIS_SIFRA: opts.postCode ?? null,
      POSTNI_OKOLIS_NAZIV: opts.post,
      HS_STEVILKA: opts.number,
      HS_DODATEK: opts.letter ?? null,
    },
  };
}

const KOCEVJE_69B = address({
  number: 69,
  letter: "b",
  lat: 45.64991045,
  lon: 14.85300719,
  municipality: "Kočevje",
  settlement: "Kočevje",
  settlementId: "110300000100999436",
  street: "Ljubljanska cesta",
  postCode: 1330,
  post: "Kočevje",
});

describe("parseSiAddressPage", () => {
  it("reads a town address off its fields", () => {
    expect(parseSiAddressPage({ features: [KOCEVJE_69B] })).toEqual([
      {
        settlementId: "110300000100999436",
        settlement: "Kočevje",
        municipality: "Kočevje",
        street: "Ljubljanska cesta",
        post: "1330 Kočevje",
        number: 69,
        ext: "b",
        ext2: 0,
        lat: 45.64991045,
        lon: 14.85300719,
      },
    ]);
  });

  it("reads village numbering, where the house has no street", () => {
    const rows = parseSiAddressPage({
      features: [
        address({
          number: 23,
          lat: 45.9,
          lon: 14.8,
          municipality: "Ivančna Gorica",
          settlement: "Šentvid pri Stični",
          settlementId: "110300000100000001",
          post: "Šentvid pri Stični",
        }),
      ],
    });
    expect(rows[0]).toMatchObject({ street: "", number: 23, ext: "", settlement: "Šentvid pri Stični" });
    // No code for this office — the office's own name still stands.
    expect(rows[0].post).toBe("Šentvid pri Stični");
  });

  it("takes the coordinate in GeoJSON order, longitude first", () => {
    const [row] = parseSiAddressPage({ features: [KOCEVJE_69B] });
    expect(row.lat).toBeCloseTo(45.65, 2);
    expect(row.lon).toBeCloseTo(14.85, 2);
  });

  it("drops what it cannot place", () => {
    const base = { municipality: "X", settlement: "Y", settlementId: "1", post: "P" };
    const bad = {
      features: [
        // Outside the country — a coordinate read the wrong way round.
        { ...address({ ...base, number: 1, lat: 46.05, lon: 14.5 }), geometry: { coordinates: [46.05, 14.5] } },
        // No house number.
        address({ ...base, number: null, lat: 46, lon: 14.5 }),
        // No settlement to file it under.
        address({ ...base, settlementId: "", number: 1, lat: 46, lon: 14.5 }),
        // No position at all.
        { ...address({ ...base, number: 1, lat: 46, lon: 14.5 }), geometry: null },
        { properties: null },
      ],
    } as SiFeatureCollection;
    expect(parseSiAddressPage(bad)).toEqual([]);
  });
});

describe("the Slovenian register as it is searched", () => {
  it("answers a house through the shared bucket search", () => {
    const collector = new AddressCollector("SI");
    const trata69 = address({
      number: 69,
      lat: 45.6499,
      lon: 14.853,
      municipality: "Kočevje",
      settlement: "Kočevje",
      settlementId: "110300000100999436",
      street: "Trata",
      postCode: 1330,
      post: "Kočevje",
    });
    for (const row of parseSiAddressPage({ features: [KOCEVJE_69B, trata69] })) collector.add(row);
    const bucket = collector.buckets()[0];
    // The file's abbreviated street still finds it, and the suffix picks the
    // house — the same ladder Croatia's register is read with.
    const hits = searchBucket(bucket, { number: 69, suffix: "b", street: "Ljubljanska" });
    // Address, then the settlement the street belongs to, then the post office —
    // the line the online GURS lookup composes too.
    expect(hits.map((h) => h.label)).toEqual(["Ljubljanska cesta 69b, Kočevje, 1330 Kočevje"]);
    expect(hits[0].municipality).toBe("Kočevje");
  });
});

describe("siAddressPageUrl", () => {
  it("asks for one sorted page of the cadastre's address layer, in WGS84", () => {
    const url = new URL(siAddressPageUrl(5000, 5000));
    expect(url.pathname).toBe("/wfs-si-gurs-kn/wfs");
    expect(url.searchParams.get("typeNames")).toBe("SI.GURS.KN:NASLOVI_HS");
    expect(url.searchParams.get("startIndex")).toBe("5000");
    expect(url.searchParams.get("count")).toBe("5000");
    expect(url.searchParams.get("outputFormat")).toBe("application/json");
    expect(url.searchParams.get("srsName")).toBe("EPSG:4326");
    expect(url.searchParams.get("sortBy")).toBe("FEATUREID");
    expect(url.searchParams.get("propertyName")).toContain("HS_STEVILKA");
  });
});

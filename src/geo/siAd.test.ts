import { describe, expect, it } from "vitest";
import { AddressCollector, searchBucket } from "./addressRegister";
import { parseSiAddressPage, parseSiPostCodes, siAddressPageUrl, type SiFeatureCollection } from "./siAd";

// Fixtures copied from the service's own GeoJSON, trimmed of the codelist
// boilerplate this parser reads past but keeping every shape it reads.

const OWS = "https://ipi.eprostor.gov.si/wfs-si-gurs-ins/ad/ows?service=wfs&version=2.0.0&request=GetFeature";

function component(kind: string, id: string, title?: string) {
  return {
    "@href": `${OWS}&typeNames=ad:${kind}&outputFormat=GML32&featureid=SI.GURS.RPE.${id}`,
    ...(title === undefined ? {} : { "@title": title }),
  };
}

/** One address feature, in the order the service writes its components: the
 *  country, the municipality, the settlement, the street, the post office. */
function address(opts: {
  designator: string;
  lat: number;
  lon: number;
  municipality: string;
  settlement: string;
  settlementId: string;
  /** Undefined where the village numbers its houses directly — the service
   *  sends the component with no title at all. */
  street?: string;
  post: string;
}) {
  return {
    properties: {
      component: [
        component("AdminUnitName", "705", "Slovenija"),
        component("AdminUnitName", "110200000110269664", opts.municipality),
        component("AddressAreaName", opts.settlementId, opts.settlement),
        component("ThoroughfareName", "110400000161938108", opts.street),
        component("PostalDescriptor", "111000000214299708", opts.post),
      ],
      description: `${opts.municipality}, ${opts.settlement}, ${opts.street ?? ""} ${opts.designator}`,
      locator: {
        designator: {
          designator: opts.designator,
          type: { "@href": "http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/addressIdentifierGeneral" },
        },
      },
      // The CRS is EPSG:4258, whose axis order puts latitude first.
      position: { geometry: { coordinates: [opts.lat, opts.lon] } },
    },
  };
}

const POSTS: SiFeatureCollection = {
  features: [
    { properties: { postCode: "1330", postName: { spelling: { text: "Kočevje" } } } },
    { properties: { postCode: "8341", postName: { spelling: { text: "Adlešiči" } } } },
  ],
};

describe("parseSiPostCodes", () => {
  it("keys the post line by the office an address names", () => {
    // An address's PostalDescriptor component carries the office and no number,
    // so the office is the only thing the two can be joined on.
    const posts = parseSiPostCodes(POSTS);
    expect(posts.get("Kočevje")).toBe("1330 Kočevje");
    expect(posts.get("Adlešiči")).toBe("8341 Adlešiči");
  });
});

describe("parseSiAddressPage", () => {
  const posts = parseSiPostCodes(POSTS);

  it("reads a town address off its components", () => {
    const rows = parseSiAddressPage(
      {
        features: [
          address({
            designator: "69 b",
            lat: 45.64991045,
            lon: 14.85300719,
            municipality: "Kočevje",
            settlement: "Kočevje",
            settlementId: "110300000100999436",
            street: "Ljubljanska cesta",
            post: "Kočevje",
          }),
        ],
      },
      posts,
    );
    expect(rows).toEqual([
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

  it("reads village numbering, where the street component has no name", () => {
    const rows = parseSiAddressPage(
      {
        features: [
          address({
            designator: "23",
            lat: 45.9,
            lon: 14.8,
            municipality: "Ivančna Gorica",
            settlement: "Šentvid pri Stični",
            settlementId: "110300000100000001",
            post: "Šentvid pri Stični",
          }),
        ],
      },
      posts,
    );
    expect(rows[0]).toMatchObject({ street: "", number: 23, ext: "", settlement: "Šentvid pri Stični" });
    // No code for this office in the table — the office's own name still stands.
    expect(rows[0].post).toBe("Šentvid pri Stični");
  });

  it("keeps the municipality apart from the country", () => {
    // Both are AdminUnitName components and only their order tells them apart;
    // taking the first would file every Slovenian house under "Slovenija".
    const rows = parseSiAddressPage({
      features: [
        address({
          designator: "1",
          lat: 46.05,
          lon: 14.5,
          municipality: "Ljubljana",
          settlement: "Ljubljana",
          settlementId: "1",
          street: "Slovenska cesta",
          post: "Ljubljana",
        }),
      ],
    });
    expect(rows[0].municipality).toBe("Ljubljana");
  });

  it("drops what it cannot place", () => {
    const bad: SiFeatureCollection = {
      features: [
        // Longitude and latitude the wrong way round — outside the country.
        address({ designator: "1", lat: 14.5, lon: 46.05, municipality: "X", settlement: "Y", settlementId: "1", post: "P" }),
        // A designator that is not a house number.
        address({ designator: "bb", lat: 46, lon: 14.5, municipality: "X", settlement: "Y", settlementId: "1", post: "P" }),
        { properties: null },
      ],
    };
    expect(parseSiAddressPage(bad)).toEqual([]);
  });
});

describe("the Slovenian register as it is searched", () => {
  it("answers a house through the shared bucket search", () => {
    const collector = new AddressCollector("SI");
    for (const row of parseSiAddressPage(
      {
        features: [
          address({
            designator: "69 b",
            lat: 45.64991045,
            lon: 14.85300719,
            municipality: "Kočevje",
            settlement: "Kočevje",
            settlementId: "110300000100999436",
            street: "Ljubljanska cesta",
            post: "Kočevje",
          }),
          address({
            designator: "69",
            lat: 45.6499,
            lon: 14.853,
            municipality: "Kočevje",
            settlement: "Kočevje",
            settlementId: "110300000100999436",
            street: "Trata",
            post: "Kočevje",
          }),
        ],
      },
      parseSiPostCodes(POSTS),
    )) {
      collector.add(row);
    }
    const bucket = collector.buckets()[0];
    // The file's abbreviated street still finds it, and the suffix picks the
    // house — the same ladder Croatia's register is read with.
    const hits = searchBucket(bucket, { number: 69, suffix: "b", street: "Ljubljanska" });
    // Address, then the settlement the street belongs to, then the post office —
    // the line the online GURS lookup composes too, so both read alike even
    // where a town and its post office share a name.
    expect(hits.map((h) => h.label)).toEqual(["Ljubljanska cesta 69b, Kočevje, 1330 Kočevje"]);
    expect(hits[0].municipality).toBe("Kočevje");
  });
});

describe("siAddressPageUrl", () => {
  it("asks for one page of the address collection", () => {
    const url = new URL(siAddressPageUrl(5000, 5000));
    expect(url.searchParams.get("typeNames")).toBe("ad:Address");
    expect(url.searchParams.get("startIndex")).toBe("5000");
    expect(url.searchParams.get("count")).toBe("5000");
    expect(url.searchParams.get("outputFormat")).toBe("application/json");
  });
});

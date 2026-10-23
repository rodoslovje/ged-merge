import { beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { crc32, deflateRawSync } from "node:zlib";
import {
  DGU_ADDRESSES_URL,
  DGU_OPCINE_URL,
  DGU_PLACES_URL,
  DGU_ZUPANIJE_URL,
  GURS_NASELJA_URL,
  GURS_OBCINE_URL,
  OVERPASS_ENDPOINTS,
  subdivisionsQuery,
} from "../geo/sources";
import { DGU_REGISTER, GURS_REGISTER, osmRegister } from "../geo/gazetteer";
import { siPostalUrl } from "../geo/siAd";
import type { GeoJob, GeoWorkerRequest, GeoWorkerResponse } from "./geoMessages";

/**
 * The geo-import worker's one way in and one way out: every job fetches (or
 * reads a file), converts, writes into the gedmerge-geo IndexedDB and answers
 * with a result or a failure the manager can put into words. Driven through a
 * stubbed `self` with `fetch` mocked per URL and fake-indexeddb underneath.
 */

let posted: GeoWorkerResponse[];
/** URL (or Overpass query) → what the service answers; missing → 404. */
let routes: Map<string, () => Response | Promise<Response>>;
let overpass: ((query: string) => Response) | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  globalThis.indexedDB = new IDBFactory();
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  routes = new Map();
  overpass = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (OVERPASS_ENDPOINTS.includes(url)) {
      if (!overpass) throw new TypeError("Failed to fetch");
      return overpass((init!.body as URLSearchParams).get("data")!);
    }
    const route = routes.get(url);
    return route ? route() : new Response("not found", { status: 404 });
  }));
});

async function freshWorker(): Promise<(job: GeoJob, requestId?: number) => Promise<void>> {
  posted = [];
  const scope = {
    onmessage: null as ((e: MessageEvent<GeoWorkerRequest>) => Promise<void>) | null,
    postMessage: (msg: GeoWorkerResponse) => posted.push(msg),
  };
  vi.stubGlobal("self", scope);
  await import("./geo.worker");
  return (job, requestId = 1) => scope.onmessage!({ data: { type: "import", requestId, job } } as MessageEvent<GeoWorkerRequest>);
}

const last = () => posted.at(-1)!;
const stages = () => posted.flatMap((m) => (m.type === "progress" ? [m.stage] : []));

/** Closed ring of an axis-aligned box, in GeoJSON lon/lat order. */
const box = (lon: number, lat: number) => [[lon, lat], [lon + 0.1, lat], [lon + 0.1, lat + 0.1], [lon, lat + 0.1], [lon, lat]];
const NASELJA = {
  features: [
    { properties: { NAZIV: "Izola", NAZIV_DJ: "Isola" }, geometry: { type: "Polygon", coordinates: [box(13.6, 45.5)] } },
    { properties: { NAZIV: "Bled", NAZIV_DJ: null }, geometry: { type: "Polygon", coordinates: [box(14.0, 46.3)] } },
  ],
};

describe("geo worker: the GURS register", () => {
  it("downloads, converts and stores the settlements, reporting each stage", async () => {
    routes.set(GURS_NASELJA_URL, () => json(NASELJA));
    const run = await freshWorker();
    await run({ kind: "gurs" }, 7);
    expect(last()).toEqual({ type: "result", requestId: 7, countries: [{ code: GURS_REGISTER, count: 2 }] });
    expect(stages()).toEqual(["waiting", "downloading", "parsing"]);
    const progress = posted.find((m) => m.type === "progress" && m.stage === "downloading");
    // Counted bytes against no total: the register announces no length to trust.
    expect(progress).toMatchObject({ requestId: 7, total: 0 });
    const { getCountry } = await import("../persist/geoDb");
    const stored = await getCountry(GURS_REGISTER);
    expect(stored?.entries.map((e) => e.name)).toEqual(["Izola", "Bled"]);
  });

  it("joins the municipalities when their table arrives", async () => {
    routes.set(GURS_NASELJA_URL, () => json({
      features: [{ properties: { NAZIV: "Soteska", EID_OBCINA: "1" }, geometry: { type: "Polygon", coordinates: [box(14.6, 46.2)] } }],
    }));
    routes.set(GURS_OBCINE_URL, () => json({ features: [{ properties: { EID_OBCINA: "1", NAZIV: "Kamnik" } }] }));
    const run = await freshWorker();
    await run({ kind: "gurs" });
    const { getCountry } = await import("../persist/geoDb");
    expect((await getCountry(GURS_REGISTER))?.entries[0]).toMatchObject({ name: "Soteska", admin: "Kamnik" });
  });

  it("a download that does not go through is a download failure", async () => {
    const run = await freshWorker();
    await run({ kind: "gurs" }); // 404
    expect(last()).toEqual({ type: "error", requestId: 1, failure: { code: "download" } });
    routes.set(GURS_NASELJA_URL, () => {
      throw new TypeError("Failed to fetch");
    });
    await run({ kind: "gurs" }, 2);
    expect(last()).toEqual({ type: "error", requestId: 2, failure: { code: "download" } });
  });

  it("an answer that is not JSON is unreadable; one with no settlements is empty", async () => {
    routes.set(GURS_NASELJA_URL, () => new Response("<html>maintenance</html>"));
    const run = await freshWorker();
    await run({ kind: "gurs" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "unreadable" } });
    routes.set(GURS_NASELJA_URL, () => json({ features: [] }));
    await run({ kind: "gurs" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "empty" } });
  });

  it("a store the browser will not open says which refusal it was", async () => {
    routes.set(GURS_NASELJA_URL, () => json(NASELJA));
    const run = await freshWorker();
    const refuse = (event: "onblocked" | "onerror") =>
      vi.stubGlobal("indexedDB", {
        open: () => {
          const req: Record<string, unknown> = { error: new DOMException("no room", "QuotaExceededError") };
          queueMicrotask(() => (req[event] as () => void)());
          return req;
        },
      });
    refuse("onblocked");
    await run({ kind: "gurs" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "storeBlocked" } });
    refuse("onerror");
    await run({ kind: "gurs" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "storeRefused", detail: "QuotaExceededError: no room" } });
  });

  it("ignores messages that are not imports", async () => {
    await freshWorker();
    const scope = (globalThis as unknown as { self: { onmessage: (e: unknown) => Promise<void> } }).self;
    await scope.onmessage({ data: { type: "ping" } });
    expect(posted).toEqual([]);
  });
});

describe("geo worker: OpenStreetMap", () => {
  const places = (names: string[]) =>
    // Padded: an answer under 200 bytes reads as Overpass's busy page.
    JSON.stringify({ elements: names.map((name, i) => ({ type: "node", lat: 46 + i / 10, lon: 14, tags: { place: "village", name } })) }) +
    " ".repeat(200);
  /** Overpass's own "timed out" answer, padded past the busy-page size. */
  const TIMEOUT = `{"version": 0.6, "elements": [${" ".repeat(200)}],\n"remark": "runtime error: Query timed out in \\"query\\" at line 1 after 201 seconds."}`;
  const SUBDIVISIONS = JSON.stringify({
    elements: [
      { tags: { "ISO3166-2": "FR-NOR", name: "Normandie", admin_level: "4" } },
      { tags: { "ISO3166-2": "FR-BRE", name: "Bretagne", admin_level: "4" } },
    ],
  }) + " ".repeat(200);

  it("a whole country: subdivisions first, then the places grouped under them", async () => {
    overpass = (q) => new Response(q === subdivisionsQuery("FR") ? SUBDIVISIONS : places(["Rouen", "Rennes", "Caen"]));
    const run = await freshWorker();
    await run({ kind: "osm", country: "FR" });
    expect(last()).toEqual({ type: "result", requestId: 1, countries: [{ code: osmRegister("FR"), count: 3 }] });
    expect(stages()).toEqual(expect.arrayContaining(["regions", "waiting", "downloading", "parsing"]));
  });

  it("a country too large for one query comes back with its regions to fetch instead", async () => {
    overpass = (q) => new Response(q === subdivisionsQuery("FR") ? SUBDIVISIONS : TIMEOUT);
    const run = await freshWorker();
    await run({ kind: "osm", country: "FR" });
    expect(last()).toEqual({
      type: "error",
      requestId: 1,
      failure: { code: "tooLarge", regions: [{ code: "FR-BRE", name: "Bretagne" }, { code: "FR-NOR", name: "Normandie" }] },
    });
  });

  it("a region too large on its own is the dead end, and names itself", async () => {
    overpass = () => new Response(TIMEOUT);
    const run = await freshWorker();
    await run({ kind: "osm", country: "FR", region: "FR-NOR" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "tooLarge", regions: [], region: "FR-NOR" } });
  });

  it("a busy service on every endpoint is busy; an unreachable one is the next one's turn", async () => {
    let calls = 0;
    overpass = () => {
      calls++;
      if (calls % 2) throw new TypeError("Failed to fetch");
      return new Response("<p>too busy</p>");
    };
    const run = await freshWorker();
    await run({ kind: "osm", country: "SI", region: "SI-01" });
    expect(calls).toBe(OVERPASS_ENDPOINTS.length);
    expect(last()).toMatchObject({ type: "error", failure: { code: "busy" } });
    overpass = () => new Response("bad", { status: 504 });
    await run({ kind: "osm", country: "SI" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "busy" } });
  });

  it("an answer with no places is empty", async () => {
    overpass = (q) => new Response(q === subdivisionsQuery("SI") ? "{}" : `{"elements": []}${" ".repeat(300)}`);
    const run = await freshWorker();
    await run({ kind: "osm", country: "SI" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "empty" } });
  });

  it("a region merges into the country's directory, replacing only its own entries", async () => {
    const run = await freshWorker();
    overpass = () => new Response(places(["Pasadena", "Fresno"]));
    await run({ kind: "osm", country: "US", region: "US-CA" });
    overpass = () => new Response(places(["Austin"]));
    await run({ kind: "osm", country: "US", region: "US-TX" });
    overpass = () => new Response(places(["Sacramento"]));
    await run({ kind: "osm", country: "US", region: "US-CA" });
    expect(last()).toEqual({ type: "result", requestId: 1, countries: [{ code: osmRegister("US"), count: 2 }] });
    const { getCountry } = await import("../persist/geoDb");
    expect((await getCountry(osmRegister("US")))?.entries.map((e) => e.name).sort()).toEqual(["Austin", "Sacramento"]);
  });
});

describe("geo worker: a GeoNames file", () => {
  const ROW = (id: number, name: string, country: string) =>
    `${id}\t${name}\t${name}\t\t46.0\t14.0\tP\tPPL\t${country}\t\t52\t\t\t\t100\t\t300\tEurope/Ljubljana\t2019-09-05`;

  it("stores one directory per country, the largest first", async () => {
    const text = [ROW(1, "Kranj", "SI"), ROW(2, "Graz", "AT"), ROW(3, "Bled", "SI"), "garbage"].join("\n");
    const run = await freshWorker();
    await run({ kind: "file", file: new File([text], "extract.txt") });
    expect(last()).toEqual({ type: "result", requestId: 1, countries: [{ code: "SI", count: 2 }, { code: "AT", count: 1 }] });
    expect(stages()).toContain("parsing");
  });

  it("a file with no places is empty; a zip with no text file is unreadable", async () => {
    const run = await freshWorker();
    await run({ kind: "file", file: new File(["nothing here\n"], "x.txt") });
    expect(last()).toMatchObject({ type: "error", failure: { code: "empty" } });
    const notReally = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0]);
    await run({ kind: "file", file: new File([notReally], "x.zip") });
    expect(last()).toMatchObject({ type: "error", failure: { code: "unreadable" } });
  });
});

describe("geo worker: the Slovenian address register", () => {
  const component = (kind: string, id: string, title?: string) => ({
    "@href": `https://example/ows?typeNames=ad:${kind}&featureid=SI.GURS.RPE.${id}`,
    ...(title === undefined ? {} : { "@title": title }),
  });
  const ADDRESS = {
    properties: {
      component: [
        component("AdminUnitName", "705", "Slovenija"),
        component("AdminUnitName", "110200000110269664", "Kočevje"),
        component("AddressAreaName", "110300000100999436", "Kočevje"),
        component("ThoroughfareName", "110400000161938108", "Ljubljanska cesta"),
        component("PostalDescriptor", "111000000214299708", "Kočevje"),
      ],
      locator: { designator: { designator: "69 b", type: { "@href": "x/addressIdentifierGeneral" } } },
      position: { geometry: { coordinates: [45.64991045, 14.85300719] } },
    },
  };

  it("pages through the register, stores it and checks it is there", async () => {
    const pages: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === siPostalUrl()) return json({ features: [{ properties: { postCode: "1330", postName: { spelling: { text: "Kočevje" } } } }] });
      pages.push(url);
      return json({ features: [ADDRESS], numberMatched: 1, numberReturned: 1 });
    }));
    const run = await freshWorker();
    await run({ kind: "addresses", country: "SI" }, 4);
    expect(last()).toEqual({ type: "addressRegister", requestId: 4, country: "SI", count: 1 });
    expect(pages).toHaveLength(1); // a short page is the last one
    expect(stages()).toEqual(expect.arrayContaining(["downloading", "storing"]));
    const { getAddressIndex } = await import("../persist/geoDb");
    expect(await getAddressIndex("SI")).toBeDefined();
  });

  it("a page that fails is a download failure; a register with no addresses is empty", async () => {
    const run = await freshWorker();
    await run({ kind: "addresses", country: "SI" }); // every URL 404s
    expect(last()).toMatchObject({ type: "error", failure: { code: "download" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === siPostalUrl()) throw new TypeError("Failed to fetch"); // the post codes are optional
      return json({ features: [], numberMatched: 0, numberReturned: 0 });
    }));
    await run({ kind: "addresses", country: "SI" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "empty" } });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    await run({ kind: "addresses", country: "SI" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "download" } });
  });

});

describe("geo worker: the Croatian registers", () => {
  /** One feature of the DGU register of geographical names. */
  const dguRow = (im_id: number, name: string, og_ime = "KONAVLE") => ({
    properties: { im_id, pisanje_imena: name, jeziknaziv: "Hrvatski", status_imena: "službeno", og_ime },
    geometry: { type: "Point", coordinates: [18.36, 42.51] },
  });

  it("DGU places land with their municipality, and their county when the tables arrive", async () => {
    routes.set(DGU_PLACES_URL, () => json({ features: [dguRow(1, "Mihatovići"), dguRow(2, "Ravna Gora", "RAVNA GORA")] }));
    routes.set(DGU_OPCINE_URL, () => json({ features: [{ properties: { og_ime: "KONAVLE", zupanija_id: 19 } }] }));
    routes.set(DGU_ZUPANIJE_URL, () => json({ features: [{ properties: { id: 19, naziv: "Dubrovačko-neretvanska županija", rb: 19 } }] }));
    const run = await freshWorker();
    await run({ kind: "dgu" });
    expect(last()).toEqual({ type: "result", requestId: 1, countries: [{ code: DGU_REGISTER, count: 2 }] });
    const { getCountry } = await import("../persist/geoDb");
    const stored = await getCountry(DGU_REGISTER);
    expect(stored?.entries[0]).toMatchObject({ name: "Mihatovići", admin: "Konavle" });
  });

  it("DGU without its side tables still imports; with no places it is empty", async () => {
    routes.set(DGU_PLACES_URL, () => json({ features: [dguRow(1, "Mihatovići")] }));
    const run = await freshWorker();
    await run({ kind: "dgu" });
    expect(last()).toMatchObject({ type: "result", countries: [{ code: DGU_REGISTER, count: 1 }] });
    routes.set(DGU_PLACES_URL, () => json({ features: [] }));
    await run({ kind: "dgu" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "empty" } });
  });

  /** A plain (non-streaming) deflated zip of the named text files. */
  function zipOf(files: Record<string, string>): Uint8Array<ArrayBuffer> {
    const enc = new TextEncoder();
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
      const nameBytes = Buffer.from(enc.encode(name));
      const raw = Buffer.from(enc.encode(content));
      const comp = deflateRawSync(raw);
      const crc = crc32(raw) >>> 0;
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(0x0800, 6);
      lh.writeUInt16LE(8, 8);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(comp.length, 18);
      lh.writeUInt32LE(raw.length, 22);
      lh.writeUInt16LE(nameBytes.length, 26);
      const local = Buffer.concat([lh, nameBytes, comp]);
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0);
      cd.writeUInt16LE(20, 4);
      cd.writeUInt16LE(20, 6);
      cd.writeUInt16LE(0x0800, 8);
      cd.writeUInt16LE(8, 10);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(comp.length, 20);
      cd.writeUInt32LE(raw.length, 24);
      cd.writeUInt16LE(nameBytes.length, 28);
      cd.writeUInt32LE(offset, 42);
      locals.push(local);
      centrals.push(Buffer.concat([cd, nameBytes]));
      offset += local.length;
    }
    const central = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(centrals.length, 8);
    eocd.writeUInt16LE(centrals.length, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(offset, 16);
    const all = Buffer.concat([...locals, central, eocd]);
    return new Uint8Array(all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength) as ArrayBuffer);
  }

  const name = (text: string) =>
    `<ad:name><gn:GeographicalName><gn:spelling><gn:SpellingOfName><gn:text>${text}</gn:text></gn:SpellingOfName></gn:spelling></gn:GeographicalName></ad:name>`;
  const ADMIN_UNITS =
    `<wfs:FeatureCollection><wfs:member><ad:AdminUnitName gml:id="AdminUnitName.5000585">${name("Andraševec")}` +
    `<ad:level xlink:href="http://inspire.ec.europa.eu/codelist/AdministrativeHierarchyLevel/4thOrder" xlink:title="4thOrder"/></ad:AdminUnitName></wfs:member></wfs:FeatureCollection>`;
  const STREETS =
    `<wfs:FeatureCollection><wfs:member><ad:ThoroughfareName gml:id="ThoroughfareName.2156774419"><ad:name><ad:ThoroughfareNameValue>${name("Brežna ulica")}</ad:ThoroughfareNameValue></ad:name></ad:ThoroughfareName></wfs:member></wfs:FeatureCollection>`;
  const address = (id: number, number: string) =>
    `<wfs:member><ad:Address gml:id="Address.${id}">` +
    `<ad:position><ad:GeographicPosition><ad:geometry><gml:Point gml:id="gad.${id}" srsDimension="2" srsName="http://www.opengis.net/def/crs/EPSG/0/3035">` +
    `<gml:pos>2561799.19 4781765.61</gml:pos></gml:Point></ad:geometry><ad:default>true</ad:default></ad:GeographicPosition></ad:position>` +
    `<ad:locator><ad:AddressLocator><ad:designator><ad:LocatorDesignator><ad:designator>${number}</ad:designator>` +
    `<ad:type xlink:href="http://inspire.ec.europa.eu/codelist/LocatorDesignatorTypeValue/addressNumber" xlink:title="addressNumber"/></ad:LocatorDesignator></ad:designator></ad:AddressLocator></ad:locator>` +
    `<ad:component xlink:href="#ThoroughfareName.2156774419"/><ad:component xlink:href="#AdminUnitName.5000585"/>` +
    `</ad:Address></wfs:member>`;

  it("Croatia's addresses are read out of the zip member by member and stored", async () => {
    const zip = zipOf({
      "AdminUnitName.gml": ADMIN_UNITS,
      "ThoroughfareName.gml": STREETS,
      "Address.gml": `<wfs:FeatureCollection>${address(1, "33")}${address(2, "35")}</wfs:FeatureCollection>`,
    });
    routes.set(DGU_ADDRESSES_URL, () => new Response(zip, { headers: { "content-length": String(zip.length) } }));
    const run = await freshWorker();
    await run({ kind: "addresses", country: "HR" });
    expect(last()).toEqual({ type: "addressRegister", requestId: 1, country: "HR", count: 2 });
    // The zip's announced length is the one total that can be believed.
    expect(posted.find((m) => m.type === "progress" && m.stage === "downloading")).toMatchObject({ total: zip.length });
    expect(stages()).toEqual(expect.arrayContaining(["parsing", "storing"]));
    const { getAddressIndex } = await import("../persist/geoDb");
    expect(await getAddressIndex("HR")).toBeDefined();
  });

  it("Croatia's download with no settlements or no addresses in it is empty", async () => {
    const run = await freshWorker();
    routes.set(DGU_ADDRESSES_URL, () => new Response(zipOf({ "AdminUnitName.gml": "<wfs:FeatureCollection/>", "Address.gml": "" })));
    await run({ kind: "addresses", country: "HR" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "empty" } });
    routes.set(DGU_ADDRESSES_URL, () => new Response(zipOf({ "AdminUnitName.gml": ADMIN_UNITS, "Address.gml": "<wfs:FeatureCollection/>" })));
    await run({ kind: "addresses", country: "HR" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "empty" } });
  });

  it("Croatia's download without its settlement file is unreadable", async () => {
    routes.set(DGU_ADDRESSES_URL, () => new Response(zipOf({ "Address.gml": "" })));
    const run = await freshWorker();
    await run({ kind: "addresses", country: "HR" });
    expect(last()).toMatchObject({ type: "error", failure: { code: "unreadable" } });
  });
});

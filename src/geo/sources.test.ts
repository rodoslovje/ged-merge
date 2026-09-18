import { describe, expect, it } from "vitest";
import {
  annotatedCountryQuery, countryQuery, DGU_PLACES_URL, MAX_ANNOTATED_SUBDIVISIONS, regionQuery, subdivisionsQuery,
} from "./sources";
import type { Subdivision } from "./gazetteer";

/**
 * The query builders are strings the importers depend on, shape for shape: a
 * typo in a CQL or Overpass fragment ships unnoticed until a download comes
 * back empty. These pin the parts the readers rely on.
 */
describe("Overpass queries", () => {
  it("the country query scopes the place nodes to the country's admin_level=2 area", () => {
    const q = countryQuery("SI");
    expect(q.startsWith("[out:json][timeout:180];")).toBe(true);
    expect(q).toContain('area["ISO3166-1"="SI"][admin_level=2]->.a;');
    expect(q).toContain('node(area.a)[place~"^(city|town|village|hamlet|suburb|locality|isolated_dwelling)$"];out qt;');
  });

  it("the annotated query emits each subdivision's marker before its places, in order", () => {
    const subs = [{ code: "AT-1" }, { code: "AT-2" }] as Subdivision[];
    const q = annotatedCountryQuery(subs);
    const marker1 = q.indexOf('rel["ISO3166-2"="AT-1"][boundary=administrative];out tags;');
    const places1 = q.indexOf('area["ISO3166-2"="AT-1"]->.a;');
    const marker2 = q.indexOf('rel["ISO3166-2"="AT-2"][boundary=administrative];out tags;');
    expect(marker1).toBeGreaterThan(-1);
    expect(places1).toBeGreaterThan(marker1);
    expect(marker2).toBeGreaterThan(places1);
    // Exactly one place block per subdivision.
    expect(q.split("node(area.a)").length - 1).toBe(2);
  });

  it("a region query is one subdivision's block; the subdivisions query lists a country's codes, tags only", () => {
    expect(regionQuery("US-CA")).toBe(`[out:json][timeout:180];rel["ISO3166-2"="US-CA"][boundary=administrative];out tags;area["ISO3166-2"="US-CA"]->.a;node(area.a)[place~"^(city|town|village|hamlet|suburb|locality|isolated_dwelling)$"];out qt;`);
    expect(subdivisionsQuery("HR")).toBe('[out:json][timeout:120];relation["ISO3166-2"~"^HR-"][boundary=administrative];out tags;');
  });

  it("the annotated-query cap is below Slovenia's 212 municipalities", () => {
    expect(MAX_ANNOTATED_SUBDIVISIONS).toBeLessThan(212);
  });
});

describe("DGU register URL", () => {
  it("filters to exactly the nine populated-place kinds, URL-encoded", () => {
    const url = new URL(DGU_PLACES_URL);
    expect(url.searchParams.get("typeNames")).toBe("rgi:v_imjesto_geoime_gs");
    expect(url.searchParams.get("srsName")).toBe("EPSG:4326");
    expect(url.searchParams.get("CQL_FILTER")).toBe("vrstaobiljezjaid IN (124,191,231,233,234,236,237,242,321)");
    expect(url.searchParams.get("propertyName")?.split(",")).toContain("geom");
  });
});

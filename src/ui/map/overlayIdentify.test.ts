import { describe, expect, it } from "vitest";
import type { MapOverlay } from "../SettingsContext";
import { featureInfoUrl, formatFeatureInfo, queryableOverlays } from "./overlayIdentify";

const t = (key: string) => key;

const wmsBase: MapOverlay = {
  id: "a",
  name: "",
  url: "https://example.test/wms",
  wms: true,
  layers: "L",
  queryLayers: "L_INFO",
};

describe("queryableOverlays", () => {
  it("keeps WMS layers with an info layer, drawn in Web Mercator", () => {
    const plain: MapOverlay = { id: "b", name: "", url: "https://tiles/{z}/{x}/{y}.png" };
    const noInfo: MapOverlay = { ...wmsBase, id: "c", queryLayers: undefined };
    // A reprojected layer cannot answer a query phrased in the map's own CRS.
    const reprojected: MapOverlay = { ...wmsBase, id: "d", nativeCrs: "EPSG:3794" };
    expect(queryableOverlays([wmsBase, plain, noInfo, reprojected]).map((o) => o.id)).toEqual(["a"]);
  });
});

describe("featureInfoUrl", () => {
  const view = { bbox: "1,2,3,4", width: 100, height: 80, i: 10, j: 20 };

  it("queries the info layer and describes the clicked pixel", () => {
    const url = new URL(featureInfoUrl(wmsBase, view));
    expect(url.origin + url.pathname).toBe("https://example.test/wms");
    expect(url.searchParams.get("REQUEST")).toBe("GetFeatureInfo");
    // GeoServer requires QUERY_LAYERS ⊆ LAYERS, so both name the info layer.
    expect(url.searchParams.get("LAYERS")).toBe("L_INFO");
    expect(url.searchParams.get("QUERY_LAYERS")).toBe("L_INFO");
    expect(url.searchParams.get("BBOX")).toBe("1,2,3,4");
    expect(url.searchParams.get("I")).toBe("10");
    expect(url.searchParams.get("J")).toBe("20");
  });

  it("carries the layer's extra params through", () => {
    const url = new URL(featureInfoUrl({ ...wmsBase, params: "TIME=2011-01-01" }, view));
    expect(url.searchParams.get("TIME")).toBe("2011-01-01");
  });
});

describe("formatFeatureInfo", () => {
  it("formats a GURS address as street, number and post town", () => {
    const html = formatFeatureInfo(
      {
        HS_STEVILKA: "23",
        HS_DODATEK: "a",
        NASELJE_NAZIV: "Šentvid pri Stični",
        POSTNI_OKOLIS_SIFRA: "1296",
        POSTNI_OKOLIS_NAZIV: "Šentvid pri Stični",
      },
      "House numbers",
      t,
    );
    expect(html).toContain("Šentvid pri Stični 23a");
    expect(html).toContain("1296 Šentvid pri Stični");
  });

  it("escapes values so file data cannot inject markup", () => {
    const html = formatFeatureInfo({ HS_STEVILKA: "1", ULICA_NAZIV: '<img src=x onerror="a">' }, "L", t);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("returns nothing for a feature with no readable fields", () => {
    expect(formatFeatureInfo({ EID_X: "1", GEOM: "…" }, "L", t)).toBe("");
    expect(formatFeatureInfo(undefined, "L", t)).toBe("");
  });
});

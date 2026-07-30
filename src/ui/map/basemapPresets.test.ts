import { describe, expect, it } from "vitest";
import { en } from "../../locales/en";
import { sl } from "../../locales/sl";
import { BASEMAPS, CUSTOM_BASEMAP, activeBasemap, basemapCredit, basemapUrl, isKnownBasemap } from "./basemapPresets";

describe("basemap presets", () => {
  it("names every preset in both languages", () => {
    for (const b of BASEMAPS) {
      expect(en, `en is missing ${b.key}`).toHaveProperty(b.key);
      expect(sl, `sl is missing ${b.key}`).toHaveProperty(b.key);
    }
  });

  it("templates every tile URL and credits every provider", () => {
    for (const b of BASEMAPS) {
      for (const theme of ["light", "dark"] as const) {
        const url = basemapUrl(b, theme);
        expect(url).toMatch(/^https:\/\//);
        expect(url).toContain("{z}");
        expect(url).toContain("{x}");
        expect(url).toContain("{y}");
        // A {s} template without shard values would request the literal host "{s}".
        if (url.includes("{s}")) expect(b.subdomains).toBeTruthy();
      }
      expect(b.attribution).not.toBe("");
    }
  });

  it("keeps the default first so an unknown id falls back to it", () => {
    expect(BASEMAPS[0].id).toBe("");
    expect(activeBasemap("no-such-provider", "")).toBe(BASEMAPS[0]);
    expect(activeBasemap("", undefined)).toBe(BASEMAPS[0]);
    expect(activeBasemap("osm", "")?.id).toBe("osm");
  });

  it("hands over to a custom URL only once one is entered", () => {
    expect(activeBasemap(CUSTOM_BASEMAP, "https://tiles.example/{z}/{x}/{y}.png")).toBeNull();
    // Chosen but not filled in yet: draw the default rather than nothing.
    expect(activeBasemap(CUSTOM_BASEMAP, "   ")).toBe(BASEMAPS[0]);
    expect(activeBasemap(CUSTOM_BASEMAP, undefined)).toBe(BASEMAPS[0]);
  });

  it("accepts stored ids it can draw and rejects the rest", () => {
    expect(isKnownBasemap("")).toBe(true);
    expect(isKnownBasemap("opentopo")).toBe(true);
    expect(isKnownBasemap(CUSTOM_BASEMAP)).toBe(true);
    expect(isKnownBasemap("stamen")).toBe(false);
  });

  it("flattens the credit to plain text for the exported PNG", () => {
    expect(basemapCredit("", "")).toBe("© OpenStreetMap contributors © CARTO");
    expect(basemapCredit("osm", "")).toBe("© OpenStreetMap contributors");
    // The user's own source: unknown terms, so nothing is asserted.
    expect(basemapCredit(CUSTOM_BASEMAP, "https://tiles.example/{z}/{x}/{y}.png")).toBe("");
  });
});

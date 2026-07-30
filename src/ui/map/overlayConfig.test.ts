import { describe, expect, it } from "vitest";
import type { MapOverlay } from "../SettingsContext";
import { overlaySignature, overlayZIndex, parseWmsParams } from "./overlayConfig";
import { OVERLAY_PRESETS, coverageContains, overlayCoverage, overlaySampleZoom, resolveOverlay } from "./overlayPresets";

const base: MapOverlay = { id: "a", name: "", url: "https://tiles.example/{z}/{x}/{y}.png" };

describe("parseWmsParams", () => {
  it("splits KEY=value pairs and skips malformed ones", () => {
    expect(parseWmsParams("TIME=2011-01-01&CQL_FILTER=A%3D1")).toEqual({
      TIME: "2011-01-01",
      CQL_FILTER: "A%3D1",
    });
    expect(parseWmsParams("=novalue&bare&B=2")).toEqual({ B: "2" });
    expect(parseWmsParams(undefined)).toEqual({});
  });
});

describe("overlaySignature", () => {
  it("changes when a tile-request field changes", () => {
    expect(overlaySignature({ ...base, url: "https://other/{z}/{x}/{y}.png" })).not.toBe(overlaySignature(base));
    expect(overlaySignature({ ...base, wms: true, layers: "X" })).not.toBe(overlaySignature(base));
    expect(overlaySignature({ ...base, maxZoom: 14 })).not.toBe(overlaySignature(base));
  });

  it("ignores fields that don't affect the request", () => {
    // Name and the show-by-default flag are UI-only: neither may force the
    // live layer to be torn down and rebuilt (opacity is set in place).
    expect(overlaySignature({ ...base, name: "Renamed", defaultOn: true })).toBe(overlaySignature(base));
  });
});

describe("overlayZIndex", () => {
  it("stacks the list first-on-top, all above the base layer", () => {
    const z = [0, 1, 2].map((i) => overlayZIndex(i, 3));
    expect(z[0]).toBeGreaterThan(z[1]!);
    expect(z[1]).toBeGreaterThan(z[2]!);
    // The base tile layer sits at 1 — every overlay must clear it.
    expect(Math.min(...z)).toBeGreaterThan(1);
  });

  it("gives a lone layer the bottom slot", () => {
    expect(overlayZIndex(0, 1)).toBe(overlayZIndex(2, 3));
  });
});

describe("resolveOverlay", () => {
  it("keeps the user's own choices when folding the preset back on", () => {
    const preset = OVERLAY_PRESETS[0]!;
    const stored: MapOverlay = { id: "x", name: "", url: "", presetKey: preset.key, defaultOn: true };
    const resolved = resolveOverlay(stored);
    expect(resolved.url).toBe(preset.url);
    expect(resolved.defaultOn).toBe(true);
  });

  it("leaves the preset's own coverage and sample zoom out of the layer", () => {
    const preset = OVERLAY_PRESETS[0]!;
    expect(preset.coverage).toBeDefined();
    expect(preset.sampleZoom).toBeDefined();
    const resolved = resolveOverlay({ id: "x", name: "", url: "", presetKey: preset.key });
    // A manual edit captures the resolved config and stores it; both document
    // the source, so they must not travel into stored settings.
    expect(resolved).not.toHaveProperty("coverage");
    expect(resolved).not.toHaveProperty("sampleZoom");
  });
});

describe("overlayCoverage", () => {
  it("reports the preset's coverage, and nothing for a layer of one's own", () => {
    const preset = OVERLAY_PRESETS[0]!;
    expect(overlayCoverage({ id: "x", name: "", url: "", presetKey: preset.key })).toBe(preset.coverage);
    expect(overlayCoverage({ id: "y", name: "Mine", url: "https://example.com/{z}/{x}/{y}.png" })).toBeUndefined();
  });

  it("gives every bundled preset a plausible box", () => {
    for (const preset of OVERLAY_PRESETS) {
      const box = preset.coverage;
      expect(box, preset.key).toBeDefined();
      const [south, west, north, east] = box!;
      expect(south, preset.key).toBeLessThan(north);
      expect(west, preset.key).toBeLessThan(east);
      expect(south, preset.key).toBeGreaterThanOrEqual(-90);
      expect(north, preset.key).toBeLessThanOrEqual(90);
      expect(west, preset.key).toBeGreaterThanOrEqual(-180);
      expect(east, preset.key).toBeLessThanOrEqual(180);
    }
  });
});

describe("overlaySampleZoom", () => {
  it("reports the preset's sample zoom, and nothing for a layer of one's own", () => {
    const preset = OVERLAY_PRESETS[0]!;
    expect(overlaySampleZoom({ id: "x", name: "", url: "", presetKey: preset.key })).toBe(preset.sampleZoom);
    expect(overlaySampleZoom({ id: "y", name: "Mine", url: "https://example.com/{z}/{x}/{y}.png" })).toBeUndefined();
  });

  it("gives every bundled preset a zoom the layer is drawn at", () => {
    for (const preset of OVERLAY_PRESETS) {
      // Without one the sample would fall back to fitting the coverage, which
      // for a scale-limited layer means previewing an empty frame.
      expect(preset.sampleZoom, preset.key).toBeDefined();
      expect(preset.sampleZoom!, preset.key).toBeGreaterThanOrEqual(preset.minZoom ?? 0);
      // The sample map's own limits (see MiniPlaceMap).
      expect(preset.sampleZoom!, preset.key).toBeGreaterThanOrEqual(2);
      expect(preset.sampleZoom!, preset.key).toBeLessThanOrEqual(18);
    }
  });
});

describe("coverageContains", () => {
  const slovenia = [45.42, 13.37, 46.88, 16.61] as const;
  const bled = [46.335, 14.06, 46.4, 14.17] as const;

  it("holds for a box inside another, and not the other way round", () => {
    expect(coverageContains(slovenia, bled)).toBe(true);
    expect(coverageContains(bled, slovenia)).toBe(false);
  });

  it("holds for a box against itself, and fails on a partial overlap", () => {
    expect(coverageContains(bled, bled)).toBe(true);
    // Switzerland: overlaps Slovenia's latitudes, but lies west of it.
    expect(coverageContains([45.8, 5.95, 47.81, 10.5], bled)).toBe(false);
  });
});

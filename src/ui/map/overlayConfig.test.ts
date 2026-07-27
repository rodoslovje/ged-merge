import { describe, expect, it } from "vitest";
import type { MapOverlay } from "../SettingsContext";
import { overlaySignature, overlayZIndex, parseWmsParams } from "./overlayConfig";
import { OVERLAY_PRESETS, resolveOverlay } from "./overlayPresets";

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
});

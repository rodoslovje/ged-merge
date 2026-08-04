import { describe, expect, it } from "vitest";
import { sanitizeOverlays, type MapOverlay } from "./SettingsContext";

/**
 * Field-parity guard: every MapOverlay field must survive a round-trip
 * through sanitizeOverlays. The sanitizer whitelists fields one by one, so a
 * field added to the interface but not taught to it is silently stripped
 * from the user's saved overlay config on the next load — a real bug class
 * this app has hit before. `Required<MapOverlay>` makes TypeScript refuse to
 * compile this fixture until a new field is added here, and the deep-equal
 * then fails until sanitizeOverlays carries it through.
 */
const FULL: Required<MapOverlay> = {
  id: "ov-1",
  name: "Franciscean cadastre",
  presetKey: "map.overlay.franciscean",
  url: "https://tiles.example.com/{z}/{x}/{y}.png",
  wms: true,
  layers: "cadastre,labels",
  styles: "default,names",
  tileSize: 512,
  queryLayers: "cadastre",
  params: "TIME=1823-01-01T00:00:00.000Z",
  nativeCrs: "EPSG:3794",
  nativeBounds: [374000, 31000, 624000, 194000],
  maxScaleDenominator: 5000,
  pyramid: {
    layer: "cadastre",
    tileMatrixSet: "EPSG:3794",
    scaleDenominators: [4000, 2000, 1000],
    origin: [374000, 194000],
    tileSize: 256,
    format: "image/png",
  },
  defaultOn: true,
  yearFrom: 1818,
  yearTo: 1828,
  attribution: "Arhiv RS",
  minZoom: 8,
  maxZoom: 16,
};

describe("sanitizeOverlays", () => {
  it("carries every MapOverlay field through unchanged", () => {
    expect(sanitizeOverlays([FULL])).toEqual([FULL]);
  });

  it("keeps a minimal overlay and drops a malformed one", () => {
    const minimal: MapOverlay = { id: "ov-2", name: "", url: "https://x/{z}/{x}/{y}.png" };
    expect(sanitizeOverlays([minimal, { name: "no id or url" }, null, 42])).toEqual([minimal]);
    expect(sanitizeOverlays("not an array")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { MapOverlay } from "../SettingsContext";
import { OVERLAY_PRESETS, overlayCoverage, overlaySampleZoom } from "./overlayPresets";
import { SAMPLE_MAP_BOX, SAMPLE_MAX_ZOOM, sampleMapView } from "./sampleView";

/** A layer added from the preset with this key, as the Settings editor stores
 *  it: the preset link plus the user's own defaultOn flag. */
const fromPreset = (key: string, id: string, defaultOn = true): MapOverlay => {
  const preset = OVERLAY_PRESETS.find((p) => p.key === key)!;
  expect(preset, key).toBeDefined();
  return { id, name: "", url: preset.url, presetKey: preset.key, defaultOn: defaultOn || undefined };
};

const houses = fromPreset("settings.map.overlays.preset.gurs.houseNumbers", "houses");
const parcels = fromPreset("settings.map.overlays.preset.gurs.parcels", "parcels");
const etatmajor = fromPreset("settings.map.overlays.preset.france.etatmajor", "etatmajor");
const own: MapOverlay = { id: "own", name: "Mine", url: "https://example.com/{z}/{x}/{y}.png", defaultOn: true };

describe("sampleMapView", () => {
  it("shows the standing sample when no layer is on", () => {
    const view = sampleMapView([], null);
    expect(view.box).toBe(SAMPLE_MAP_BOX);
    expect(view.minZoom).toBeUndefined();
    expect(view.maxZoom).toBe(SAMPLE_MAX_ZOOM);
  });

  it("opens a scale-limited layer at the zoom it draws at", () => {
    const view = sampleMapView([houses], { id: "houses", seq: 1 });
    const zoom = overlaySampleZoom(houses);
    expect(zoom).toBe(16);
    // Pinned, not merely allowed: fitting the coverage would land far above the
    // zoom the service starts drawing house numbers at.
    expect(view.minZoom).toBe(zoom);
    expect(view.maxZoom).toBe(zoom);
  });

  it("keeps a layer that covers the standard scene on it, and goes to one that does not", () => {
    expect(sampleMapView([houses], { id: "houses", seq: 1 }).box).toBe(SAMPLE_MAP_BOX);
    expect(sampleMapView([etatmajor], { id: "etatmajor", seq: 1 }).box).toBe(overlayCoverage(etatmajor));
  });

  it("re-frames on every tick, even when the frame is the one already shown", () => {
    // Two layers of the same reach: unticking one leaves the sample framed
    // exactly as before, so only the count tells the second tick apart — and
    // without it a sample the user had panned away from would never come back.
    const both = sampleMapView([houses, parcels], { id: "houses", seq: 1 });
    const afterUntick = sampleMapView([{ ...houses, defaultOn: undefined }, parcels], { id: "houses", seq: 1 });
    const reticked = sampleMapView([houses, parcels], { id: "houses", seq: 2 });
    expect(afterUntick.box).toBe(both.box);
    expect(afterUntick.maxZoom).toBe(both.maxZoom);
    expect(reticked.nonce).not.toBe(afterUntick.nonce);
  });

  it("leaves the sample where it is when a layer of one's own is switched on", () => {
    // It declares no ground, so there is nothing to frame — and no reframe.
    const view = sampleMapView([own, houses], { id: "own", seq: 3 });
    expect(view.nonce).toBeUndefined();
    expect(view.maxZoom).toBe(overlaySampleZoom(houses));
  });

  it("hands the frame to another layer still on when the framed one goes off", () => {
    const view = sampleMapView([{ ...houses, defaultOn: undefined }, etatmajor], { id: "houses", seq: 1 });
    expect(view.box).toBe(overlayCoverage(etatmajor));
    expect(view.maxZoom).toBe(overlaySampleZoom(etatmajor));
  });
});

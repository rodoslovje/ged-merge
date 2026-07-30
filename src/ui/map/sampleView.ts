import type { MapOverlay } from "../SettingsContext";
import type { MiniMapView } from "./MiniPlaceMap";
import { coverageContains, overlayCoverage, overlaySampleZoom, type CoverageBox } from "./overlayPresets";

// What the base-map sample in Settings → Map frames. Kept out of the modal so
// the rules — which ground, how close, and when a layer switched on takes the
// sample over — can be read and tested on their own.

/** What the sample falls back to: Bled — lake, town and mountains in one frame,
 *  so a plain street map, a shaded relief and an aerial image are all told
 *  apart at a glance. Also the scene any layer that covers it is shown on. */
export const SAMPLE_MAP_BOX: CoverageBox = [46.335, 14.06, 46.4, 14.17];

/** How far the sample zooms in with no layer to follow — enough of the box
 *  above to be a town rather than a region. A layer marked Default overrides it
 *  with the zoom it was measured to draw at (its preset's `sampleZoom`). */
export const SAMPLE_MAX_ZOOM = 13;

/** The layer the sample follows: the one last switched on by default, counted
 *  so that switching the same layer on again is a fresh request to be framed. */
export interface FramedOverlay {
  id: string;
  seq: number;
}

/** The view the sample should show for the layers marked Default, given which
 *  of them was switched on last. */
export function sampleMapView(overlays: readonly MapOverlay[], framed: FramedOverlay | null): MiniMapView {
  const shown = overlays.filter((o) => o.defaultOn);
  // The layer last ticked leads. Failing that — it was unticked again, or it is
  // one of the user's own, which declares no extent — the first layer on show
  // that does name its ground; failing that, the standing sample.
  const last = shown.find((o) => o.id === framed?.id);
  const lead = (last && overlayCoverage(last) ? last : undefined) ?? shown.find((o) => overlayCoverage(o));
  const coverage = lead && overlayCoverage(lead);
  // A layer whose ground includes the standard scene is shown on it: that is a
  // town with houses, fields and water, which tells an aerial or cadastral
  // layer apart at once — while the middle of a country-sized box is as likely
  // to be forest, and at the zoom an address layer needs, empty.
  const box = coverage && !coverageContains(coverage, SAMPLE_MAP_BOX) ? coverage : SAMPLE_MAP_BOX;
  // The zoom the layer draws at decides the sample outright: fitting its
  // coverage instead would preview a scale-limited layer as a blank frame.
  const zoom = lead && overlaySampleZoom(lead);
  // Counting only ticks that landed on the leading layer: switching on a layer
  // of one's own, which frames nothing, leaves the sample where it is.
  const nonce = lead && lead === last ? framed?.seq : undefined;
  return { box, minZoom: zoom || undefined, maxZoom: zoom || SAMPLE_MAX_ZOOM, nonce };
}

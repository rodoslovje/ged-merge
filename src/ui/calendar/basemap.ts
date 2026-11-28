// The base map under the calendar's flags: CARTO's Voyager, drawn from vector
// tiles by MapLibre into a picture of the page's shape. Vector tiles draw at
// any size, so the picture is made large enough to print sharp on A3 — a
// raster tile would blur there. The library is a lazy chunk of its own: only
// a calendar that shows a map loads it.
//
// The family website's viewer is built without this module (see
// publish/vitePlugin.ts): it shows no calendar, and must not carry the library.

import type { GeoCoord } from "../../gedcom/types";
import type { MapSpot } from "../../calendar/mapPins";
import { CARTO_KEY } from "../map/basemapPresets";

export interface Basemap {
  /** The picture, as an object URL kept for the visit. */
  url: string;
  /** Where each coordinate fell on it. */
  spots: MapSpot[];
}

const STYLE = `https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json?key=${CARTO_KEY}`;
/** The credit CARTO and OpenStreetMap ask for, written on the picture's edge. */
export const BASEMAP_CREDIT = "© OpenStreetMap contributors © CARTO";

/** The picture's width in CSS pixels — small, so the base map's own place names
 *  are of a size with the page's text — and how many device pixels each is drawn
 *  with: 2800 across, some 240 dpi on an A3 page's picture. */
const WIDTH = 800;
const PIXEL_RATIO = 3.5;
/** The longest side a drawing may have, in device pixels. */
const MAX_PIXELS = 4000;
/** The share of the width each side keeps clear of places, for the boxes. */
const SIDE = 0.24;
/** The closest a map of one town zooms in. */
const MAX_ZOOM = 11;
/** How long the tiles may take before the map is given up on. */
const TIMEOUT_MS = 30_000;

const drawn = new Map<string, Promise<Basemap>>();

/**
 * The map that holds all of `coords`, `aspect` wide for its height. Drawn
 * once per set of places and shape, and kept: the same picture serves the
 * wizard's preview, the review and the print. A failed drawing is forgotten,
 * so the next ask tries again.
 */
export const renderBasemap: ((coords: GeoCoord[], aspect: number) => Promise<Basemap>) | undefined = (coords, aspect) => {
  const key = `${aspect.toFixed(2)} ${coords.map((c) => `${c.lat},${c.lon}`).join(" ")}`;
  let map = drawn.get(key);
  if (!map) {
    map = draw(coords, aspect);
    drawn.set(key, map);
    map.catch(() => drawn.delete(key));
  }
  return map;
};

async function draw(coords: GeoCoord[], aspect: number): Promise<Basemap> {
  const [{ Map: GlMap, setWorkerUrl }, { default: workerUrl }] = await Promise.all([
    import("maplibre-gl"),
    import("maplibre-gl/dist/maplibre-gl-worker.mjs?url"),
  ]);
  setWorkerUrl(workerUrl);
  const height = Math.round(WIDTH / aspect);
  // Off the screen, but laid out: the library draws into a box with a size.
  const box = document.createElement("div");
  box.style.cssText = `position:fixed;left:-20000px;top:0;width:${WIDTH}px;height:${height}px;`;
  document.body.appendChild(box);
  const lats = coords.map((c) => c.lat);
  const lons = coords.map((c) => c.lon);
  const map = new GlMap({
    container: box,
    style: STYLE,
    interactive: false,
    attributionControl: false,
    // A tall picture is drawn a little coarser, to stay inside what a
    // graphics card draws in one piece.
    pixelRatio: Math.min(PIXEL_RATIO, MAX_PIXELS / Math.max(WIDTH, height)),
    fadeDuration: 0,
    // The picture is read back off the canvas once it is drawn.
    canvasContextAttributes: { preserveDrawingBuffer: true },
    bounds: [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
    // The places keep to the middle: a column of boxes stands down each side.
    fitBoundsOptions: {
      padding: { top: height * 0.1, bottom: height * 0.12, left: WIDTH * SIDE, right: WIDTH * SIDE },
      maxZoom: MAX_ZOOM,
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("basemap: timed out")), TIMEOUT_MS);
      map.once("idle", () => {
        window.clearTimeout(timer);
        resolve();
      });
    });
    const spots = coords.map((c) => {
      const p = map.project([c.lon, c.lat]);
      return { x: p.x / WIDTH, y: p.y / height };
    });
    const blob = await new Promise<Blob | null>((resolve) => map.getCanvas().toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("basemap: no picture");
    return { url: URL.createObjectURL(blob), spots };
  } finally {
    map.remove();
    box.remove();
  }
}

import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader } from "pbf";

// Period borders: the administrative territories of a chosen year, read from
// OpenHistoricalMap.
//
// OHM publishes no raster tiles — a world of prerendered images for every date
// in history isn't feasible — so its boundaries arrive as Mapbox Vector Tiles
// and the app draws them itself (see ../ui/map/bordersLayer.ts). Every
// territory carries the years it existed for as `start_decdate` / `end_decdate`,
// decimal years derived from OHM's `start_date` / `end_date` tags (1867-06-08 →
// 1867.43) and negative before year 1. Filtering on those turns one year of the
// map's own year filter into the crownlands, counties and military-frontier
// districts that stood there then — which is what an event's place means when
// the register that recorded it names a country nobody has heard of since.
//
// This module is the pure half: what to request, what a tile holds, which of it
// belongs to a given year and zoom, and where a name can be written. It knows
// nothing of Leaflet or the DOM, so it is unit-testable like the rest of
// src/geo/.

/** OHM's boundary-only tileset: one `boundaries` layer of named administrative
 *  polygons. The general `ohm` tileset carries the same borders as lines, but
 *  drags roads, buildings and land use along with them and leaves the names in
 *  a separate layer — this one is the smaller, better-labelled fetch. */
export const OHM_TILE_URL = "https://vtiles.openhistoricalmap.org/maps/ohm_admin/{z}/{x}/{y}.pbf";

/** OHM data is public domain (CC0); the project asks to be credited. */
export const OHM_ATTRIBUTION =
  '© <a href="https://www.openhistoricalmap.org/">OpenHistoricalMap</a> contributors (CC0)';

/** The same credit as plain text, for the caption burned into exported PNGs
 *  (basemapCredit does this for the base map). */
export const OHM_CREDIT = "© OpenHistoricalMap contributors (CC0)";

/** The deepest zoom tiles are fetched at. Past it the same tiles are drawn
 *  again over a smaller area — and because the geometry is vector, that is
 *  redrawn at full sharpness rather than magnified (see {@link tileTransform}),
 *  so nothing is lost but the fetches. A parish sits well inside its district;
 *  the borders around it do not gain detail from a deeper tile. */
export const OHM_MAX_ZOOM = 12;

/** The tiles are drawn 512 px wide rather than the usual 256. A 512-px grid at
 *  zoom z is the standard tile grid at z − 1, which is what OHM serves — so one
 *  request covers four ordinary tiles of screen, off a source already
 *  generalized past what that screen resolves. */
export const OHM_TILE_PX = 512;

/** Which zoom's tiles a view is drawn from — the one thing that decides what
 *  the layer costs.
 *
 *  OHM's boundary tiles carry every period at once, so they do not thin out
 *  going up the pyramid the way an ordinary tileset does. Measured against the
 *  live service, gzipped, one tile: 41 kB at zoom 12, 45 at 10, 68 at 9, 105
 *  at 8, 180 at 7, then 465 at 6 and at 5, 1.4 MB at 4 and 3, 1.2 MB at 1 and
 *  1.7 MB for the single tile of zoom 0. Fetching a wide view at its own zoom
 *  would mean a dozen of the expensive ones — several megabytes for a screen
 *  where a district is a smudge.
 *
 *  So wide views are drawn from a coarser tile instead, blown back up: the
 *  geometry is vector, so that is redrawn sharp rather than magnified (see
 *  {@link tileTransform}), and the tile is generalized to about what such a
 *  view resolves anyway. The steps below keep a screenful at roughly one to
 *  two megabytes at every zoom — a whole-continent view then costs one tile,
 *  not twelve, and the world is the single zoom-0 tile.
 *
 *  Past zoom 12 the same tiles are reused: a parish sits well inside its
 *  district, and the borders around it gain no detail from a deeper fetch. */
export function sourceZoom(gridZoom: number): number {
  if (gridZoom >= 7) return Math.min(gridZoom, OHM_MAX_ZOOM);
  if (gridZoom === 6) return 5;
  return Math.max(0, gridZoom - 2);
}

const LAYER = "boundaries";

/** Where a territory of this administrative level starts being drawn, mirroring
 *  the cut OHM's own style makes: countries at every zoom, crownlands (4) early,
 *  districts (5–6) once a region fills the screen, communes (7–9) only from
 *  close up. Levels the table doesn't name are treated as the deepest. */
export function adminMinZoom(level: number): number {
  if (level <= 2) return 0;
  if (level === 3) return 5;
  if (level === 4) return 3;
  if (level <= 6) return 8;
  if (level <= 8) return 10;
  return 11;
}

/** How heavy a border of this level is drawn, in CSS pixels: an empire's
 *  outline reads over the district lines inside it. */
export function borderWeight(level: number): number {
  if (level <= 2) return 2.4;
  if (level === 3) return 1.8;
  if (level === 4) return 1.4;
  if (level <= 6) return 1;
  return 0.8;
}

/** A point in tile-local coordinates (0…{@link DecodedTile.extent}). */
export interface TilePoint {
  x: number;
  y: number;
}

/** One ring, as x and y alternating in tile-local units.
 *
 *  Flat and 16-bit on purpose. A tile is kept decoded so that changing the year
 *  is a repaint rather than a refetch, and the wide-view tiles are enormous —
 *  the single tile the whole world is drawn from holds 2.3 million points,
 *  which as a point object each would be a hundred megabytes to hold on to.
 *  Interleaved in an `Int16Array` the same ring costs 9 MB, and tile
 *  coordinates — a few hundred either side of an extent of 4096 — sit well
 *  inside 16 bits. */
export type Ring = Int16Array;

/** Walk a ring's points. */
export function ringLength(ring: Ring): number {
  return ring.length >> 1;
}

/** Tile coordinates, Leaflet's `L.Coords` reduced to plain data. */
export interface TileCoords {
  z: number;
  x: number;
  y: number;
}

/** One territory, as much of it as this tile holds. */
export interface BorderArea {
  /** OHM's own id, which is what makes the same territory in the neighbouring
   *  tile the same territory — so its name is written once. */
  id: number;
  level: number;
  name: string;
  /** Decimal years; either end open means it reaches on from there. */
  start?: number;
  end?: number;
  /** The dates as OHM writes them, for a reader ("1849-12-08"–"1918-12-01"). */
  startDate?: string;
  endDate?: string;
  rings: Ring[];
}

/** One decoded tile, still holding every era it carries — the year is applied
 *  by {@link bordersAt}, so scrubbing the year filter redraws from this instead
 *  of fetching again. */
export interface DecodedTile {
  extent: number;
  areas: BorderArea[];
}

function num(value: number | string | boolean | undefined): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function str(value: number | string | boolean | undefined): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** The name to write on a territory: the interface's language where OHM has it
 *  (`name_sl`), then English, then the territory's own name.
 *
 *  English is in the middle because OHM's `name` is the territory's own, in its
 *  own script — the Ottoman Empire's is دولت علیه عثمانیه — and half of what a
 *  Slovenian reader meets here has no `name_sl`. A name in the Latin alphabet
 *  they can read beats a faithful one they cannot. Where the two are the same
 *  language, as for the Monarchy's German crownlands, the fallback never
 *  fires. */
function pickName(props: Record<string, number | string | boolean>, lang?: string): string | undefined {
  const local = lang ? str(props[`name_${lang}`]) : undefined;
  return local ?? str(props.name_en) ?? str(props.name);
}

/** Read the territories out of one vector tile. `buf` is the tile as served
 *  (the transport gzip already undone by fetch); `lang` is the interface
 *  language, resolved by {@link pickName}. */
export function decodeBorderTile(buf: ArrayBuffer, lang?: string): DecodedTile {
  const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
  const layer = tile.layers[LAYER];
  const areas: BorderArea[] = [];
  for (let i = 0; layer && i < layer.length; i++) {
    const f = layer.feature(i);
    const level = num(f.properties.admin_level);
    const id = num(f.properties.osm_id);
    if (level === undefined || id === undefined) continue;
    const name = pickName(f.properties, lang);
    if (!name) continue;
    areas.push({
      id,
      level,
      name,
      start: num(f.properties.start_decdate),
      end: num(f.properties.end_decdate),
      startDate: str(f.properties.start_date),
      endDate: str(f.properties.end_date),
      rings: f.loadGeometry().map((ring) => {
        const flat = new Int16Array(ring.length * 2);
        for (let p = 0; p < ring.length; p++) {
          flat[p * 2] = ring[p].x;
          flat[p * 2 + 1] = ring[p].y;
        }
        return flat;
      }),
    });
  }
  return { extent: layer?.extent ?? 4096, areas };
}

/** Did this territory exist during `year`? An end date inside the year still
 *  counts — the Monarchy's borders belong to 1918 although they ended that
 *  November — and either end left open means it reaches on from there. */
export function aliveAt(period: { start?: number; end?: number }, year: number): boolean {
  return (period.start ?? -Infinity) < year + 1 && (period.end ?? Infinity) >= year;
}

/** The territories one tile contributes at `year`, thinned to the levels
 *  {@link adminMinZoom} draws at this zoom, largest level first so an empire's
 *  outline is drawn under the districts inside it. */
export function bordersAt(tile: DecodedTile, year: number, zoom: number): BorderArea[] {
  return tile.areas
    .filter((a) => zoom >= adminMinZoom(a.level) && aliveAt(a, year))
    .sort((a, b) => a.level - b.level);
}

/** The standard tile the layer's 512-px grid tile stands for: the same x and y,
 *  one zoom coarser (see {@link OHM_TILE_PX}). Leaflet numbers its own grid by
 *  the map's zoom whatever size the tiles are, so this is where the drawn tile
 *  and the fetched one part company. */
export function gridCoords(coords: TileCoords): TileCoords {
  return { z: coords.z - 1, x: coords.x, y: coords.y };
}

/** Which tile actually holds the data for `coords`: itself where the zoom is
 *  fetched at its own scale, otherwise the ancestor tile {@link sourceZoom}
 *  sends it to. */
export function sourceCoords(coords: TileCoords): TileCoords {
  const z = sourceZoom(coords.z);
  if (z >= coords.z) return coords;
  const k = 2 ** (coords.z - z);
  return { z, x: Math.floor(coords.x / k), y: Math.floor(coords.y / k) };
}

/** How a source tile's local coordinates land on the canvas of the tile being
 *  drawn: `px = x * scale + dx`. For a tile that is its own source this is
 *  simply the extent scaled to the tile's pixels; for one drawn from an
 *  ancestor it also blows the ancestor up and slides the right quarter (or
 *  sixteenth, …) of it into view — vector geometry, so the result is as sharp
 *  as a native tile instead of a magnified image. */
export function tileTransform(
  coords: TileCoords,
  source: TileCoords,
  extent: number,
  sizePx: number,
): { scale: number; dx: number; dy: number } {
  const k = 2 ** (coords.z - source.z);
  const scale = (k * sizePx) / extent;
  return {
    scale,
    dx: (source.x * k - coords.x) * sizePx,
    dy: (source.y * k - coords.y) * sizePx,
  };
}

/** The signed area of a ring, in tile units — the sign says which way it winds
 *  (an outer ring one way, the hole in it the other), the size says which part
 *  of a scattered territory is the one worth writing the name on. */
export function ringArea(ring: Ring): number {
  const n = ringLength(ring);
  let doubled = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    doubled += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
  }
  return doubled / 2;
}

/** The centre of gravity of a territory's parts in this tile, with the area
 *  they carry — the caller adds these up across the tiles a territory reaches
 *  into to find the middle of the whole of it.
 *
 *  Weighted by signed area, so a hole pulls the centre away from itself and a
 *  scattered territory's name lands on the bulk of it rather than midway
 *  between its pieces. A bounding box's centre won't do: the Ottoman Empire's
 *  box over the Balkans has its middle in Croatia. Undefined where this tile's
 *  parts are all degenerate. */
export function areaCentroid(area: BorderArea): (TilePoint & { weight: number }) | undefined {
  let total = 0;
  let cx = 0;
  let cy = 0;
  for (const ring of area.rings) {
    const n = ringLength(ring);
    if (n < 3) continue;
    let doubled = 0;
    let rx = 0;
    let ry = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const cross = ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
      doubled += cross;
      rx += (ring[j * 2] + ring[i * 2]) * cross;
      ry += (ring[j * 2 + 1] + ring[i * 2 + 1]) * cross;
    }
    if (!doubled) continue;
    const weight = doubled / 2;
    total += weight;
    cx += (rx / (3 * doubled)) * weight;
    cy += (ry / (3 * doubled)) * weight;
  }
  if (!total) return undefined;
  return { x: cx / total, y: cy / total, weight: Math.abs(total) };
}

/** The stretches of a horizontal line at `y` that run *inside* this
 *  territory's parts in this tile, as `[from, to]` pairs in tile-local units,
 *  left to right.
 *
 *  This is what keeps a name on its own ground. A centre of gravity is the
 *  middle of a shape, which for a crescent is not in the shape at all: Dalmatia
 *  curves around Bosnia, so its centre — and its bounding box's, worse — lands
 *  inland, over a country it never held. Crossing the shape at that height
 *  instead and writing the name across the widest stretch of it puts the word
 *  where the territory is.
 *
 *  Even-odd, so a hole in a territory is a gap between two stretches, and a
 *  scattered one gives a stretch per island. */
export function scanSpans(area: BorderArea, y: number): [number, number][] {
  const crossings: number[] = [];
  for (const ring of area.rings) {
    const n = ringLength(ring);
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yj = ring[j * 2 + 1];
      const yi = ring[i * 2 + 1];
      // Half-open on purpose: an edge is counted at its lower end only, so a
      // vertex exactly at this height is one crossing, not two.
      if (yj <= y === yi <= y) continue;
      const xj = ring[j * 2];
      const xi = ring[i * 2];
      crossings.push(xj + ((y - yj) / (yi - yj)) * (xi - xj));
    }
  }
  crossings.sort((a, b) => a - b);
  const spans: [number, number][] = [];
  for (let i = 0; i + 1 < crossings.length; i += 2) spans.push([crossings[i], crossings[i + 1]]);
  return spans;
}

/** The tile URL for one set of coordinates. */
export function ohmTileUrl(coords: TileCoords): string {
  return OHM_TILE_URL.replace("{z}", String(coords.z))
    .replace("{x}", String(coords.x))
    .replace("{y}", String(coords.y));
}

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

/** The shallowest map zoom the borders are drawn at, and why there is a floor
 *  at all: OHM's boundary tiles carry every era at once, so they grow sharply
 *  as they zoom out. Measured against the live service (gzipped, one tile):
 *  45 kB at zoom 10, 68 at 9, 105 at 8, 180 at 7 — but 465 at 6 and 5, and
 *  1.4 MB at 4 and 3. Below this floor a screenful runs to several megabytes,
 *  for a view where a district is a smudge, so the layer stops and the chip
 *  says why. Zoom 8 still holds a region several times wider than the parishes
 *  a file is usually read at. */
export const OHM_MIN_MAP_ZOOM = 8;

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
  rings: TilePoint[][];
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

/** Read the territories out of one vector tile. `buf` is the tile as served
 *  (the transport gzip already undone by fetch). `lang` picks the name column
 *  OHM ships per language — `name_sl` for the Slovenian interface — falling
 *  back to the territory's own official name, which for the Monarchy's
 *  crownlands is the German one the registers used anyway. */
export function decodeBorderTile(buf: ArrayBuffer, lang?: string): DecodedTile {
  const tile = new VectorTile(new PbfReader(new Uint8Array(buf)));
  const layer = tile.layers[LAYER];
  const areas: BorderArea[] = [];
  for (let i = 0; layer && i < layer.length; i++) {
    const f = layer.feature(i);
    const level = num(f.properties.admin_level);
    const id = num(f.properties.osm_id);
    if (level === undefined || id === undefined) continue;
    const name = (lang ? str(f.properties[`name_${lang}`]) : undefined) ?? str(f.properties.name);
    if (!name) continue;
    areas.push({
      id,
      level,
      name,
      start: num(f.properties.start_decdate),
      end: num(f.properties.end_decdate),
      startDate: str(f.properties.start_date),
      endDate: str(f.properties.end_date),
      rings: f.loadGeometry().map((ring) => ring.map((p) => ({ x: p.x, y: p.y }))),
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

/** Which tile actually holds the data for `coords`: itself, or — past
 *  {@link OHM_MAX_ZOOM} — the ancestor tile at that zoom which covers it. */
export function sourceCoords(coords: TileCoords, maxZoom = OHM_MAX_ZOOM): TileCoords {
  if (coords.z <= maxZoom) return coords;
  const k = 2 ** (coords.z - maxZoom);
  return { z: maxZoom, x: Math.floor(coords.x / k), y: Math.floor(coords.y / k) };
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
export function ringArea(ring: readonly TilePoint[]): number {
  let doubled = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    doubled += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  }
  return doubled / 2;
}

/** Where to write a territory's name: the centroid of its largest ring here,
 *  with that ring's area — the caller compares areas across tiles to decide
 *  which tile writes the name of a territory that spans several. Undefined for
 *  a territory whose parts in this tile are all degenerate. */
export function labelAnchor(area: BorderArea): (TilePoint & { area: number }) | undefined {
  let best: readonly TilePoint[] | undefined;
  let bestArea = 0;
  for (const ring of area.rings) {
    const size = Math.abs(ringArea(ring));
    if (size > bestArea) {
      bestArea = size;
      best = ring;
    }
  }
  if (!best || !bestArea) return undefined;
  // Area-weighted centroid — the polygon's balance point, which for the compact
  // shapes an administrative unit has sits inside it.
  let doubled = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = best.length - 1; i < best.length; j = i++) {
    const cross = best[j].x * best[i].y - best[i].x * best[j].y;
    doubled += cross;
    cx += (best[j].x + best[i].x) * cross;
    cy += (best[j].y + best[i].y) * cross;
  }
  if (!doubled) return undefined;
  return { x: cx / (3 * doubled), y: cy / (3 * doubled), area: bestArea };
}

/** The tile URL for one set of coordinates. */
export function ohmTileUrl(coords: TileCoords): string {
  return OHM_TILE_URL.replace("{z}", String(coords.z))
    .replace("{x}", String(coords.x))
    .replace("{y}", String(coords.y));
}

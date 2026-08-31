import L from "leaflet";
import {
  OHM_ATTRIBUTION,
  OHM_TILE_PX,
  areaCentroid,
  bordersAt,
  borderWeight,
  decodeBorderTile,
  gridCoords,
  ohmTileUrl,
  ringLength,
  scanSpans,
  sourceCoords,
  tileTransform,
  type BorderArea,
  type DecodedTile,
  type TileCoords,
} from "../../geo/ohmBorders";
import { SANS } from "../exportSvg";

// The period-borders layer: OpenHistoricalMap's administrative territories for
// one year, drawn onto canvas tiles.
//
// OHM ships vector tiles, not images, so this is a GridLayer that fetches, and
// paints, its own tiles — the same shape as reprojectedWmsLayer, and painting
// into <canvas> for the same reason: the PNG export composes whatever tile
// elements a layer has drawn, image or canvas alike.
//
// Two things follow from the geometry being vector rather than pixels. Zooming
// past the deepest fetched zoom redraws the same territories at full sharpness
// instead of magnifying them, and changing the year is a repaint of tiles
// already in hand — scrubbing the year filter costs no requests at all.

/** Above the historical overlays (see overlayConfig's OVERLAY_Z), below the
 *  markers, which Leaflet keeps in a pane of their own. */
export const BORDERS_Z = 100;

/** A territory needs at least this much of the view, in each direction, for a
 *  name to be worth writing on it (CSS px). */
const LABEL_MIN_SPAN = 34;

/** …and at most this share of it. A territory that fills the screen has no
 *  middle you can see, so naming it anywhere is naming it in an arbitrary
 *  place: at a parish's zoom the Monarchy goes unlabelled and the duchy inside
 *  it is named, and zooming out until the Monarchy fits is what makes its own
 *  name appear. It is how an atlas behaves, and it keeps the nested territories
 *  of one spot from writing three names over each other. */
const LABEL_MAX_COVER = 0.6;

/** Space kept clear around a name when testing it against the ones already
 *  placed (CSS px). */
const LABEL_PAD = 6;

/** Text size by administrative level: an empire's name reads over a district's. */
function labelSize(level: number): number {
  if (level <= 2) return 13;
  if (level <= 4) return 12;
  return 10.5;
}

/** The canvas font string for a level, shared by the measuring pass and the
 *  drawing one — they must agree or the collision boxes are the wrong size. */
function labelFont(level: number): string {
  return `${level <= 2 ? 600 : 500} ${labelSize(level)}px ${SANS}`;
}

interface BorderColors {
  line: string;
  halo: string;
}

/** The design tokens the borders are drawn in, resolved now — canvas takes
 *  colours, not `var()` (createBaseLayer reads its outline the same way). */
export function borderColors(): BorderColors {
  const styles = getComputedStyle(document.documentElement);
  return {
    line: styles.getPropertyValue("--map-border").trim() || "#5b2d8e",
    halo: styles.getPropertyValue("--map-border-halo").trim() || "rgba(255,255,255,.85)",
  };
}

export interface BordersLayerOptions extends L.GridLayerOptions {
  /** The year drawn — the upper end of the map's year filter. */
  year: number;
  /** Language for OHM's per-language names (`name_sl`), else the local name. */
  lang?: string;
  colors: BorderColors;
}

/** One live tile: its canvas, where its data came from, and the decoded tile
 *  once it has arrived. */
interface LiveTile {
  canvas: HTMLCanvasElement;
  /** Leaflet's own coordinates for the drawn tile — its z is the map's zoom,
   *  and its x/y place it in the 512-px grid on screen. */
  coords: TileCoords;
  /** The standard tile it stands for, one zoom coarser (see gridCoords). */
  grid: TileCoords;
  /** The tile actually fetched: {@link grid}, or its ancestor past the
   *  deepest zoom OHM is asked for. */
  source: TileCoords;
  size: number;
  dpr: number;
  tile?: DecodedTile;
}

/** A name to write on one tile, at that tile's own pixel coordinates. A name
 *  that straddles a tile seam is handed to both tiles, each drawing it at its
 *  own coordinates — the halves meet at the seam and read as one word. */
interface LabelPlacement {
  x: number;
  y: number;
  level: number;
  name: string;
}

const tileKey = (c: TileCoords) => `${c.z}/${c.x}/${c.y}`;

/** Decoded tiles kept beyond the life of the tiles that asked for them, so a
 *  pan back — or the sixteen children of one overzoomed tile — costs nothing.
 *  Bounded because the decoded geometry is far larger than the bytes it came
 *  from: a screenful is about a dozen tiles, so this holds a few screens' worth
 *  and lets the rest go. */
const DECODE_CACHE_MAX = 48;

const BordersLayer = L.GridLayer.extend({
  initialize(this: L.GridLayer, options: BordersLayerOptions) {
    L.Util.setOptions(this, options);
    const self = this as unknown as BordersInternals;
    self._live = new Map();
    self._decoded = new Map();
    self._pending = new Map();
    self._frame = 0;
    this.on("tileunload", (e: L.TileEvent) => {
      self._live.delete(tileKey(e.coords as unknown as TileCoords));
    });
  },

  createTile(this: L.GridLayer, coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const self = this as unknown as BordersInternals;
    const size = this.getTileSize();
    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(size.x * dpr);
    canvas.height = Math.round(size.y * dpr);
    const plain: TileCoords = { z: coords.z, x: coords.x, y: coords.y };
    const grid = gridCoords(plain);
    const live: LiveTile = {
      canvas,
      coords: plain,
      grid,
      source: sourceCoords(grid),
      size: size.x,
      dpr,
    };
    self._live.set(tileKey(plain), live);
    self
      ._fetch(live.source)
      .then((tile) => {
        live.tile = tile;
        // One tile's arrival can move a name into it, or out of a neighbour, so
        // the whole visible set is repainted rather than this canvas alone.
        self._scheduleRepaint();
        done(undefined, canvas);
      })
      .catch((err: unknown) => {
        done(err instanceof Error ? err : new Error("border tile request failed"), canvas);
      });
    return canvas;
  },

  /** Draw `year` instead — a repaint of the tiles already held, no requests. */
  setYear(this: L.GridLayer, year: number): void {
    const opts = this.options as BordersLayerOptions;
    if (opts.year === year) return;
    opts.year = year;
    (this as unknown as BordersInternals)._scheduleRepaint();
  },

  /** Fetch and decode one source tile, sharing the request between the tiles
   *  that want it and remembering the result for the ones that come later. */
  _fetch(this: L.GridLayer, source: TileCoords): Promise<DecodedTile> {
    const self = this as unknown as BordersInternals;
    const key = tileKey(source);
    const held = self._decoded.get(key);
    if (held) return Promise.resolve(held);
    const flight = self._pending.get(key);
    if (flight) return flight;
    const lang = (this.options as BordersLayerOptions).lang;
    const request = fetch(ohmTileUrl(source))
      .then((res) => {
        if (!res.ok) throw new Error(`OHM tile ${key}: ${res.status}`);
        return res.arrayBuffer();
      })
      .then((buf) => {
        const tile = decodeBorderTile(buf, lang);
        if (self._decoded.size >= DECODE_CACHE_MAX) {
          // Oldest first: Map keeps insertion order.
          const oldest = self._decoded.keys().next().value;
          if (oldest !== undefined) self._decoded.delete(oldest);
        }
        self._decoded.set(key, tile);
        return tile;
      })
      .finally(() => self._pending.delete(key));
    self._pending.set(key, request);
    return request;
  },

  /** Coalesce the repaints that a burst of arriving tiles would otherwise each
   *  ask for into one, on the next frame. */
  _scheduleRepaint(this: L.GridLayer): void {
    const self = this as unknown as BordersInternals;
    if (self._frame) return;
    self._frame = L.Util.requestAnimFrame(() => {
      self._frame = 0;
      self._repaint();
    });
  },

  _repaint(this: L.GridLayer): void {
    const self = this as unknown as BordersInternals;
    const opts = this.options as BordersLayerOptions;
    const zoom = (this as unknown as { _tileZoom?: number })._tileZoom;
    const map = this._map;
    if (zoom === undefined || !map) return;
    const byTile = placeLabels(self._live, opts, zoom, map.getPixelBounds());
    for (const [key, live] of self._live) {
      if (live.coords.z !== zoom) continue;
      paintTile(live, opts, zoom, byTile.get(key) ?? []);
    }
  },
});

/** Internals the prototype above shares between its methods. */
interface BordersInternals {
  _live: Map<string, LiveTile>;
  _decoded: Map<string, DecodedTile>;
  _pending: Map<string, Promise<DecodedTile>>;
  _frame: number;
  _fetch(source: TileCoords): Promise<DecodedTile>;
  _scheduleRepaint(): void;
  _repaint(): void;
}

/** How much of the map one territory takes up, gathered across every tile it
 *  reaches into, in the map's own pixel coordinates: the box it spans, and the
 *  running area-weighted sum that gives its centre of gravity. */
interface Footprint {
  id: number;
  level: number;
  name: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Σ centre·area and Σ area over this territory's parts. */
  sumX: number;
  sumY: number;
  weight: number;
}

const clamp = (v: number, lo: number, hi: number) => (lo > hi ? v : Math.min(Math.max(v, lo), hi));

/** One canvas kept aside to measure text with — the placement pass runs before
 *  any tile is painted, so it has no drawing context of its own yet. */
let measurer: CanvasRenderingContext2D | null = null;
function measureLabel(name: string, level: number): number {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return name.length * labelSize(level) * 0.55;
  measurer.font = labelFont(level);
  return measurer.measureText(name).width;
}

/** Where a horizontal line at `y` (map pixels) runs across the territory `id`,
 *  as the widest such stretch that is on screen — the place its name can be
 *  written without leaving its own ground.
 *
 *  Each tile is scanned in its own coordinates and its answers clipped to its
 *  own box: a tile holds only a clipped piece of the territory, and the cut
 *  edges are drawn along the tile's margin, so a stretch measured across tiles
 *  at once would count them. The pieces are then joined back up, tile by
 *  neighbouring tile, into the stretches the whole territory has. */
function widestSpan(
  live: Map<string, LiveTile>,
  id: number,
  opts: BordersLayerOptions,
  zoom: number,
  y: number,
  viewX0: number,
  viewX1: number,
): [number, number] | undefined {
  const pieces: [number, number][] = [];
  for (const tile of live.values()) {
    if (!tile.tile || tile.coords.z !== zoom) continue;
    const area = bordersAt(tile.tile, opts.year, zoom).find((a) => a.id === id);
    if (!area) continue;
    const at = tileProjector(tile);
    const originX = tile.coords.x * tile.size;
    const originY = tile.coords.y * tile.size;
    const local = at.unprojectY(y - originY);
    for (const [from, to] of scanSpans(area, local)) {
      const x0 = clamp(at.x(from) + originX, originX, originX + tile.size);
      const x1 = clamp(at.x(to) + originX, originX, originX + tile.size);
      if (x1 > x0) pieces.push([x0, x1]);
    }
  }
  if (!pieces.length) return undefined;
  pieces.sort((a, b) => a[0] - b[0]);
  let best: [number, number] | undefined;
  let run = pieces[0];
  const keep = (span: [number, number]) => {
    const x0 = Math.max(span[0], viewX0);
    const x1 = Math.min(span[1], viewX1);
    if (x1 > x0 && (!best || x1 - x0 > best[1] - best[0])) best = [x0, x1];
  };
  for (const piece of pieces.slice(1)) {
    // Touching, because the piece ended where the next tile begins.
    if (piece[0] <= run[1] + 0.5) run = [run[0], Math.max(run[1], piece[1])];
    else {
      keep(run);
      run = piece;
    }
  }
  keep(run);
  return best;
}

/** Work out which names to write, and hand each to the tiles that must draw it.
 *  Placement is done once for the whole map rather than per tile: a territory
 *  reaches across tiles, and each tile holds only its own clipped scrap of it,
 *  whose middle is nowhere in particular. */
function placeLabels(
  live: Map<string, LiveTile>,
  opts: BordersLayerOptions,
  zoom: number,
  view: L.Bounds,
): Map<string, LabelPlacement[]> {
  const footprints = new Map<number, Footprint>();
  for (const tile of live.values()) {
    if (!tile.tile || tile.coords.z !== zoom) continue;
    const at = tileProjector(tile);
    const originX = tile.coords.x * tile.size;
    const originY = tile.coords.y * tile.size;
    for (const area of bordersAt(tile.tile, opts.year, zoom)) {
      let foot = footprints.get(area.id);
      if (!foot) {
        foot = {
          id: area.id,
          level: area.level,
          name: area.name,
          minX: Infinity,
          maxX: -Infinity,
          minY: Infinity,
          maxY: -Infinity,
          sumX: 0,
          sumY: 0,
          weight: 0,
        };
        footprints.set(area.id, foot);
      }
      for (const ring of area.rings) {
        const n = ringLength(ring);
        for (let i = 0; i < n; i++) {
          const x = at.x(ring[i * 2]) + originX;
          const y = at.y(ring[i * 2 + 1]) + originY;
          if (x < foot.minX) foot.minX = x;
          if (x > foot.maxX) foot.maxX = x;
          if (y < foot.minY) foot.minY = y;
          if (y > foot.maxY) foot.maxY = y;
        }
      }
      // This tile's share of the territory, weighted so that the pieces add up
      // to the middle of the whole of it rather than the middle of its box.
      const centre = areaCentroid(area);
      if (centre) {
        foot.sumX += (at.x(centre.x) + originX) * centre.weight;
        foot.sumY += (at.y(centre.y) + originY) * centre.weight;
        foot.weight += centre.weight;
      }
    }
  }

  const size = view.getSize();
  const viewArea = Math.max(1, size.x * size.y);
  const wanted = [];
  for (const foot of footprints.values()) {
    // The part of the territory that is actually on screen: its name belongs in
    // the middle of that, not of a shape reaching past both edges.
    const x0 = Math.max(foot.minX, view.min!.x);
    const x1 = Math.min(foot.maxX, view.max!.x);
    const y0 = Math.max(foot.minY, view.min!.y);
    const y1 = Math.min(foot.maxY, view.max!.y);
    const width = x1 - x0;
    const height = y1 - y0;
    if (width < LABEL_MIN_SPAN || height < LABEL_MIN_SPAN) continue;
    const cover = (width * height) / viewArea;
    if (cover > LABEL_MAX_COVER) continue;
    // The height of the territory's centre of gravity, held inside the part of
    // it that is on screen: a name for a shape reaching off the edge belongs on
    // the piece the reader can see.
    const y = foot.weight ? clamp(foot.sumY / foot.weight, y0, y1) : (y0 + y1) / 2;
    // Then across, onto the territory itself rather than the middle of its
    // span — Dalmatia's middle is in Bosnia (see scanSpans).
    const span = widestSpan(live, foot.id, opts, zoom, y, x0, x1);
    const x = span ? (span[0] + span[1]) / 2 : foot.weight ? clamp(foot.sumX / foot.weight, x0, x1) : (x0 + x1) / 2;
    wanted.push({ ...foot, x, y, cover });
  }
  // Smallest first: where two names want the same spot, the local one wins —
  // it is the one the reader can't work out from the map around it.
  wanted.sort((a, b) => a.cover - b.cover);

  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const byTile = new Map<string, LabelPlacement[]>();
  for (const label of wanted) {
    const half = measureLabel(label.name, label.level) / 2 + LABEL_PAD;
    const halfHeight = labelSize(label.level) / 2 + LABEL_PAD;
    // Nudged back inside the map where a long name would otherwise run off the
    // edge — half a district's name hanging past the frame reads as a bug.
    const x = clamp(label.x, view.min!.x + half, view.max!.x - half);
    const y = clamp(label.y, view.min!.y + halfHeight, view.max!.y - halfHeight);
    const box = { x0: x - half, y0: y - halfHeight, x1: x + half, y1: y + halfHeight };
    if (placed.some((p) => p.x0 < box.x1 && box.x0 < p.x1 && p.y0 < box.y1 && box.y0 < p.y1)) continue;
    placed.push(box);
    // Every tile the name touches draws its own piece of it.
    for (const [key, tile] of live) {
      if (tile.coords.z !== zoom) continue;
      const originX = tile.coords.x * tile.size;
      const originY = tile.coords.y * tile.size;
      if (originX > box.x1 || originX + tile.size < box.x0) continue;
      if (originY > box.y1 || originY + tile.size < box.y0) continue;
      const list = byTile.get(key) ?? [];
      list.push({ x: x - originX, y: y - originY, level: label.level, name: label.name });
      byTile.set(key, list);
    }
  }
  return byTile;
}

/** Tile-local coordinates of the fetched tile → this canvas's CSS pixels, one
 *  axis at a time (the geometry is a flat array of alternating x and y, so
 *  nothing is gained by pairing them up again). The transform is worked out in
 *  the standard grid the source belongs to, at this canvas's own width. */
interface Projector {
  x(value: number): number;
  y(value: number): number;
  /** …and back again, for a scan line given in the canvas's own pixels. */
  unprojectY(value: number): number;
}

function tileProjector(live: LiveTile): Projector {
  const { scale, dx, dy } = tileTransform(live.grid, live.source, live.tile?.extent ?? 4096, live.size);
  return { x: (v) => v * scale + dx, y: (v) => v * scale + dy, unprojectY: (v) => (v - dy) / scale };
}

/** Repaint one tile from the data it already holds. */
function paintTile(live: LiveTile, opts: BordersLayerOptions, zoom: number, labels: LabelPlacement[]): void {
  const ctx = live.canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(live.dpr, 0, 0, live.dpr, 0, 0);
  ctx.clearRect(0, 0, live.size, live.size);
  if (!live.tile) return;
  const at = tileProjector(live);
  const areas = bordersAt(live.tile, opts.year, zoom);
  ctx.strokeStyle = opts.colors.line;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // Sorted by level, so one path per level carries every border of that weight.
  let level: number | undefined;
  const flush = () => {
    if (level !== undefined) ctx.stroke();
  };
  for (const area of areas) {
    if (area.level !== level) {
      flush();
      level = area.level;
      ctx.lineWidth = borderWeight(level);
      ctx.beginPath();
    }
    strokeArea(ctx, area, at);
  }
  flush();
  for (const label of labels) drawLabel(ctx, label, opts.colors);
}

/** Add one territory's rings to the current path. The tiles are cut with a
 *  margin around them, so the straight run where a polygon was clipped falls
 *  outside the canvas and never shows as a border that isn't there. */
function strokeArea(ctx: CanvasRenderingContext2D, area: BorderArea, at: Projector): void {
  for (const ring of area.rings) {
    const n = ringLength(ring);
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const x = at.x(ring[i * 2]);
      const y = at.y(ring[i * 2 + 1]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

function drawLabel(ctx: CanvasRenderingContext2D, label: LabelPlacement, colors: BorderColors): void {
  ctx.font = labelFont(label.level);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  ctx.strokeStyle = colors.halo;
  ctx.strokeText(label.name, label.x, label.y);
  ctx.fillStyle = colors.line;
  ctx.fillText(label.name, label.x, label.y);
}

/** A borders layer for one year. `setYear` moves it without refetching. */
export function bordersLayer(options: Omit<BordersLayerOptions, "attribution">): L.GridLayer & {
  setYear(year: number): void;
} {
  return new (BordersLayer as unknown as new (o: BordersLayerOptions) => L.GridLayer & { setYear(y: number): void })({
    ...options,
    attribution: OHM_ATTRIBUTION,
    zIndex: options.zIndex ?? BORDERS_Z,
    // Tiles of 512 px, taken one zoom coarser than the map stands at: a
    // quarter as many requests for the same screen, off a source whose
    // boundaries are already generalized past what that screen can show.
    tileSize: OHM_TILE_PX,
  });
}

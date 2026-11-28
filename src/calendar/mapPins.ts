// The family calendar's map: where the people it celebrates live — each one's
// last residence that carries coordinates. Pure; the map and its flags are the
// view's.

import type { Dataset, GeoCoord } from "../gedcom/types";
import { lastResidence } from "../chart/nodeDisplay";

export interface MapPin {
  coord: GeoCoord;
  /** The place's own name: its most specific part. */
  place: string;
  /** Everyone living there, in the order given. */
  ids: string[];
}

/** Two residences closer than this (about a hundred metres) are one pin. */
const SAME_PLACE = 3;

/** One pin per place the given people live at, the fullest first. A person
 *  with no residence that carries coordinates has none. */
export function residencePins(ds: Dataset, ids: Iterable<string>): MapPin[] {
  const pins = new Map<string, MapPin>();
  for (const id of new Set(ids)) {
    const indi = ds.individuals.get(id);
    const place = indi && lastResidence(indi, (e) => e.place?.coord)?.place;
    if (!place?.coord) continue;
    const key = `${place.coord.lat.toFixed(SAME_PLACE)},${place.coord.lon.toFixed(SAME_PLACE)}`;
    const pin = pins.get(key) ?? { coord: place.coord, place: place.parts[0] || place.raw, ids: [] };
    pin.ids.push(id);
    pins.set(key, pin);
  }
  return [...pins.values()].sort((a, b) => b.ids.length - a.ids.length);
}

/** A point on the drawn map, as fractions of its width and height. */
export interface MapSpot {
  x: number;
  y: number;
}

export interface MapFlag extends MapSpot {
  place: string;
  ids: string[];
}

/**
 * The flags a drawn map carries: pins whose dots would touch (within `reach`
 * of the map's width) share one flag, under the name of the
 * place most of them live at. `spots[i]` is where `pins[i]` fell on the map,
 * `aspect` its width over its height.
 */
export function mapFlags(pins: MapPin[], spots: MapSpot[], aspect: number, reach = 0.025): MapFlag[] {
  const flags: MapFlag[] = [];
  pins.forEach((pin, i) => {
    const at = spots[i];
    if (!at) return;
    // Distances in widths, so the reach is the same in both directions.
    const near = flags.find((f) => Math.hypot(f.x - at.x, (f.y - at.y) / aspect) < reach);
    if (near) near.ids.push(...pin.ids);
    else flags.push({ ...at, place: pin.place, ids: [...pin.ids] });
  });
  return flags;
}

/** The share of the people a map must hold before a far-off place may fall off it. */
const FRAME_SHARE = 0.6;
/** A place just outside the frame still joins it when it is no further out
 *  than this many times the frame's own reach. */
const FRAME_STRETCH = 1.5;

/** Distance between two coordinates, in kilometres — near enough for ranking. */
function km(a: GeoCoord, b: GeoCoord): number {
  const dy = (a.lat - b.lat) * 111;
  const dx = (a.lon - b.lon) * 111 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180));
  return Math.hypot(dx, dy);
}

/** The value half of the people lie at or below. */
function weightedMedian(pins: MapPin[], of: (p: MapPin) => number): number {
  const sorted = [...pins].sort((a, b) => of(a) - of(b));
  const half = pins.reduce((n, p) => n + p.ids.length, 0) / 2;
  let seen = 0;
  for (const p of sorted) {
    seen += p.ids.length;
    if (seen >= half) return of(p);
  }
  return of(sorted[0]);
}

/**
 * The pins a map is framed on, and the ones left off it. One cousin overseas
 * would shrink the whole family's home to a dot, so the map holds where most
 * of them live: the places nearest the family's middle until they hold
 * {@link FRAME_SHARE} of the people, and any further place that is still
 * about as near. The rest are `away` — named beside the map, not drawn on it.
 */
export function framePins(pins: MapPin[]): { on: MapPin[]; away: MapPin[] } {
  if (pins.length < 2) return { on: pins, away: [] };
  const middle = { lat: weightedMedian(pins, (p) => p.coord.lat), lon: weightedMedian(pins, (p) => p.coord.lon) };
  const byReach = pins.map((pin) => ({ pin, far: km(pin.coord, middle) })).sort((a, b) => a.far - b.far);
  const need = pins.reduce((n, p) => n + p.ids.length, 0) * FRAME_SHARE;
  const on = new Set<MapPin>();
  let held = 0;
  let reach = 0;
  for (const { pin, far } of byReach) {
    // A frame of a town or two has little reach to stretch: a hundred kilometres stand in.
    if (held >= need && far > Math.max(reach, 100) * FRAME_STRETCH) break;
    on.add(pin);
    held += pin.ids.length;
    reach = far;
  }
  // Both in the order given: the fullest place first.
  return { on: pins.filter((p) => on.has(p)), away: pins.filter((p) => !on.has(p)) };
}

type XY = [number, number];
/** Whether the segments a–b and c–d cross each other. */
function segmentsCross(a: XY, b: XY, c: XY, d: XY): boolean {
  const turn = (p: XY, q: XY, r: XY) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return turn(a, b, c) !== turn(a, b, d) && turn(c, d, a) !== turn(c, d, b);
}

/** A flag drawn as a callout: a box at the map's edge, tied to its place by a line. */
export interface Callout extends MapFlag {
  side: "left" | "right";
  /** The box's top edge, as a fraction of the map's height. */
  top: number;
  /** Where the line meets the box, as a fraction of the map's height. */
  tie: number;
  /** How many of the names the box writes out; the rest are counted. */
  names: number;
}

/** A callout's measures, in the page's em. */
export const CALLOUT = {
  /** A line of a box. */
  line: 0.875,
  /** A box's own padding, top and bottom together. */
  pad: 0.3,
  /** Between two boxes of a column, and between a column and the map's edge. */
  gap: 0.35,
  /** A box's width. */
  width: 9,
  /** The most names a box writes out. */
  names: 4,
};

/** Lines a box of `count` people takes when it writes out `names` of them:
 *  the place, the names, and a line counting the rest. */
const boxLines = (count: number, names: number) => 1 + Math.min(count, names) + (count > names && names > 0 ? 1 : 0);
const boxHeight = (count: number, names: number) => boxLines(count, names) * CALLOUT.line + CALLOUT.pad;

/**
 * The flags laid out as callouts in a column down each side of a map
 * `heightEm` tall, of which the last `footEm` are kept free. A flag goes to
 * the side its place is nearer, beside it where there is room; boxes that
 * would overlap are pushed apart, and when a column has more boxes than room
 * every box writes out fewer names — down to the place alone, with a count.
 * Two neighbours whose lines would cross change places, so no line crosses
 * another of its side. `widthEm` is the map's width, `edgeEm` a box's
 * distance from its edge.
 */
export function layoutCallouts(flags: MapFlag[], widthEm: number, heightEm: number, footEm = 0, edgeEm = 0.5): Callout[] {
  const room = heightEm - footEm - CALLOUT.gap;
  const sides = { left: [] as MapFlag[], right: [] as MapFlag[] };
  for (const f of flags) sides[f.x < 0.5 ? "left" : "right"].push(f);
  const tall = (list: MapFlag[], names: number) => list.reduce((h, f) => h + boxHeight(f.ids.length, names) + CALLOUT.gap, CALLOUT.gap);
  // A crowded side hands the places nearest the middle to the other one.
  for (const [from, to] of [["left", "right"], ["right", "left"]] as const) {
    sides[from].sort((a, b) => Math.abs(b.x - 0.5) - Math.abs(a.x - 0.5));
    while (sides[from].length > 1 && tall(sides[from], 0) > room && tall(sides[to], 0) + CALLOUT.line * 2 < room) sides[to].push(sides[from].pop()!);
  }
  let names = CALLOUT.names;
  while (names > 0 && (tall(sides.left, names) > room || tall(sides.right, names) > room)) names--;

  const out: Callout[] = [];
  for (const side of ["left", "right"] as const) {
    // Where a line of this side meets its box, across the map.
    const inner = side === "left" ? edgeEm + CALLOUT.width : widthEm - edgeEm - CALLOUT.width;
    const stack = (order: MapFlag[]) => {
      const column = order.map((f) => {
        const h = boxHeight(f.ids.length, names);
        return { f, h, top: f.y * heightEm - h / 2, tie: 0 };
      });
      // Down the column: no box above the map, none over the one before it.
      let floor = CALLOUT.gap;
      for (const box of column) {
        box.top = Math.max(box.top, floor);
        floor = box.top + box.h + CALLOUT.gap;
      }
      // And back up, where the last ones ran past the foot.
      let ceiling = room;
      for (const box of [...column].reverse()) {
        box.top = Math.min(box.top, ceiling - box.h);
        ceiling = box.top - CALLOUT.gap;
      }
      for (const box of column) box.tie = box.top + Math.min(box.h / 2, CALLOUT.line);
      return column;
    };
    type Box = ReturnType<typeof stack>[number];
    const crosses = (a: Box, b: Box) =>
      segmentsCross(
        [a.f.x * widthEm, a.f.y * heightEm], [inner, a.tie],
        [b.f.x * widthEm, b.f.y * heightEm], [inner, b.tie],
      );
    const order = sides[side].sort((a, b) => a.y - b.y);
    let column = stack(order);
    // Neighbours whose lines cross change places; a bounded number of rounds,
    // since a swap can cross the next pair.
    for (let round = 0; round < order.length; round++) {
      let swapped = false;
      for (let i = 0; i + 1 < order.length; i++) {
        if (!crosses(column[i], column[i + 1])) continue;
        [order[i], order[i + 1]] = [order[i + 1], order[i]];
        column = stack(order);
        swapped = true;
      }
      if (!swapped) break;
    }
    for (const { f, top, tie } of column) out.push({ ...f, side, names, top: top / heightEm, tie: tie / heightEm });
  }
  return out;
}

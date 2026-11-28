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

/** One pin per place the given people last lived at, the fullest first. A
 *  person with no residence that carries coordinates has none. */
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
 * The flags a drawn map carries: pins that would stand on top of each other
 * (within `reach` of the map's width) share one flag, under the name of the
 * place most of them live at. `spots[i]` is where `pins[i]` fell on the map,
 * `aspect` its width over its height.
 */
export function mapFlags(pins: MapPin[], spots: MapSpot[], aspect: number, reach = 0.07): MapFlag[] {
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
const FRAME_STRETCH = 3;

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
    // A frame of one town has no reach to stretch: fifty kilometres stand in.
    if (held >= need && far > Math.max(reach, 50) * FRAME_STRETCH) break;
    on.add(pin);
    held += pin.ids.length;
    reach = far;
  }
  // Both in the order given: the fullest place first.
  return { on: pins.filter((p) => on.has(p)), away: pins.filter((p) => !on.has(p)) };
}

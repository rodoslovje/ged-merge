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

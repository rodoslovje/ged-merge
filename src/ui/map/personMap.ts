import type { Dataset, GeoCoord } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import { MAP_EVENT_KINDS, personPoints, type MapEventKind } from "../../geo/points";
import { buildPersonPaths } from "../../geo/paths";
import { kindsColorVar } from "./markerStyle";
import type { MiniMapPin } from "./MiniPlaceMap";

/** One person's small places map: pins, life path and the kinds it shows. */
export interface PersonMap {
  pins: MiniMapPin[];
  /** The chronological stops of their life, when there are any. */
  path?: GeoCoord[];
  /** The event kinds present, in the canonical order — the legend row. */
  kinds: MapEventKind[];
}

/**
 * A person's coordinate-carrying events (own + spouse-family), grouped per
 * location as coloured pins, plus their chronological life path — the small
 * map under Edit's events and on the family website's person page. Null when
 * nothing is geocoded.
 */
export function personMapOf(dataset: Dataset, personId: string, t: Translate): PersonMap | null {
  const points = personPoints(dataset, personId);
  if (!points.length) return null;
  const byCoord = new Map<
    string,
    { coord: GeoCoord; place: string; addrs: Set<string>; labels: string[]; kinds: Set<string> }
  >();
  for (const p of points) {
    const k = `${p.coord.lat}:${p.coord.lon}`;
    const label = `${eventDisplayLabel(p.tag, t)}${p.year !== undefined ? ` ${p.year}` : ""}`;
    const hit = byCoord.get(k);
    if (hit) {
      hit.labels.push(label);
      hit.kinds.add(p.kind);
      if (p.address) hit.addrs.add(p.address);
    } else {
      byCoord.set(k, {
        coord: p.coord,
        place: p.place,
        addrs: new Set(p.address ? [p.address] : []),
        labels: [label],
        kinds: new Set([p.kind]),
      });
    }
  }
  const pins: MiniMapPin[] = [...byCoord.values()].map((g) => ({
    coord: g.coord,
    label: g.place,
    // One address means this pin is that house; several events with
    // different addresses landed on one coordinate, so name none.
    ...(g.addrs.size === 1 ? { sub: [...g.addrs][0] } : {}),
    lines: g.labels,
    kind: "candidate" as const,
    colorVar: kindsColorVar(g.kinds),
  }));
  const path = buildPersonPaths(points)
    .find((pp) => pp.personId === personId)
    ?.stops.map((s) => s.coord);
  const present = new Set(points.map((p) => p.kind));
  const kinds = MAP_EVENT_KINDS.filter((k) => present.has(k));
  return { pins, path, kinds };
}

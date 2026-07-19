import type { GedNode, GeoCoord } from "../types";

// Writing coordinates into a PLAC node as the standard GEDCOM MAP structure:
//   2 PLAC Kranj, Slovenija
//   3 MAP
//   4 LATI N46.23887
//   4 LONG E14.35561
// The builder lifts exactly this shape back into `GedPlace.coord`
// (parseCoordPair), so a rebuilt record shows the coordinate immediately.

/** One axis in the hemisphere-prefixed decimal form `parseCoordPair` reads.
 *  Five decimals ≈ 1 m; trailing zeros are trimmed ("N46.05", not "N46.05000"). */
export function formatCoordValue(value: number, axis: "lat" | "lon"): string {
  const hemi = axis === "lat" ? (value < 0 ? "S" : "N") : value < 0 ? "W" : "E";
  const fixed = Math.abs(value).toFixed(5).replace(/\.?0+$/, "");
  return hemi + fixed;
}

/**
 * Set (insert or replace) the `MAP` coordinates on a `PLAC` node, and — when a
 * GOV id is given — the GEDCOM-L `_GOV` identity tag alongside it:
 *   3 MAP
 *   4 LATI …
 *   4 LONG …
 *   3 _GOV object_310010
 * A new MAP goes first among the PLAC's children after any `FORM`; an existing
 * MAP has its LATI/LONG rewritten in place. `_GOV` (a MAP sibling) is inserted
 * right after MAP or, if already present, rewritten; without a govId any
 * existing `_GOV` is left untouched.
 */
export function setPlaceCoord(placNode: GedNode, coord: GeoCoord, govId?: string): void {
  const level = placNode.level + 1;
  let map = placNode.children.find((c) => c.tag === "MAP");
  if (!map) {
    map = { level, tag: "MAP", children: [] };
    const at = placNode.children.findIndex((c) => c.tag !== "FORM");
    if (at === -1) placNode.children.push(map);
    else placNode.children.splice(at, 0, map);
  }
  map.children = [
    { level: level + 1, tag: "LATI", value: formatCoordValue(coord.lat, "lat"), children: [] },
    { level: level + 1, tag: "LONG", value: formatCoordValue(coord.lon, "lon"), children: [] },
  ];
  if (govId) {
    let gov = placNode.children.find((c) => c.tag === "_GOV");
    if (!gov) {
      gov = { level, tag: "_GOV", value: govId, children: [] };
      placNode.children.splice(placNode.children.indexOf(map) + 1, 0, gov);
    } else {
      gov.value = govId;
    }
  }
}

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

/**
 * Write a house-precise coordinate from the address register onto one event.
 *
 * Which tag it lands in depends on whether PLAC can legitimately hold it:
 *
 *  - **PLAC names the house** (`PLAC Šentvid pri Stični 23`) — the place string
 *    identifies that house, so every occurrence of it shares this coordinate.
 *    Written as the standard `PLAC.MAP`, which every other program reads.
 *  - **PLAC names only the settlement** and the number is in ADDR — the place
 *    string is shared by every event in that settlement, so a house coordinate
 *    must not go there: `scanSplitCoordPlaces` would later offer to copy it onto
 *    the settlement's other, differently-addressed events. It goes under ADDR as
 *    `_MAP` instead. GEDCOM defines `MAP` under `PLAC` only, so there is no
 *    standard alternative; the `_` prefix marks it a vendor extension (as with
 *    `_GOV` above), which readers skip rather than misinterpret.
 *
 * Returns the tag written, or undefined when the event has neither node.
 */
export function setAddressCoord(eventNode: GedNode, coord: GeoCoord, placeNamesHouse: boolean): "PLAC" | "_MAP" | undefined {
  const plac = eventNode.children.find((c) => c.tag === "PLAC");
  if (placeNamesHouse && plac) {
    setPlaceCoord(plac, coord);
    return "PLAC";
  }
  const addr = eventNode.children.find((c) => c.tag === "ADDR");
  if (!addr) {
    // No ADDR to hang it on: fall back to PLAC rather than dropping the pick.
    if (!plac) return undefined;
    setPlaceCoord(plac, coord);
    return "PLAC";
  }
  const level = addr.level + 1;
  let map = addr.children.find((c) => c.tag === "_MAP");
  if (!map) {
    map = { level, tag: "_MAP", children: [] };
    // After the structured address parts (ADR1/CITY/POST/…), so a reader that
    // walks them in order is unaffected.
    addr.children.push(map);
  }
  map.children = [
    { level: level + 1, tag: "LATI", value: formatCoordValue(coord.lat, "lat"), children: [] },
    { level: level + 1, tag: "LONG", value: formatCoordValue(coord.lon, "lon"), children: [] },
  ];
  return "_MAP";
}

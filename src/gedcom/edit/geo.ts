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
 * Whether two coordinates serialize to the same `LATI`/`LONG` text — the
 * equality that matters for "would writing this change anything". Exact float
 * comparison is the wrong test there: a candidate carries full precision while
 * the file holds the written 5-decimal form, so re-picking the very entry a
 * value came from compared unequal and "rewrote" every occurrence with
 * byte-identical text — a nonzero change count and an empty undo step.
 */
export function sameWrittenCoord(a: GeoCoord, b: GeoCoord): boolean {
  return (
    formatCoordValue(a.lat, "lat") === formatCoordValue(b.lat, "lat") &&
    formatCoordValue(a.lon, "lon") === formatCoordValue(b.lon, "lon")
  );
}

/**
 * Declare what each comma part of a `PLAC` stands for, as the standard `FORM`
 * substructure:
 *   2 PLAC Zgornje Bitnje, Kranj, Slovenia
 *   3 FORM Place,Upravna Enota,Country
 * FORM leads the PLAC's children — `setPlaceCoord` places a new `MAP` after it
 * — and an existing one is rewritten rather than duplicated.
 */
export function setPlaceForm(placNode: GedNode, form: string): void {
  const existing = placNode.children.find((c) => c.tag === "FORM");
  if (existing) {
    existing.value = form;
    return;
  }
  placNode.children.unshift({ level: placNode.level + 1, tag: "FORM", value: form, children: [] });
}

/**
 * Keep a place's FORM describing the place it sits on, after that place changed.
 * A known schema — attested on this very place elsewhere in the file, or
 * composed with it from a register — is written. With none, a FORM inherited
 * from the *previous* place is kept minus the deleted parts' labels when the
 * change (given via `prevValue`) only deleted parts, and dropped once its label
 * count no longer matches the parts it claims to name, since it demonstrably
 * describes something else; one that still lines up is left alone rather than
 * guessed at.
 */
export function reconcilePlaceForm(placNode: GedNode, form: string | undefined, prevValue?: string): void {
  if (form) {
    setPlaceForm(placNode, form);
    return;
  }
  const existing = placNode.children.find((c) => c.tag === "FORM");
  if (!existing?.value || !placNode.value) return;
  if (existing.value.split(",").length === placNode.value.split(",").length) return;
  const carried = prevValue ? formMinusDeletedParts(prevValue, existing.value, placNode.value) : undefined;
  if (carried) existing.value = carried;
  else placNode.children = placNode.children.filter((c) => c !== existing);
}

/**
 * The FORM a value keeps through a rename that only *deletes* comma parts:
 * "Chicago, , Cook, Illinois, United States" losing its blank level keeps
 * "Place, Municipality, County, State, Country" minus the Municipality slot,
 * rather than losing its labels with the comma.
 *
 * Only an unambiguous deletion qualifies. Each surviving part must name exactly
 * one part of the old value, in order — a rewording, a reordering, or a part
 * the old value wrote twice ("United States, , , , United States" collapsing to
 * its country, which its labels file under Place *and* Country) answers
 * undefined, and the caller drops the stale FORM as before.
 */
function formMinusDeletedParts(prevValue: string, form: string, value: string): string | undefined {
  const before = prevValue.split(",").map((s) => s.trim());
  const after = value.split(",").map((s) => s.trim());
  const labels = form.split(",");
  if (labels.length !== before.length || after.length >= before.length) return undefined;
  const kept: string[] = [];
  let last = -1;
  for (const part of after) {
    const at = before.indexOf(part);
    if (at <= last || before.indexOf(part, at + 1) !== -1) return undefined;
    kept.push(labels[at]);
    last = at;
  }
  return kept.join(",").trim();
}

/**
 * Remove a `PLAC` node's `_GOV` identity, leaving the `MAP` coordinate alone.
 * Used when an event moves to a different place: a coordinate is a position and
 * stays roughly true (or is replaced by the new place's), while a GOV id names
 * one specific place and would be a plain untruth under the new name. Returns
 * whether anything was removed.
 */
export function clearPlaceGov(placNode: GedNode): boolean {
  const before = placNode.children.length;
  placNode.children = placNode.children.filter((c) => c.tag !== "_GOV");
  return placNode.children.length !== before;
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

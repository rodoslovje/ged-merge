import type { GedNode } from "../gedcom/types";
import { isUnknownPlaceValue } from "../gedcom/place";

/**
 * Tidy a place (or address) value's whitespace only: collapse runs of spaces
 * and trim the ends. Place names are deliberately left exactly as the source
 * wrote them — casing and spelling are not changed on import (structural
 * reshaping to the main's layout happens later, during merge).
 */
export function normalizePlaceString(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Strip all-placeholder `PLAC`/`ADDR` nodes ("----", "unknown", "----, ----")
 * from a record tree, returning each removed raw value (for the report).
 *
 * Such a value states exactly what an absent tag states — the place is
 * unknown — so carrying a foreign "----" into the compare view would show a
 * difference where there is no information on either side. This is the place
 * analog of {@link dropPlaceholderDates}; unlike dates and names it needs no
 * gate on the main's convention, because GEDCOM's way of writing "no place" is
 * to write no tag, and the merge never removes a placeholder the *main* holds.
 *
 * A node carrying children (a `MAP` coordinate, a `NOTE`) is left alone: the
 * value says nothing but the subtree might, and dropping it would lose data.
 */
export function dropPlaceholderPlaces(node: GedNode): string[] {
  const removed: string[] = [];
  const kept: GedNode[] = [];
  for (const child of node.children) {
    if (
      (child.tag === "PLAC" || child.tag === "ADDR") &&
      child.children.length === 0 &&
      isUnknownPlaceValue(child.value)
    ) {
      removed.push(child.value!.trim());
      continue; // drop this node
    }
    removed.push(...dropPlaceholderPlaces(child));
    kept.push(child);
  }
  node.children = kept;
  return removed;
}

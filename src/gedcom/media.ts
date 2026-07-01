/**
 * Media (`OBJE`) house-style detection.
 *
 * GEDCOM files attach a photo to a person in one of two styles:
 *  - **inline** — a `1 OBJE` block with a direct `2 FILE` child on the record;
 *  - **shared** — a top-level `0 @O@ OBJE` record referenced by a `1 OBJE @O@`
 *    pointer, so the same photo can be cited by several people.
 *
 * When the editor adds a photo it follows whichever style the master file
 * already uses (mirroring how normalization respects the master's date/place
 * conventions), so the saved file stays internally consistent.
 */

import { isPointer } from "./source";
import { hasChild } from "./node";
import type { GedNode } from "./types";

export type MediaMode = "inline" | "shared";

/**
 * Detect whether the master attaches photos inline or via shared top-level
 * `OBJE` records, by counting how each `OBJE` on an `INDI`/`FAM` record is
 * expressed. Ties — and a file with no photos at all — fall back to "shared",
 * since shared records allow one photo to be referenced by several people.
 */
export function detectMediaMode(records: GedNode[]): MediaMode {
  let inline = 0;
  let shared = 0;
  for (const rec of records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    for (const child of rec.children) {
      if (child.tag !== "OBJE") continue;
      const value = child.value?.trim();
      if (value && isPointer(value)) shared++;
      else if (hasChild(child, "FILE")) inline++;
    }
  }
  return inline > shared ? "inline" : "shared";
}

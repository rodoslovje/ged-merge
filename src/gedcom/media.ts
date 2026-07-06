/**
 * Media (`OBJE`) house-style detection.
 *
 * GEDCOM files attach a photo to a person in one of two styles:
 *  - **inline** — a `1 OBJE` block with a direct `2 FILE` child on the record;
 *  - **shared** — a top-level `0 @O@ OBJE` record referenced by a `1 OBJE @O@`
 *    pointer, so the same photo can be cited by several people.
 *
 * When the editor adds a photo it follows whichever style the main file
 * already uses (mirroring how normalization respects the main's date/place
 * conventions), so the saved file stays internally consistent.
 */

import { cropOf, isPointer, objeInfoOf, objeNodesFor, type CropRegion } from "./source";
import { childrenByTag, hasChild } from "./node";
import type { GedNode } from "./types";

export type MediaMode = "inline" | "shared";

/**
 * Detect whether the main attaches photos inline or via shared top-level
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

// ── Media reference collection ──────────────────────────────────────────────

/**
 * Where a media link (`OBJE`) sits inside a record — enough to re-find its node
 * after any in-place mutation or undo, without holding a node reference:
 * the record itself (`eventTag` unset) or one of its direct-child events
 * (e.g. the second `RESI`), then the position among that container's `OBJE`
 * children. Edit operations resolve it freshly via {@link mediaNodeAt}.
 */
export interface MediaAddress {
  /** Tag of the record's direct child holding the `OBJE` (e.g. `"BIRT"`);
   *  undefined when the `OBJE` sits on the record itself. */
  eventTag?: string;
  /** Index among the record's direct children with `eventTag`. */
  eventIndex?: number;
  /** Index among the container's direct `OBJE` children (counting URL-only
   *  ones too, so edit ops target the right child even when some `OBJE`s
   *  aren't displayable photos). */
  objeIndex: number;
}

/** One local media file linked from a record, with the descriptive fields
 *  shown in the viewer and the address edit operations need. */
export interface MediaRef extends MediaAddress {
  file: string;
  title?: string;
  /** A `DATE` on the media — the date it depicts (not an edit timestamp). */
  date?: string;
  place?: string;
  /** Free-text description, from `_DSCR` or `NOTE`. */
  description?: string;
  /** Shared media record xref, present only for pointer-style OBJE links. */
  xref?: string;
  /** GEDCOM 7 crop region from the OBJE *link* — the part of this (group) photo
   *  that depicts the record. Lives on the link, not the shared media record. */
  crop?: CropRegion;
}

/** Local file, title, and descriptive content for one OBJE node, or null when
 *  it's a URL/has no file. Reuses the shared OBJE parser; keeps only nodes whose
 *  `FILE` is a local filename (a displayable photo), dropping URL-only links. */
function objeMediaRef(objeNode: GedNode): Pick<MediaRef, "file" | "title" | "date" | "place" | "description"> | null {
  const info = objeInfoOf(objeNode);
  if (!info.file || info.url) return null;
  return {
    file: info.file,
    title: info.title,
    date: info.date,
    place: info.place,
    description: info.description,
  };
}

/**
 * Every local media file linked from a record's `OBJE` children — on the record
 * itself first, then under its direct-child events (a christening photo on
 * `CHR`, a wedding photo on a `FAM`'s `MARR`, …). `SOUR` citation subtrees are
 * skipped: their media belongs to the source and is shown by the sources UI.
 */
export function collectMediaRefs(raw: GedNode, records: GedNode[]): MediaRef[] {
  const objeNodes = objeNodesFor(records);
  const refs: MediaRef[] = [];

  const collectFrom = (container: GedNode, at: Pick<MediaAddress, "eventTag" | "eventIndex">) => {
    let objeIndex = -1;
    for (const child of container.children) {
      if (child.tag !== "OBJE") continue;
      objeIndex++;
      const val = child.value?.trim();
      const xref = val && isPointer(val) ? val : undefined;
      const objeNode = xref ? objeNodes.get(xref) : child;
      if (!objeNode) continue;
      const ref = objeMediaRef(objeNode);
      // The crop region lives on the link node (`child`), not the shared OBJE
      // record — different people crop different parts of the same image.
      if (ref) refs.push({ ...ref, xref, crop: cropOf(child), ...at, objeIndex });
    }
  };

  collectFrom(raw, {});
  const tagCounts = new Map<string, number>();
  for (const child of raw.children) {
    const eventIndex = tagCounts.get(child.tag) ?? 0;
    tagCounts.set(child.tag, eventIndex + 1);
    if (child.tag === "OBJE" || child.tag === "SOUR" || child.children.length === 0) continue;
    collectFrom(child, { eventTag: child.tag, eventIndex });
  }
  return refs;
}

/** Resolve a media address to its container node — the record itself or the
 *  addressed event — against the record's *current* children. */
export function mediaContainerOf(raw: GedNode, addr: MediaAddress): GedNode | undefined {
  if (!addr.eventTag) return raw;
  return childrenByTag(raw, addr.eventTag)[addr.eventIndex ?? 0];
}

/** Resolve a media address to its `OBJE` link node, or undefined when the
 *  record no longer has it (e.g. after an undo). */
export function mediaNodeAt(raw: GedNode, addr: MediaAddress): GedNode | undefined {
  const container = mediaContainerOf(raw, addr);
  return container ? childrenByTag(container, "OBJE")[addr.objeIndex] : undefined;
}

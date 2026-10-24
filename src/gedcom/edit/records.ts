import type { Dataset, Family, GedNode, Individual, NoteRef } from "../types";
import type { FormatOverrides } from "../../normalize/formatOverrides";
import { memoOnContent } from "./cache";
import { EDITABLE_LINK_TAGS, FAM_CHILD_ORDER, INDI_CHILD_ORDER, insertGrouped, insertOrdered } from "./shared";
import { applyNoteRefs, type SharedNoteCtx } from "./notes";
import { fsIdNode, isFsIdNode } from "../exid";

/** Tags used for record-level links (top-level on INDI/FAM records). */
const RECORD_LINK_TAGS: readonly string[] = EDITABLE_LINK_TAGS;

/** The record-level link tags written as one value line (`_WEBTAG` is a block). */
const LINE_LINK_TAGS = new Set(["WWW", "URL", "_URL", "_LINK"]);

/** The extension a link on a person or family record is written with where
 *  nothing else decides: neither GEDCOM version has a link on a record. */
export const RECORD_LINK_EXTENSION = "_URL";

/**
 * The tag a link on a person or family record is written with. Neither
 * standard has one there (`WWW` belongs to an address or an event), so a
 * strict target format writes {@link RECORD_LINK_EXTENSION}. The file's own
 * format keeps the record's own link tag, else the one the file writes most,
 * else the extension too.
 */
export function recordLinkTag(records: GedNode[], record: GedNode, overrides?: FormatOverrides): string {
  if (overrides?.standard) return RECORD_LINK_EXTENSION;
  const own = record.children.find((c) => LINE_LINK_TAGS.has(c.tag))?.tag;
  return own ?? memoOnContent(records, "recordLinkTag", () => fileRecordLinkTag(records));
}

function fileRecordLinkTag(records: GedNode[]): string {
  const counts = new Map<string, number>();
  for (const rec of records) {
    if (rec.tag !== "INDI" && rec.tag !== "FAM") continue;
    for (const c of rec.children) if (LINE_LINK_TAGS.has(c.tag)) counts.set(c.tag, (counts.get(c.tag) ?? 0) + 1);
  }
  let best = RECORD_LINK_EXTENSION;
  let max = 0;
  for (const [tag, n] of counts) if (n > max) [best, max] = [tag, n];
  return best;
}

/** Tags carrying a FamilySearch person id (MacFamilyTree / RootsMagic dialects),
 *  plus GEDCOM 7's `EXID` with the FamilySearch type (see `gedcom/exid`). */
export type FsIdTag = "_FID" | "_FSFTID" | "EXID";

/**
 * The FamilySearch-id tag a new id should be written with. A strict target
 * format writes GEDCOM 7's standard `EXID` in 7.0, and in 5.5.1 — which has
 * no EXID — the file's own extension, else RootsMagic's `_FSFTID`. The file's
 * own format keeps the tag the file already uses if any record carries one,
 * else `EXID` in a 7.0 file, else the producing software's native dialect
 * (MacFamilyTree writes `_FID`), else `_FSFTID`.
 */
export function preferredFsIdTag(ds: Dataset, overrides?: FormatOverrides): FsIdTag {
  if (overrides?.standard === "7.0") return "EXID";
  for (const indi of ds.individuals.values()) {
    const node = indi.raw.children.find(isFsIdNode);
    if (node && (node.tag !== "EXID" || !overrides?.standard)) return node.tag as FsIdTag;
  }
  if (overrides?.standard) return "_FSFTID";
  if (ds.version === "7.0") return "EXID";
  const head = ds.records.find((r) => r.tag === "HEAD");
  const sour = head?.children.find((c) => c.tag === "SOUR")?.value?.toUpperCase() ?? "";
  return sour.includes("FAMILYTREE") ? "_FID" : "_FSFTID";
}

/**
 * Replace an individual's FamilySearch person ids (`_FID`/`_FSFTID`/`EXID`).
 * Existing nodes keep their tag and position (values updated in place); ids
 * beyond the existing count are appended with `tag` — the record's own tag when
 * it has one, else the caller's file-level preference (see {@link preferredFsIdTag}).
 */
export function setFsIds(indi: Individual, ids: string[], preferredTag: FsIdTag): void {
  const clean = ids.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const existing = indi.raw.children.filter(isFsIdNode);
  const tag = existing.length ? existing[existing.length - 1].tag : preferredTag;
  existing.slice(0, clean.length).forEach((node, i) => { node.value = clean[i]; });
  if (clean.length < existing.length) {
    const drop = new Set(existing.slice(clean.length));
    indi.raw.children = indi.raw.children.filter((c) => !drop.has(c));
  }
  for (const value of clean.slice(existing.length)) {
    insertGrouped(indi.raw, fsIdNode(tag, value, indi.raw.level + 1), ["CHAN", "CREA"]);
  }
}

/** Replace an individual's notes, preserving shared-note pointers (see {@link applyNoteRefs}). */
export function setNotes(ctx: SharedNoteCtx, indi: Individual, notes: NoteRef[]): void {
  applyNoteRefs(ctx, indi.raw, notes, INDI_CHILD_ORDER);
}

/** Replace a family's notes, preserving shared-note pointers (see {@link applyNoteRefs}). */
export function setFamilyNotes(ctx: SharedNoteCtx, fam: Family, notes: NoteRef[]): void {
  applyNoteRefs(ctx, fam.raw, notes, FAM_CHILD_ORDER);
}

/** Replace all top-level link records on an individual (WWW/URL/_URL/_WEBTAG),
 *  writing each with `tag` (see {@link recordLinkTag}). */
export function setIndividualLinks(indi: Individual, links: string[], tag: string): void {
  indi.raw.children = indi.raw.children.filter((c) => !RECORD_LINK_TAGS.includes(c.tag));
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) continue;
    insertOrdered(indi.raw, { level: indi.raw.level + 1, tag, value: trimmed, children: [] }, INDI_CHILD_ORDER);
  }
}

/** Replace all top-level link records on a family (WWW/URL/_URL/_WEBTAG),
 *  writing each with `tag` (see {@link recordLinkTag}). */
export function setFamilyLinks(fam: Family, links: string[], tag: string): void {
  fam.raw.children = fam.raw.children.filter((c) => !RECORD_LINK_TAGS.includes(c.tag));
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) continue;
    insertOrdered(fam.raw, { level: fam.raw.level + 1, tag, value: trimmed, children: [] }, FAM_CHILD_ORDER);
  }
}

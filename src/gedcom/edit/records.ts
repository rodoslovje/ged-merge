import type { Dataset, Family, Individual, NoteRef } from "../types";
import { EDITABLE_LINK_TAGS, FAM_CHILD_ORDER, INDI_CHILD_ORDER, insertGrouped, insertOrdered } from "./shared";
import { applyNoteRefs, type SharedNoteCtx } from "./notes";

/** Tags used for record-level links (top-level on INDI/FAM records). */
const RECORD_LINK_TAGS: readonly string[] = EDITABLE_LINK_TAGS;

/** Tags carrying a FamilySearch person id (MacFamilyTree / RootsMagic dialects). */
const FSID_TAGS = ["_FID", "_FSFTID"];

export type FsIdTag = "_FID" | "_FSFTID";

/**
 * The FamilySearch-id tag a new id should be written with: the tag the file
 * already uses if any record carries one, else the producing software's native
 * dialect (MacFamilyTree writes `_FID`), else RootsMagic's `_FSFTID`.
 */
export function preferredFsIdTag(ds: Dataset): FsIdTag {
  for (const indi of ds.individuals.values()) {
    const node = indi.raw.children.find((c) => FSID_TAGS.includes(c.tag));
    if (node) return node.tag as FsIdTag;
  }
  const head = ds.records.find((r) => r.tag === "HEAD");
  const sour = head?.children.find((c) => c.tag === "SOUR")?.value?.toUpperCase() ?? "";
  return sour.includes("FAMILYTREE") ? "_FID" : "_FSFTID";
}

/**
 * Replace an individual's FamilySearch person ids (`_FID`/`_FSFTID`). Existing
 * nodes keep their tag and position (values updated in place); ids beyond the
 * existing count are appended with `tag` — the record's own tag when it has
 * one, else the caller's file-level preference (see {@link preferredFsIdTag}).
 */
export function setFsIds(indi: Individual, ids: string[], preferredTag: FsIdTag): void {
  const clean = ids.map((s) => s.trim().toUpperCase()).filter(Boolean);
  const existing = indi.raw.children.filter((c) => FSID_TAGS.includes(c.tag));
  const tag = existing.length ? existing[existing.length - 1].tag : preferredTag;
  existing.slice(0, clean.length).forEach((node, i) => { node.value = clean[i]; });
  if (clean.length < existing.length) {
    const drop = new Set(existing.slice(clean.length));
    indi.raw.children = indi.raw.children.filter((c) => !drop.has(c));
  }
  for (const value of clean.slice(existing.length)) {
    insertGrouped(indi.raw, { level: indi.raw.level + 1, tag, value, children: [] }, ["CHAN", "CREA"]);
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

/** Replace all top-level link records on an individual (WWW/URL/_URL/_WEBTAG). */
export function setIndividualLinks(indi: Individual, links: string[]): void {
  indi.raw.children = indi.raw.children.filter((c) => !RECORD_LINK_TAGS.includes(c.tag));
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) continue;
    insertOrdered(indi.raw, { level: indi.raw.level + 1, tag: "WWW", value: trimmed, children: [] }, INDI_CHILD_ORDER);
  }
}

/** Replace all top-level link records on a family (WWW/URL/_URL/_WEBTAG). */
export function setFamilyLinks(fam: Family, links: string[]): void {
  fam.raw.children = fam.raw.children.filter((c) => !RECORD_LINK_TAGS.includes(c.tag));
  for (const link of links) {
    const trimmed = link.trim();
    if (!trimmed) continue;
    insertOrdered(fam.raw, { level: fam.raw.level + 1, tag: "WWW", value: trimmed, children: [] }, FAM_CHILD_ORDER);
  }
}

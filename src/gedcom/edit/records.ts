import type { Family, Individual, NoteRef } from "../types";
import { FAM_CHILD_ORDER, INDI_CHILD_ORDER, insertOrdered } from "./shared";
import { applyNoteRefs, type SharedNoteCtx } from "./notes";

/** Tags used for record-level links (top-level on INDI/FAM records). */
const RECORD_LINK_TAGS = ["WWW", "URL", "_URL", "_WEBTAG"];

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

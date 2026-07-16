import { cloneNode, removeChildren } from "../node";
import { isPointer } from "../uri";
import type { Dataset, GedNode, NoteRef } from "../types";
import { bumpSourceCacheVersion, rebuildFamily, rebuildIndividual } from "./cache";
import { insertOrdered } from "./shared";

/**
 * Shared-note aware note editing.
 *
 * A note on a person/family/event is either inline (`1 NOTE text…`) or a
 * pointer to a shared record (`1 NOTE @N1@` → `0 @N1@ NOTE text…`). The old
 * write-back flattened every note to inline text, which orphaned the shared
 * records, diverged multi-referenced notes, and dropped the records' own
 * sub-structure (CHAN/CREA, MacFamilyTree's `PRIV` privacy flag, …). The
 * helpers here keep pointer notes as pointers: a text edit is applied inside
 * the shared record (all referrers see it — that is what "shared" means), and
 * only removing the last reference deletes the record itself.
 *
 * Mutations to shared records are reported as {@link SharedNoteChange}s so the
 * UI layer can turn them into undo/redo record patches — this module stays
 * free of UI types.
 */

/** One shared NOTE record this edit touched, for the caller's undo patches. */
export interface SharedNoteChange {
  xref: string;
  /** Deep copy of the record before the change. */
  before: GedNode;
  /** Deep copy after the change; null = the record was removed (last ref gone). */
  after: GedNode | null;
  /** For removals: the record's index in `records` before the splice. */
  index?: number;
}

/** Collects shared-record mutations across one edit operation. */
export interface SharedNoteCtx {
  records: GedNode[];
  changes: SharedNoteChange[];
}

export function noteCtx(records: GedNode[]): SharedNoteCtx {
  return { records, changes: [] };
}

function findNoteRecord(records: GedNode[], xref: string): GedNode | undefined {
  return records.find((r) => r.tag === "NOTE" && r.xref === xref);
}

/** Count `NOTE @xref@` pointers anywhere in the dataset (all records, all levels). */
export function countNoteRefs(records: GedNode[], xref: string): number {
  let n = 0;
  const walk = (node: GedNode): void => {
    for (const child of node.children) {
      if (child.tag === "NOTE" && child.value?.trim() === xref) n++;
      walk(child);
    }
  };
  for (const rec of records) walk(rec);
  return n;
}

/** Rewrite the text of shared NOTE record `xref` in place (no-op if the text
 *  is unchanged or the record doesn't exist), recording the change in `ctx`. */
export function setSharedNoteText(ctx: SharedNoteCtx, xref: string, text: string): void {
  const rec = findNoteRecord(ctx.records, xref);
  if (!rec || (rec.value ?? "") === text) return;
  const before = cloneNode(rec);
  rec.value = text;
  // The note index caches record *values*, so an in-place text edit goes stale.
  bumpSourceCacheVersion(ctx.records);
  ctx.changes.push({ xref, before, after: cloneNode(rec) });
}

/** Delete shared NOTE record `xref` if nothing references it anymore (call
 *  after the referring pointer node has been removed from its owner). */
export function removeNoteRecordIfOrphaned(ctx: SharedNoteCtx, xref: string): void {
  if (countNoteRefs(ctx.records, xref) > 0) return;
  const index = ctx.records.findIndex((r) => r.tag === "NOTE" && r.xref === xref);
  if (index === -1) return;
  const [rec] = ctx.records.splice(index, 1);
  bumpSourceCacheVersion(ctx.records);
  ctx.changes.push({ xref, before: cloneNode(rec), after: null, index });
}

/**
 * Replace the record-level notes of `ownerRaw` with `refs`, preserving
 * shared-note pointers: a ref with an `xref` keeps its `NOTE @xref@` pointer
 * (its text edit, if any, goes into the shared record), a ref without one is
 * written inline. Shared records whose last reference was removed are deleted.
 */
export function applyNoteRefs(ctx: SharedNoteCtx, ownerRaw: GedNode, refs: NoteRef[], order: string[]): void {
  const prevXrefs = ownerRaw.children
    .filter((c) => c.tag === "NOTE" && c.value && isPointer(c.value.trim()))
    .map((c) => c.value!.trim());

  for (const ref of refs) {
    if (ref.xref) setSharedNoteText(ctx, ref.xref, ref.text);
  }

  removeChildren(ownerRaw, "NOTE");
  for (const ref of refs) {
    const value = ref.xref ?? ref.text.trim();
    // An inline note with no text left is a removal; a pointer stays even when
    // its record text is empty (the record may carry sub-structure).
    if (!value) continue;
    insertOrdered(ownerRaw, { level: ownerRaw.level + 1, tag: "NOTE", value, children: [] }, order);
  }

  const kept = new Set(refs.map((r) => r.xref).filter(Boolean));
  for (const xref of prevXrefs) {
    if (!kept.has(xref)) removeNoteRecordIfOrphaned(ctx, xref);
  }
}

/**
 * Re-derive the typed projections of every individual/family that references
 * one of the changed shared notes — their `.notes`/`.noteRefs` text came from
 * the shared record and is stale now. `skipId` is the owner the caller already
 * rebuilds through its own commit path.
 */
export function rebuildNoteReferrers(dataset: Dataset, changes: { xref: string }[], skipId?: string): void {
  if (!changes.length) return;
  const xrefs = new Set(changes.map((c) => c.xref));
  const referencesChanged = (raw: GedNode): boolean => {
    const walk = (node: GedNode): boolean =>
      node.children.some(
        (c) => (c.tag === "NOTE" && c.value && xrefs.has(c.value.trim())) || walk(c),
      );
    return walk(raw);
  };
  for (const indi of dataset.individuals.values()) {
    if (indi.id !== skipId && referencesChanged(indi.raw)) rebuildIndividual(dataset, indi);
  }
  for (const fam of dataset.families.values()) {
    if (fam.id !== skipId && referencesChanged(fam.raw)) rebuildFamily(dataset, fam);
  }
}

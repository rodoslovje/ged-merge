import { cloneNode, removeChildren } from "../node";
import { isPointer } from "../uri";
import { detectPrivacyStyle, isPrivateNode, setPrivateFlag, type PrivacyTagStyle } from "../private";
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
  /** Lazily detected privacy-marker dialect (see {@link detectPrivacyStyle}). */
  privacyStyle?: PrivacyTagStyle;
}

export function noteCtx(records: GedNode[]): SharedNoteCtx {
  return { records, changes: [] };
}

/** The file's privacy dialect, detected once per ctx (i.e. per commit). */
function privacyStyleOf(ctx: SharedNoteCtx): PrivacyTagStyle {
  return (ctx.privacyStyle ??= detectPrivacyStyle(ctx.records));
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

/** Rewrite the text of shared NOTE record `xref` in place, recording the
 *  change in `ctx`. No-op if the record doesn't exist or the text is
 *  trim-equal to what's stored: editors show/prefill trimmed text (a
 *  MacFamilyTree record's text starts on a CONT line, i.e. with a newline),
 *  and an untouched save must not rewrite records with whitespace-only
 *  differences. */
export function setSharedNoteText(ctx: SharedNoteCtx, xref: string, text: string): void {
  const rec = findNoteRecord(ctx.records, xref);
  if (!rec || (rec.value ?? "").trim() === text.trim()) return;
  const before = cloneNode(rec);
  rec.value = text;
  // The note index caches record *values*, so an in-place text edit goes stale.
  bumpSourceCacheVersion(ctx.records);
  ctx.changes.push({ xref, before, after: cloneNode(rec) });
}

/** Set/clear the private flag on shared NOTE record `xref` (no-op when it
 *  already matches), following the file's own marker dialect. */
export function setSharedNotePrivate(ctx: SharedNoteCtx, xref: string, on: boolean): void {
  const rec = findNoteRecord(ctx.records, xref);
  if (!rec || isPrivateNode(rec) === on) return;
  const before = cloneNode(rec);
  setPrivateFlag(rec, on, privacyStyleOf(ctx), ctx.records);
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
    if (ref.xref) {
      setSharedNoteText(ctx, ref.xref, ref.text);
      // Only an explicit flag writes: refs built without `private` (older
      // callers, tests) must not silently strip a record's privacy marker.
      if (ref.private !== undefined) setSharedNotePrivate(ctx, ref.xref, ref.private);
    }
  }

  removeChildren(ownerRaw, "NOTE");
  for (const ref of refs) {
    const value = ref.xref ?? ref.text.trim();
    // An inline note with no text left is a removal; a pointer stays even when
    // its record text is empty (the record may carry sub-structure).
    if (!value) continue;
    const node: GedNode = { level: ownerRaw.level + 1, tag: "NOTE", value, children: [] };
    // An inline note carries its own private marker; a pointer's lives in the
    // shared record (set above).
    if (!ref.xref && ref.private) setPrivateFlag(node, true, privacyStyleOf(ctx), ctx.records);
    insertOrdered(ownerRaw, node, order);
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

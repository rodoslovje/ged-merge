import { cloneNode } from "../node";
import { isPointer } from "../uri";
import { detectPrivacyStyle, isPrivateNode, isV7, setPrivateFlag, type PrivacyTagStyle } from "../private";
import { isHtmlNote } from "../noteHtml";
import type { Dataset, GedNode, NoteRef } from "../types";
import { bumpSourceCacheVersion, rebuildFamily, rebuildIndividual } from "./cache";
import { insertOrdered, insertRecord, nextXref } from "./shared";

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
  /** Deep copy of the record before the change; null = the record was created
   *  by this edit (undo removes it). */
  before: GedNode | null;
  /** Deep copy after the change; null = the record was removed (last ref gone). */
  after: GedNode | null;
  /** For removals: the record's index in `records` before the splice. */
  index?: number;
}

/** How a file writes a record's notes — see {@link detectNoteStyle}. */
export type NoteStyle = "shared" | "inline";

/** Collects shared-record mutations across one edit operation. */
export interface SharedNoteCtx {
  records: GedNode[];
  changes: SharedNoteChange[];
  /** Lazily detected privacy-marker dialect (see {@link detectPrivacyStyle}). */
  privacyStyle?: PrivacyTagStyle;
  /** Lazily detected note shape (see {@link detectNoteStyle}). */
  noteStyle?: NoteStyle;
}

/** `privacyStyle` presets the marker dialect (e.g. the Settings override);
 *  left out, it's detected from the file on first use. */
export function noteCtx(records: GedNode[], privacyStyle?: PrivacyTagStyle): SharedNoteCtx {
  return { records, changes: [], ...(privacyStyle ? { privacyStyle } : {}) };
}

/** The file's privacy dialect, detected once per ctx (i.e. per commit). */
function privacyStyleOf(ctx: SharedNoteCtx): PrivacyTagStyle {
  return (ctx.privacyStyle ??= detectPrivacyStyle(ctx.records));
}

/**
 * Whether this file keeps a record's notes in shared `0 @N…@ NOTE` records
 * (MacFamilyTree's habit — the record points at one with `1 NOTE @N1@`) or
 * inline on the record itself.
 *
 * A new note used to be written inline whatever the file did, which left a
 * file of 328 shared notes with a handful of inline ones this app had added —
 * the same kind of outlier a stray `MM/DD/YYYY` date would be. Detected from
 * the record-level notes the file already has, which is exactly the level
 * {@link applyNoteRefs} writes at; majority wins, and a file with no notes at
 * all gets the simpler inline shape.
 */
export function detectNoteStyle(records: GedNode[]): NoteStyle {
  let shared = 0;
  let inline = 0;
  for (const rec of records) {
    if (!rec.xref) continue;
    for (const child of rec.children) {
      if (child.tag !== "NOTE") continue;
      const v = child.value?.trim();
      if (v && isPointer(v)) shared++;
      else inline++;
    }
  }
  return shared > inline ? "shared" : "inline";
}

/** The file's note shape, detected once per ctx (i.e. per commit). */
function noteStyleOf(ctx: SharedNoteCtx): NoteStyle {
  return (ctx.noteStyle ??= detectNoteStyle(ctx.records));
}

/**
 * Create a shared `0 @N…@ NOTE` record holding `text`, and return its xref for
 * the pointer that will refer to it. Recorded in `ctx` like every other shared
 * change, so undo removes the record along with the pointer.
 */
function createNoteRecord(ctx: SharedNoteCtx, text: string): string {
  const xref = nextXref(ctx.records, "N");
  const rec: GedNode = { level: 0, xref, tag: "NOTE", value: text, children: [] };
  syncNoteMime(rec, ctx.records);
  insertRecord(ctx.records, rec);
  bumpSourceCacheVersion(ctx.records);
  ctx.changes.push({ xref, before: null, after: cloneNode(rec) });
  return xref;
}

/** GEDCOM 7 names a note's markup on a `MIME text/html` line; 5.5.1 has no
 *  such line and the markup is recognized from the text. Kept in step with
 *  the text this app writes: a rich-text note gets the line, a note edited
 *  back to plain text loses it. */
function syncNoteMime(node: GedNode, records: GedNode[]): void {
  const idx = node.children.findIndex((c) => c.tag === "MIME");
  const html = isV7(records) && isHtmlNote(node.value ?? "");
  if (html && idx === -1) node.children.unshift({ level: node.level + 1, tag: "MIME", value: "text/html", children: [] });
  else if (!html && idx !== -1 && node.children[idx].value?.trim().toLowerCase() === "text/html") node.children.splice(idx, 1);
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
  syncNoteMime(rec, ctx.records);
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
  removeNoteRecord(ctx, xref);
}

/** Unconditional removal half of {@link removeNoteRecordIfOrphaned} — the
 *  caller has already established the record is orphaned. */
function removeNoteRecord(ctx: SharedNoteCtx, xref: string): void {
  const index = ctx.records.findIndex((r) => r.tag === "NOTE" && r.xref === xref);
  if (index === -1) return;
  const [rec] = ctx.records.splice(index, 1);
  bumpSourceCacheVersion(ctx.records);
  ctx.changes.push({ xref, before: cloneNode(rec), after: null, index });
}

/** One tree walk counting the remaining references of several NOTE xrefs at
 *  once — a commit dropping k shared notes used to walk the whole dataset k
 *  times over via per-xref {@link countNoteRefs}. */
function countNoteRefsMulti(records: GedNode[], xrefs: ReadonlySet<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const x of xrefs) counts.set(x, 0);
  const walk = (node: GedNode): void => {
    for (const child of node.children) {
      const v = child.tag === "NOTE" ? child.value?.trim() : undefined;
      if (v !== undefined && counts.has(v)) counts.set(v, counts.get(v)! + 1);
      walk(child);
    }
  };
  for (const rec of records) walk(rec);
  return counts;
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

  // Read the file's note shape before this owner's notes are torn down and
  // rebuilt below: asking mid-rebuild would sample a tree holding only the
  // pointers reinserted so far, so the second note of a mixed record would see
  // an all-shared file and follow it.
  const style = noteStyleOf(ctx);
  // The texts this record already held inline. A note among them is not a new
  // note, whatever the file's habit is — ticking its 🔒 must not quietly lift it
  // into a shared record and leave a pointer in its place. Wholesale conversion
  // is the Normalize tool's job, where it is asked for and previewed.
  const wasInline = new Set(
    ownerRaw.children
      .filter((c) => c.tag === "NOTE" && c.value && !isPointer(c.value.trim()))
      .map((c) => c.value!.trim()),
  );

  for (const ref of refs) {
    if (ref.xref) {
      setSharedNoteText(ctx, ref.xref, ref.text);
      // Only an explicit flag writes: refs built without `private` (older
      // callers, tests) must not silently strip a record's privacy marker.
      if (ref.private !== undefined) setSharedNotePrivate(ctx, ref.xref, ref.private);
    }
  }

  // Each ref is matched to the NOTE line it was read from, and only what the
  // edit changed is written: the old teardown-and-rebuild wrote every note back
  // from its text alone, so editing one note dropped the others' SOUR, LANG,
  // TRAN and vendor sub-lines, their CONC wrap, and their place in the record.
  // A ref carries no position, so identity is its xref (pointer) or its text
  // (inline); an inline note left over after that — the one being edited —
  // pairs with a leftover line standing between the same matched neighbours,
  // which is how the editor keeps its list (a note added at the end never
  // takes over one removed from the front).
  const existing = ownerRaw.children.filter(
    // Only the lines the editor was shown: an inline NOTE with no text of its
    // own never became a ref, so it cannot have been removed.
    (c) => c.tag === "NOTE" && !!c.value?.trim(),
  );
  const live = refs.filter((r) => r.xref || r.text.trim());
  const matched: (GedNode | undefined)[] = live.map(() => undefined);
  const used = new Set<GedNode>();
  const claim = (i: number, pick: (c: GedNode) => boolean): void => {
    const node = existing.find((c) => !used.has(c) && pick(c));
    if (node) { matched[i] = node; used.add(node); }
  };
  live.forEach((ref, i) => {
    if (ref.xref) claim(i, (c) => c.value!.trim() === ref.xref);
    else claim(i, (c) => !isPointer(c.value!.trim()) && c.value!.trim() === ref.text.trim());
  });
  live.forEach((ref, i) => {
    if (ref.xref || matched[i]) return;
    const before = matched.slice(0, i).reverse().find(Boolean);
    const after = matched.slice(i + 1).find(Boolean);
    const lo = before ? existing.indexOf(before) : -1;
    const hi = after ? existing.indexOf(after) : existing.length;
    claim(i, (c) => {
      const at = existing.indexOf(c);
      return at > lo && at < hi && !isPointer(c.value!.trim());
    });
  });

  for (const node of existing) {
    if (!used.has(node)) ownerRaw.children.splice(ownerRaw.children.indexOf(node), 1);
  }

  const written: (string | undefined)[] = [];
  let prev: GedNode | undefined;
  live.forEach((ref, i) => {
    const node = matched[i];
    if (node) {
      written.push(ref.xref);
      if (!ref.xref) {
        // An inline note: rewrite its value only when the text really moved
        // (the editor trims; a trailing space in the file is not an edit), and
        // its marker only when the flag flipped.
        if (node.value!.trim() !== ref.text.trim()) {
          node.value = ref.text.trim();
          syncNoteMime(node, ctx.records);
        }
        if (isPrivateNode(node) !== !!ref.private) setPrivateFlag(node, !!ref.private, privacyStyleOf(ctx), ctx.records);
      }
      prev = node;
      return;
    }
    // A note the file has no record for yet is written the way this file writes
    // notes — as a shared record it points at, or inline. Following the file's
    // own habit is the courtesy the date, place and privacy-marker conventions
    // already get; writing inline regardless left a file of shared notes with a
    // handful of this app's inline ones sitting among them.
    let xref = ref.xref;
    if (!xref && style === "shared" && !wasInline.has(ref.text.trim())) {
      xref = createNoteRecord(ctx, ref.text.trim());
      if (ref.private) setSharedNotePrivate(ctx, xref, true);
    }
    written.push(xref);
    const added: GedNode = { level: ownerRaw.level + 1, tag: "NOTE", value: xref ?? ref.text.trim(), children: [] };
    if (!xref) syncNoteMime(added, ctx.records);
    // An inline note carries its own private marker; a pointer's lives in the
    // shared record (set above).
    if (!xref && ref.private) setPrivateFlag(added, true, privacyStyleOf(ctx), ctx.records);
    // Right after the note before it, so a new note lands where the list has it.
    const at = prev ? ownerRaw.children.indexOf(prev) : -1;
    if (at !== -1) ownerRaw.children.splice(at + 1, 0, added);
    else insertOrdered(ownerRaw, added, order);
    prev = added;
  });

  const kept = new Set(written.filter(Boolean));
  const dropped = new Set(prevXrefs.filter((x) => !kept.has(x)));
  if (dropped.size) {
    const counts = countNoteRefsMulti(ctx.records, dropped);
    for (const xref of dropped) {
      if (counts.get(xref) === 0) removeNoteRecord(ctx, xref);
    }
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

import { cloneNode } from "../gedcom/node";
import { isPointer } from "../gedcom/uri";
import { isPrivateNode, setPrivateFlag, detectPrivacyStyle, type PrivacyTagStyle } from "../gedcom/private";
import type { GedNode } from "../gedcom/types";
import type { NormChange } from "../normalize/types";
import { nextXref } from "../gedcom/edit/shared";

/**
 * The Normalize pass for note shape.
 *
 * A note is written either as a record's own text (`1 NOTE some text`) or as a
 * shared `0 @N…@ NOTE` record the referrer points at (`1 NOTE @N1@`). Files
 * pick one habit and keep it — MacFamilyTree writes shared records, most other
 * programs write inline — and a file that has been through several of them ends
 * up with both, the way it ends up with two date formats.
 *
 * This restates every note in the target shape. Record-level and event-level
 * notes are counted and converted separately, because one file can hold
 * opposite habits at the two levels and the reader may want only one of them
 * changed.
 *
 * Working on the raw tree rather than the typed model is deliberate: the model
 * lifts only an event's *first* note, and a pass that silently skipped the
 * second would leave exactly the outlier it was asked to remove.
 */

/** Which shape notes are written in. */
export type NoteShape = "shared" | "inline";

/** Which notes a pass should touch: a record's own, or an event's, or both. */
export interface NoteReshapeScope {
  /** Notes hanging directly off an INDI/FAM record. */
  record: boolean;
  /** Notes deeper in the record — on events, names, citations. */
  event: boolean;
}

/**
 * Whether a note node at this depth counts as a record's own note. A note that
 * is a direct child of the top-level record is the record's; anything deeper
 * belongs to whatever structure holds it (an event, a name, a citation).
 */
const isRecordLevel = (depth: number) => depth === 1;

/** Whether a top-level record's notes are this pass's business — see
 *  {@link reshapeNotes} for the two exceptions. */
function carriesNotes(rec: GedNode): boolean {
  return !!rec.xref && rec.tag !== "NOTE";
}

/**
 * Restate every note in `records` in `target` shape.
 *
 * Every record that can carry a note is walked — people, families, sources,
 * media, repositories. Leaving sources out would have left this file with 47
 * pointer notes on its sources after a pass asked to remove every one of them,
 * which is exactly the leftover the pass exists to clear.
 *
 * Two records are skipped on purpose: a `NOTE` record itself (nesting a note
 * record inside a note record is not a shape anyone writes) and `HEAD`, whose
 * note is the file's own metadata rather than genealogy.
 *
 * Returns how many notes moved, plus a handful of illustrative examples.
 */
export function reshapeNotes(
  records: GedNode[],
  target: NoteShape,
  scope: NoteReshapeScope = { record: true, event: true },
): { changed: number; examples: NormChange[] } {
  let changed = 0;
  const examples: NormChange[] = [];
  const seen = new Set<string>();
  const note = (before: string, after: string) => {
    changed++;
    if (examples.length >= 12) return;
    const signature = `${before.replace(/\d+/g, "#")}→${after.replace(/\d+/g, "#")}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    examples.push({ before, after });
  };

  const style = detectPrivacyStyle(records);
  const noteRecords = new Map<string, GedNode>();
  for (const rec of records) {
    if (rec.tag === "NOTE" && rec.xref) noteRecords.set(rec.xref, rec);
  }

  /** Referrer count per shared NOTE, so a record is only deleted once the last
   *  pointer to it is gone — and a note used twice is recognized before it is
   *  copied into two places. */
  const refCounts = new Map<string, number>();
  const countRefs = (node: GedNode) => {
    for (const child of node.children) {
      const v = child.tag === "NOTE" ? child.value?.trim() : undefined;
      if (v && isPointer(v)) refCounts.set(v, (refCounts.get(v) ?? 0) + 1);
      countRefs(child);
    }
  };
  for (const rec of records) countRefs(rec);

  const inScope = (depth: number) => (isRecordLevel(depth) ? scope.record : scope.event);

  const walk = (node: GedNode, depth: number): void => {
    for (const child of node.children) {
      if (child.tag === "NOTE" && inScope(depth)) {
        const value = child.value?.trim() ?? "";
        if (target === "shared" && !isPointer(value) && value) {
          toShared(child, note, records, noteRecords);
        } else if (target === "inline" && isPointer(value)) {
          toInline(child, value, note, noteRecords, refCounts, style, records);
        }
      }
      walk(child, depth + 1);
    }
  };

  for (const rec of records) {
    if (!carriesNotes(rec)) continue;
    walk(rec, 1);
  }

  // Shared records nothing points at any more — every referrer was flattened.
  if (target === "inline") {
    for (const [xref, count] of refCounts) {
      if (count > 0) continue;
      const i = records.findIndex((r) => r.tag === "NOTE" && r.xref === xref);
      if (i !== -1) records.splice(i, 1);
    }
  }

  return { changed, examples };
}

/** Lift an inline note into a shared record and leave a pointer behind. */
function toShared(
  noteNode: GedNode,
  note: (before: string, after: string) => void,
  records: GedNode[],
  noteRecords: Map<string, GedNode>,
): void {
  const text = noteNode.value ?? "";
  const xref = nextXref(records, "N");
  const rec: GedNode = { level: 0, xref, tag: "NOTE", value: text, children: [] };
  // Everything hanging off the inline note travels with it, privacy marker
  // included — the flag belongs to the note, and on a pointer note the note is
  // the record.
  for (const child of noteNode.children) rec.children.push(cloneNode(child));
  // A record before TRLR, like every other record this app creates.
  const trlr = records.findIndex((r) => r.tag === "TRLR");
  records.splice(trlr === -1 ? records.length : trlr, 0, rec);
  noteRecords.set(xref, rec);
  noteNode.value = xref;
  noteNode.children = [];
  note(preview(text), `${xref} → ${preview(text)}`);
}

/** Copy a shared record's text back onto the pointer, releasing the reference. */
function toInline(
  noteNode: GedNode,
  xref: string,
  note: (before: string, after: string) => void,
  noteRecords: Map<string, GedNode>,
  refCounts: Map<string, number>,
  style: PrivacyTagStyle,
  records: GedNode[],
): void {
  const rec = noteRecords.get(xref);
  if (!rec) return; // dangling pointer — not this pass's business to invent text
  // MacFamilyTree starts a note record's text on a `1 CONT` line, so its value
  // begins with a newline. Carried over as-is that becomes a bare `1 NOTE`
  // followed by `2 CONT …` — the record's own layout habit, not the note's
  // content, and nothing anyone wants written into 163 people.
  noteNode.value = (rec.value ?? "").replace(/^\n+/, "");
  // The record's own sub-structure does not all belong on an inline note: its
  // CHAN/CREA are the *record's* history and mean nothing once the record is
  // gone. The privacy flag does belong to the note, so it is the one thing
  // carried over — rewritten in the file's dialect at the note's new level.
  noteNode.children = [];
  if (isPrivateNode(rec)) setPrivateFlag(noteNode, true, style, records);
  refCounts.set(xref, (refCounts.get(xref) ?? 1) - 1);
  note(`${xref} → ${preview(rec.value ?? "")}`, preview(rec.value ?? ""));
}

/** How many referrers a shared note has — the caller warns before flattening a
 *  note that several records share, since each gets its own copy of the text. */
export function sharedNotesUsedTwice(records: GedNode[]): number {
  const counts = new Map<string, number>();
  const walk = (node: GedNode) => {
    for (const child of node.children) {
      const v = child.tag === "NOTE" ? child.value?.trim() : undefined;
      if (v && isPointer(v)) counts.set(v, (counts.get(v) ?? 0) + 1);
      walk(child);
    }
  };
  for (const rec of records) walk(rec);
  let shared = 0;
  for (const n of counts.values()) if (n > 1) shared++;
  return shared;
}

/** Which shape a file's notes are in, counted separately per level — the
 *  "Auto" setting follows the majority at each level, so a file whose records
 *  are shared and whose events are inline keeps both habits. */
export function detectNoteShapes(records: GedNode[]): { record: NoteShape; event: NoteShape } {
  const counts = { record: { shared: 0, inline: 0 }, event: { shared: 0, inline: 0 } };
  const walk = (node: GedNode, depth: number) => {
    for (const child of node.children) {
      if (child.tag === "NOTE") {
        const bucket = isRecordLevel(depth) ? counts.record : counts.event;
        const v = child.value?.trim();
        if (v && isPointer(v)) bucket.shared++;
        else bucket.inline++;
      }
      walk(child, depth + 1);
    }
  };
  for (const rec of records) {
    if (!carriesNotes(rec)) continue;
    walk(rec, 1);
  }
  return {
    record: counts.record.shared > counts.record.inline ? "shared" : "inline",
    event: counts.event.shared > counts.event.inline ? "shared" : "inline",
  };
}

/** A note's text, shortened for a report row. */
function preview(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one;
}

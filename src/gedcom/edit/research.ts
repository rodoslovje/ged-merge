import { todayGedcom } from "../chanCrea";
import {
  isResearchPointer, readResearchNote, readResearchNotes, researchNoteNode, researchPointerNode,
  RESEARCH_TAG, RESEARCH_XREF_PREFIX, type ResearchIndex, type ResearchNote,
} from "../research";
import type { GedNode } from "../types";
import { bumpContentVersion, memoOnContent } from "./cache";
import { insertGrouped, insertRecord, nextXref } from "./shared";

/** What the reader edits of a research note; the rest is the record's own. */
export type ResearchFields = Pick<ResearchNote, "kind" | "done" | "text" | "links" | "media">;

/** The lines {@link writeResearchNote} owns; any other line of the record
 *  (its date, a change stamp) stays as it is. */
const FIELD_TAGS = new Set(["TYPE", "STAT", "NOTE", "WWW", "OBJE"]);

/** A record's or an event's own bookkeeping, which a pointer goes ahead of. */
const TRAILING = ["CHAN", "CREA"];

/** The file's research note records by xref, reused until the file changes. */
export function researchRecords(records: GedNode[]): Map<string, GedNode> {
  return memoOnContent(records, "researchRecords", () => {
    const out = new Map<string, GedNode>();
    for (const r of records) if (r.tag === RESEARCH_TAG && r.xref) out.set(r.xref, r);
    return out;
  });
}

/** Every note and where it is filed ({@link readResearchNotes}), reused until
 *  the file changes. A walk over every record: for a list of all notes, or
 *  for the places one note is filed under — never per row. */
export function researchIndex(records: GedNode[]): ResearchIndex {
  return memoOnContent(records, "researchIndex", () => readResearchNotes(records));
}

/** A note filed under a record, and the events of the record it is about —
 *  `undefined` in `events` stands for the record as a whole. */
export interface FiledNote {
  note: ResearchNote;
  events: (string | undefined)[];
}

/** The notes filed on `node` itself — a record's own, or one event's. */
export function researchNotesOn(records: GedNode[], node: GedNode): ResearchNote[] {
  let found: Map<string, GedNode> | undefined;
  const out: ResearchNote[] = [];
  for (const child of node.children) {
    if (!isResearchPointer(child)) continue;
    const record = (found ??= researchRecords(records)).get(child.value!.trim());
    if (record) out.push(readResearchNote(record));
  }
  return out;
}

/** The notes filed under `record` and under its events, each once, in the
 *  order their first pointer comes. Reads the record alone: a person with no
 *  note costs one look at their lines. */
export function researchNotesUnder(records: GedNode[], record: GedNode): FiledNote[] {
  const byId = new Map<string, FiledNote>();
  const add = (note: ResearchNote, event: string | undefined) => {
    const filed = byId.get(note.id);
    if (filed) filed.events.push(event);
    else byId.set(note.id, { note, events: [event] });
  };
  for (const note of researchNotesOn(records, record)) add(note, undefined);
  for (const child of record.children) {
    if (!child.children.length || isResearchPointer(child)) continue;
    for (const note of researchNotesOn(records, child)) add(note, child.tag);
  }
  return [...byId.values()];
}

/** File note `noteId` under `node` (a record or one of its events), once. */
export function fileResearchNote(node: GedNode, noteId: string): void {
  if (node.children.some((c) => isResearchPointer(c) && c.value!.trim() === noteId)) return;
  insertGrouped(node, researchPointerNode(noteId, node.level + 1), TRAILING);
}

/** Take note `noteId` off `node`. */
export function unfileResearchNote(node: GedNode, noteId: string): void {
  node.children = node.children.filter((c) => !(isResearchPointer(c) && c.value!.trim() === noteId));
}

/** Add a research note to the file, dated `today`, and return its record. */
export function createResearchNote(records: GedNode[], fields: ResearchFields, today: string = todayGedcom()): GedNode {
  const record = researchNoteNode({ ...fields, id: nextXref(records, RESEARCH_XREF_PREFIX), created: today });
  insertRecord(records, record);
  bumpContentVersion(records);
  return record;
}

/** Rewrite a note record's fields in place, keeping its date and any line
 *  the app does not write. */
export function writeResearchNote(records: GedNode[], record: GedNode, fields: ResearchFields): void {
  // Only the lines this owns: a caller may hand over a whole note, date included.
  const written = researchNoteNode({ ...fields, id: record.xref ?? "" }).children.filter((c) => FIELD_TAGS.has(c.tag));
  const kept = record.children.filter((c) => !FIELD_TAGS.has(c.tag));
  // TYPE and STAT lead, the date and whatever else the record had follows,
  // then the text, links and media — and the change stamp stays last.
  const lead = written.filter((c) => c.tag === "TYPE" || c.tag === "STAT");
  const body = written.filter((c) => c.tag !== "TYPE" && c.tag !== "STAT");
  const trailing = kept.filter((c) => TRAILING.includes(c.tag));
  record.children = [...lead, ...kept.filter((c) => !TRAILING.includes(c.tag)), ...body, ...trailing];
  bumpContentVersion(records);
}

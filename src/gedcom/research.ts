import { childText, childrenByTag } from "./node";
import type { GedNode } from "./types";
import { isPointer } from "./uri";

/**
 * Research notes: the reader's own working material — an idea, a question, a
 * task, a find set aside for later — kept apart from the genealogical data.
 *
 * Neither GEDCOM version has a structure for it, so a note is a record of the
 * app's own extension tag, and the person, family or event it is about points
 * at it with one line:
 *
 *     0 @RN1@ _RESEARCH
 *     1 TYPE QUESTION
 *     1 STAT OPEN
 *     1 DATE 23 NOV 2026
 *     1 NOTE Did he really die in America? Check the passenger lists.
 *     1 WWW https://example.org/list
 *     1 OBJE @M4@
 *
 *     0 @I7@ INDI
 *     1 DEAT
 *     2 _RESEARCH @RN1@      ← about this event
 *     1 _RESEARCH @RN1@      ← or about the person
 *
 * A note nothing points at is one not filed yet. The record is the same in
 * GEDCOM 5.5.1 and 7.0 — its lines are the extension's own, valid under an
 * extension record in both — so the writer takes no target; 7.0's
 * `HEAD.SCHMA` declares the tag on save like any other (`writeSchema`).
 *
 * The notes are written by Save only. Every other output — a branch, the
 * privacy export — and an incoming compare file drop them with
 * {@link dropResearchNotes}.
 */
export const RESEARCH_TAG = "_RESEARCH";

/** The xref prefix of a research note record (`@RN1@`), for `nextXref`. */
export const RESEARCH_XREF_PREFIX = "RN";

/** What a note is, as `TYPE` writes it. */
export const RESEARCH_KINDS = ["IDEA", "QUESTION", "TASK", "FIND"] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

const STAT_OPEN = "OPEN";
const STAT_DONE = "DONE";

export interface ResearchNote {
  /** The record's xref (`@RN1@`). */
  id: string;
  kind: ResearchKind;
  /** Settled (`STAT DONE`); an open note is one still to look into. */
  done: boolean;
  /** When it was written down, as a GEDCOM date (`23 NOV 2026`). */
  created?: string;
  text: string;
  /** Web addresses (`WWW`). */
  links: string[];
  /** Media records it keeps (`OBJE @M1@`). */
  media: string[];
}

/** One place a note is filed under. */
export interface ResearchRef {
  /** The person or family record pointing at the note. */
  recordId: string;
  recordTag: string;
  /** For a note about one event: the event line's position among the record's
   *  children, and its tag. Absent for a note about the record as a whole. */
  eventIndex?: number;
  eventTag?: string;
}

export interface ResearchIndex {
  /** Every note, in file order. */
  notes: ResearchNote[];
  /** Note xref → the places pointing at it. A note not filed has no entry. */
  refs: Map<string, ResearchRef[]>;
}

/** A line that files a research note under its parent (`_RESEARCH @RN1@`). */
export const isResearchPointer = (node: GedNode): boolean =>
  node.tag === RESEARCH_TAG && !!node.value && isPointer(node.value.trim());

/** Read one research note record. A kind the app does not know reads as an idea. */
export function readResearchNote(record: GedNode): ResearchNote {
  const kind = childText(record, "TYPE")?.toUpperCase() as ResearchKind | undefined;
  return {
    id: record.xref ?? "",
    kind: kind && RESEARCH_KINDS.includes(kind) ? kind : "IDEA",
    done: childText(record, "STAT")?.toUpperCase() === STAT_DONE,
    created: childText(record, "DATE"),
    text: childrenByTag(record, "NOTE").map((n) => n.value ?? "").filter((v) => v && !isPointer(v.trim())).join("\n\n"),
    links: childrenByTag(record, "WWW").map((n) => n.value?.trim() ?? "").filter(Boolean),
    media: childrenByTag(record, "OBJE").map((n) => n.value?.trim() ?? "").filter(isPointer),
  };
}

/**
 * Every research note of a file and where each is filed. One pass over the
 * records and the two levels a pointer is written on — a record's own lines
 * and the lines of its events.
 */
export function readResearchNotes(records: readonly GedNode[]): ResearchIndex {
  const notes: ResearchNote[] = [];
  const refs = new Map<string, ResearchRef[]>();
  const add = (pointer: GedNode, ref: ResearchRef) => {
    const id = pointer.value!.trim();
    const list = refs.get(id);
    if (list) list.push(ref);
    else refs.set(id, [ref]);
  };
  for (const rec of records) {
    if (rec.tag === RESEARCH_TAG) {
      if (rec.xref) notes.push(readResearchNote(rec));
      continue;
    }
    if (!rec.xref) continue;
    for (let i = 0; i < rec.children.length; i++) {
      const child = rec.children[i];
      if (isResearchPointer(child)) add(child, { recordId: rec.xref, recordTag: rec.tag });
      else {
        for (const sub of child.children) {
          if (isResearchPointer(sub)) add(sub, { recordId: rec.xref, recordTag: rec.tag, eventIndex: i, eventTag: child.tag });
        }
      }
    }
  }
  return { notes, refs };
}

const line = (level: number, tag: string, value?: string): GedNode => ({ level, tag, value, children: [] });

/** The record a note is written as. */
export function researchNoteNode(note: ResearchNote): GedNode {
  const record: GedNode = { level: 0, xref: note.id, tag: RESEARCH_TAG, children: [] };
  record.children.push(line(1, "TYPE", note.kind), line(1, "STAT", note.done ? STAT_DONE : STAT_OPEN));
  if (note.created) record.children.push(line(1, "DATE", note.created));
  if (note.text.trim()) record.children.push(line(1, "NOTE", note.text.trim()));
  for (const url of note.links) if (url.trim()) record.children.push(line(1, "WWW", url.trim()));
  for (const xref of note.media) record.children.push(line(1, "OBJE", xref));
  return record;
}

/** The line that files a note under a record (`level` 1) or one of its events (2). */
export function researchPointerNode(noteId: string, level: number): GedNode {
  return line(level, RESEARCH_TAG, noteId);
}

/**
 * Take the research notes out of `records`, in place: the note records and
 * every line pointing at one, at any depth. For a file that leaves the
 * reader's hands, and for an incoming file, whose notes are its owner's.
 * Returns the number of note records removed.
 */
export function dropResearchNotes(records: GedNode[]): number {
  let removed = 0;
  const scrub = (node: GedNode): void => {
    let hit = false;
    for (const child of node.children) {
      if (isResearchPointer(child)) hit = true;
      else if (child.children.length) scrub(child);
    }
    if (hit) node.children = node.children.filter((c) => !isResearchPointer(c));
  };
  let at = 0;
  for (const rec of records) {
    if (rec.tag === RESEARCH_TAG) {
      removed++;
      continue;
    }
    scrub(rec);
    records[at++] = rec;
  }
  records.length = at;
  return removed;
}

import {
  bumpContentVersion, createMediaRecord, createResearchNote, fileResearchNote, findSharedMediaByFile, rebuildFamily, rebuildIndividual, recordPosition,
  removeRecordsByXref, researchIndex, researchRecords, unfileResearchNote, writeResearchNote, type ResearchFields,
} from "../../gedcom/edit";
import { cloneNode } from "../../gedcom/node";
import { readResearchNote } from "../../gedcom/research";
import type { Dataset, GedNode } from "../../gedcom/types";
import { coalescePatches, type RecordPatch } from "../historyTypes";

/** One place a note is filed under: a person or family, or one of its events
 *  (by the event line's position among the record's lines). */
export interface ResearchTarget {
  recordId: string;
  eventIndex?: number;
}

/** What the note's dialog opens on: a new note (no `id`) or an existing one. */
export interface ResearchDraft {
  id?: string;
  fields: ResearchFields;
  targets: ResearchTarget[];
}

/** Media files picked for a note that the file has no record for yet, and the
 *  GEDCOM version their records are written in. */
export interface NewResearchMedia {
  files: string[];
  version: "5.5.1" | "7.0";
}

/** The fields a new note starts with. */
export const NEW_RESEARCH_FIELDS: ResearchFields = { kind: "QUESTION", done: false, text: "", links: [], media: [] };

const targetKey = (target: ResearchTarget) => `${target.recordId}#${target.eventIndex ?? ""}`;

/** An existing note as the dialog edits it: its fields and where it is filed. */
export function researchDraftOf(dataset: Dataset, noteId: string): ResearchDraft | undefined {
  const record = researchRecords(dataset.records).get(noteId);
  if (!record) return undefined;
  const { id, ...fields } = readResearchNote(record);
  const targets = (researchIndex(dataset.records).refs.get(noteId) ?? []).map(({ recordId, eventIndex }) => ({ recordId, eventIndex }));
  return { id, fields, targets };
}

/**
 * Apply one research note edit to `dataset` and return it as the patches of a
 * single undo step: the note's record — created (no `noteId`), rewritten, or
 * deleted (`fields` null) — and its pointer on every record it is now filed
 * under or no longer is. The people and families touched are rebuilt; the
 * caller pushes the patches and marks them dirty. `newMedia` are files to
 * attach: each gets a media record of its own unless the file has one.
 */
export function applyResearchEdit(
  dataset: Dataset,
  noteId: string | undefined,
  fields: ResearchFields | null,
  targets: ResearchTarget[],
  newMedia?: NewResearchMedia,
): RecordPatch[] {
  const records = dataset.records;
  const existing = noteId ? researchRecords(records).get(noteId) : undefined;
  if ((noteId && !existing) || (!existing && !fields)) return [];
  const rawOf = (recordId: string): GedNode | undefined =>
    dataset.individuals.get(recordId)?.raw ?? dataset.families.get(recordId)?.raw;
  const filedNow: ResearchTarget[] = noteId ? (researchIndex(records).refs.get(noteId) ?? []) : [];
  const want = new Map((fields ? targets : []).map((target) => [targetKey(target), target]));
  const have = new Map(filedNow.map((target) => [targetKey(target), target]));
  // The lines the pointers sit on, found before any of them moves: an event
  // is named by its position, which a pointer added above it would shift.
  const nodeOf = (target: ResearchTarget): GedNode | undefined => {
    const raw = rawOf(target.recordId);
    return target.eventIndex === undefined ? raw : raw?.children[target.eventIndex];
  };
  const drop = [...have].filter(([key]) => !want.has(key)).map(([, target]) => ({ target, node: nodeOf(target) }));
  const file = [...want].filter(([key]) => !have.has(key)).map(([, target]) => ({ target, node: nodeOf(target) }));

  const patches: RecordPatch[] = [];
  if (fields && newMedia?.files.length) {
    const media = [...fields.media];
    for (const file of newMedia.files) {
      let xref = findSharedMediaByFile(records, file)?.xref;
      if (!xref) {
        const record = createMediaRecord(records, file, newMedia.version);
        xref = record.xref!;
        patches.push({ type: "record", id: xref, before: null, after: cloneNode(record) });
      }
      if (!media.includes(xref)) media.push(xref);
    }
    fields = { ...fields, media };
  }
  let id: string;
  if (existing && !fields) {
    id = existing.xref!;
    const index = recordPosition(records, existing);
    const was = cloneNode(existing);
    removeRecordsByXref(records, [id]);
    bumpContentVersion(records);
    patches.push({ type: "record", id, before: was, after: null, ...(index !== undefined ? { index } : {}) });
  } else if (existing) {
    id = existing.xref!;
    const was = cloneNode(existing);
    writeResearchNote(records, existing, fields!);
    patches.push({ type: "record", id, before: was, after: cloneNode(existing) });
  } else {
    const record = createResearchNote(records, fields!);
    id = record.xref!;
    patches.push({ type: "record", id, before: null, after: cloneNode(record) });
  }

  const before = new Map<string, GedNode>();
  const touch = (recordId: string) => {
    const raw = rawOf(recordId);
    if (raw && !before.has(recordId)) before.set(recordId, cloneNode(raw));
  };
  for (const { target, node } of drop) {
    if (!node) continue;
    touch(target.recordId);
    unfileResearchNote(node, id);
  }
  for (const { target, node } of file) {
    if (!node) continue;
    touch(target.recordId);
    fileResearchNote(node, id);
  }
  for (const [recordId, was] of before) {
    const indi = dataset.individuals.get(recordId);
    const fam = indi ? undefined : dataset.families.get(recordId);
    if (indi) rebuildIndividual(dataset, indi);
    else if (fam) rebuildFamily(dataset, fam);
    else continue;
    patches.push({ type: indi ? "individual" : "family", id: recordId, before: was, after: cloneNode((indi ?? fam)!.raw) });
  }
  return patches;
}

/**
 * Delete several research notes as one undo step: each note's record and its
 * pointer wherever it was filed. A record's index is its position before any
 * of them went — undo puts records back in ascending order of it — and a
 * person filed under two of the notes gets one patch, not two.
 */
export function removeResearchNotes(dataset: Dataset, noteIds: string[]): RecordPatch[] {
  const notes = researchRecords(dataset.records);
  const position = new Map<string, number>();
  for (const id of noteIds) {
    const record = notes.get(id);
    const index = record ? recordPosition(dataset.records, record) : undefined;
    if (index !== undefined) position.set(id, index);
  }
  const patches: RecordPatch[] = [];
  for (const id of noteIds) {
    for (const patch of applyResearchEdit(dataset, id, null, [])) {
      const index = patch.type === "record" ? position.get(patch.id) : undefined;
      patches.push(index !== undefined ? { ...patch, index } : patch);
    }
  }
  return coalescePatches(patches);
}

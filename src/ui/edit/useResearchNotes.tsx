import { useMemo, useState, type ReactNode } from "react";
import {
  bumpContentVersion, createResearchNote, fileResearchNote, rebuildFamily, rebuildIndividual, recordPosition,
  removeRecordsByXref, researchIndex, researchNotesOn, researchNotesUnder, researchRecords, unfileResearchNote,
  writeResearchNote, type FiledNote, type ResearchFields,
} from "../../gedcom/edit";
import { cloneNode } from "../../gedcom/node";
import { readResearchNote } from "../../gedcom/research";
import type { Dataset, GedNode, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import type { RecordPatch } from "../historyTypes";
import type { ResearchApi } from "./ResearchContext";
import { ResearchDialog, type ResearchDraft, type ResearchTarget } from "./ResearchDialog";
import { useStableHandler } from "./useStableHandler";

const NEW_FIELDS: ResearchFields = { kind: "QUESTION", done: false, text: "", links: [], media: [] };

const targetKey = (target: ResearchTarget) => `${target.recordId}#${target.eventIndex ?? ""}`;

/**
 * The research notes of the Edit view: what is filed under the person on
 * screen, the dialog that adds and edits a note, and the edits themselves —
 * each one undo step covering the note's record and every record it is filed
 * under or taken off.
 */
export function useResearchNotes({
  dataset,
  person,
  selectedId,
  gen,
  onPushEdit,
  onDirty,
  refresh,
  navigate,
  t,
}: {
  dataset: Dataset;
  person: Individual | undefined;
  selectedId: string | undefined;
  /** Moves whenever the records changed from outside this hook (undo, a tool). */
  gen: string;
  onPushEdit: (patches: RecordPatch[], navigateTo?: string) => void;
  onDirty: (type: "individual" | "family", id: string) => void;
  /** Re-render the view after an edit. */
  refresh: () => void;
  navigate: (personId: string) => void;
  t: Translate;
}): {
  api: ResearchApi;
  /** The notes filed under the person, their events and their families. */
  filed: FiledNote[];
  /** Start a new note about the person. */
  add: () => void;
  open: (noteId: string) => void;
  toggleDone: (noteId: string) => void;
  dialog: ReactNode;
} {
  const [draft, setDraft] = useState<ResearchDraft | null>(null);
  const [ownGen, setOwnGen] = useState(0);
  const records = dataset.records;

  const rawOf = (recordId: string): GedNode | undefined =>
    dataset.individuals.get(recordId)?.raw ?? dataset.families.get(recordId)?.raw;

  /**
   * Write one note edit as a single undo step: the note's record (created,
   * rewritten, or deleted when `fields` is null) and its pointer on every
   * record it is now filed under or no longer is.
   */
  function apply(noteId: string | undefined, fields: ResearchFields | null, targets: ResearchTarget[]) {
    const existing = noteId ? researchRecords(records).get(noteId) : undefined;
    if (noteId && !existing) return;
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

    const before = new Map<string, GedNode>();
    const touch = (recordId: string) => {
      const raw = rawOf(recordId);
      if (raw && !before.has(recordId)) before.set(recordId, cloneNode(raw));
    };
    const patches: RecordPatch[] = [];
    let id = noteId;
    if (existing && !fields) {
      const index = recordPosition(records, existing);
      const was = cloneNode(existing);
      removeRecordsByXref(records, [existing.xref!]);
      bumpContentVersion(records);
      patches.push({ type: "record", id: existing.xref!, before: was, after: null, ...(index !== undefined ? { index } : {}) });
    } else if (existing && fields) {
      const was = cloneNode(existing);
      writeResearchNote(records, existing, fields);
      patches.push({ type: "record", id: existing.xref!, before: was, after: cloneNode(existing) });
    } else if (fields) {
      const record = createResearchNote(records, fields);
      id = record.xref;
      patches.push({ type: "record", id: id!, before: null, after: cloneNode(record) });
    }
    if (!id) return;
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
      const kind = indi ? "individual" : "family";
      patches.push({ type: kind, id: recordId, before: was, after: cloneNode((indi ?? fam)!.raw) });
      onDirty(kind, recordId);
    }
    onPushEdit(patches, selectedId);
    setOwnGen((n) => n + 1);
    refresh();
  }

  const open = useStableHandler((noteId: string) => {
    const record = researchRecords(records).get(noteId);
    if (!record) return;
    const { id, ...fields } = readResearchNote(record);
    const targets = (researchIndex(records).refs.get(noteId) ?? []).map(({ recordId, eventIndex }) => ({ recordId, eventIndex }));
    setDraft({ id, fields, targets });
  });

  /** The record `node` belongs to — the person on screen or one of their
   *  families — as a place to file a note under. */
  function targetOf(node: GedNode): ResearchTarget | undefined {
    if (!person) return undefined;
    const owners = [person.raw, ...[...person.spouseOf, ...person.childOf].map((id) => dataset.families.get(id)?.raw)];
    for (const raw of owners) {
      if (!raw?.xref) continue;
      if (raw === node) return { recordId: raw.xref };
      const at = raw.children.indexOf(node);
      if (at !== -1) return { recordId: raw.xref, eventIndex: at };
    }
    return undefined;
  }

  const addTo = useStableHandler((node: GedNode) => {
    const target = targetOf(node);
    if (target) setDraft({ fields: NEW_FIELDS, targets: [target] });
  });

  const add = useStableHandler(() => {
    if (person) setDraft({ fields: NEW_FIELDS, targets: [{ recordId: person.id }] });
  });

  const toggleDone = useStableHandler((noteId: string) => {
    const record = researchRecords(records).get(noteId);
    if (!record) return;
    const note = readResearchNote(record);
    apply(noteId, { ...note, done: !note.done }, researchIndex(records).refs.get(noteId) ?? []);
  });

  // One object until the notes change: a fresh one on every render would
  // re-render every event row that reads it.
  const api = useMemo<ResearchApi>(
    () => ({
      openNotesOn: (node) => researchNotesOn(records, node).filter((note) => !note.done),
      open,
      addTo,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, open, addTo, ownGen, gen],
  );

  // Read on every render, from the person's own lines: the records are edited
  // in place, and a person with no note costs one look at them.
  const filed: FiledNote[] = [];
  if (person) {
    const byId = new Map<string, FiledNote>();
    const owners = [person.raw, ...person.spouseOf.map((id) => dataset.families.get(id)?.raw)];
    for (const raw of owners) {
      if (!raw) continue;
      for (const item of researchNotesUnder(records, raw)) {
        const seen = byId.get(item.note.id);
        if (seen) seen.events.push(...item.events);
        else byId.set(item.note.id, item);
      }
    }
    filed.push(...byId.values());
  }

  const dialog = draft && (
    <ResearchDialog
      // A fresh dialog per note: its fields are seeded once, on mount.
      key={draft.id ?? "new"}
      draft={draft}
      dataset={dataset}
      t={t}
      onClose={() => setDraft(null)}
      onSave={(fields, targets) => {
        setDraft(null);
        apply(draft.id, fields, targets);
      }}
      onRemove={draft.id ? () => { setDraft(null); apply(draft.id, null, []); } : undefined}
      onNavigate={(personId) => { setDraft(null); navigate(personId); }}
    />
  );

  return { api, filed, add, open, toggleDone, dialog };
}

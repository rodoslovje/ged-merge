import { useMemo, useState, type ReactNode } from "react";
import { researchNotesOn, researchNotesUnder, type FiledNote, type ResearchFields } from "../../gedcom/edit";
import type { Dataset, GedNode, Individual } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import type { RecordPatch } from "../historyTypes";
import type { ResearchApi } from "./ResearchContext";
import { ResearchDialog } from "./ResearchDialog";
import { applyResearchEdit, NEW_RESEARCH_FIELDS, researchDraftOf, type NewResearchMedia, type ResearchDraft, type ResearchTarget } from "./researchEdit";
import { useStableHandler } from "./useStableHandler";

/**
 * The research notes of the Edit view: what is filed under the person on
 * screen, the dialog that adds and edits a note, and the edits themselves —
 * each one undo step (see {@link applyResearchEdit}).
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
  /** The notes filed under the person and their events. */
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

  function apply(noteId: string | undefined, fields: ResearchFields | null, targets: ResearchTarget[], newMedia?: NewResearchMedia) {
    const patches = applyResearchEdit(dataset, noteId, fields, targets, newMedia);
    if (!patches.length) return;
    // The push first: it snapshots each record from the patch's `before`;
    // marking dirty ahead of it would snapshot the record already changed.
    onPushEdit(patches, selectedId);
    for (const patch of patches) if (patch.type !== "record") onDirty(patch.type, patch.id);
    setOwnGen((n) => n + 1);
    refresh();
  }

  const open = useStableHandler((noteId: string) => {
    const existing = researchDraftOf(dataset, noteId);
    if (existing) setDraft(existing);
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
    if (target) setDraft({ fields: NEW_RESEARCH_FIELDS, targets: [target] });
  });

  const add = useStableHandler(() => {
    if (person) setDraft({ fields: NEW_RESEARCH_FIELDS, targets: [{ recordId: person.id }] });
  });

  const toggleDone = useStableHandler((noteId: string) => {
    const existing = researchDraftOf(dataset, noteId);
    if (existing) apply(noteId, { ...existing.fields, done: !existing.fields.done }, existing.targets);
  });

  // One object until the notes change: a fresh one on every render would
  // re-render every event row that reads it.
  const api = useMemo<ResearchApi>(
    () => ({
      openNotesOn: (node) => researchNotesOn(records, node).filter((note) => !note.done),
      filedUnder: (record) => researchNotesUnder(records, record),
      open,
      toggleDone,
      addTo,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [records, open, toggleDone, addTo, ownGen, gen],
  );

  // Read on every render, from the person's own lines: the records are edited
  // in place, and a person with no note costs one look at them.
  // A family's notes are shown with the family, not here.
  const filed: FiledNote[] = person ? researchNotesUnder(records, person.raw) : [];

  const dialog = draft && (
    <ResearchDialog
      // A fresh dialog per note: its fields are seeded once, on mount.
      key={draft.id ?? "new"}
      draft={draft}
      dataset={dataset}
      t={t}
      onClose={() => setDraft(null)}
      onSave={(fields, targets, newMedia) => {
        setDraft(null);
        apply(draft.id, fields, targets, newMedia);
      }}
      onRemove={draft.id ? () => { setDraft(null); apply(draft.id, null, []); } : undefined}
      onNavigate={(personId) => { setDraft(null); navigate(personId); }}
    />
  );

  return { api, filed, add, open, toggleDone, dialog };
}

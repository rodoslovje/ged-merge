import { useState } from "react";
import type { FiledNote } from "../../gedcom/edit";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import { researchText, type ResearchNote } from "../../gedcom/research";
import type { GedNode } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { tipProps } from "../IconTip";
import { NotebookIcon } from "../icons/NotebookIcon";
import { RESEARCH_ICON, ResearchTitle, researchTitle, useResearch } from "./ResearchContext";

/** What a note's chip says on hover: its whole text, then its links. */
function noteTip(note: ResearchNote): string {
  return [researchText(note), ...note.links].filter(Boolean).join("\n");
}

/**
 * A person's or a family's research notes: everything filed under the record
 * and its events, as chips at the far end of the card's row of "+ Add" chips —
 * the same place whether there are any or not, apart from the person's data.
 * An open note leads with a box that settles it; the settled ones fold away
 * behind a count.
 */
export function ResearchSection({
  filed,
  t,
  onOpen,
  onToggleDone,
  onAdd,
  addTooltip,
}: {
  filed: FiledNote[];
  t: Translate;
  onOpen: (noteId: string) => void;
  onToggleDone: (noteId: string) => void;
  onAdd: () => void;
  /** What the "Task" chip says on hover, where it is not the person's. */
  addTooltip?: string;
}) {
  const [showDone, setShowDone] = useState(false);
  const open = filed.filter((f) => !f.note.done);
  const done = filed.filter((f) => f.note.done);
  const chip = ({ note, events }: FiledNote) => {
    // The events it is about, each named once; a note about the person as a
    // whole names none.
    const where = [...new Set(events.filter((tag): tag is string => !!tag))].map((tag) => eventDisplayLabel(tag, t));
    return (
      <span key={note.id} className={`research-chip${note.done ? " is-done" : ""}`}>
        <input
          type="checkbox"
          className="research-chip-check"
          checked={note.done}
          title={t(note.done ? "research.reopen" : "research.markDone")}
          aria-label={t(note.done ? "research.reopen" : "research.markDone")}
          onChange={() => onToggleDone(note.id)}
        />
        <button
          type="button"
          className="research-chip-open"
          {...tipProps(noteTip(note), { edit: true, kind: t(`research.kind.${note.kind}`) })}
          onClick={() => onOpen(note.id)}
        >
          <span aria-hidden="true">{RESEARCH_ICON[note.kind]}</span>
          <span className="research-chip-text"><ResearchTitle note={note} /></span>
          {where.length > 0 && <span className="research-chip-where">{where.join(", ")}</span>}
        </button>
      </span>
    );
  };
  return (
    <span className="research-section" role="group" aria-label={t("research.section")}>
        {open.map(chip)}
        {done.length > 0 && (
          <button
            type="button"
            className="edit-name-chip research-done-toggle"
            aria-expanded={showDone}
            onClick={() => setShowDone((v) => !v)}
          >
            {showDone ? "▾" : "▸"} {t("research.doneCount", { n: done.length })}
          </button>
        )}
        {showDone && done.map(chip)}
        <button type="button" className="edit-name-chip edit-name-chip-add edit-name-chip-task" title={addTooltip ?? t("research.addTooltip")} onClick={onAdd}>
          <NotebookIcon size={13} /> {t("research.add")}
        </button>
    </span>
  );
}

/** The open research notes of one event, as marks beside its sources. */
export function ResearchRefs({ node, t }: { node: GedNode | undefined; t: Translate }) {
  const api = useResearch();
  const notes = api && node ? api.openNotesOn(node) : [];
  if (!api || notes.length === 0) return null;
  return (
    <span className="research-refs">
      {notes.map((note) => (
        <button
          key={note.id}
          type="button"
          className="link-icon edit-link-icon research-ref"
          {...tipProps(noteTip(note), { edit: true, heading: researchTitle(note), kind: t(`research.kind.${note.kind}`) })}
          onClick={() => api.open(note.id)}
        >
          {RESEARCH_ICON[note.kind]}
        </button>
      ))}
    </span>
  );
}

/**
 * A family's own tasks, at the far end of the row of "+ Add" chips beside the
 * partner — the notes filed under the family and its events, as the person's
 * card shows the person's.
 */
export function FamilyResearch({ node, t }: { node: GedNode; t: Translate }) {
  const api = useResearch();
  if (!api) return null;
  return (
    <ResearchSection
      filed={api.filedUnder(node)}
      t={t}
      onOpen={api.open}
      onToggleDone={api.toggleDone}
      onAdd={() => api.addTo(node)}
      addTooltip={t("research.addFamilyTooltip")}
    />
  );
}

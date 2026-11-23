import { useState } from "react";
import type { FiledNote } from "../../gedcom/edit";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import type { ResearchNote } from "../../gedcom/research";
import type { GedNode } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { tipProps } from "../IconTip";
import { RESEARCH_ICON, researchTitle, useResearch } from "./ResearchContext";

/** What a note's chip says on hover: its whole text, then its links. */
function noteTip(note: ResearchNote): string {
  return [note.text, ...note.links].filter(Boolean).join("\n");
}

/**
 * The person's research notes: everything filed under them, their events and
 * their families, as one row of chips. An open note leads with a box that
 * settles it; the settled ones fold away behind a count.
 */
export function ResearchSection({
  filed,
  t,
  onOpen,
  onToggleDone,
  onAdd,
}: {
  filed: FiledNote[];
  t: Translate;
  onOpen: (noteId: string) => void;
  onToggleDone: (noteId: string) => void;
  onAdd: () => void;
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
          <span className="research-chip-text">{researchTitle(note)}</span>
          {where.length > 0 && <span className="research-chip-where">{where.join(", ")}</span>}
        </button>
      </span>
    );
  };
  return (
    <div className="edit-record-section research-section">
      <div className="edit-record-label-row">
        <span className="edit-record-label">{t("research.section")}</span>
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
        <button type="button" className="edit-name-chip edit-name-chip-add" title={t("research.addTooltip")} onClick={onAdd}>
          + {t("research.add")}
        </button>
      </div>
    </div>
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

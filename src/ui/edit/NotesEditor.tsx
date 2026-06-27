import { useEffect, useRef, useState } from "react";
import type { Translate } from "../../locales/i18n";
import { ClearableTextarea } from "./ClearableInput";

/** Multi-line notes attached to a person or family record. */
export function NotesEditor({
  notes: initialNotes,
  addOnMount,
  addTrigger,
  sectionLabel,
  t,
  onCommit,
}: {
  notes: string[];
  addOnMount?: boolean;
  addTrigger?: number;
  sectionLabel?: string;
  t: Translate;
  onCommit: (notes: string[]) => void;
}) {
  const [notes, setNotes] = useState(() => addOnMount ? [...initialNotes, ""] : initialNotes);
  const prevTrigger = useRef(addTrigger ?? 0);
  const focusNewRef = useRef<number | null>(addOnMount ? initialNotes.length : null);
  const textareaRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  useEffect(() => {
    if ((addTrigger ?? 0) > prevTrigger.current) {
      setNotes((prev) => { focusNewRef.current = prev.length; return [...prev, ""]; });
    }
    prevTrigger.current = addTrigger ?? 0;
  }, [addTrigger]);

  useEffect(() => {
    if (focusNewRef.current !== null) {
      textareaRefs.current[focusNewRef.current]?.focus();
      focusNewRef.current = null;
    }
  });

  function commitNotes(next: string[]) {
    setNotes(next);
    onCommit(next.map((n) => n.trim()).filter(Boolean));
  }

  return (
    <div className="edit-notes">
      {sectionLabel && (
        <div className="edit-record-label-row">
          <span className="edit-record-label">{sectionLabel}</span>
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addNoteTooltip")}
            onClick={() => setNotes((prev) => { focusNewRef.current = prev.length; return [...prev, ""]; })}
          >
            + {t("edit.addNote")}
          </button>
        </div>
      )}
      {notes.map((note, i) => (
        <ClearableTextarea
          key={i}
          ref={(el) => { textareaRefs.current[i] = el; }}
          className="edit-input edit-event-note"
          value={note}
          placeholder={t("field.notes")}
          title={t("field.notes")}
          rows={1}
          onChange={(e) => setNotes((prev) => prev.map((n, idx) => (idx === i ? e.target.value : n)))}
          onBlur={() => commitNotes(notes)}
          onClear={() => commitNotes(notes.filter((_, idx) => idx !== i))}
        />
      ))}
    </div>
  );
}

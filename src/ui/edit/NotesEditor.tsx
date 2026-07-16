import { useEffect, useRef, useState } from "react";
import type { NoteRef } from "../../gedcom/types";
import { stripNoteLinks } from "../../gedcom/builder";
import type { Translate } from "../../locales/i18n";
import { ClearableTextarea } from "./ClearableInput";

/** Multi-line notes attached to a person or family record.
 *
 * Works on `NoteRef`s (verbatim text + shared-record identity) so a pointer
 * to a shared NOTE record keeps its identity through an edit round-trip. Two
 * kinds of refs are carried through commits but not shown as chips: pointer
 * notes with no resolvable text (the record may still hold sub-structure)
 * and notes whose text is only URLs (those surface as link chips instead) —
 * previously an edit silently deleted them. */
export function NotesEditor({
  notes: initialNotes,
  addOnMount,
  addTrigger,
  sectionLabel,
  baselineNotes,
  t,
  onCommit,
}: {
  notes: NoteRef[];
  addOnMount?: boolean;
  addTrigger?: number;
  sectionLabel?: string;
  /** The note texts as they were at the last clean/saved state; any note not in
   * here is new or changed and renders bold, like other new/changed data. */
  baselineNotes?: string[];
  t: Translate;
  onCommit: (notes: NoteRef[]) => void;
}) {
  const baseline = new Set(baselineNotes ?? initialNotes.map((n) => n.text));
  const [notes, setNotes] = useState<NoteRef[]>(() => (addOnMount ? [...initialNotes, { text: "" }] : initialNotes));
  const prevTrigger = useRef(addTrigger ?? 0);
  const focusNewRef = useRef<number | null>(addOnMount ? initialNotes.length : null);
  const textareaRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  useEffect(() => {
    if ((addTrigger ?? 0) > prevTrigger.current) {
      setNotes((prev) => { focusNewRef.current = prev.length; return [...prev, { text: "" }]; });
    }
    prevTrigger.current = addTrigger ?? 0;
  }, [addTrigger]);

  useEffect(() => {
    if (focusNewRef.current !== null) {
      textareaRefs.current[focusNewRef.current]?.focus();
      focusNewRef.current = null;
    }
  });

  /** Carried but not chip-rendered: an empty pointer note, or a note whose
   *  text is only URLs (a blank inline entry is a chip being typed into). */
  const isHidden = (n: NoteRef) => (n.text.trim() ? !stripNoteLinks(n.text) : !!n.xref);

  function commitNotes(next: NoteRef[]) {
    setNotes(next);
    // An inline note trims like before; a pointer note's text stays verbatim
    // (trimming an untouched one would needlessly rewrite the shared record).
    onCommit(next.filter((n) => n.xref || n.text.trim()).map((n) => (n.xref ? n : { text: n.text.trim() })));
  }

  // Size each note to its widest line (not its total length — a multi-line note
  // is only as wide as its longest line) so short notes sit next to each other
  // and flow to the next line only when they don't fit.
  const noteWidth = (v: string) => {
    const longest = v.split("\n").reduce((m, line) => Math.max(m, line.length), 0);
    return { width: `${Math.min(48, Math.max(6, longest + 2))}ch` };
  };

  const noteFields = notes.map((note, i) =>
    isHidden(note) ? null : (
      <ClearableTextarea
        key={i}
        ref={(el) => { textareaRefs.current[i] = el; }}
        wrapClassName="edit-note-chip"
        wrapStyle={noteWidth(note.text)}
        className={`edit-input edit-event-note${note.text.trim() && !baseline.has(note.text) ? " edit-input--dirty" : ""}`}
        value={note.text}
        placeholder={t("field.notes")}
        title={t("field.notes")}
        rows={1}
        onChange={(e) => setNotes((prev) => prev.map((n, idx) => (idx === i ? { ...n, text: e.target.value } : n)))}
        onBlur={() => commitNotes(notes)}
        onClear={() => commitNotes(notes.filter((_, idx) => idx !== i))}
      />
    ),
  );

  return (
    <div className="edit-notes">
      {sectionLabel ? (
        <div className="edit-record-label-row">
          <span className="edit-record-label">{sectionLabel}</span>
          {noteFields}
          <button
            type="button"
            className="edit-name-chip edit-name-chip-add"
            title={t("edit.addNoteTooltip")}
            onClick={() => setNotes((prev) => { focusNewRef.current = prev.length; return [...prev, { text: "" }]; })}
          >
            + {t("edit.addNote")}
          </button>
        </div>
      ) : (
        noteFields
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import type { NoteRef } from "../../gedcom/types";
import type { Translate } from "../../locales/i18n";
import { noteToText } from "../../gedcom/noteHtml";
import { RichNoteInput } from "./RichNoteInput";
import { linkHref } from "../FieldValue";

/** First URL in a note's text, for the chip's open-link button. */
function firstUrlIn(text: string): string | undefined {
  const m = /https?:\/\/[^\s<>"]+/i.exec(noteToText(text));
  return m ? m[0].replace(/[.,;)\]]+$/, "") : undefined;
}

/** Multi-line notes attached to a person or family record.
 *
 * Works on `NoteRef`s (verbatim text + shared-record identity) so a pointer
 * to a shared NOTE record keeps its identity through an edit round-trip.
 * Every note with text is a chip — including URL-only ones, which the old
 * string-based editor hid (and then silently deleted on the next edit). Only
 * a pointer with no resolvable text stays chipless: it's carried through
 * commits untouched (the record may still hold sub-structure). */
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
  const boxRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if ((addTrigger ?? 0) > prevTrigger.current) {
      setNotes((prev) => { focusNewRef.current = prev.length; return [...prev, { text: "" }]; });
    }
    prevTrigger.current = addTrigger ?? 0;
  }, [addTrigger]);

  useEffect(() => {
    if (focusNewRef.current !== null) {
      boxRefs.current[focusNewRef.current]?.focus();
      focusNewRef.current = null;
    }
  });

  /** Carried but not chip-rendered: a pointer note with no resolvable text
   *  (a blank inline entry is a chip being typed into). */
  const isHidden = (n: NoteRef) => !n.text.trim() && !!n.xref;

  function commitNotes(next: NoteRef[]) {
    setNotes(next);
    // An inline note trims like before; a pointer note's text stays verbatim
    // (trimming an untouched one would needlessly rewrite the shared record).
    // The rest of the ref is carried through: rebuilding an inline note as
    // `{ text }` dropped its private flag on every commit, so the 🔒 lived only
    // in this component's own state and was gone the next time the record was
    // read back. A pointer note kept its flag (it travels in the shared record),
    // which is why only inline notes lost it.
    onCommit(
      next
        .filter((n) => n.xref || n.text.trim())
        .map((n) => (n.xref ? n : { ...n, text: n.text.trim() })),
    );
  }

  // Size each note to its widest line (not its total length — a multi-line note
  // is only as wide as its longest line) so short notes sit next to each other
  // and flow to the next line only when they don't fit. The floor is generous:
  // a freshly added note should offer a sentence's worth of typing room. The
  // chip's chrome — the lock's 22px on the left, the × button's 18px on the
  // right, the border — is added in px on top of the text's own width, so a
  // line that fits the count does not wrap on the padding (`ch` is measured in
  // the chip's mono font, see `.edit-note-chip`). The line is measured on the
  // note's plain text (an HTML note's tags take no room on screen); a note
  // with a table or a long paragraph takes the row.
  const noteWidth = (v: string) => {
    const longest = noteToText(v).split("\n").reduce((m, line) => Math.max(m, line.length), 0);
    if (/<table\b/i.test(v) || longest > 48) return { width: "100%" };
    return { width: `calc(${Math.max(18, longest)}ch + 42px)` };
  };

  const noteFields = notes.map((note, i) => {
    if (isHidden(note)) return null;
    const url = firstUrlIn(note.text);
    return (
      <span key={i} className="edit-note-item">
        <RichNoteInput
          ref={(el) => { boxRefs.current[i] = el; }}
          wrapClassName="edit-note-chip"
          wrapStyle={noteWidth(note.text)}
          leading={
            <button
              type="button"
              className={`note-chip-lock${note.private ? " is-on" : ""}`}
              title={t(note.private ? "edit.notePrivateOn" : "edit.notePrivateOff")}
              aria-pressed={!!note.private}
              tabIndex={-1}
              onMouseDown={(e) => {
                e.preventDefault(); // keep the box's focus/blur cycle intact
                commitNotes(notes.map((n, idx) => (idx === i ? { ...n, private: !n.private } : n)));
              }}
            >
              🔒
            </button>
          }
          className={`edit-input edit-event-note${note.text.trim() && !baseline.has(note.text) ? " edit-input--dirty" : ""}`}
          // Shown formatted; the stored text stays verbatim until the user
          // really edits, so an untouched blur can't rewrite the record.
          text={note.text}
          placeholder={t("field.notes")}
          title={t("field.notes")}
          t={t}
          onInput={(text) => setNotes((prev) => prev.map((n, idx) => (idx === i ? { ...n, text } : n)))}
          onBlur={() => commitNotes(notes)}
          onClear={() => commitNotes(notes.filter((_, idx) => idx !== i))}
        />
        {url && (
          <a className="source-ref-open" href={linkHref(url)} target="_blank" rel="noreferrer noopener" title={url}>
            ↗
          </a>
        )}
      </span>
    );
  });

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

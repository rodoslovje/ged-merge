import { createElement, Fragment, type ReactNode } from "react";
import { isHtmlNote, parseNoteHtml, type NoteInline } from "../gedcom/noteHtml";

/**
 * One line of a formatted note as elements: bold, italic and underline kept.
 * A link is an anchor only where the caller says so — a note's first line on a
 * chip that is itself a button shows the link's words alone.
 */
export function noteInlineNodes(kids: NoteInline[], links = true): ReactNode[] {
  return kids.map((kid, i) =>
    kid.t === "text" ? kid.text
      : kid.t === "br" ? <br key={i} />
      : kid.t === "a"
        ? links
          ? <a key={i} href={kid.href} target="_blank" rel="noreferrer noopener">{noteInlineNodes(kid.kids, links)}</a>
          : <Fragment key={i}>{noteInlineNodes(kid.kids, links)}</Fragment>
        : createElement(kid.t, { key: i }, noteInlineNodes(kid.kids, links)));
}

/**
 * A note where it is read rather than edited — the report, the family website:
 * the formatting it was given (bold, italic, underline, lists, links) when the
 * file keeps it as HTML, its plain text otherwise.
 *
 * `text` is the note as the surrounding view already shows it (tidied, perhaps
 * with its links taken out); `rich` is the note's own HTML when it has any.
 * Everything is a `span`, so the note sits in whatever holds it — a paragraph,
 * a line of an event — without breaking that element's own nesting rules.
 */
export function NoteText({ text, rich }: { text: string; rich?: string | null }) {
  if (!rich || !isHtmlNote(rich)) return <>{text}</>;
  const blocks = parseNoteHtml(rich).blocks;
  if (!blocks.length) return <>{text}</>;
  return (
    <span className="note-text">
      {blocks.map((block, i) => {
        if (block.t === "p" || block.t === "h") {
          const kids = noteInlineNodes(block.kids);
          return <span key={i} className="note-block">{block.t === "h" ? <b>{kids}</b> : kids}</span>;
        }
        if (block.t === "list") {
          return (
            <span key={i} className={`note-list${block.ordered ? " note-list--ordered" : ""}`}>
              {block.items.map((item, j) => <span key={j} className="note-item">{noteInlineNodes(item)}</span>)}
            </span>
          );
        }
        // A pasted table: a line per row, its cells side by side.
        return block.rows.map((row, j) => (
          <span key={`${i}-${j}`} className="note-block note-block--row">
            {row.map((cell, k) => (
              <Fragment key={k}>{k > 0 && " · "}{cell.header ? <b>{noteInlineNodes(cell.kids)}</b> : noteInlineNodes(cell.kids)}</Fragment>
            ))}
          </span>
        ));
      })}
    </span>
  );
}

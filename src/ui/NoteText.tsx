import { createElement, Fragment, type ReactNode } from "react";
import { isHtmlNote, parseNoteHtml, type NoteInline } from "../gedcom/noteHtml";
import { splitUrls } from "../gedcom/uri";

/** Text with each web address written in it as a link that opens in a new tab. */
function linkedText(text: string, key: number | string = "t"): ReactNode {
  const parts = splitUrls(text);
  if (parts.every((p) => typeof p === "string")) return text;
  return (
    <Fragment key={key}>
      {parts.map((p, i) => typeof p === "string" ? p : <a key={i} href={p.url} target="_blank" rel="noreferrer noopener">{p.url}</a>)}
    </Fragment>
  );
}

/**
 * One line of a formatted note as elements: bold, italic and underline kept.
 * A link is an anchor only where the caller says so — a note's first line on a
 * chip that is itself a button shows the link's words alone. With `autolink`,
 * an address merely typed in the text becomes a link too.
 */
export function noteInlineNodes(kids: NoteInline[], links = true, autolink = false): ReactNode[] {
  return kids.map((kid, i) =>
    kid.t === "text" ? (autolink ? linkedText(kid.text, i) : kid.text)
      : kid.t === "br" ? <br key={i} />
      : kid.t === "a"
        ? links
          ? <a key={i} href={kid.href} target="_blank" rel="noreferrer noopener">{noteInlineNodes(kid.kids, links)}</a>
          : <Fragment key={i}>{noteInlineNodes(kid.kids, links)}</Fragment>
        : createElement(kid.t, { key: i }, noteInlineNodes(kid.kids, links, autolink)));
}

/**
 * A note where it is read rather than edited — the report, the family website:
 * the formatting it was given (bold, italic, underline, lists, links) when the
 * file keeps it as HTML, its plain text otherwise. Either way a web address
 * written in the text is a link.
 *
 * `text` is the note as the surrounding view already shows it (tidied, perhaps
 * with its links taken out); `rich` is the note's own HTML when it has any.
 * Everything is a `span`, so the note sits in whatever holds it — a paragraph,
 * a line of an event — without breaking that element's own nesting rules.
 */
export function NoteText({ text, rich }: { text: string; rich?: string | null }) {
  const plain = () => {
    const linked = linkedText(text);
    return linked === text ? <>{text}</> : <span className="note-text">{linked}</span>;
  };
  if (!rich || !isHtmlNote(rich)) return plain();
  const blocks = parseNoteHtml(rich).blocks;
  if (!blocks.length) return plain();
  return (
    <span className="note-text">
      {blocks.map((block, i) => {
        if (block.t === "p" || block.t === "h") {
          const kids = noteInlineNodes(block.kids, true, true);
          return <span key={i} className="note-block">{block.t === "h" ? <b>{kids}</b> : kids}</span>;
        }
        if (block.t === "list") {
          return (
            <span key={i} className={`note-list${block.ordered ? " note-list--ordered" : ""}`}>
              {block.items.map((item, j) => <span key={j} className="note-item">{noteInlineNodes(item, true, true)}</span>)}
            </span>
          );
        }
        // A pasted table: a line per row, its cells side by side.
        return block.rows.map((row, j) => (
          <span key={`${i}-${j}`} className="note-block note-block--row">
            {row.map((cell, k) => (
              <Fragment key={k}>{k > 0 && " · "}{cell.header ? <b>{noteInlineNodes(cell.kids, true, true)}</b> : noteInlineNodes(cell.kids, true, true)}</Fragment>
            ))}
          </span>
        ));
      })}
    </span>
  );
}

import { createContext, createElement, Fragment, useContext, type ReactNode } from "react";
import { inlinesToText, isHtmlNote, parseNoteHtml, type NoteInline } from "../../gedcom/noteHtml";
import type { GedNode } from "../../gedcom/types";
import { researchText, type ResearchKind, type ResearchNote } from "../../gedcom/research";

// A research note about an event is shown and added on the event's own row.
// What the row needs — the notes filed on its node, a way to open one and to
// add one — belongs to the Edit view, and this carries it there without
// drilling props through the event-list components, as AssocContext does.

export interface ResearchApi {
  /** The notes filed on `node` (an event) that are still open. */
  openNotesOn: (node: GedNode) => ResearchNote[];
  /** Open a note for editing. */
  open: (noteId: string) => void;
  /** Start a new note about `node`. */
  addTo: (node: GedNode) => void;
}

const ResearchContext = createContext<ResearchApi | null>(null);

export const ResearchProvider = ResearchContext.Provider;

/** null outside the Edit view: the merge's read-only rows show no research notes. */
export function useResearch(): ResearchApi | null {
  return useContext(ResearchContext);
}

/** The mark each kind of note is drawn with. */
export const RESEARCH_ICON: Record<ResearchKind, string> = {
  IDEA: "💡",
  QUESTION: "❓",
  TASK: "📋",
  FIND: "📎",
};

/** A note's first line, for a chip or a list row. */
export function researchTitle(note: ResearchNote): string {
  return researchText(note).split("\n").find((line) => line.trim())?.trim() ?? note.links[0] ?? "";
}

/** One line of a formatted text as elements: bold, italic and underline kept,
 *  a link as its words (the chip it sits in is itself a button). */
function inlineNodes(kids: NoteInline[]): ReactNode[] {
  return kids.map((kid, i) =>
    kid.t === "text" ? kid.text
      : kid.t === "br" ? " "
      : kid.t === "a" ? <Fragment key={i}>{inlineNodes(kid.kids)}</Fragment>
      : createElement(kid.t, { key: i }, inlineNodes(kid.kids)));
}

/** {@link researchTitle} with the formatting its first line was given. */
export function ResearchTitle({ note }: { note: ResearchNote }) {
  if (isHtmlNote(note.text)) {
    for (const block of parseNoteHtml(note.text).blocks) {
      const kids = block.t === "p" || block.t === "h" ? block.kids : block.t === "list" ? block.items[0] ?? [] : [];
      // The first line only: up to the block's first line break.
      const cut = kids.findIndex((kid) => kid.t === "br");
      const line = cut < 0 ? kids : kids.slice(0, cut);
      if (inlinesToText(line).trim()) return <>{inlineNodes(line)}</>;
    }
  }
  return <>{researchTitle(note)}</>;
}

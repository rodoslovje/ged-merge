import { useSyncExternalStore } from "react";
import { noteToText } from "../gedcom/noteHtml";

// Whether long notes show folded to their first line. One choice for every
// note on screen, kept in localStorage like the other per-browser display
// habits: it is about how this screen is read, not about the file.

const KEY = "notesCollapsed";

/** `gen` moves on every "fold all / unfold all", so each editor knows to drop
 *  the notes it had folded or unfolded one by one. */
let state = { collapsed: readStored(), gen: 0 };
const listeners = new Set<() => void>();

function readStored(): boolean {
  try {
    return localStorage.getItem(KEY) === "true";
  } catch {
    return false;
  }
}

/** Fold or unfold every long note, in every editor on screen. */
export function setNotesCollapsed(collapsed: boolean): void {
  state = { collapsed, gen: state.gen + 1 };
  try {
    localStorage.setItem(KEY, String(collapsed));
  } catch {
    // Storage blocked: the choice still holds until the page is reloaded.
  }
  listeners.forEach((l) => l());
}

export function useNotesCollapsed(): { collapsed: boolean; gen: number } {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => state,
  );
}

/** A note long enough to be worth folding: more than three lines, or a
 *  paragraph that wraps into as many. */
export function isCollapsibleNote(text: string): boolean {
  const plain = noteToText(text).trim();
  return plain.split("\n").length > 3 || plain.length > 400;
}

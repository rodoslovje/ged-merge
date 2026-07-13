import { useCallback, useRef, useState } from "react";
import type { RecordPatch } from "../ui/historyTypes";
import type { CandidateDecision } from "../review/types";

export type UndoEntry =
  | {
      mode: "edit";
      patches: RecordPatch[];
      navigateTo?: string;
      redoNavigateTo?: string;
    }
  | {
      mode: "merge";
      before: Map<string, CandidateDecision>;
      after: Map<string, CandidateDecision>;
      mainId: string;
      compareId: string;
    }
  | {
      // A compare-tree "bring in this branch" toggle. Holds the before/after of
      // the import-branch key set, like `merge` holds the decisions map.
      mode: "import";
      before: Set<string>;
      after: Set<string>;
    }
  | {
      // A Tools-tab "not a duplicate" toggle. Holds the before/after of the
      // rejected within-file duplicate-pair key set. References the main file
      // only, so it survives a compare reload like `edit` entries do.
      mode: "rejectDup";
      before: Set<string>;
      after: Set<string>;
    };

const MAX_STACK = 100;


export function useUndoRedo() {
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Stable ref so useCallback closures with [] deps can call push without
  // re-registering. App.tsx replaces pushRef.current each render.
  const pushRef = useRef((_entry: UndoEntry) => {});

  const push = useCallback((entry: UndoEntry) => {
    if (undoStack.current.length >= MAX_STACK) undoStack.current.shift();
    undoStack.current.push(entry);
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }, []);

  pushRef.current = push;

  const undo = useCallback((): UndoEntry | undefined => {
    const entry = undoStack.current.pop();
    if (!entry) return undefined;
    redoStack.current.push(entry);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
    return entry;
  }, []);

  const redo = useCallback((): UndoEntry | undefined => {
    const entry = redoStack.current.pop();
    if (!entry) return undefined;
    undoStack.current.push(entry);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
    return entry;
  }, []);

  const clearAll = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    setCanUndo(false);
    setCanRedo(false);
  }, []);

  /** Restore both stacks from a previous session (IndexedDB hydrate). */
  const hydrate = useCallback((undo: UndoEntry[], redo: UndoEntry[]) => {
    undoStack.current = undo;
    redoStack.current = redo;
    setCanUndo(undo.length > 0);
    setCanRedo(redo.length > 0);
  }, []);

  /** Snapshot both stacks for persistence. `rejectDup` entries are excluded:
   *  an app version that predates them would hit its unknown-mode fallback on
   *  hydrate and corrupt the decisions map, and losing just their undo history
   *  on reload is harmless (the rejected pairs themselves persist separately). */
  const serialize = useCallback(() => ({
    undo: undoStack.current.filter((e) => e.mode !== "rejectDup"),
    redo: redoStack.current.filter((e) => e.mode !== "rejectDup"),
  }), []);

  /** Drop entries that reference the incoming file (merge decisions, import
   *  branches) — called when the compare is replaced or unloaded. Edit and
   *  duplicate-rejection entries only touch main data and stay valid. */
  const dropMergeEntries = useCallback(() => {
    const keep = (e: UndoEntry) => e.mode === "edit" || e.mode === "rejectDup";
    undoStack.current = undoStack.current.filter(keep);
    redoStack.current = redoStack.current.filter(keep);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(redoStack.current.length > 0);
  }, []);

  return { canUndo, canRedo, push, pushRef, undo, redo, clearAll, dropMergeEntries, hydrate, serialize };
}

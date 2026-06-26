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
      masterId: string;
      compareId: string;
    }
  | {
      // A compare-tree "bring in this branch" toggle. Holds the before/after of
      // the import-branch key set, like `merge` holds the decisions map.
      mode: "import";
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

  const dropMergeEntries = useCallback(() => {
    undoStack.current = undoStack.current.filter((e) => e.mode === "edit");
    redoStack.current = redoStack.current.filter((e) => e.mode === "edit");
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(redoStack.current.length > 0);
  }, []);

  return { canUndo, canRedo, push, pushRef, undo, redo, clearAll, dropMergeEntries };
}

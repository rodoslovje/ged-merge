import type { Dataset } from "../gedcom/types";
import type { NameLayout, NormalizationReport, PlaceLayout, SourceLayout } from "../normalize/types";
import type { MatchResult } from "../match/types";
import type { CandidateDecision } from "../review/types";
import type { DatasetRole } from "../worker/messages";

/**
 * The shared "workspace" state — the loaded files, the match result, and the
 * merge decisions — as a single reducer-managed store. This is the state the
 * worker, the save flow, persistence, and all three mode views entangle over
 * when it lives as scattered `useState`s in App; centralising it here gives the
 * parse → match → decide pipeline one home with explicit, testable transitions.
 *
 * Purely-UI-local state (filter/sort, modals, selection, navigation) stays in
 * the components — this store is only the data pipeline.
 */

/** A parsed file plus the load-time normalization metadata shown in the summary. */
export interface LoadedFile {
  fileName: string;
  dataset: Dataset;
  report?: NormalizationReport;
  placeLayout?: PlaceLayout;
  dateFormat?: string;
  datePlaceholder?: string;
  sourceLayout?: SourceLayout;
  nameLayout?: NameLayout;
  unknownNameStyle?: string;
  marriedNameTag?: boolean;
}

/** One file slot's lifecycle: empty → loading → loaded | error. */
export type SlotState =
  | { status: "empty" }
  | { status: "loading"; fileName: string }
  | { status: "loaded"; file: LoadedFile }
  | { status: "error"; fileName: string; message: string };

export interface WorkspaceState {
  main: SlotState;
  compare: SlotState;
  /** The last successfully-loaded main, kept while a reload is in progress so
   *  the views don't flash back to the landing page. */
  lastMainFile: LoadedFile | null;
  /** Bumped every time a main file finishes loading (first load, reload, or
   *  replacement). Views with per-person local state (Edit, Tools) key on this
   *  so a different dataset remounts them: xref collisions between files (both
   *  roots being @I1@, say) would otherwise let React reuse input components
   *  whose local state still holds the previous file's values. The in-place
   *  dataset rebuild after save dispatches no slotLoaded, so saving keeps the
   *  current view state. */
  mainLoadGen: number;
  matches: MatchResult | null;
  /** True while the worker is (re)computing matches. */
  matching: boolean;
  /** Home/start person for kinship ranking, or undefined for none. */
  startId: string | undefined;
  /** Confirmed per-pair merge decisions, keyed by `decisionKey(...)`. */
  decisions: Map<string, CandidateDecision>;
  /** Import-branch requests, keyed by `importKey(...)`. */
  importBranches: Set<string>;
  /** Within-file duplicate pairs the user has dismissed as not-a-duplicate,
   *  keyed by `duplicatePairKey(...)`, so re-running the Tools duplicate scan
   *  doesn't resurface them. */
  rejectedDuplicates: Set<string>;
}

export const initialWorkspace: WorkspaceState = {
  main: { status: "empty" },
  compare: { status: "empty" },
  lastMainFile: null,
  mainLoadGen: 0,
  matches: null,
  matching: false,
  startId: undefined,
  decisions: new Map(),
  importBranches: new Set(),
  rejectedDuplicates: new Set(),
};

export type WorkspaceAction =
  | { type: "slotLoading"; role: DatasetRole; fileName: string }
  | { type: "slotLoaded"; role: DatasetRole; file: LoadedFile }
  | { type: "slotError"; role: DatasetRole; fileName: string; message: string }
  | { type: "slotCleared"; role: DatasetRole }
  | { type: "matchingStarted" }
  | { type: "matched"; result: MatchResult }
  | { type: "matchesCleared" }
  | { type: "setStart"; id: string | undefined }
  | { type: "decisionsSet"; decisions: Map<string, CandidateDecision> }
  | { type: "decisionsCleared" }
  | { type: "confirmedDecisionsCleared" }
  | { type: "importBranchesSet"; branches: Set<string> }
  | { type: "importBranchesCleared" }
  | { type: "rejectedDuplicatesSet"; pairs: Set<string> }
  | { type: "rejectedDuplicatesCleared" }
  | { type: "reset" };

function slotKey(role: DatasetRole): "main" | "compare" {
  return role;
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "slotLoading":
      return { ...state, [slotKey(action.role)]: { status: "loading", fileName: action.fileName } };

    case "slotLoaded": {
      const next: WorkspaceState = { ...state, [slotKey(action.role)]: { status: "loaded", file: action.file } };
      // A freshly-loaded main becomes the preserved baseline.
      if (action.role === "main") {
        next.lastMainFile = action.file;
        next.mainLoadGen = state.mainLoadGen + 1;
      }
      return next;
    }

    case "slotError":
      return {
        ...state,
        [slotKey(action.role)]: { status: "error", fileName: action.fileName, message: action.message },
      };

    case "slotCleared":
      return { ...state, [slotKey(action.role)]: { status: "empty" } };

    case "matchingStarted":
      return state.matching ? state : { ...state, matching: true };

    case "matched":
      return { ...state, matches: action.result, matching: false };

    case "matchesCleared":
      // Drop stale results on a file (re)load; the worker emits fresh matches
      // once both sides are re-normalized. Leaves `matching` untouched.
      return state.matches === null ? state : { ...state, matches: null };

    case "setStart":
      return { ...state, startId: action.id };

    case "decisionsSet":
      // Replace the whole decision map (session restore, undo/redo, a decision
      // handler's freshly-built result). Defensively copied so the store can't
      // alias a caller's map (e.g. one also held in the undo stack).
      return { ...state, decisions: new Map(action.decisions) };

    case "decisionsCleared":
      return state.decisions.size === 0 ? state : { ...state, decisions: new Map() };

    case "confirmedDecisionsCleared": {
      // After a save bakes confirmed decisions into the dataset, drop them so the
      // pending-changes count and edit highlighting reset. ALWAYS returns a fresh
      // map (even if none were confirmed) — the caller relies on the identity
      // change to bump EditView's merge generation.
      const decisions = new Map(state.decisions);
      for (const [key, d] of decisions) if (d.status === "confirmed") decisions.delete(key);
      return { ...state, decisions };
    }

    case "importBranchesSet":
      return { ...state, importBranches: new Set(action.branches) };

    case "importBranchesCleared":
      return state.importBranches.size === 0 ? state : { ...state, importBranches: new Set() };

    case "rejectedDuplicatesSet":
      return { ...state, rejectedDuplicates: new Set(action.pairs) };

    case "rejectedDuplicatesCleared":
      return state.rejectedDuplicates.size === 0 ? state : { ...state, rejectedDuplicates: new Set() };

    case "reset":
      return {
        ...initialWorkspace,
        // Keep counting across a reset so a later load never reuses a
        // generation key an earlier file already rendered under.
        mainLoadGen: state.mainLoadGen,
        decisions: new Map(),
        importBranches: new Set(),
        rejectedDuplicates: new Set(),
      };
  }
}

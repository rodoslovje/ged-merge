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
  master: SlotState;
  compare: SlotState;
  /** The last successfully-loaded master, kept while a reload is in progress so
   *  the views don't flash back to the landing page. */
  lastMasterFile: LoadedFile | null;
  matches: MatchResult | null;
  /** True while the worker is (re)computing matches. */
  matching: boolean;
  /** Home/start person for kinship ranking, or undefined for none. */
  startId: string | undefined;
  /** Confirmed per-pair merge decisions, keyed by `decisionKey(...)`. */
  decisions: Map<string, CandidateDecision>;
  /** Import-branch requests, keyed by `importKey(...)`. */
  importBranches: Set<string>;
}

export const initialWorkspace: WorkspaceState = {
  master: { status: "empty" },
  compare: { status: "empty" },
  lastMasterFile: null,
  matches: null,
  matching: false,
  startId: undefined,
  decisions: new Map(),
  importBranches: new Set(),
};

export type WorkspaceAction =
  | { type: "slotLoading"; role: DatasetRole; fileName: string }
  | { type: "slotLoaded"; role: DatasetRole; file: LoadedFile }
  | { type: "slotError"; role: DatasetRole; fileName: string; message: string }
  | { type: "slotCleared"; role: DatasetRole }
  | { type: "matchingStarted" }
  | { type: "matched"; result: MatchResult }
  | { type: "setStart"; id: string | undefined }
  | { type: "decide"; key: string; decision: CandidateDecision }
  | { type: "undecide"; key: string }
  | { type: "decisionsRestored"; decisions: Map<string, CandidateDecision> }
  | { type: "decisionsCleared" }
  | { type: "importBranchesRestored"; branches: Set<string> }
  | { type: "reset" };

function slotKey(role: DatasetRole): "master" | "compare" {
  return role;
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "slotLoading":
      return { ...state, [slotKey(action.role)]: { status: "loading", fileName: action.fileName } };

    case "slotLoaded": {
      const next: WorkspaceState = { ...state, [slotKey(action.role)]: { status: "loaded", file: action.file } };
      // A freshly-loaded master becomes the preserved baseline.
      if (action.role === "master") next.lastMasterFile = action.file;
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

    case "setStart":
      return { ...state, startId: action.id };

    case "decide": {
      const decisions = new Map(state.decisions);
      decisions.set(action.key, action.decision);
      return { ...state, decisions };
    }

    case "undecide": {
      if (!state.decisions.has(action.key)) return state;
      const decisions = new Map(state.decisions);
      decisions.delete(action.key);
      return { ...state, decisions };
    }

    case "decisionsRestored":
      return { ...state, decisions: new Map(action.decisions) };

    case "decisionsCleared":
      return state.decisions.size === 0 ? state : { ...state, decisions: new Map() };

    case "importBranchesRestored":
      return { ...state, importBranches: new Set(action.branches) };

    case "reset":
      return {
        ...initialWorkspace,
        decisions: new Map(),
        importBranches: new Set(),
      };
  }
}

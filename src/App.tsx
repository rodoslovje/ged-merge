import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { type RecordPatch, type PendingEditApply, cloneRaw, snapshotRecords, patchesFromSnapshots } from "./ui/historyTypes";
import { useUndoRedo } from "./edit-state/useUndoRedo";
import { useTheme } from "./ui/useTheme";
import { useMode, type Mode } from "./ui/useMode";
import { useLegalModal } from "./ui/useLegalModal";
import { useMatchList } from "./ui/useMatchList";
import { useMobileWarning } from "./ui/useMobileWarning";
import { useGedcomWorker } from "./ui/useGedcomWorker";
import { useAutoDismissToast } from "./ui/useAutoDismissToast";
import { initialWorkspace, workspaceReducer, type LoadedFile, type SlotState } from "./state/workspace";
import { useDirtyTracking } from "./edit-state/useDirtyTracking";
import { useTranslation } from "react-i18next";
import type { GedNode } from "./gedcom/types";
import { cloneNode } from "./gedcom/node";
import { buildDataset } from "./gedcom/builder";
import { rebuildIndividual, rebuildFamily, removeIndividual, removeFamily } from "./gedcom/edit";
import { serializeGedcom } from "./gedcom/serialize";
import { mergeDecisions, formatReport, type ChangeReport, type ImportBranchRequest } from "./merge/merge";
import { sortEventsByDate } from "./merge/applyFields";
import { buildEditReport, enrichEditReport, combineReports, removeRecordFromReport } from "./gedcom/editReport";
import { defaultStartId } from "./match/relatives";
import type { DatasetRole, WorkerResponse } from "./worker/messages";
import { decisionKey, importKey, parseImportKey, type CandidateDecision, type ImportDirection, type MatchDecisionStatus } from "./review/types";
import { nowGedcomTime, stampChanCrea, todayGedcom } from "./gedcom/chanCrea";
import { downloadText } from "./ui/download";
import { AutoMediaOffer, GedcomLoader } from "./ui/GedcomLoader";
import { StartPersonSelector } from "./ui/StartPersonSelector";
import { CompareTree } from "./ui/CompareTree";
import { LegalModal } from "./ui/LegalModal";
import { ShortcutsModal } from "./ui/ShortcutsModal";
import { SettingsModal } from "./ui/SettingsModal";
import { KEY, isModalOpen, isEditableTarget } from "./keyboard/shortcuts";
import { MergeView } from "./ui/MergeView";
import { EditView } from "./ui/EditView";
import { ToolsView } from "./ui/ToolsView";
import { applyPlaceRename } from "./tools/placeEdit";
import { fixBrokenLinks } from "./tools/fixLinks";
import { fixSexFromRole } from "./tools/fixSex";
import { fixDates } from "./tools/fixDates";
import { fixDuplicatePointers } from "./tools/fixDuplicatePointers";
import { mergeDuplicate } from "./tools/mergeDuplicate";
import { SaveDialog } from "./ui/SaveDialog";
import { useConfirmDialog } from "./ui/useConfirmDialog";
import { EditTree } from "./ui/EditTree";
import { RelationshipChart } from "./ui/RelationshipChart";
import { Landing } from "./ui/Landing";
import { PwaReloadPrompt } from "./ui/PwaReloadPrompt";
import { Wordmark } from "./ui/icons/LogoMark";
import { GearIcon } from "./ui/icons/GearIcon";
import { MediaFolderProvider } from "./ui/MediaFolderContext";
import { loadWorkspace, saveFile, deleteFile, saveSession, clearWorkspace, requestPersistentStorage, type StoredSession, type StoredEditState } from "./persist/idb";
import { ChartSettingsProvider } from "./ui/ChartSettingsContext";
import { SettingsProvider, useSettings, useNameOf } from "./ui/SettingsContext";
import { GlobalSearchModal, type OpenHow, type SearchRowMeta } from "./ui/GlobalSearchModal";
import { buildSearchRows, type FilterContext } from "./ui/globalSearch";
import { SearchIcon } from "./ui/icons/SearchIcon";
import { kinshipInfo, lineageClass } from "./match/kinship";
import { computeDistances } from "./match/distance";
import { xrefLabel } from "./gedcom/nameDisplay";
import { PhotoViewerProvider } from "./ui/PhotoViewer";
import type { TreeMode } from "./tree/compareTree";
import {
  applyFilters,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  nextSort,
  type Filters,
  type SortKey,
  type SortState,
} from "./ui/matchView";

/** Which candidate pair the full-page compare tree is showing, and how. */
interface TreeView {
  masterId: string;
  compareId: string;
  mode: TreeMode;
}

/** A compare selection remembered in browser history (for the Back button). */
interface SelRef {
  masterId: string;
  compareId: string;
}

// Reuses the landing.samples.<key>.name translation keys, so the sample
// label is only defined once per language.
const SAMPLE_FILES = [
  { file: "EuropeRoyalFamilies.ged", key: "europe" },
  { file: "EnglishTudorRoyalFamily.ged", key: "tudor" },
  { file: "USPresidents.ged", key: "presidents" },
];

// Matching can finish in under a millisecond once the engine is JIT-warm, far
// too fast to ever paint a "matching" state — so keep the spinner up for at
// least this long once it starts.
const MIN_MATCHING_DISPLAY_MS = 300;

// Both mode views stay mounted (see render below) and are toggled with these
// styles rather than `hidden`, so the active one keeps the `flex: 1 1 0;
// min-height: 0` column sizing its content (`.edit-view`/`.main-split`)
// expects from a direct child of `.app` — `hidden` alone would collapse the
// wrapper to auto height and break the layout.
const modeLayerStyle: CSSProperties = { display: "flex", flexDirection: "column", flex: "1 1 0", minHeight: 0 };
const modeLayerHiddenStyle: CSSProperties = { display: "none" };

// MediaFolderProvider is mounted by the `App` wrapper below, *above* the
// full-page tree early-returns — so navigating into the Compare/Edit tree and
// back doesn't unmount it. In Firefox the picked folder is an in-memory
// Map<string,File> that can't be persisted to IndexedDB, so a remount there
// would silently lose it and force the user to re-pick the folder.
function AppContent() {
  const { t, i18n } = useTranslation();
  const { settings } = useSettings();
  const nameOf = useNameOf();
  // Opt-in workspace caching (off by default). Mirrored into a ref so the
  // mount-only worker/hydration effect reads the current value without needing
  // to re-run, and the (non-memoized) loadFile closure always sees it fresh.
  const persistEnabled = settings.persistWorkspace;
  const persistEnabledRef = useRef(persistEnabled);
  persistEnabledRef.current = persistEnabled;

  // Whether we've already attempted the one-time default start person for the
  // currently loaded master, so a user who clears it isn't re-defaulted.
  const autoStartRef = useRef(false);
  // Timestamp the "matching" spinner started, and the pending timer delaying
  // its "matched" result — see MIN_MATCHING_DISPLAY_MS below.
  const matchingStartRef = useRef<number | null>(null);
  const matchedTimerRef = useRef<number | null>(null);
  // The shared workspace store (reducer). Migrating in slices — the file slots
  // live here now; matches/decisions/etc. are still separate useState below and
  // move over in later steps. `lastMasterFile` is the most recently *successfully*
  // loaded master, kept while a reload is in progress so the Merge/Edit views
  // stay mounted (showing the previous data) instead of flashing the landing
  // page while `master` is transiently "loading" or "error".
  const [workspace, dispatch] = useReducer(workspaceReducer, initialWorkspace);
  // decisions/importBranches live in the workspace store too; the destructured
  // values keep every read site (and the sync refs below) unchanged.
  const { master, compare, lastMasterFile, matches, matching, decisions, importBranches } = workspace;
  const [startId, setStartId] = useState<string | undefined>(undefined);
  // When the first matches arrive with no start person, focus the picker so the
  // user can start typing immediately.
  const [focusStart, setFocusStart] = useState(false);
  // Keeps current decisions accessible from stable useCallback closures.
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;

  // Opt-in "graft this whole incoming branch on save" selections, made from the
  // compare tree. Each entry is an `importKey(direction, incomingId)`. Kept
  // outside `decisions` because it's a bulk-add, not a per-candidate decision.
  const importBranchesRef = useRef(importBranches);
  importBranchesRef.current = importBranches;
  // Tracks whether there are unsaved changes — updated each render so the
  // stable popstate handler can check without stale-closure issues.
  const hasUnsavedChangesRef = useRef(false);
  // Set right before an intentional reload so the beforeunload handler skips
  // the browser's native "leave page?" prompt after an in-app confirmation.
  const skipUnloadWarnRef = useRef(false);
  // Holds the currently-registered beforeunload handler so an intentional
  // reload can detach it synchronously before navigating.
  const beforeUnloadRef = useRef<((e: BeforeUnloadEvent) => void) | null>(null);
  // A merge session read from IndexedDB on startup, applied once the first match
  // result arrives (the candidate list it keys into must exist first). Null when
  // there is nothing to restore or it has already been consumed.
  const pendingSessionRef = useRef<StoredSession | null>(null);
  // Gates session persistence: stays false until the startup restore has settled
  // (or there was nothing to restore), so the debounced writer can't overwrite a
  // cached session with the empty state that exists mid-restore.
  const hydratedRef = useRef(false);
  // Whether the startup restore is still waiting on a compare file to match —
  // decides whether persistence is enabled after the master parses or only once
  // matching completes.
  const expectCompareRef = useRef(false);
  // Edit-state cached from a previous session, applied (instead of resetOnLoad)
  // once the edited master re-parses. Null when there is nothing to restore.
  const pendingEditStateRef = useRef<StoredEditState | null>(null);
  // The raw compare Blob (File on load, cached Blob on hydrate) — kept so that
  // enabling persistence mid-session can cache the compare exactly, including a
  // CSV that can't be re-serialized from its dataset.
  const compareBlobRef = useRef<Blob | null>(null);
  // Whether the master blob has been cached this session. The debounced effect
  // is the *sole* writer of the master key (serializing the live dataset), so a
  // fire-and-forget original write from loadFile can't race and clobber a later
  // edited write. False after a fresh master load → the next debounce caches it.
  const masterCachedRef = useRef(false);
  // Bumps on every dataset-mutating edit (and undo/redo of one). Drives the
  // persistence debounce and, when > 0, signals the dataset differs from the
  // originally-loaded file so the *edited* serialization must be cached.
  const [editVersion, setEditVersion] = useState(0);
  const bumpEdit = useCallback(() => setEditVersion((v) => v + 1), []);

  // ── Unified undo/redo (edit + merge in one stack) ─────────────────────────
  const undoRedo = useUndoRedo();
  const { canUndo, canRedo } = undoRedo;
  // ── Edit-mode dirty tracking (changed ids, pre-edit snapshots) ─────────────
  const dirty = useDirtyTracking();
  const { changedPersonIds, changedFamilyIds } = dirty;
  // Subset of changedPersonIds: individuals touched by structural edits (date/tag
  // changes via the edit UI) that may need chronological re-sorting on save.
  // Place renames mutate only PLAC values in-place and do NOT add here, so a bulk
  // rename can't silently reorder events that were in a non-canonical position.
  const sortEligiblePersonIdsRef = useRef(new Set<string>());
  // Queued edit-patch apply: consumed by EditView once it is mounted.
  const [pendingEditApply, setPendingEditApply] = useState<PendingEditApply | null>(null);

  // Matches list view state.
  const [sort, setSort] = useState<SortState[]>(DEFAULT_SORT);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<{ masterId: string; compareId: string } | null>(null);
  const [showFilters, setShowFilters] = useState(true);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [preview, setPreview] = useState<{
    records: GedNode[];
    report: ChangeReport;
    title: string;
    files: string[];
    downloadLabel: string;
    /** For the merge "total records" line. */
    masterRecordCount?: number;
    base: string;
    /** Record IDs from edit mode — show navigate/remove buttons for these. */
    editRecordIds: Set<string>;
    /** Whether this save includes confirmed merge matches (vs. edits only). */
    isMerge: boolean;
  } | null>(null);
  const { showMobileWarning, dismissMobileWarning } = useMobileWarning();
  // Brief confirmation shown after a successful download; auto-dismisses.
  const [saveToast, setSaveToast] = useAutoDismissToast();
  const compareRef = useRef<HTMLDivElement>(null);

  const [openMatches, setOpenMatches] = useState(false);

  // File-info panel: forced open when Merge has no matches yet; otherwise toggleable.
  const [showInfoPanel, setShowInfoPanel] = useState(false);

  // The person Edit is currently showing — reported up by EditView so that
  // switching to Merge mode (tab click or the "m" shortcut) can jump to that
  // same person's match candidate instead of leaving Merge on a stale prior
  // selection.
  const [editPersonId, setEditPersonId] = useState<string | undefined>(undefined);

  // Merge / Edit / Tools mode; persisted to localStorage in a small hook.
  const [mode, setMode] = useMode();

  // Light/dark theme mode + applied `data-theme`, in a self-contained hook.
  const { themeMode, changeThemeMode } = useTheme();

  // Privacy/Terms modal (also opened via a `?legal=` URL param), in a hook.
  const { legalOpen, legalPage, openLegal, closeLegal } = useLegalModal();

  // Full-page "Compare tree" view, kept in sync with browser history so the
  // back button returns to the main view.
  const [treeView, setTreeView] = useState<TreeView | null>(null);

  useEffect(() => {
    // Keep a throwaway "leave-guard" entry beneath the app's main entry. The
    // browser Back button then lands on a same-document popstate we can intercept
    // with our own confirmation dialog, instead of the un-stylable native
    // beforeunload prompt. Set up once; a remount keeps the existing entries.
    if (window.history.state?.gedPage !== "main") {
      window.history.replaceState({ ...window.history.state, gedPage: "leave-guard" }, "");
      window.history.pushState({ gedPage: "main" }, "");
    }

    function onPop(e: PopStateEvent) {
      const st = (e.state ?? {}) as {
        gedPage?: string; gedTree?: TreeView; gedSel?: SelRef;
        gedEditTreeId?: string; gedRelId?: string; gedMode?: Mode; gedNavigateTo?: string;
      };
      // Landing on the leave-guard = the user pressed Back from the app's main
      // entry and is about to leave the app. Intercept it.
      if (st.gedPage === "leave-guard") {
        if (hasUnsavedChangesRef.current) {
          // Re-push main so we stay on the app, then confirm asynchronously.
          window.history.pushState({ gedPage: "main" }, "");
          confirmDialog(t("app.navLeaveConfirm"), t("confirm.leave")).then((ok) => {
            if (ok) {
              // Already confirmed in-app — skip the native beforeunload prompt,
              // then navigate past the re-pushed main and the guard to leave.
              skipUnloadWarnRef.current = true;
              window.history.go(-2);
            }
          });
        } else {
          // No unsaved changes: continue past the guard to the previous page.
          window.history.back();
        }
        return;
      }
      setTreeView(st.gedTree ?? null);
      setEditTreeId(st.gedEditTreeId ?? null);
      setRelTargetId(st.gedRelId ?? null);
      // Restore the mode recorded for this entry (e.g. returning to the Tools tab
      // after opening a person from it). Absent on older/plain entries, in which
      // case the current mode is left untouched.
      if (st.gedMode) setMode(st.gedMode);
      if (st.gedNavigateTo) setNavigateToId(st.gedNavigateTo);
      // Restore a remembered compare selection (set when a person link pushed it).
      if (st.gedSel) {
        const { masterId, compareId } = st.gedSel;
        setSelectedId({ masterId, compareId });
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // App-styled confirmation dialog as a promise (`confirmDialog(...)`), in a hook.
  const { confirmDialog, confirmDialogElement } = useConfirmDialog();

  /** Settings → wipe the cached workspace (master/compare files + merge session)
   *  from IndexedDB. Doesn't touch the live, in-memory session — the current
   *  work stays loaded; only the persisted copy used to restore on reload goes. */
  async function handleClearCache() {
    if (!(await confirmDialog(t("settings.data.clearConfirm"), t("confirm.continue")))) return;
    await clearWorkspace();
    setSaveToast(t("settings.data.cleared"));
  }

  /** Record the current compare selection in the current history entry so the
   *  browser Back button returns here after a person-link or tree push. */
  function rememberSelection() {
    if (current) window.history.replaceState({ gedSel: { masterId: current.masterId, compareId: current.compareId } }, "");
  }

  function openTree(masterId: string, compareId: string) {
    rememberSelection();
    const view: TreeView = { masterId, compareId, mode: "ancestors" };
    window.history.pushState({ gedTree: view }, "");
    setTreeView(view);
  }
  /** Re-root the open tree on another person, as a new history entry. */
  function rerootTree(masterId?: string, compareId?: string) {
    if (!masterId && !compareId) return;
    setTreeView((cur) => {
      const view: TreeView = { masterId: masterId ?? "", compareId: compareId ?? "", mode: cur?.mode ?? "ancestors" };
      window.history.pushState({ gedTree: view }, "");
      return view;
    });
  }
  /** Leave the open tree and select this pair back in the Matches list. Pushes a
   *  fresh matches entry so the browser Back button returns to the tree. */
  function showInMatches(masterId: string, compareId: string) {
    window.history.pushState({ gedSel: { masterId, compareId } }, "");
    setSelectedId({ masterId, compareId });
    setTreeView(null);
  }
  function changeTreeMode(mode: TreeMode) {
    setTreeView((cur) => {
      if (!cur) return cur;
      const next = { ...cur, mode };
      window.history.replaceState({ gedTree: next }, "");
      return next;
    });
  }

  // Dispatch a message from the GEDCOM worker to the right state. Invoked on
  // every worker message via useGedcomWorker's latest-handler ref.
  const handleWorkerMessage = (msg: WorkerResponse) => {
      if (msg.type === "matching") {
        if (matchedTimerRef.current != null) {
          window.clearTimeout(matchedTimerRef.current);
          matchedTimerRef.current = null;
        }
        if (matchingStartRef.current === null) matchingStartRef.current = performance.now();
        dispatch({ type: "matchingStarted" });
        return;
      }
      if (msg.type === "matched") {
        const applyMatched = () => {
          matchingStartRef.current = null;
          matchedTimerRef.current = null;
          dispatch({ type: "matched", result: msg.result });
          setSelectedId(null);
          setOpenMatches(true);
          setShowInfoPanel(false);
          // First matches after a startup restore: re-apply the cached merge
          // session now that the candidate list (keyed by xref) exists. Setting
          // the home person re-ranks, producing another `matched` — harmless,
          // the session is already consumed (ref nulled).
          const restored = pendingSessionRef.current;
          if (restored) {
            pendingSessionRef.current = null;
            if (restored.decisions.length) dispatch({ type: "decisionsSet", decisions: new Map(restored.decisions) });
            if (restored.importBranches.length) dispatch({ type: "importBranchesSet", branches: new Set(restored.importBranches) });
          }
          hydratedRef.current = true; // restore settled — persistence may resume
        };
        // matchDatasets can finish in under a millisecond once the engine is
        // JIT-warm (e.g. re-matching on a master reload), too fast for React to
        // ever paint the "matching" state. Hold the spinner up for a minimum
        // stretch so background recomputation stays visible to the user.
        const elapsed = matchingStartRef.current != null ? performance.now() - matchingStartRef.current : MIN_MATCHING_DISPLAY_MS;
        const remaining = MIN_MATCHING_DISPLAY_MS - elapsed;
        if (remaining > 0) {
          matchedTimerRef.current = window.setTimeout(applyMatched, remaining);
        } else {
          applyMatched();
        }
        return;
      }
      if (msg.type === "parsed") {
        const file: LoadedFile = { fileName: msg.fileName, dataset: msg.dataset };
        if (msg.report) file.report = msg.report;
        if (msg.placeLayout) file.placeLayout = msg.placeLayout;
        if (msg.dateFormat) file.dateFormat = msg.dateFormat;
        if (msg.datePlaceholder) file.datePlaceholder = msg.datePlaceholder;
        if (msg.sourceLayout) file.sourceLayout = msg.sourceLayout;
        if (msg.nameLayout) file.nameLayout = msg.nameLayout;
        if (msg.unknownNameStyle) file.unknownNameStyle = msg.unknownNameStyle;
        if (msg.marriedNameTag) file.marriedNameTag = msg.marriedNameTag;
        // slotLoaded also records lastMasterFile when role is "master".
        dispatch({ type: "slotLoaded", role: msg.role, file });
        if (msg.role === "master") {
          // Restore the cached start person as soon as the master is parsed —
          // matching (and `applyMatched`) only runs once a compare is also
          // loaded, so a master-only workspace would otherwise never restore it.
          const restoredStart = pendingSessionRef.current?.startId;
          if (restoredStart) changeStart(restoredStart);
          // Master-only restore (no compare to match): nothing more to wait for.
          if (!expectCompareRef.current) hydratedRef.current = true;
        }
      } else {
        dispatch({ type: "slotError", role: msg.role, fileName: msg.fileName, message: msg.message });
        // A file that fails to parse must not stay cached, or every reload would
        // re-load it into an error and never reach the landing page.
        void deleteFile(msg.role);
        // A failed restore won't reach `matched`/the master branch — unblock
        // persistence so later user-loaded files still get cached.
        hydratedRef.current = true;
      }
  };
  // Owns the worker's lifecycle; always dispatches to the latest handler above.
  const { post } = useGedcomWorker(handleWorkerMessage);

  // Restore a cached workspace on mount: re-feed the stored files through the
  // worker so the parse → normalize → match pipeline (and start-person ranking)
  // rebuilds exactly as a fresh load would. The merge session is stashed and
  // applied in `applyMatched` once the candidate list exists.
  useEffect(() => {
    let cancelled = false;
    // Only read the cache when the user has opted in; otherwise there is nothing
    // stored and we go straight to the landing page.
    const hydrate: ReturnType<typeof loadWorkspace> = persistEnabledRef.current
      ? loadWorkspace()
      : Promise.resolve({});
    void hydrate.then((ws) => {
      if (cancelled) return;
      if (!ws.master) {
        hydratedRef.current = true; // nothing cached — persist freely from here
        return;
      }
      pendingSessionRef.current = ws.session ?? null;
      pendingEditStateRef.current = ws.session?.editState ?? null;
      expectCompareRef.current = !!ws.compare;
      masterCachedRef.current = true; // restored master is already in the cache
      if (ws.compare) compareBlobRef.current = ws.compare.blob;
      // A cached start person will be restored explicitly; suppress the one-time
      // auto-default so it doesn't fight the restore.
      if (ws.session?.startId) autoStartRef.current = true;
      const feed = (role: DatasetRole, sf: NonNullable<typeof ws.master>) => {
        dispatch({ type: "slotLoading", role, fileName: sf.fileName });
        void sf.blob.arrayBuffer().then((buffer) => {
          if (cancelled) return;
          post(
            sf.isCsv
              ? { type: "parseCsv", fileName: sf.fileName, buffer }
              : { type: "parse", role, fileName: sf.fileName, buffer },
            [buffer],
          );
        });
      };
      feed("master", ws.master); // master first so its profile is set before compare normalizes
      if (ws.compare) feed("compare", ws.compare);
    });
    return () => { cancelled = true; };
  }, [post]);

  // On unmount, cancel a pending "hold the spinner" timer so it can't fire a
  // setState after teardown.
  useEffect(() => () => {
    if (matchedTimerRef.current != null) window.clearTimeout(matchedTimerRef.current);
  }, []);

  async function loadSample(role: DatasetRole, fileName: string) {
    const res = await fetch(`samples/${fileName}`);
    const blob = await res.blob();
    loadFile(role, new File([blob], fileName, { type: "text/plain" }));
  }

  async function loadFile(role: DatasetRole, file: File) {
    // A user-initiated load supersedes any in-flight startup restore, so enable
    // session persistence (and stop expecting the cached compare to arrive).
    hydratedRef.current = true;
    expectCompareRef.current = false;
    pendingSessionRef.current = null;
    pendingEditStateRef.current = null;
    if (role === "master" && (changedCount > 0 || confirmedCount > 0 || importCount > 0)) {
      if (!(await confirmDialog(t("load.masterReplaceConfirm"), t("confirm.continue")))) return;
    }
    if (role === "compare" && (confirmedCount > 0 || importCount > 0)) {
      if (!(await confirmDialog(t("load.incomingReplaceConfirm"), t("confirm.continue")))) return;
    }

    // macOS hands back filenames in decomposed (NFD) form, e.g. "Kovačič" as
    // c + combining caron. Our subset fonts don't carry the combining marks, so
    // the accent mispositions; normalize to NFC (precomposed) for display.
    const fileName = file.name.normalize("NFC");
    const isCsv = role === "compare" && /\.csv$/i.test(fileName);
    dispatch({ type: "slotLoading", role, fileName });
    // Cache the compare's raw bytes so a reload restores it (only when opted in).
    // The master is NOT written here — the debounced effect owns the master key
    // (it serializes the live, possibly-edited dataset), so a stale original
    // write can't land after and clobber an edit. A fresh master resets the flag
    // so the next debounce re-caches it.
    if (role === "compare") {
      compareBlobRef.current = file;
      if (persistEnabled) void saveFile("compare", { fileName, blob: file, isCsv, savedAt: Date.now() });
    } else {
      masterCachedRef.current = false;
    }
    // Drop stale results + decisions; the worker will emit fresh matches once
    // both sides are (re)loaded and re-normalized.
    dispatch({ type: "matchesCleared" });
    dispatch({ type: "decisionsCleared" });
    dispatch({ type: "importBranchesCleared" });
    setPendingEditApply(null);
    setPreview(null);
    setOpenMatches(false);
    if (role === "master") {
      undoRedo.clearAll();
      dirty.prepareForLoad();
      setEditVersion(0); // new file → dataset matches the cached original again
      sortEligiblePersonIdsRef.current = new Set();
      setEditTreeId(null);
      setRelTargetId(null);
      setStartId(undefined); // start person is opt-in; reset on (re)load
      setFocusStart(false);
      autoStartRef.current = false; // allow the default start person for the new file
    } else {
      // Incoming reload: edit entries remain valid (they only touch master data).
      // Drop merge entries whose field comparisons reference the old incoming file.
      undoRedo.dropMergeEntries();
    }
    const buffer = await file.arrayBuffer();
    post(
      isCsv ? { type: "parseCsv", fileName, buffer } : { type: "parse", role, fileName, buffer },
      [buffer], // transfer ownership — avoids copying large files
    );
  }

  function changeStart(id: string | undefined) {
    setStartId(id);
    post({ type: "setStart", id: id ?? "" });
  }

  // Capture the set of IDs that exist at load time so we can later distinguish
  // "modified existing" from "newly added" when reverting via Remove from save.
  useEffect(() => {
    if (master.status !== "loaded") return;
    // Startup restore of an edited workspace: the re-parsed master is the edited
    // serialization, so adopt the cached pre-edit tracking and undo history
    // instead of treating the current (edited) records as the clean baseline.
    const es = pendingEditStateRef.current;
    if (es) {
      pendingEditStateRef.current = null;
      dirty.hydrate(es);
      undoRedo.hydrate(es.undo, es.redo);
      sortEligiblePersonIdsRef.current = new Set(es.sortEligiblePersonIds);
      setEditVersion(1); // mark dataset as edited so further edits keep persisting
    } else {
      dirty.resetOnLoad(master.file.dataset);
      sortEligiblePersonIdsRef.current = new Set();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master.status]);

  // When the master finishes loading, default the start person to its root
  // individual if present. Attempted once per file (autoStartRef), so a user
  // who later clears the start person isn't overridden.
  useEffect(() => {
    if (master.status !== "loaded" || autoStartRef.current) return;
    autoStartRef.current = true;
    if (startId) return;
    const start = defaultStartId(master.file.dataset);
    if (start) {
      changeStart(start);
    } else {
      setFocusStart(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master.status]);

  // In merge mode, also attempt once when first match results arrive (covers
  // the case where master loaded before the worker finished computing matches).
  useEffect(() => {
    if (!matches || autoStartRef.current) return;
    autoStartRef.current = true;
    if (startId) return;
    const ds = master.status === "loaded" ? master.file.dataset : undefined;
    const start = ds ? defaultStartId(ds) : undefined;
    if (start) {
      changeStart(start);
    } else {
      setFocusStart(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  // Persist the workspace so a reload restores it: the pending merge session
  // (decisions, import branches, start person) plus, once the dataset has been
  // edited, the edited master text and the edit-state (dirty tracking + undo
  // history). Debounced because these change rapidly while working; keyed to the
  // loaded master/compare so a stale restore can be skipped.
  useEffect(() => {
    if (!persistEnabled) return; // caching is opt-in
    const masterFileName = lastMasterFile?.fileName;
    if (!masterFileName) return; // nothing loaded yet → nothing to cache
    if (!hydratedRef.current) return; // a startup restore is still settling
    const handle = window.setTimeout(async () => {
      const edited = editVersion > 0; // dataset differs from the cached original
      const editState: StoredEditState | undefined = edited
        ? { ...dirty.serialize(), sortEligiblePersonIds: [...sortEligiblePersonIdsRef.current], ...undoRedo.serialize() }
        : undefined;
      // Cache the master's *current* serialization (edited or original) — this
      // effect is the sole master writer. Re-serialize when the dataset has been
      // edited, or once when it hasn't been cached yet this session (a pure-merge
      // session then serializes only that first time, not on every decision). It
      // is written before the session below, so a session record always points
      // at an already-committed master.
      if (masterDataset && (edited || !masterCachedRef.current)) {
        await saveFile("master", {
          fileName: masterFileName,
          blob: new Blob([serializeGedcom(masterDataset.records, { eol: masterDataset.eol, finalNewline: masterDataset.finalNewline })]),
          savedAt: Date.now(),
        });
        masterCachedRef.current = true;
      }
      await saveSession({
        masterFileName,
        compareFileName: compare.status === "loaded" ? compare.file.fileName : undefined,
        decisions: Array.from(decisions),
        importBranches: Array.from(importBranches),
        startId,
        editState,
        savedAt: Date.now(),
      });
    }, 800);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistEnabled, decisions, importBranches, startId, compare, lastMasterFile, editVersion, changedPersonIds, changedFamilyIds]);

  // React to the opt-in toggle: on enable, request durable storage (the only
  // place that may prompt) and cache the current workspace right away; on
  // disable, wipe the cache. The debounced effect above writes the session.
  const prevPersistRef = useRef(persistEnabled);
  useEffect(() => {
    if (persistEnabled === prevPersistRef.current) return; // includes the mount no-op
    prevPersistRef.current = persistEnabled;
    if (!persistEnabled) {
      void clearWorkspace();
      return;
    }
    void requestPersistentStorage();
    const ds = lastMasterFile?.dataset;
    if (ds && lastMasterFile) {
      void saveFile("master", {
        fileName: lastMasterFile.fileName,
        blob: new Blob([serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline })]),
        savedAt: Date.now(),
      });
    }
    if (compareBlobRef.current && compare.status === "loaded") {
      void saveFile("compare", {
        fileName: compare.file.fileName,
        blob: compareBlobRef.current,
        isCsv: /\.csv$/i.test(compare.file.fileName),
        savedAt: Date.now(),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistEnabled]);

  function toggleSort(key: SortKey) {
    setSort((prev) => nextSort(prev, key));
  }

  // The merge "match list" view-model (ranked/filtered lists, selection, index
  // maps) — pure derivation, extracted to a hook. The stateful setters
  // (sort/filters) and navigation callbacks stay here.
  const { allSorted, visible, visibleMasterOrder, current, visibleIndex, allSortedIndex, indexByMaster, indexByCompare } =
    useMatchList({ matches, sort, filters, decisions, selectedId });

  // Refs used by the stable callbacks and the arrow-key effect so they don't
  // need to re-register whenever visible changes.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const visibleIndexRef = useRef(visibleIndex);
  visibleIndexRef.current = visibleIndex;

  const canNavigatePerson = useCallback(
    (side: "master" | "incoming", id: string) =>
      (side === "master" ? indexByMaster : indexByCompare).has(id),
    [indexByMaster, indexByCompare],
  );


  // Stable identity — uses visibleRef so memoized rows don't re-render on
  // every filter change (only rows whose own props change do).
  const select = useCallback((visIdx: number) => {
    const c = visibleRef.current[visIdx];
    if (!c) return;
    setSelectedId({ masterId: c.masterId, compareId: c.compareId });
    if (window.innerWidth <= 880) {
      setTimeout(() => {
        compareRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 50);
    }
  }, []);

  // Prev/Next navigate within the filtered visible list.
  const onSelectPrev = useCallback(() => {
    const idx = Math.max(0, visibleIndexRef.current - 1);
    const c = visibleRef.current[idx];
    if (c) setSelectedId({ masterId: c.masterId, compareId: c.compareId });
  }, []);

  const onSelectNext = useCallback(() => {
    const idx = Math.min(visibleRef.current.length - 1, visibleIndexRef.current + 1);
    const c = visibleRef.current[idx];
    if (c) setSelectedId({ masterId: c.masterId, compareId: c.compareId });
  }, []);

  // When filters change: keep current person if they survive the new filter;
  // otherwise jump to the first person in the new filtered list.
  function handleFilters(f: Filters) {
    const newVisible = applyFilters(allSorted, f);
    const currentStillVisible = current
      ? newVisible.some(c => c.masterId === current.masterId && c.compareId === current.compareId)
      : false;
    if (!currentStillVisible && newVisible.length > 0) {
      setSelectedId({ masterId: newVisible[0].masterId, compareId: newVisible[0].compareId });
    }
    setFilters(f);
  }

  // Jump the compare view to a relative's own match row, pushing a history entry
  // so the browser Back button returns to where we were.
  const navigatePerson = useCallback(
    (side: "master" | "incoming", id: string) => {
      const target = (side === "master" ? indexByMaster : indexByCompare).get(id);
      if (!target) return;
      if (target.masterId === current?.masterId && target.compareId === current?.compareId) return;
      if (current) window.history.replaceState({ gedSel: { masterId: current.masterId, compareId: current.compareId } }, "");
      window.history.pushState({ gedSel: { masterId: target.masterId, compareId: target.compareId } }, "");
      setSelectedId({ masterId: target.masterId, compareId: target.compareId });
      if (window.innerWidth <= 880) {
        setTimeout(() => { compareRef.current?.scrollIntoView({ behavior: "smooth" }); }, 50);
      }
    },
    [indexByMaster, indexByCompare, current],
  );

  function handleUndo() {
    const entry = undoRedo.undo();
    if (!entry) return;
    if (entry.mode === "edit") {
      if (entry.navigateTo) setNavigateToId(entry.navigateTo);
      setMode("edit");
      setPendingEditApply({ patches: entry.patches, direction: "undo", navigateTo: entry.navigateTo, redoNavigateTo: entry.redoNavigateTo });
    } else if (entry.mode === "import") {
      dispatch({ type: "importBranchesSet", branches: entry.before });
    } else {
      setSelectedId({ masterId: entry.masterId, compareId: entry.compareId });
      setMode("merge");
      requestAnimationFrame(() => {
        dispatch({ type: "decisionsSet", decisions: entry.before });
      });
    }
  }

  function handleRedo() {
    const entry = undoRedo.redo();
    if (!entry) return;
    if (entry.mode === "edit") {
      const navId = entry.redoNavigateTo ?? entry.navigateTo;
      if (navId) setNavigateToId(navId);
      setMode("edit");
      setPendingEditApply({ patches: entry.patches, direction: "redo", navigateTo: entry.navigateTo, redoNavigateTo: entry.redoNavigateTo });
    } else if (entry.mode === "import") {
      dispatch({ type: "importBranchesSet", branches: entry.after });
    } else {
      setSelectedId({ masterId: entry.masterId, compareId: entry.compareId });
      setMode("merge");
      requestAnimationFrame(() => {
        dispatch({ type: "decisionsSet", decisions: entry.after });
      });
    }
  }

  // Stable ref for keyboard handler (recreated each render but registered once).
  const globalShortcutRef = useRef({ undo: handleUndo, redo: handleRedo, save: () => {}, canSave: false });
  globalShortcutRef.current.undo = handleUndo;
  globalShortcutRef.current.redo = handleRedo;

  // Global "standard" shortcuts: modifier chords (undo/redo/save) plus the
  // universal find (`/`) and shortcut-help (`?`/F1) keys. Bare app-specific keys
  // (mode switches, decisions, tree) live in their own handlers below and in the
  // per-view files. All of them bail while a modal is open so they don't act on
  // the app behind a dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const editable = isEditableTarget(e.target);
      const mod = e.metaKey || e.ctrlKey;

      // Ctrl/Cmd+S saves from anywhere — including mid-edit. Blur the field
      // first so its in-progress value commits (edit fields save on blur),
      // then save. preventDefault always, so the browser never shows its own
      // "save page" prompt. Skipped only while another dialog is open.
      if (mod && e.key === "s" && !isModalOpen()) {
        e.preventDefault();
        const doSave = () => { if (globalShortcutRef.current.canSave) globalShortcutRef.current.save(); };
        if (editable) {
          // Let the field's blur-commit flush into app state before reading
          // canSave / building the save report off the now-current dataset.
          (e.target as HTMLElement).blur();
          requestAnimationFrame(doSave);
        } else {
          doSave();
        }
        return;
      }

      if (editable) return;

      // `?` / F1 toggle the shortcut cheat sheet. Allowed even with the sheet
      // itself open (so it toggles closed), but not stacked over another modal.
      if (e.key === "?" || e.key === "F1") {
        e.preventDefault();
        setShowShortcuts((v) => (!v && isModalOpen() ? v : !v));
        return;
      }
      if (isModalOpen()) return;

      if (mod) {
        if (e.key === "z" && !e.shiftKey) { e.preventDefault(); globalShortcutRef.current.undo(); }
        else if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); globalShortcutRef.current.redo(); }
        return;
      }

      // `/` opens the whole-file global search from any mode (Merge/Edit/Tools).
      // The per-mode match filter has its own key (`f`, handled in MergeView).
      if (e.key === "/") {
        e.preventDefault();
        setShowGlobalSearch(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const [navigateToId, setNavigateToId] = useState<string | undefined>(undefined);

  // Switch to Edit, pointing it at whichever candidate Merge currently has
  // selected (so the person carries over instead of Edit staying on whoever
  // it last showed).
  function switchToEdit() {
    if (current) setNavigateToId(current.masterId);
    setMode("edit");
  }

  // Clicking the start icon jumps Edit mode to the chosen start person.
  function goToStartPerson() {
    if (!startId) return;
    setNavigateToId(startId);
    setMode("edit");
  }

  // Switch to Merge, pointing it at the match candidate for whichever person
  // Edit is currently showing (so the person carries over the other way too) —
  // falls back to leaving Merge's selection untouched when that person isn't
  // itself a match candidate.
  function switchToMerge() {
    const c = editPersonId ? allSorted.find((c) => c.masterId === editPersonId) : undefined;
    if (c) setSelectedId({ masterId: c.masterId, compareId: c.compareId });
    setMode("merge");
  }

  // Switch to the maintenance Tools tab, which operates on the whole master file.
  function switchToTools() {
    setMode("tools");
  }

  // Mode-switch shortcuts: fixed bare keys E / M / T (see KEY in keyboard/shortcuts).
  // Kept locale-independent — label-derived first letters collided across
  // translations (e.g. Slovenian "Urejanje"/"Združi") and weren't discoverable.
  const modeSwitchRef = useRef({ mode, switchToEdit, switchToMerge, switchToTools });
  modeSwitchRef.current = { mode, switchToEdit, switchToMerge, switchToTools };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isModalOpen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      const { mode: cur, switchToEdit: se, switchToMerge: sme, switchToTools: st } = modeSwitchRef.current;
      if (key === KEY.modeEdit && cur !== "edit") { e.preventDefault(); se(); }
      else if (key === KEY.modeMerge && cur !== "merge") { e.preventDefault(); sme(); }
      else if (key === KEY.modeTools && cur !== "tools") { e.preventDefault(); st(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // As soon as a fresh match result lands, point Edit at the first candidate —
  // same as switching into Edit mode via its "e" shortcut already does for
  // whichever candidate Merge has selected (see the `editKey` branch above).
  // Without this, Edit keeps showing whatever person it last had (often not a
  // match candidate at all, e.g. the start person), so its Left/Right match
  // navigation silently does nothing until the user manually picks a person
  // who is on the list.
  useEffect(() => {
    if (!matches) return;
    const first = allSorted[0];
    if (first) setNavigateToId(first.masterId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  function updateDecision(next: CandidateDecision) {
    if (!current) return;
    const key = decisionKey("individual", current.masterId, current.compareId);
    const before = new Map(decisions);
    const after = new Map(decisions).set(key, next);
    undoRedo.push({ mode: "merge", before, after, masterId: current.masterId, compareId: current.compareId });
    dispatch({ type: "decisionsSet", decisions: after });
  }

  // Same as `updateDecision`, but for EditView: the person being edited there
  // isn't necessarily Merge's currently selected candidate (`current`) — e.g.
  // after confirming two matches and navigating from one to the other within
  // Edit. EditView already knows which decision it means (it found `key` by
  // matching the decision's own master id against the person on screen), so
  // it passes that key explicitly instead of relying on `current`.
  function updateDecisionForKey(key: string, next: CandidateDecision) {
    const [, masterId, compareId] = key.split(":");
    const before = new Map(decisions);
    const after = new Map(decisions).set(key, next);
    undoRedo.push({ mode: "merge", before, after, masterId, compareId });
    dispatch({ type: "decisionsSet", decisions: after });
  }

  // Set a pair's status while keeping its field choices; clicking the active
  // status again clears it back to undecided. Used by the compare tree, where a
  // node may be a person that never appeared in the candidate list.
  const setPairStatus = useCallback(
    (masterId: string, compareId: string, status: MatchDecisionStatus) => {
      const key = decisionKey("individual", masterId, compareId);
      const before = decisionsRef.current;
      const cur = before.get(key);
      const nextStatus = cur?.status === status ? "undecided" : status;
      const after = new Map(before).set(key, { status: nextStatus, fields: cur?.fields ?? {} });
      undoRedo.pushRef.current({ mode: "merge", before: new Map(before), after, masterId, compareId });
      dispatch({ type: "decisionsSet", decisions: after });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [], // undoRedo.pushRef/decisionsRef are stable refs — no re-registration needed
  );

  // Toggle a "bring in this incoming person's ancestors/descendants on save"
  // request from the compare tree. Like `setPairStatus`, it's undoable and reads
  // current state from a ref so the callback stays stable.
  const toggleImportBranch = useCallback(
    (direction: ImportDirection, incomingId: string) => {
      const key = importKey(direction, incomingId);
      const before = importBranchesRef.current;
      const after = new Set(before);
      if (after.has(key)) after.delete(key);
      else after.add(key);
      undoRedo.pushRef.current({ mode: "import", before: new Set(before), after });
      dispatch({ type: "importBranchesSet", branches: after });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [], // undoRedo.pushRef/importBranchesRef are stable refs — no re-registration needed
  );

  const handlePushEdit = useCallback(
    (patches: RecordPatch[], navigateTo?: string, redoNavigateTo?: string) => {
      dirty.captureSnapshotsForPush(patches);
      undoRedo.pushRef.current({ mode: "edit", patches, navigateTo, redoNavigateTo });
      bumpEdit();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const masterDataset = lastMasterFile?.dataset;
  const compareDataset = compare.status === "loaded" ? compare.file.dataset : undefined;

  // Edit Tree: full-page tree view for the edit mode.
  const [editTreeId, setEditTreeId] = useState<string | null>(null);

  function openEditTree(id: string) {
    window.history.pushState({ gedEditTreeId: id }, "");
    setEditTreeId(id);
  }

  // Relationship-to-start diagram: full-page view for the selected person.
  const [relTargetId, setRelTargetId] = useState<string | null>(null);

  function openRelationship(id: string) {
    window.history.pushState({ gedRelId: id }, "");
    setRelTargetId(id);
  }

  // Whole-file search index for the global search dialog. Rebuilt when the
  // dataset is (re)loaded, edited (editVersion), or the name-display settings
  // change — the same triggers that alter a person's displayed name.
  const searchRows = useMemo(
    () => (masterDataset ? buildSearchRows(masterDataset.individuals, nameOf) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [masterDataset, nameOf, editVersion],
  );

  // Master id → its merge decision (confirmed/deferred/rejected), for the global
  // search "decision" facet. Undecided candidates carry no entry.
  const decisionByMaster = useMemo(() => {
    const m = new Map<string, MatchDecisionStatus>();
    for (const [key, d] of decisions) {
      if (d.status === "undecided") continue;
      const masterId = key.split(":")[1];
      if (!m.has(masterId)) m.set(masterId, d.status);
    }
    return m;
  }, [decisions]);

  // Relationship hops from the start person to every reachable individual, for
  // the kinship facet. One BFS, recomputed only when the start person or the
  // dataset (via edits) changes. Empty when no start person is set.
  const kinshipDistances = useMemo(
    () => (startId && masterDataset ? computeDistances(masterDataset, startId) : new Map<string, number>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startId, masterDataset, editVersion],
  );

  // Cross-cutting lookups the search facets need but that aren't baked into the
  // (dataset-derived) rows: unsaved-edit, merge-decision, and kinship-hop per person.
  const searchFilterContext = useMemo<FilterContext>(
    () => ({
      isEdited: (id) => changedPersonIds.has(id),
      decisionOf: (id) => decisionByMaster.get(id),
      kinshipHops: (id) => kinshipDistances.get(id),
    }),
    [changedPersonIds, decisionByMaster, kinshipDistances],
  );

  // Per-row record-id / kinship extras for the search results, honouring the
  // "show record ids" and "show kinship" settings. Kinship is computed lazily
  // (only for the ≤50 rendered rows) and cached per person, since a full kinship
  // solve per keystroke over the whole list would be costly on large trees. The
  // cache is keyed to the start person + dataset edits + the kinship setting.
  const kinshipCacheRef = useRef(new Map<string, { label: string; lineageClass: string } | null>());
  useEffect(() => {
    kinshipCacheRef.current = new Map();
  }, [startId, masterDataset, settings.showKinship, editVersion]);
  const searchMetaOf = useCallback(
    (id: string): SearchRowMeta => {
      const meta: SearchRowMeta = {};
      if (settings.showXref) meta.xref = xrefLabel(id);
      if (settings.showKinship && startId && masterDataset && startId !== id) {
        let cached = kinshipCacheRef.current.get(id);
        if (cached === undefined) {
          const info = kinshipInfo(masterDataset, startId, id, t);
          cached = info ? { label: info.label, lineageClass: lineageClass(info.lineage) } : null;
          kinshipCacheRef.current.set(id, cached);
        }
        if (cached) {
          meta.kinship = cached.label;
          meta.kinshipLineage = cached.lineageClass;
        }
      }
      return meta;
    },
    [settings.showXref, settings.showKinship, startId, masterDataset, t],
  );

  // Open a person chosen in global search. Routes by context: a match candidate
  // lands in Merge on its pair; anyone else jumps to them in Edit. Shift opens
  // their tree, Alt their relationship-to-start (falling back to Edit when there
  // is no start person to measure from).
  function openSearchResult(id: string, how: OpenHow) {
    if (how === "tree") { openEditTree(id); return; }
    if (how === "relationship") {
      if (startId && startId !== id) openRelationship(id);
      else { setNavigateToId(id); setMode("edit"); }
      return;
    }
    // Mode-aware "open": staying in Merge only makes sense when Merge is the
    // active mode and the person is a match candidate — then land on their pair.
    // From Edit (or Tools, or for a non-candidate), open the person in Edit so
    // an edit-mode search never yanks the user into Merge.
    const candidate = mode === "merge" ? indexByMaster.get(id) : undefined;
    if (candidate) {
      setSelectedId({ masterId: candidate.masterId, compareId: candidate.compareId });
      setMode("merge");
    } else {
      setNavigateToId(id);
      setMode("edit");
    }
  }

  const changedCount = changedPersonIds.size + changedFamilyIds.size;

  // Called by EditView after undo/redo patches have been applied to the dataset.
  // Delegates to useDirtyTracking which handles all the case logic as pure ops.
  const handlePatchApplied = useCallback(
    (patches: RecordPatch[], direction: "undo" | "redo") => {
      if (!masterDataset) return;
      dirty.onPatchApplied(patches, direction, masterDataset);
      bumpEdit();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [masterDataset],
  );

  const confirmedCount = useMemo(() => {
    let n = 0;
    for (const d of decisions.values()) if (d.status === "confirmed") n++;
    return n;
  }, [decisions]);

  const confirmedMasterIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [key, d] of decisions) {
      if (d.status === "confirmed") ids.add(key.split(":")[1]);
    }
    return ids;
  }, [decisions]);

  const importCount = importBranches.size;

  // Decode the import-branch key set into engine requests for the merge.
  const importRequests = useMemo<ImportBranchRequest[]>(() => {
    const out: ImportBranchRequest[] = [];
    for (const key of importBranches) {
      const parsed = parseImportKey(key);
      if (parsed) out.push({ incomingId: parsed.incomingId, direction: parsed.direction });
    }
    return out;
  }, [importBranches]);

  hasUnsavedChangesRef.current = changedCount > 0 || confirmedCount > 0 || importCount > 0;

  // Warn before leaving the page when there are unsaved changes. Registered once
  // on mount and reads refs so it always reflects the current state without
  // re-subscribing. The handler is kept in a ref so an intentional in-app reload
  // can detach it synchronously before navigating — some browsers (e.g. Firefox)
  // abort a programmatic reload while a beforeunload listener is attached.
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (skipUnloadWarnRef.current || !hasUnsavedChangesRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    }
    beforeUnloadRef.current = onBeforeUnload;
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      beforeUnloadRef.current = null;
    };
  }, []);

  /** Drop the unsaved-changes guard and reload. Runs synchronously inside the
   *  dialog button's click handler so the reload keeps the user's activation —
   *  Firefox blocks a programmatic reload that fires from an async continuation. */
  function discardAndReload() {
    skipUnloadWarnRef.current = true;
    if (beforeUnloadRef.current) {
      window.removeEventListener("beforeunload", beforeUnloadRef.current);
      beforeUnloadRef.current = null;
    }
    window.location.reload();
  }

  async function handleTitleClick() {
    const hasChanges = mode === "merge" ? confirmedCount > 0 || importCount > 0 : changedCount > 0 || confirmedCount > 0 || importCount > 0;
    if (!hasChanges) {
      discardAndReload();
      return;
    }
    // Pass the reload as the dialog's synchronous confirm action; the awaited
    // result is only used to no-op on cancel.
    await confirmDialog(t("app.reloadConfirm"), t("confirm.reload"), discardAndReload);
  }

  function handleSave() {
    if (!masterDataset || master.status !== "loaded") return;
    const base = master.file.fileName.replace(/\.ged$/i, "");
    const editRecordIds = new Set([...changedPersonIds, ...changedFamilyIds]);
    const isMerge = confirmedCount > 0 || importCount > 0;

    const editReport = changedCount > 0
      ? enrichEditReport(
          buildEditReport(changedPersonIds, changedFamilyIds, masterDataset, dirty.loadedPersonIds.current, dirty.loadedFamilyIds.current, dirty.personSnapshots.current, dirty.familySnapshots.current),
          masterDataset, dirty.personSnapshots.current, dirty.familySnapshots.current, t,
        )
      : null;

    let records: GedNode[];
    let report: ChangeReport;
    let masterRecordCount: number | undefined;
    if (isMerge) {
      const compareDs = compareDataset!;
      const { records: mergedRecords, report: mergeReport } = mergeDecisions(
        masterDataset, compareDs, decisions, matches ?? { individuals: [] }, t, importRequests,
      );
      records = mergedRecords;
      report = editReport ? combineReports(editReport, mergeReport) : mergeReport;
      masterRecordCount = masterDataset.individuals.size + masterDataset.families.size;
    } else {
      records = masterDataset.records;
      report = editReport!;
    }

    // Ensure canonical event order (BIRT → lifespan → DEAT/BURI) for all
    // edited records. Merge-only targets are already sorted inside mergeDecisions;
    // edited records that had no confirmed merge decision are not, so sort them here.
    // Only sort individuals that went through structural edits (date/tag changes via
    // the edit UI) — bulk operations like place rename mutate values in-place and
    // must not silently reorder events that were already in a non-canonical position.
    for (const r of records) {
      if (r.tag === "INDI" && r.xref && changedPersonIds.has(r.xref) && sortEligiblePersonIdsRef.current.has(r.xref)) sortEventsByDate(r);
    }

    setPreview({
      records,
      report,
      title: t("save.preview.title"),
      files: [`${base}.gedmerge.ged`, `${base}.gedmerge.report.txt`],
      downloadLabel: t("save.preview.download"),
      masterRecordCount,
      base,
      editRecordIds,
      isMerge,
    });
  }

  // Feed the live save action + its enabled state to the Ctrl/Cmd+S handler.
  globalShortcutRef.current.save = handleSave;
  globalShortcutRef.current.canSave = !!lastMasterFile && (changedCount > 0 || confirmedCount > 0 || importCount > 0);

  function handleEditDirty(type: "individual" | "family", id: string) {
    if (!masterDataset) return;
    dirty.markDirty(type, id, masterDataset);
    if (type === "individual") sortEligiblePersonIdsRef.current.add(id);
  }

  function handleConfirmSave() {
    if (!preview || !masterDataset) return;

    const usage = masterDataset.chanCreaUsage;
    if (usage.recordChan || usage.recordCrea || usage.eventChan || usage.eventCrea) {
      const changedIds = new Set([
        ...preview.editRecordIds,
        ...Object.keys(preview.report.recordKinds),
      ]);
      const newIds = new Set(
        preview.report.changes.filter((c) => c.newRecord).map((c) => c.recordId),
      );
      const stampNow = new Date();
      stampChanCrea(
        preview.records,
        changedIds,
        newIds,
        usage,
        todayGedcom(stampNow),
        nowGedcomTime(stampNow),
      );
    }

    const text = serializeGedcom(preview.records, {
      eol: masterDataset.eol,
      finalNewline: masterDataset.finalNewline,
    });
    downloadText(`${preview.base}.gedmerge.ged`, text);
    downloadText(`${preview.base}.gedmerge.report.txt`, formatReport(preview.report, "GED Save change report"));

    // The saved file is the new master baseline — refresh the cache so a reload
    // restores the saved state (the confirmed decisions are now baked in and
    // cleared below, so the persisted session debounce will write them away).
    if (persistEnabled) {
      void saveFile("master", {
        fileName: lastMasterFile?.fileName ?? `${preview.base}.ged`,
        blob: new Blob([text]),
        savedAt: Date.now(),
      });
    }

    // The downloaded file is the new master baseline — rebuild the live dataset
    // from the same records so the app reflects exactly what was saved, instead
    // of leaving merged-in fields stuck on stale pre-merge data (mergeDecisions
    // only ever wrote them into a clone for serialization).
    const rebuilt = buildDataset({
      version: masterDataset.version,
      charset: masterDataset.charset,
      records: preview.records,
      warnings: masterDataset.warnings,
      eol: masterDataset.eol,
      finalNewline: masterDataset.finalNewline,
    });
    Object.assign(masterDataset, rebuilt);
    dirty.resetOnSave(masterDataset);
    sortEligiblePersonIdsRef.current = new Set();

    // These confirmed decisions are now baked into the live dataset — clear them
    // so the pending-changes count doesn't still include them. The action always
    // replaces the map (even when nothing was confirmed) so EditView's
    // merge-generation bump remounts event rows and drops their stale
    // "dirty since edit" highlighting.
    dispatch({ type: "confirmedDecisionsCleared" });
    // Imported branches are now baked into the live dataset — clear the requests.
    dispatch({ type: "importBranchesCleared" });
    setSaveToast(t("save.toast", { count: preview.files.length }));
    setPreview(null);
    // The saved file is the new baseline — undo/redo entries refer to a state
    // that no longer exists, so there's nothing left to meaningfully undo into.
    undoRedo.clearAll();
    // The cached master text (written just above) now equals the live dataset,
    // so drop the "dataset is edited" flag and mark the master cached — the
    // debounce (sole master writer) then leaves it alone until the next edit.
    setEditVersion(0);
    masterCachedRef.current = true;
  }

  function handleRemoveFromSave(id: string, kind: "individual" | "family") {
    if (!masterDataset || !preview) return;
    const patches: RecordPatch[] = [];

    if (kind === "individual") {
      const snapshot = dirty.personSnapshots.current.get(id);
      const indi = masterDataset.individuals.get(id);
      if (indi) {
        const beforeIndi = cloneRaw(indi.raw);
        if (dirty.loadedPersonIds.current.has(id) && snapshot) {
          indi.raw.value = snapshot.value;
          indi.raw.children = snapshot.children.map(cloneNode);
          rebuildIndividual(masterDataset, indi);
          patches.push({ type: "individual", id, before: beforeIndi, after: cloneRaw(indi.raw) });
        } else {
          // Snapshot the person's families and all their members: pruning a
          // family that drops below two members unlinks its survivors too.
          const affectedFamilyIds = [...indi.spouseOf, ...indi.childOf];
          const memberIds = new Set<string>();
          for (const famId of affectedFamilyIds) {
            const fam = masterDataset.families.get(famId);
            if (fam) for (const m of [fam.husband, fam.wife, ...fam.children]) if (m && m !== id) memberIds.add(m);
          }
          const before = snapshotRecords(masterDataset, memberIds, affectedFamilyIds);
          removeIndividual(masterDataset, indi);
          patches.push({ type: "individual", id, before: beforeIndi, after: null });
          patches.push(...patchesFromSnapshots(masterDataset, before));
        }
      }
      // Keep snapshot for undo machinery — it is still needed for dirty tracking on undo/redo.
      dirty.removeDirty("individual", id);
    } else {
      const snapshot = dirty.familySnapshots.current.get(id);
      const fam = masterDataset.families.get(id);
      if (fam) {
        const beforeFam = cloneRaw(fam.raw);
        if (dirty.loadedFamilyIds.current.has(id) && snapshot) {
          fam.raw.value = snapshot.value;
          fam.raw.children = snapshot.children.map(cloneNode);
          rebuildFamily(masterDataset, fam);
          patches.push({ type: "family", id, before: beforeFam, after: cloneRaw(fam.raw) });
        } else {
          const memberIds = [fam.husband, fam.wife, ...fam.children].filter(Boolean) as string[];
          const memberBefores = new Map<string, GedNode>();
          for (const indiId of memberIds) {
            const indi = masterDataset.individuals.get(indiId);
            if (indi) memberBefores.set(indiId, cloneRaw(indi.raw));
          }
          removeFamily(masterDataset, fam);
          patches.push({ type: "family", id, before: beforeFam, after: null });
          for (const [indiId, before] of memberBefores) {
            const indi = masterDataset.individuals.get(indiId);
            patches.push({ type: "individual", id: indiId, before, after: indi ? cloneRaw(indi.raw) : null });
          }
        }
      }
      // Keep snapshot for undo machinery — it is still needed for dirty tracking on undo/redo.
      dirty.removeDirty("family", id);
    }

    if (patches.length > 0) {
      undoRedo.push({ mode: "edit", patches, navigateTo: id });
      bumpEdit();
    }

    setPreview((prev) => {
      if (!prev) return null;
      const newReport = removeRecordFromReport(prev.report, id);
      if (newReport.changes.length === 0) return null;
      const newEditRecordIds = new Set(prev.editRecordIds);
      newEditRecordIds.delete(id);
      return { ...prev, report: newReport, editRecordIds: newEditRecordIds };
    });
  }

  // Modals (legal / shortcuts) and the page footer are shared between the main
  // app shell and the full-page tree views, so they're built once here. The
  // User's Guide is the standalone /guide page (opened from the footer), not an
  // in-app modal.
  const appModals = (
    <>
      <LegalModal isOpen={legalOpen} onClose={closeLegal} page={legalPage} />
      <ShortcutsModal isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />
      <GlobalSearchModal
        isOpen={showGlobalSearch}
        onClose={() => setShowGlobalSearch(false)}
        rows={searchRows}
        onOpen={openSearchResult}
        filterContext={searchFilterContext}
        metaOf={searchMetaOf}
        startId={startId}
        hasDecisions={decisions.size > 0}
      />
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        themeMode={themeMode}
        onThemeMode={changeThemeMode}
        onClearCache={() => { setShowSettings(false); void handleClearCache(); }}
      />
      {confirmDialogElement}
    </>
  );

  const appFooter = (
    <footer className="app-footer">
      <a href="https://luka.renko.fyi" target="_blank" rel="noopener noreferrer">
        © 2026 Luka Renko
      </a>
      <span className="app-footer-sep">·</span>
      <a
        href={i18n.language === "sl" ? "navodila/" : "guide/"}
        className="app-footer-link"
        target="_blank"
        rel="noopener noreferrer"
      >
        {t("help.title")}
      </a>
      <span className="app-footer-sep">·</span>
      <button className="app-footer-link" onClick={() => setShowShortcuts(true)}>
        {t("shortcuts.title")}
      </button>
      <span className="app-footer-sep">·</span>
      <button
        className="app-footer-link"
        onClick={() => openLegal("privacy")}
      >
        {t("footer.privacy")}
      </button>
      <span className="app-footer-sep">·</span>
      <button
        className="app-footer-link"
        onClick={() => openLegal("terms")}
      >
        {t("footer.terms")}
      </button>
      <span className="app-footer-sep">·</span>
      <a href="mailto:support@gedmerge.com">{t("footer.contact")}</a>
    </footer>
  );

  // Full-page tree views (Compare / Edit) keep the app brand title and footer
  // around the tree so the page never feels detached from the rest of the app.
  const wrapTree = (content: React.ReactNode) => (
    <div className="app tree-shell">
      <header className="app-head tree-shell-head">
        <div className="app-head-top">
          <div className="app-head-brand">
            <h1 onClick={handleTitleClick} className="brand-clickable">
              <Wordmark />
            </h1>
            {(lastMasterFile || compare.status === "loaded") && (
              <div className="app-head-file-pills">
                {lastMasterFile && (
                  <button className="header-file-btn gm-file master" onClick={() => window.history.back()} title={`${t("tree.master")}: ${lastMasterFile.fileName}`}>
                    {lastMasterFile.fileName}
                  </button>
                )}
                {compare.status === "loaded" && (
                  <button className="header-file-btn gm-file incoming" onClick={() => window.history.back()} title={`${t("tree.incoming")}: ${compare.file.fileName}`}>
                    {compare.file.fileName}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="lang-switcher">
            <button
              className="nav-btn icon-only"
              onClick={() => setShowGlobalSearch(true)}
              title={t("globalSearch.tooltip")}
              aria-label={t("globalSearch.title")}
            >
              <SearchIcon size={18} />
            </button>
            <button
              className="nav-btn icon-only"
              onClick={() => setShowSettings(true)}
              title={t("settings.title")}
              aria-label={t("settings.title")}
            >
              <GearIcon size={18} />
            </button>
          </div>
        </div>
      </header>
      {content}
      {appFooter}
      {appModals}
    </div>
  );

  // Full-page tree views (Compare / Edit) render as an overlay on top of the
  // still-mounted main app (hidden via display:none below) rather than replacing
  // it. Keeping Edit/Merge mounted preserves their scroll position when the user
  // returns — important on mobile, where the page is a single tall scroll.
  let treeOverlay: React.ReactNode = null;
  if (treeView && masterDataset && compareDataset && matches) {
    treeOverlay = wrapTree(
      <CompareTree
        masterDs={masterDataset}
        compareDs={compareDataset}
        matches={matches}
        rootMasterId={treeView.masterId}
        rootCompareId={treeView.compareId}
        mode={treeView.mode}
        onModeChange={changeTreeMode}
        onReroot={rerootTree}
        onBack={() => window.history.back()}
        onShowInMatches={showInMatches}
        decisions={decisions}
        changedPersonIds={changedPersonIds}
        onDecide={setPairStatus}
        importBranches={importBranches}
        onToggleImport={toggleImportBranch}
        startId={startId}
      />
    );
  } else if (editTreeId && masterDataset) {
    treeOverlay = wrapTree(
      <EditTree
        masterDs={masterDataset}
        rootId={editTreeId}
        startId={startId}
        changedPersonIds={changedPersonIds}
        decisions={decisions}
        onBack={() => window.history.back()}
      />
    );
  } else if (relTargetId && masterDataset && startId) {
    treeOverlay = wrapTree(
      <RelationshipChart
        masterDs={masterDataset}
        startId={startId}
        targetId={relTargetId}
        onBack={() => window.history.back()}
        onNavigate={(id) => {
          window.history.back(); // close the chart overlay
          setNavigateToId(id);
        }}
      />
    );
  }

  // Panel is forced open whenever Merge mode has no matches yet; otherwise
  // follows the user's showInfoPanel toggle.
  const infoPanelOpen = showInfoPanel || (mode === "merge" && !matches);
  const canClosePanel = !(mode === "merge" && !matches);
  // Show the incoming column in the panel when in Merge mode or a file was loaded.
  const showCompareInPanel = mode === "merge" || compare.status !== "empty";

  function toggleInfoPanel() {
    if (canClosePanel) setShowInfoPanel((p) => !p);
  }

  return (
    <>
    <PwaReloadPrompt />
    {treeOverlay}
    <AutoMediaOffer master={master} />
    <div className="app" style={treeOverlay ? { display: "none" } : undefined}>
      {showMobileWarning && (
        <div className="mobile-warning">
          <span>{t("app.mobileWarning")}</span>
          <button onClick={dismissMobileWarning} title={t("help.close")}>✕</button>
        </div>
      )}
      <header className="app-head">
        <div className="app-head-top">
          <div className="app-head-brand">
            <h1 onClick={handleTitleClick} className="brand-clickable">
              <Wordmark />
            </h1>
            {(lastMasterFile || compare.status === "loaded") && (
              <div className="app-head-file-pills">
                {lastMasterFile && (
                  <button className="header-file-btn gm-file master" onClick={toggleInfoPanel} title={`${t("tree.master")}: ${lastMasterFile.fileName}`}>
                    {lastMasterFile.fileName}
                  </button>
                )}
                {compare.status === "loaded" && (
                  <button className="header-file-btn gm-file incoming" onClick={toggleInfoPanel} title={`${t("tree.incoming")}: ${compare.file.fileName}`}>
                    {compare.file.fileName}
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="lang-switcher">
            {masterDataset && (
              <button
                className="nav-btn icon-only"
                onClick={() => setShowGlobalSearch(true)}
                title={t("globalSearch.tooltip")}
                aria-label={t("globalSearch.title")}
              >
                <SearchIcon size={18} />
              </button>
            )}
            <button
              className="nav-btn icon-only"
              onClick={() => setShowSettings(true)}
              title={t("settings.title")}
              aria-label={t("settings.title")}
            >
              <GearIcon size={18} />
            </button>
          </div>
        </div>
        {masterDataset && (
          <div className="app-head-controls">
            <StartPersonSelector
              individuals={masterDataset.individuals}
              startId={startId}
              onChange={changeStart}
              onClear={() => changeStart(undefined)}
              onStartClick={goToStartPerson}
              autoFocus={focusStart}
              onAutoFocused={() => setFocusStart(false)}
            />
            <div className="app-head-actions">
              {lastMasterFile && (changedCount > 0 || confirmedCount > 0 || importCount > 0) && (
                <button
                  className="export-btn"
                  onClick={handleSave}
                  title={t("save.gedcom.tooltip")}
                >
                  <span className="export-btn-label-full">{t("save.gedcom")}</span>
                  <span className="export-btn-label-short">{t("save")}</span>
                  {" "}({new Set([...changedPersonIds, ...changedFamilyIds, ...confirmedMasterIds]).size + importCount})
                </button>
              )}
              {lastMasterFile && (canUndo || canRedo) && (
                <>
                  <button className="tree-open-btn" onClick={handleUndo} disabled={!canUndo} title={t("undo.tooltip")}>
                    ↩ {t("undo")}
                  </button>
                  <button className="tree-open-btn" onClick={handleRedo} disabled={!canRedo} title={t("redo.tooltip")}>
                    {t("redo")} ↪
                  </button>
                </>
              )}
            </div>
            <div className="mode-tabs">
              <button
                className={`seg-btn ${mode === "edit" ? "active" : ""}`}
                onClick={() => { if (mode !== "edit") switchToEdit(); }}
                title={t("mode.edit.tooltip")}
              >
                {t("mode.edit")}
              </button>
              <button
                className={`seg-btn ${mode === "merge" ? "active" : ""}`}
                onClick={() => { if (mode !== "merge") switchToMerge(); }}
                title={t("mode.merge.tooltip")}
              >
                {t("mode.merge")}
              </button>
              <button
                className={`seg-btn ${mode === "tools" ? "active" : ""}`}
                onClick={() => { if (mode !== "tools") switchToTools(); }}
                title={t("mode.tools.tooltip")}
              >
                {t("mode.tools")}
              </button>
            </div>
          </div>
        )}
      </header>

      {/* File info panel — forced open in Merge before matches; toggleable otherwise */}
      {infoPanelOpen && lastMasterFile && (
        <div className="info-panel">
          {canClosePanel && (
            <button
              className="nav-btn icon-only info-panel-close"
              onClick={() => setShowInfoPanel(false)}
              title={t("help.close")}
            >
              ✕
            </button>
          )}
          <div className={showCompareInPanel ? "info-panel-cols" : "info-panel-single"}>
            <GedcomLoader
              title={t("load.master")}
              state={master}
              onLoad={(f) => loadFile("master", f)}
              accent="master"
            />
            {showCompareInPanel && (
              <div className="loader-with-samples">
                <GedcomLoader
                  title={t("load.incoming")}
                  state={compare}
                  onLoad={(f) => loadFile("compare", f)}
                  accent="incoming"
                  highlight={compare.status === "empty"}
                  tooltip={compare.status === "empty" ? t("load.incoming.tooltip") : undefined}
                  description={t("merge.intro.incomingHint")}
                />
                {compare.status === "empty" && (
                  <div className="sample-links">
                    <span className="sample-links-label">{t("intro.tryDemo")}</span>
                    {SAMPLE_FILES.map(({ file, key }) => (
                      <button key={file} className="sample-link" onClick={() => loadSample("compare", file)}>
                        {t(`landing.samples.${key}.name`)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {matching && (
            <div className="matching" role="status" aria-live="polite" style={{ marginTop: "12px" }}>
              <span className="spinner" aria-hidden="true" />
              {t("matches.calculating")}
            </div>
          )}
        </div>
      )}

      {/* Master landing — shown before any master file has ever loaded; once one
          has, reloads/errors stay on this page (in the info panel above) instead
          of bouncing back here. */}
      {!lastMasterFile && (
        <Landing
          masterState={master}
          onLoadFile={(f) => loadFile("master", f)}
          onLoadSample={(fileName) => loadSample("master", fileName)}
        />
      )}

      {/* Both modes stay mounted once the master is loaded — toggling visibility
          instead of conditionally rendering avoids re-mounting the (unvirtualized)
          match list from scratch on every Edit<->Merge switch, which was very
          noticeable with thousands of matches. The wrapper must reproduce the
          flex sizing `.edit-view`/`.main-split` expect from their parent (a
          `flex: 1 1 0; min-height: 0` column child of `.app`) — a plain
          `hidden` div would collapse to auto height and break the layout. */}
      {lastMasterFile && masterDataset && (
        <>
          <div style={mode === "merge" ? modeLayerStyle : modeLayerHiddenStyle}>
            <MergeView
              matches={matches}
              sort={sort}
              onToggleSort={toggleSort}
              filters={filters}
              setFilters={handleFilters}
              visible={visible}
              visibleIndex={visibleIndex}
              allSortedIndex={allSortedIndex}
              allSortedCount={allSorted.length}
              onSelectPrev={onSelectPrev}
              onSelectNext={onSelectNext}
              onSelect={select}
              decisions={decisions}
              showFilters={showFilters}
              setShowFilters={setShowFilters}
              startId={startId}
              masterDataset={masterDataset}
              openMatches={openMatches}
              setOpenMatches={setOpenMatches}
              current={current}
              compareDataset={compareDataset}
              onUpdateDecision={updateDecision}
              onOpenTree={openTree}
              canNavigatePerson={canNavigatePerson}
              onNavigatePerson={navigatePerson}
              compareRef={compareRef}
              active={mode === "merge"}
            />
          </div>
          <div style={mode === "edit" ? modeLayerStyle : modeLayerHiddenStyle}>
            <EditView
              dataset={masterDataset}
              fileName={lastMasterFile.fileName}
              startId={startId}
              changeStart={changeStart}
              onDirty={handleEditDirty}
              onShowTree={(id) => openEditTree(id)}
              onShowRelationship={(id) => openRelationship(id)}
              marriedNameTag={lastMasterFile.marriedNameTag}
              navigateToId={navigateToId}
              onNavigated={() => setNavigateToId(undefined)}
              onPersonChange={setEditPersonId}
              matchCompareIdFor={matches ? (id) => indexByMaster.get(id)?.compareId : undefined}
              matchOrder={matches ? visibleMasterOrder : undefined}
              decisions={decisions}
              changedPersonIds={changedPersonIds}
              compareDataset={compareDataset}
              onUpdateDecision={updateDecisionForKey}
              onPushEdit={handlePushEdit}
              onPatchApplied={handlePatchApplied}
              pendingApply={pendingEditApply}
              onApplied={() => setPendingEditApply(null)}
              active={mode === "edit"}
            />
          </div>
          <div style={mode === "tools" ? modeLayerStyle : modeLayerHiddenStyle}>
            <ToolsView
              dataset={masterDataset}
              fileName={lastMasterFile.fileName}
              onNavigate={(id) => {
                // Tag the current entry as Tools and push an Edit entry, so the
                // browser Back button returns to the Tools tab we came from.
                window.history.replaceState({ ...window.history.state, gedMode: "tools" }, "");
                window.history.pushState({ gedMode: "edit", gedNavigateTo: id }, "");
                setNavigateToId(id);
                setMode("edit");
              }}
              active={mode === "tools"}
              onApplyPlaceRename={(from, to, scope) => {
                if (!masterDataset) return;
                const patches = applyPlaceRename(masterDataset, from, to, scope);
                if (patches.length > 0) {
                  handlePushEdit(patches);
                  for (const p of patches) {
                    if (p.type !== "record") dirty.markDirty(p.type, p.id, masterDataset);
                  }
                }
              }}
              onFixBrokenLinks={() => {
                if (!masterDataset) return 0;
                const patches = fixBrokenLinks(masterDataset);
                if (patches.length > 0) {
                  handlePushEdit(patches);
                  for (const p of patches) {
                    if (p.type !== "record") dirty.markDirty(p.type, p.id, masterDataset);
                  }
                }
                return patches.length;
              }}
              onFixSexFromRole={() => {
                if (!masterDataset) return 0;
                const patches = fixSexFromRole(masterDataset);
                if (patches.length > 0) {
                  handlePushEdit(patches);
                  for (const p of patches) {
                    if (p.type !== "record") dirty.markDirty(p.type, p.id, masterDataset);
                  }
                }
                return patches.length;
              }}
              onFixDates={() => {
                if (!masterDataset) return 0;
                const patches = fixDates(masterDataset);
                if (patches.length > 0) {
                  handlePushEdit(patches);
                  for (const p of patches) {
                    if (p.type !== "record") dirty.markDirty(p.type, p.id, masterDataset);
                  }
                }
                return patches.length;
              }}
              onFixDuplicatePointers={() => {
                if (!masterDataset) return 0;
                const patches = fixDuplicatePointers(masterDataset);
                if (patches.length > 0) {
                  handlePushEdit(patches);
                  for (const p of patches) {
                    if (p.type !== "record") dirty.markDirty(p.type, p.id, masterDataset);
                  }
                }
                return patches.length;
              }}
              onMergeDuplicate={(survivorId, removedId, decision) => {
                if (!masterDataset) return false;
                const patches = mergeDuplicate(masterDataset, survivorId, removedId, decision, t);
                if (patches.length === 0) return false;
                handlePushEdit(patches);
                for (const p of patches) {
                  if (p.type !== "record") dirty.markDirty(p.type, p.id, masterDataset);
                }
                return true;
              }}
            />
          </div>
        </>
      )}
      {preview && (
        <SaveDialog
          report={preview.report}
          title={preview.title}
          files={preview.files}
          downloadLabel={preview.downloadLabel}
          masterRecordCount={preview.masterRecordCount}
          editRecordIds={preview.editRecordIds}
          dataset={masterDataset}
          onConfirm={handleConfirmSave}
          onClose={() => setPreview(null)}
          onNavigate={(id) => { setPreview(null); setNavigateToId(id); }}
          onRemove={handleRemoveFromSave}
        />
      )}
      {saveToast && (
        <div className="save-toast" role="status" onClick={() => setSaveToast(null)}>
          {saveToast}
        </div>
      )}
      {appFooter}
      {appModals}
    </div>
    </>
  );
}

export function App() {
  return (
    <SettingsProvider>
      <ChartSettingsProvider>
        <MediaFolderProvider>
          <PhotoViewerProvider>
            <AppContent />
          </PhotoViewerProvider>
        </MediaFolderProvider>
      </ChartSettingsProvider>
    </SettingsProvider>
  );
}

export type { SlotState };

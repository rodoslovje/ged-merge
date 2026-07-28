import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { type RecordPatch, type PendingEditApply, cloneRaw, snapshotRecords, patchesFromSnapshots } from "./ui/historyTypes";
import { useUndoRedo } from "./edit-state/useUndoRedo";
import { useTheme } from "./ui/useTheme";
import { useMode } from "./ui/useMode";
import { useAppHistory } from "./ui/useAppHistory";
import { useLegalModal } from "./ui/useLegalModal";
import { useMatchList } from "./ui/useMatchList";
import { useMobileWarning } from "./ui/useMobileWarning";
import { useGedcomWorker } from "./ui/useGedcomWorker";
import { useAutoDismissToast } from "./ui/useAutoDismissToast";
import { initialWorkspace, workspaceReducer, type SlotState } from "./state/workspace";
import { loadedFileFromParsed } from "./state/loadedFile";
import { useDirtyTracking } from "./edit-state/useDirtyTracking";
import { useTranslation } from "react-i18next";
import type { Dataset, GedNode } from "./gedcom/types";
import { cloneNode, nodeFingerprint } from "./gedcom/node";
import { buildDataset } from "./gedcom/builder";
import { rebuildIndividual, rebuildFamily, removeIndividual, removeFamily } from "./gedcom/edit";
import { downloadOptions, ensureUtf8Charset, serializeGedcom } from "./gedcom/serialize";
import { formatReport, type ImportBranchRequest } from "./merge/merge";
import { buildEditSaveRecords } from "./merge/editSaveRecords";
import { buildSavePreview, type SavePreview } from "./save/buildSavePreview";
import { removeRecordFromReport } from "./gedcom/editReport";
import { defaultStartId } from "./match/relatives";
import type { DatasetRole, WorkerRequest, WorkerResponse } from "./worker/messages";
import { decisionKey, importKey, parseDecisionKey, parseImportKey, type CandidateDecision, type ImportDirection, type MatchDecisionStatus } from "./review/types";
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
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { ErrorFallback } from "./ui/ErrorFallback";
import { applyPlaceRename } from "./tools/placeEdit";
import { applyGeocode, movePlaceForAddresses, renamePlaceValue } from "./tools/geocode";
import { applyAddressCoords } from "./tools/addresses";
import { fixBrokenLinks } from "./tools/fixLinks";
import { fixSexFromRole } from "./tools/fixSex";
import { fixDates } from "./tools/fixDates";
import { fixDuplicatePointers } from "./tools/fixDuplicatePointers";
import { fillPlaceCoordsFromFile } from "./tools/placeCoords";
import { mergeDuplicate } from "./tools/mergeDuplicate";
import { duplicatePairKey, parseDuplicatePairKey } from "./tools/duplicates";
import { SaveDialog } from "./ui/SaveDialog";
import { useConfirmDialog } from "./ui/useConfirmDialog";
import { ChartsHub } from "./ui/ChartsHub";
import { Landing } from "./ui/Landing";
import { AppFooter } from "./ui/AppFooter";
import { PwaReloadPrompt } from "./ui/PwaReloadPrompt";
import { Wordmark } from "./ui/icons/LogoMark";
import { GearIcon } from "./ui/icons/GearIcon";
import { ChartIcon } from "./ui/icons/ChartIcon";
import { MediaFolderProvider } from "./ui/MediaFolderContext";
import { saveFile, deleteFile } from "./persist/idb";
import { hashFile } from "./persist/fingerprint";
import { useWorkspacePersistence } from "./persist/useWorkspacePersistence";
import { ChartSettingsProvider, useChartSettings } from "./ui/ChartSettingsContext";
import { SettingsProvider, useSettings, useNameOf } from "./ui/SettingsContext";
import { GlobalSearchModal, type OpenHow, type SearchRowMeta } from "./ui/GlobalSearchModal";
import { buildSearchRows, type FilterContext } from "./ui/globalSearch";
import { SearchIcon } from "./ui/icons/SearchIcon";
import { AddPersonIcon } from "./ui/icons/AddPersonIcon";
import { NEW_FILE_BASENAME, newGedcomText } from "./gedcom/newFile";
import { kinshipInfo, lineageClass } from "./match/kinship";
import { computeDistances } from "./match/distance";
import { xrefLabel } from "./gedcom/nameDisplay";
import { MediaViewerProvider } from "./ui/MediaViewer";
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  nextSort,
  visibleCandidates,
  type Filters,
  type SortKey,
  type SortState,
} from "./ui/matchView";

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
// Class rather than an inline style so the phone layout can release the
// `flex: 1 1 0` cap — on a narrow screen the shell scrolls as one document and
// this layer has to grow with its content, not sit at the shell's height.
// See `.mode-layer` in index.css.
const modeLayerClass = "mode-layer";
const modeLayerHiddenClass = "mode-layer mode-layer--hidden";

// MediaFolderProvider is mounted by the `App` wrapper below, *above* the
// full-page tree early-returns — so navigating into the Compare/Edit tree and
// back doesn't unmount it. In Firefox the picked folder is an in-memory
// Map<string,File> that can't be persisted to IndexedDB, so a remount there
// would silently lose it and force the user to re-pick the folder.
function AppContent() {
  const { t } = useTranslation();
  const { settings } = useSettings();
  // Chart kind (tree / fan / … / relationship) — read to route chart deep-links,
  // set when an entry point asks for a specific diagram.
  const { settings: chartSettings, setKind: setChartKind } = useChartSettings();
  const nameOf = useNameOf();
  // Whether we've already attempted the one-time default start person for the
  // currently loaded main, so a user who clears it isn't re-defaulted.
  const autoStartRef = useRef(false);
  // Timestamp the "matching" spinner started, and the pending timer delaying
  // its "matched" result — see MIN_MATCHING_DISPLAY_MS below.
  const matchingStartRef = useRef<number | null>(null);
  const matchedTimerRef = useRef<number | null>(null);
  // The shared workspace store (reducer) — the whole data pipeline: file slots,
  // match result, merge decisions, import branches, rejected duplicates, start
  // person. Purely-UI-local state (selection, modals, sort/filters, navigation)
  // stays in useState below by design — see state/workspace.ts. `lastMainFile`
  // is the most recently *successfully* loaded main, kept while a reload is in
  // progress so the Merge/Edit views stay mounted (showing the previous data)
  // instead of flashing the landing page while `main` is transiently "loading"
  // or "error".
  const [workspace, dispatch] = useReducer(workspaceReducer, initialWorkspace);
  // decisions/importBranches live in the workspace store too; the destructured
  // values keep every read site (and the sync refs below) unchanged.
  const { main, compare, lastMainFile, mainLoadGen, matches, matching, decisions, importBranches, rejectedDuplicates, startId } = workspace;
  const mainDataset = lastMainFile?.dataset;
  const compareDataset = compare.status === "loaded" ? compare.file.dataset : undefined;
  // When the first matches arrive with no start person, focus the picker so the
  // user can start typing immediately.
  const [focusStart, setFocusStart] = useState(false);
  // Keeps current decisions accessible from stable useCallback closures.
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;
  // Same for the live main dataset (stable identity per load, but needed from
  // []-dep callbacks like setPairStatus).
  const mainDatasetRef = useRef(mainDataset);
  mainDatasetRef.current = mainDataset;

  /** Stamp a decision being set to confirmed with the main person's current
   *  record fingerprint, so the save preview can warn when Edit-mode changes
   *  land on that person after the confirmation (the field choices were made
   *  against values that may no longer exist). */
  function stampMainFp(next: CandidateDecision, mainId: string): CandidateDecision {
    if (next.status !== "confirmed") return next;
    const raw = mainDatasetRef.current?.individuals.get(mainId)?.raw;
    return raw ? { ...next, mainFp: nodeFingerprint(raw) } : next;
  }

  // Opt-in "graft this whole incoming branch on save" selections, made from the
  // compare tree. Each entry is an `importKey(direction, incomingId)`. Kept
  // outside `decisions` because it's a bulk-add, not a per-candidate decision.
  const importBranchesRef = useRef(importBranches);
  importBranchesRef.current = importBranches;
  // Bumps on every dataset-mutating edit (and undo/redo of one). Drives the
  // persistence debounce and, when > 0, signals the dataset differs from the
  // originally-loaded file so the *edited* serialization must be cached.
  const [editVersion, setEditVersion] = useState(0);
  // Same counter as a synchronously-updated ref, for consumers that must see
  // the bump in the tick the mutation happens (the tools worker's dataset
  // cache re-validates against just-fixed data before React re-renders).
  const editVersionRef = useRef(0);
  const bumpEdit = useCallback(() => {
    editVersionRef.current += 1;
    setEditVersion((v) => v + 1);
  }, []);

  // ── Unified undo/redo (edit + merge in one stack) ─────────────────────────
  const undoRedo = useUndoRedo();
  const { canUndo, canRedo } = undoRedo;
  // ── Edit-mode dirty tracking (changed ids, pre-edit snapshots) ─────────────
  const dirty = useDirtyTracking();
  const { changedPersonIds, changedFamilyIds, changedRecordIds } = dirty;
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
  const [selectedId, setSelectedId] = useState<{ mainId: string; compareId: string } | null>(null);
  const [showFilters, setShowFilters] = useState(true);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  // Outstanding "create a new, unattached person" request handed to Edit mode —
  // see EditView's `addPersonRequest`. The nonce only grows, so each request is
  // acted on exactly once even when the same name is asked for twice.
  const [addPersonRequest, setAddPersonRequest] = useState<{ nonce: number; name?: string }>();
  // The pending save dialog's payload — see `SavePreview` for the field docs.
  const [preview, setPreview] = useState<SavePreview | null>(null);
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

  // App-styled confirmation dialog as a promise (`confirmDialog(...)`), in a hook.
  const { confirmDialog, confirmDialogElement } = useConfirmDialog();

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
          const restored = persistence.pendingSessionRef.current;
          if (restored) {
            persistence.pendingSessionRef.current = null;
            if (restored.decisions.length) dispatch({ type: "decisionsSet", decisions: new Map(restored.decisions) });
            if (restored.importBranches.length) dispatch({ type: "importBranchesSet", branches: new Set(restored.importBranches) });
          }
          persistence.hydratedRef.current = true; // restore settled — persistence may resume
        };
        // matchDatasets can finish in under a millisecond once the engine is
        // JIT-warm (e.g. re-matching on a main reload), too fast for React to
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
        const file = loadedFileFromParsed(msg);
        // slotLoaded also records lastMainFile when role is "main".
        dispatch({ type: "slotLoaded", role: msg.role, file });
        if (msg.role === "main") {
          // Restore the cached start person as soon as the main is parsed —
          // matching (and `applyMatched`) only runs once a compare is also
          // loaded, so a main-only workspace would otherwise never restore it.
          // Only restore a start person that still exists in this main — a
          // stale id (e.g. cached against a different file) would leave the
          // views pointing at a person that isn't there ("no individuals").
          const restoredStart = persistence.pendingSessionRef.current?.startId;
          if (restoredStart && file.dataset.individuals.has(restoredStart)) {
            changeStart(restoredStart);
          } else {
            // No valid cached start person → let the default one apply (hydration
            // suppressed it in anticipation of a restore that isn't coming).
            autoStartRef.current = false;
          }
          // Restore rejected within-file duplicates only if the cached session
          // actually belongs to this same-named main (defence in depth on top of
          // the single-slot cache) and each pair's both records still exist.
          const restoredRejected = persistence.pendingSessionRef.current?.rejectedDuplicates;
          if (restoredRejected?.length && persistence.pendingSessionRef.current?.mainFileName === msg.fileName) {
            const valid = restoredRejected.filter((key) => {
              const pair = parseDuplicatePairKey(key);
              return !!pair && file.dataset.individuals.has(pair.aId) && file.dataset.individuals.has(pair.bId);
            });
            if (valid.length) dispatch({ type: "rejectedDuplicatesSet", pairs: new Set(valid) });
          }
          // Main-only restore (no compare to match): nothing more to wait for.
          if (!persistence.expectCompareRef.current) persistence.hydratedRef.current = true;
        }
      } else {
        dispatch({ type: "slotError", role: msg.role, fileName: msg.fileName, message: msg.message });
        // A file that fails to parse must not stay cached, or every reload would
        // re-load it into an error and never reach the landing page.
        void deleteFile(msg.role);
        // A compare that fails to (re)load leaves no incoming file, but the
        // hydrated undo history may still hold merge entries referencing it —
        // undoing one would resurrect decisions with nothing to merge against.
        if (msg.role === "compare") undoRedo.dropMergeEntries();
        // A failed restore won't reach `matched`/the main branch — unblock
        // persistence so later user-loaded files still get cached.
        persistence.hydratedRef.current = true;
      }
  };
  // The worker itself died (uncaught throw or an undeliverable message): fail
  // whatever was waiting on it, or the slot/matching spinners hang forever
  // with nothing in the UI hinting why.
  const handleWorkerFailure = (message: string) => {
    for (const role of ["main", "compare"] as const) {
      const slot = workspace[role];
      if (slot.status === "loading") {
        dispatch({ type: "slotError", role, fileName: slot.fileName, message });
        // Same as a parse failure: a file whose load crashes the worker must
        // not stay cached, or every reload would crash into it again.
        void deleteFile(role);
      }
    }
    matchingStartRef.current = null;
    dispatch({ type: "matchingStopped" });
    persistence.hydratedRef.current = true; // a failed restore must not block persistence
  };
  // Owns the worker's lifecycle; always dispatches to the latest handler above.
  const { post, reset: resetWorker } = useGedcomWorker(handleWorkerMessage, handleWorkerFailure);

  // Opt-in IndexedDB persistence: startup hydration (re-feeding cached files
  // through the worker), the debounced session/main writer, the enable toggle,
  // and the on-disk external-change checks. Returns the restore-coordination
  // refs the worker handlers above and the load/save flows below share.
  const persistence = useWorkspacePersistence({
    persistEnabled: settings.persistWorkspace,
    workspace, mainDataset, editVersion, dirty, undoRedo,
    sortEligiblePersonIdsRef, post, dispatch, autoStartRef,
    loadFile, confirmDialog, setSaveToast,
  });
  const { persistEnabled, mainHandle, compareHandle } = persistence;

  // On unmount, cancel a pending "hold the spinner" timer so it can't fire a
  // setState after teardown.
  useEffect(() => () => {
    if (matchedTimerRef.current != null) window.clearTimeout(matchedTimerRef.current);
  }, []);

  /** "Start a new file": synthesize an empty GEDCOM and feed it through the
   *  ordinary load path, so nothing downstream has to know it wasn't imported.
   *  Edit mode then offers its empty-state "add the first person" button. */
  function startNewFile() {
    const file = new File([newGedcomText()], `${NEW_FILE_BASENAME}.ged`, { type: "text/plain" });
    void loadFile("main", file);
    setMode("edit");
  }

  async function loadSample(role: DatasetRole, fileName: string) {
    const res = await fetch(`samples/${fileName}`);
    const blob = await res.blob();
    loadFile(role, new File([blob], fileName, { type: "text/plain" }));
  }

  async function loadFile(role: DatasetRole, file: File, handle?: FileSystemFileHandle) {
    // A user-initiated load supersedes any in-flight startup restore, so enable
    // session persistence (and stop expecting the cached compare to arrive).
    persistence.userLoadedRef.current = true;
    persistence.hydratedRef.current = true;
    persistence.expectCompareRef.current = false;
    persistence.pendingSessionRef.current = null;
    persistence.pendingEditStateRef.current = null;
    // Also guards a reload triggered by the external-change check below: if
    // there's unsaved work, this asks before discarding it exactly as it would
    // for any other replace.
    if (role === "main" && (changedCount > 0 || confirmedCount > 0 || importCount > 0)) {
      if (!(await confirmDialog(t("load.mainReplaceConfirm"), t("confirm.continue")))) return;
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
    // Fixed at this fresh load — carried unchanged through every later cache
    // write for this file (see the originalHash doc comment on StoredFile).
    const originalHash = await hashFile(file);
    // Cache the compare's raw bytes so a reload restores it (only when opted in).
    // The main is NOT written here — the debounced effect owns the main key
    // (it serializes the live, possibly-edited dataset), so a stale original
    // write can't land after and clobber an edit. A fresh main resets the flag
    // so the next debounce re-caches it.
    if (role === "compare") {
      persistence.compareBlobRef.current = file;
      persistence.setCompareHandle(handle ?? null);
      persistence.compareOriginalHashRef.current = originalHash;
      if (persistence.persistEnabled) void saveFile("compare", { fileName, blob: file, isCsv, savedAt: Date.now(), originalHash, handle });
    } else {
      persistence.mainCachedRef.current = false;
      persistence.setMainHandle(handle ?? null);
      persistence.mainOriginalHashRef.current = originalHash;
    }
    // Drop stale results + decisions; the worker will emit fresh matches once
    // both sides are (re)loaded and re-normalized.
    dispatch({ type: "matchesCleared" });
    dispatch({ type: "decisionsCleared" });
    dispatch({ type: "importBranchesCleared" });
    setPendingEditApply(null);
    setPreview(null);
    setOpenMatches(false);
    if (role === "main") {
      undoRedo.clearAll();
      dirty.prepareForLoad();
      setEditVersion(0); // new file → dataset matches the cached original again
      editVersionRef.current = 0;
      sortEligiblePersonIdsRef.current = new Set();
      setChartsRootId(null);
      dispatch({ type: "setStart", id: undefined }); // start person is opt-in; reset on (re)load
      dispatch({ type: "rejectedDuplicatesCleared" }); // rejects reference this main's xrefs only
      setFocusStart(false);
      autoStartRef.current = false; // allow the default start person for the new file
    } else {
      // Incoming reload: edit entries remain valid (they only touch main data).
      // Drop merge entries whose field comparisons reference the old incoming file.
      undoRedo.dropMergeEntries();
    }
    const buffer = await file.arrayBuffer();
    const newMsg: WorkerRequest = isCsv
      ? { type: "parseCsv", fileName, buffer }
      : { type: "parse", role, fileName, buffer, formatOverrides: settings.formatOverrides };

    // A new file supersedes any match still being computed. The worker can't
    // interrupt its own synchronous scoring pass, so when one is in flight we
    // hard-abort it: tear the worker down (which stops the computation at once)
    // and stand up a fresh one, re-feeding the kept slot so the pipeline restarts
    // cleanly on the new file. When nothing is matching there is nothing to abort,
    // so we keep the existing worker (and its cached datasets) and just re-parse.
    const otherLoaded = role === "main" ? compare.status === "loaded" : main.status === "loaded";
    const keptMain = lastMainFile;
    if (matching && otherLoaded) {
      resetWorker();
      // Always feed main before compare so the compare normalizes against the
      // main's profile.
      if (role === "main") {
        post(newMsg, [buffer]); // new main first
        await refeedCompare(); // kept compare second (re-parsed from its raw bytes)
      } else if (keptMain) {
        // Silent re-feed rebuilds the worker's main without touching the main
        // thread's (possibly edited) main file or the edit tracking bound to it.
        const text = serializeGedcom(keptMain.dataset.records, {
          eol: keptMain.dataset.eol,
          finalNewline: keptMain.dataset.finalNewline,
        });
        const mainBuf = await new Blob([text]).arrayBuffer();
        post(
          { type: "parse", role: "main", fileName: keptMain.fileName, buffer: mainBuf, silent: true, formatOverrides: settings.formatOverrides },
          [mainBuf],
        );
        if (startId) post({ type: "setStart", id: startId }); // restore kinship ranking
        post(newMsg, [buffer]); // new compare last
      }
      return;
    }
    post(newMsg, [buffer]); // transfer ownership — avoids copying large files
  }

  /** Re-parse the currently-loaded compare from its retained raw bytes — used to
   *  restock a freshly-recreated worker after a hard-abort (see loadFile). */
  async function refeedCompare() {
    const blob = persistence.compareBlobRef.current;
    if (!blob || compare.status !== "loaded") return;
    const fileName = compare.file.fileName;
    const isCsv = /\.csv$/i.test(fileName);
    const buffer = await blob.arrayBuffer();
    post(
      isCsv ? { type: "parseCsv", fileName, buffer } : { type: "parse", role: "compare", fileName, buffer },
      [buffer],
    );
  }

  /** Remove the incoming file and go back to working on the main alone. Drops
   *  the match result and any merge decisions/import branches (edits to the main
   *  are untouched), and forgets the cached compare so a reload stays main-only. */
  async function unloadCompare() {
    if (compare.status !== "loaded") return;
    if (confirmedCount > 0 || importCount > 0) {
      if (!(await confirmDialog(t("load.incomingUnloadConfirm"), t("confirm.continue")))) return;
    }
    // A user-initiated unload supersedes any in-flight startup restore of the
    // compare, mirroring loadFile.
    persistence.expectCompareRef.current = false;
    persistence.compareBlobRef.current = null;
    if (persistence.persistEnabled) void deleteFile("compare");
    // Merge entries reference the now-gone incoming file; edits stay valid.
    undoRedo.dropMergeEntries();
    dispatch({ type: "slotCleared", role: "compare" });
    dispatch({ type: "matchesCleared" });
    dispatch({ type: "decisionsCleared" });
    dispatch({ type: "importBranchesCleared" });
    setPendingEditApply(null);
    setPreview(null);
    setOpenMatches(false);
    setSelectedId(null);
    post({ type: "clearCompare" });
  }

  function changeStart(id: string | undefined) {
    dispatch({ type: "setStart", id });
    post({ type: "setStart", id: id ?? "" });
  }

  // Capture the set of IDs that exist at load time so we can later distinguish
  // "modified existing" from "newly added" when reverting via Remove from save.
  useEffect(() => {
    if (main.status !== "loaded") return;
    // Startup restore of an edited workspace: the re-parsed main is the edited
    // serialization, so adopt the cached pre-edit tracking and undo history
    // instead of treating the current (edited) records as the clean baseline.
    const es = persistence.pendingEditStateRef.current;
    let hydrated = false;
    if (es) {
      persistence.pendingEditStateRef.current = null;
      // Defense in depth on top of the SESSION_SCHEMA gate in persist/idb.ts:
      // a cached edit-state whose shape no longer matches the app must never
      // brick startup — fall back to a clean baseline (the cached main text
      // already contains the edits; only their change-tracking is lost).
      try {
        dirty.hydrate(es);
        undoRedo.hydrate(es.undo, es.redo);
        // No cached compare coming → merge entries in the hydrated history
        // reference an incoming file that won't exist. Drop them, or undoing
        // one would resurrect decisions with nothing to merge against.
        if (!persistence.expectCompareRef.current) undoRedo.dropMergeEntries();
        sortEligiblePersonIdsRef.current = new Set(es.sortEligiblePersonIds);
        setEditVersion(1); // mark dataset as edited so further edits keep persisting
        hydrated = true;
      } catch (err) {
        console.warn("Discarding incompatible cached edit state:", err);
        undoRedo.clearAll();
      }
    }
    if (!hydrated) {
      dirty.resetOnLoad(main.file.dataset);
      sortEligiblePersonIdsRef.current = new Set();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main.status]);

  // When the main finishes loading, default the start person to its root
  // individual if present. Attempted once per file (autoStartRef), so a user
  // who later clears the start person isn't overridden.
  useEffect(() => {
    if (main.status !== "loaded" || autoStartRef.current) return;
    autoStartRef.current = true;
    if (startId) return;
    const start = defaultStartId(main.file.dataset);
    if (start) {
      changeStart(start);
    } else {
      setFocusStart(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main.status]);

  // In merge mode, also attempt once when first match results arrive (covers
  // the case where main loaded before the worker finished computing matches).
  useEffect(() => {
    if (!matches || autoStartRef.current) return;
    autoStartRef.current = true;
    if (startId) return;
    const ds = main.status === "loaded" ? main.file.dataset : undefined;
    const start = ds ? defaultStartId(ds) : undefined;
    if (start) {
      changeStart(start);
    } else {
      setFocusStart(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  function toggleSort(key: SortKey) {
    setSort((prev) => nextSort(prev, key));
  }

  // The merge "match list" view-model (ranked/filtered lists, selection, index
  // maps) — pure derivation, extracted to a hook. The stateful setters
  // (sort/filters) and navigation callbacks stay here.
  const { allSorted, visible, visibleMainOrder, current, visibleIndex, indexByMain, indexByCompare } =
    useMatchList({ matches, sort, filters, decisions, selectedId });

  // Refs used by the stable callbacks and the arrow-key effect so they don't
  // need to re-register whenever visible changes.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const visibleIndexRef = useRef(visibleIndex);
  visibleIndexRef.current = visibleIndex;

  const [navigateToId, setNavigateToId] = useState<string | undefined>(undefined);

  // Browser-history/overlay state machine: the full-page overlays (Compare
  // Tree / Charts hub), popstate restoration of mode/selection/navigation, and
  // the unsaved-changes leave guards (history entry + beforeunload).
  const {
    treeView, chartsRootId, setChartsRootId, chartsBackKey,
    overlayOpen, overlayOpenRef, hasUnsavedChangesRef,
    openTree, rerootTree, showInMatches, changeTreeMode, openCharts,
    discardAndReload,
  } = useAppHistory({ confirmDialog, current, mode, setMode, setSelectedId, setNavigateToId, setChartKind });

  const canNavigatePerson = useCallback(
    (side: "main" | "incoming", id: string) =>
      (side === "main" ? indexByMain : indexByCompare).has(id),
    [indexByMain, indexByCompare],
  );


  // Stable identity — uses visibleRef so memoized rows don't re-render on
  // every filter change (only rows whose own props change do).
  const select = useCallback((visIdx: number) => {
    const c = visibleRef.current[visIdx];
    if (!c) return;
    setSelectedId({ mainId: c.mainId, compareId: c.compareId });
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
    if (c) setSelectedId({ mainId: c.mainId, compareId: c.compareId });
  }, []);

  const onSelectNext = useCallback(() => {
    const idx = Math.min(visibleRef.current.length - 1, visibleIndexRef.current + 1);
    const c = visibleRef.current[idx];
    if (c) setSelectedId({ mainId: c.mainId, compareId: c.compareId });
  }, []);

  // Rejecting the selected candidate drops it from the visible list right
  // away — jump to whatever takes its place (the next row, or the new last
  // row if it was the bottom one) so the compare panel doesn't keep showing a
  // person that just disappeared from the list. Uses the pre-rejection
  // visible/index refs, so "its place" means its old position.
  const selectAfterReject = useCallback((mainId: string, compareId: string) => {
    const remaining = visibleRef.current.filter((c) => !(c.mainId === mainId && c.compareId === compareId));
    if (remaining.length === 0) return;
    const idx = Math.min(visibleIndexRef.current, remaining.length - 1);
    const c = remaining[idx];
    if (c) setSelectedId({ mainId: c.mainId, compareId: c.compareId });
  }, []);

  // When filters change: keep current person if they survive the new filter;
  // otherwise jump to the first person in the new filtered list.
  function handleFilters(f: Filters) {
    const newVisible = visibleCandidates(allSorted, f, decisions);
    const currentStillVisible = current
      ? newVisible.some(c => c.mainId === current.mainId && c.compareId === current.compareId)
      : false;
    if (!currentStillVisible && newVisible.length > 0) {
      setSelectedId({ mainId: newVisible[0].mainId, compareId: newVisible[0].compareId });
    }
    setFilters(f);
  }

  // Jump the compare view to a relative's own match row, pushing a history entry
  // so the browser Back button returns to where we were.
  const navigatePerson = useCallback(
    (side: "main" | "incoming", id: string) => {
      const target = (side === "main" ? indexByMain : indexByCompare).get(id);
      if (!target) return;
      if (target.mainId === current?.mainId && target.compareId === current?.compareId) return;
      if (current) window.history.replaceState({ gedSel: { mainId: current.mainId, compareId: current.compareId } }, "");
      window.history.pushState({ gedSel: { mainId: target.mainId, compareId: target.compareId } }, "");
      setSelectedId({ mainId: target.mainId, compareId: target.compareId });
      if (window.innerWidth <= 880) {
        setTimeout(() => { compareRef.current?.scrollIntoView({ behavior: "smooth" }); }, 50);
      }
    },
    [indexByMain, indexByCompare, current],
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
    } else if (entry.mode === "rejectDup") {
      setMode("tools");
      dispatch({ type: "rejectedDuplicatesSet", pairs: entry.before });
    } else {
      setSelectedId({ mainId: entry.mainId, compareId: entry.compareId });
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
    } else if (entry.mode === "rejectDup") {
      setMode("tools");
      dispatch({ type: "rejectedDuplicatesSet", pairs: entry.after });
    } else {
      setSelectedId({ mainId: entry.mainId, compareId: entry.compareId });
      setMode("merge");
      requestAnimationFrame(() => {
        dispatch({ type: "decisionsSet", decisions: entry.after });
      });
    }
  }

  // Stable ref for keyboard handler (recreated each render but registered once).
  const globalShortcutRef = useRef({ undo: handleUndo, redo: handleRedo, save: () => {}, canSave: false, addPerson: () => {} });
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
        return;
      }

      // `N` adds a new, unattached person from any mode — but not from a
      // full-page chart, where the new person would appear behind the overlay
      // with no sign anything happened.
      if (e.key.toLowerCase() === KEY.addPerson && !overlayOpenRef.current) {
        e.preventDefault();
        globalShortcutRef.current.addPerson();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayOpenRef]); // a stable ref — effectively mount-only

  // Switch to Edit, pointing it at whichever candidate Merge currently has
  // selected (so the person carries over instead of Edit staying on whoever
  // it last showed).
  function switchToEdit() {
    if (current) setNavigateToId(current.mainId);
    setMode("edit");
  }

  // Add a person attached to nobody — a new branch, or the first person in a
  // file that has none. The work happens in Edit mode (which owns the person
  // view and the name focus), so switch there and hand the request over.
  function requestAddPerson(name?: string) {
    if (!mainDataset) return;
    setMode("edit");
    setAddPersonRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, name }));
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
    const c = editPersonId ? allSorted.find((c) => c.mainId === editPersonId) : undefined;
    if (c) setSelectedId({ mainId: c.mainId, compareId: c.compareId });
    setMode("merge");
  }

  // Switch to the maintenance Tools tab, which operates on the whole main file.
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
      if (isEditableTarget(e.target) || isModalOpen() || overlayOpenRef.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      const { mode: cur, switchToEdit: se, switchToMerge: sme, switchToTools: st } = modeSwitchRef.current;
      if (key === KEY.modeEdit && cur !== "edit") { e.preventDefault(); se(); }
      else if (key === KEY.modeMerge && cur !== "merge") { e.preventDefault(); sme(); }
      else if (key === KEY.modeTools && cur !== "tools") { e.preventDefault(); st(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [overlayOpenRef]); // a stable ref — effectively mount-only

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
    if (first) setNavigateToId(first.mainId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  function updateDecision(next: CandidateDecision) {
    if (!current) return;
    const key = decisionKey("individual", current.mainId, current.compareId);
    const wasRejected = decisions.get(key)?.status === "rejected";
    const before = new Map(decisions);
    const after = new Map(decisions).set(key, stampMainFp(next, current.mainId));
    undoRedo.push({ mode: "merge", before, after, mainId: current.mainId, compareId: current.compareId });
    dispatch({ type: "decisionsSet", decisions: after });
    if (next.status === "rejected" && !wasRejected) selectAfterReject(current.mainId, current.compareId);
  }

  // Same as `updateDecision`, but for EditView: the person being edited there
  // isn't necessarily Merge's currently selected candidate (`current`) — e.g.
  // after confirming two matches and navigating from one to the other within
  // Edit. EditView already knows which decision it means (it found `key` by
  // matching the decision's own main id against the person on screen), so
  // it passes that key explicitly instead of relying on `current`.
  function updateDecisionForKey(key: string, next: CandidateDecision) {
    const parsed = parseDecisionKey(key);
    if (!parsed) return;
    const { mainId, compareId } = parsed;
    const before = new Map(decisions);
    const after = new Map(decisions).set(key, stampMainFp(next, mainId));
    undoRedo.push({ mode: "merge", before, after, mainId, compareId });
    dispatch({ type: "decisionsSet", decisions: after });
  }

  // Set a pair's status while keeping its field choices; clicking the active
  // status again clears it back to undecided. Used by the compare tree, where a
  // node may be a person that never appeared in the candidate list.
  const setPairStatus = useCallback(
    (mainId: string, compareId: string, status: MatchDecisionStatus) => {
      const key = decisionKey("individual", mainId, compareId);
      const before = decisionsRef.current;
      const cur = before.get(key);
      const nextStatus = cur?.status === status ? "undecided" : status;
      const after = new Map(before).set(key, stampMainFp({ status: nextStatus, fields: cur?.fields ?? {} }, mainId));
      undoRedo.pushRef.current({ mode: "merge", before: new Map(before), after, mainId, compareId });
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

  /** Shared tail of every Tools-tab fix action: record the patch batch as one
   *  undo entry and mark each touched record dirty. Returns the patch count so
   *  callers can report how many records the fix touched. */
  function applyToolPatches(patches: RecordPatch[]): number {
    if (!mainDataset || patches.length === 0) return 0;
    handlePushEdit(patches);
    for (const p of patches) {
      // A shared record edited on its own (no owner card behind it — e.g. the
      // date repair rewriting a SOUR's DATE) is its own dirty subject; with an
      // owner, the owner's patch in the same batch carries the flag.
      if (p.type === "record") { if (!p.owner) dirty.markRecordDirty(p.id); }
      else dirty.markDirty(p.type, p.id, mainDataset);
    }
    return patches.length;
  }

  /** The header Charts trigger: the person the active mode is looking at, or
   *  the start person, or the file's default — so charts are reachable from
   *  every mode without first switching to Edit. */
  function openChartsFromHeader() {
    if (!mainDataset) return;
    const id =
      (mode === "edit" ? editPersonId : mode === "merge" ? selectedId?.mainId : undefined) ??
      startId ??
      defaultStartId(mainDataset);
    if (id) openCharts(id);
  }

  // Whole-file search index for the global search dialog. Rebuilt when the
  // dataset is (re)loaded, edited (editVersion), or the name-display settings
  // change — the same triggers that alter a person's displayed name.
  const searchRows = useMemo(
    () => (mainDataset ? buildSearchRows(mainDataset.individuals, nameOf) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mainDataset, nameOf, editVersion],
  );

  // Main id → its merge decision (confirmed/deferred/rejected), for the global
  // search "decision" facet. Undecided candidates carry no entry.
  const decisionByMain = useMemo(() => {
    const m = new Map<string, MatchDecisionStatus>();
    for (const [key, d] of decisions) {
      if (d.status === "undecided") continue;
      const parsed = parseDecisionKey(key);
      if (!parsed) continue;
      if (!m.has(parsed.mainId)) m.set(parsed.mainId, d.status);
    }
    return m;
  }, [decisions]);

  // Relationship hops from the start person to every reachable individual, for
  // the kinship facet. One BFS, recomputed only when the start person or the
  // dataset (via edits) changes. Empty when no start person is set.
  const kinshipDistances = useMemo(
    () => (startId && mainDataset ? computeDistances(mainDataset, startId) : new Map<string, number>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [startId, mainDataset, editVersion],
  );

  // Cross-cutting lookups the search facets need but that aren't baked into the
  // (dataset-derived) rows: unsaved-edit, merge-decision, and kinship-hop per person.
  const searchFilterContext = useMemo<FilterContext>(
    () => ({
      isEdited: (id) => changedPersonIds.has(id),
      decisionOf: (id) => decisionByMain.get(id),
      kinshipHops: (id) => kinshipDistances.get(id),
    }),
    [changedPersonIds, decisionByMain, kinshipDistances],
  );

  // Per-row record-id / kinship extras for the search results, honouring the
  // "show record ids" and "show kinship" settings. Kinship is computed lazily
  // (only for the ≤50 rendered rows) and cached per person, since a full kinship
  // solve per keystroke over the whole list would be costly on large trees. The
  // cache is keyed to the start person + dataset edits + the kinship setting.
  const kinshipCacheRef = useRef(new Map<string, { label: string; lineageClass: string } | null>());
  useEffect(() => {
    kinshipCacheRef.current = new Map();
  }, [startId, mainDataset, settings.showKinship, editVersion]);
  const searchMetaOf = useCallback(
    (id: string): SearchRowMeta => {
      const meta: SearchRowMeta = {};
      if (settings.showXref) meta.xref = xrefLabel(id);
      if (settings.showKinship && startId && mainDataset && startId !== id) {
        let cached = kinshipCacheRef.current.get(id);
        if (cached === undefined) {
          const info = kinshipInfo(mainDataset, startId, id, t);
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
    [settings.showXref, settings.showKinship, startId, mainDataset, t],
  );

  // Open a person chosen in global search. Routes by context: a match candidate
  // lands in Merge on its pair; anyone else jumps to them in Edit. Shift opens
  // their tree, Alt their relationship-to-start (falling back to Edit when there
  // is no start person to measure from).
  function openSearchResult(id: string, how: OpenHow) {
    // Opened from a chart overlay, plain "open" re-roots the chart on the
    // chosen person instead of invisibly navigating the hidden views beneath.
    if ((chartsRootId || treeView) && how === "open") {
      openCharts(id);
      return;
    }
    // "Tree" reopens the last pedigree chart (tree / grid / fan / circle) — but
    // never the relationship diagram, which has its own action below.
    if (how === "tree") {
      openCharts(id, chartSettings.kind === "relationship" ? "tree" : undefined);
      return;
    }
    if (how === "relationship") {
      // No start person set → the hub's relationship kind prompts for one
      // inline; only relating the start person to themselves falls back to Edit.
      if (startId !== id) openCharts(id, "relationship");
      else { setNavigateToId(id); setMode("edit"); }
      return;
    }
    // Mode-aware "open": staying in Merge only makes sense when Merge is the
    // active mode and the person is a match candidate — then land on their pair.
    // From Edit (or Tools, or for a non-candidate), open the person in Edit so
    // an edit-mode search never yanks the user into Merge.
    const candidate = mode === "merge" ? indexByMain.get(id) : undefined;
    if (candidate) {
      setSelectedId({ mainId: candidate.mainId, compareId: candidate.compareId });
      setMode("merge");
    } else {
      setNavigateToId(id);
      setMode("edit");
    }
  }

  const changedCount = changedPersonIds.size + changedFamilyIds.size + changedRecordIds.size;

  // Called by EditView after undo/redo patches have been applied to the dataset.
  // Delegates to useDirtyTracking which handles all the case logic as pure ops.
  const handlePatchApplied = useCallback(
    (patches: RecordPatch[], direction: "undo" | "redo") => {
      if (!mainDataset) return;
      dirty.onPatchApplied(patches, direction, mainDataset);
      bumpEdit();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mainDataset],
  );

  // Confirmed decisions whose main person still exists — a person deleted in
  // Edit mode after being confirmed can't be merged (mergeDecisions skips it),
  // so it must not count toward the Save badge either. Depends on editVersion:
  // deletions mutate the dataset in place.
  // One pass over the decisions yields both: `count` is confirmed *entries*
  // (what the merge engine will apply, and so what the Save badge reports),
  // `mainIds` the distinct people they touch. These differ only when a main id
  // carries more than one confirmed entry — see `findConfirmedDecision`.
  const { count: confirmedCount, mainIds: confirmedMainIds } = useMemo(() => {
    let count = 0;
    const mainIds = new Set<string>();
    for (const [key, d] of decisions) {
      if (d.status !== "confirmed") continue;
      const parsed = parseDecisionKey(key);
      if (!parsed || !mainDataset?.individuals.has(parsed.mainId)) continue;
      count++;
      mainIds.add(parsed.mainId);
    }
    return { count, mainIds };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisions, mainDataset, editVersion]);

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

  /** An individual whose events the save may reorder — see `buildEditSaveRecords`. */
  function isSortEligible(xref: string) {
    return changedPersonIds.has(xref) && sortEligiblePersonIdsRef.current.has(xref);
  }

  /** Gather the live workspace state `buildSavePreview` reads. Kept as its own
   *  function so the wiring stays readable next to the one-line `handleSave`. */
  function savePreviewInput(mainDs: Dataset, fileName: string) {
    return {
      main: mainDs,
      mainFileName: fileName,
      compare: compareDataset,
      decisions,
      matches,
      importRequests,
      confirmedCount,
      importCount,
      changedPersonIds,
      changedFamilyIds,
      changedRecordIds,
      loadedPersonIds: dirty.loadedPersonIds.current,
      loadedFamilyIds: dirty.loadedFamilyIds.current,
      personSnapshots: dirty.personSnapshots.current,
      familySnapshots: dirty.familySnapshots.current,
      recordSnapshots: dirty.recordSnapshots.current,
      isSortEligible,
      now: new Date(),
      t,
      nameOf,
    };
  }

  function handleSave() {
    if (!mainDataset || main.status !== "loaded") return;
    const next = buildSavePreview(savePreviewInput(mainDataset, main.file.fileName));
    if (next) setPreview(next);
  }

  // Feed the live save action + its enabled state to the Ctrl/Cmd+S handler.
  globalShortcutRef.current.save = handleSave;
  globalShortcutRef.current.canSave = !!lastMainFile && (changedCount > 0 || confirmedCount > 0 || importCount > 0);
  globalShortcutRef.current.addPerson = () => requestAddPerson();

  function handleEditDirty(type: "individual" | "family", id: string) {
    if (!mainDataset) return;
    dirty.markDirty(type, id, mainDataset);
    if (type === "individual") sortEligiblePersonIdsRef.current.add(id);
  }

  function handleConfirmSave() {
    if (!preview || !mainDataset) return;

    const usage = mainDataset.chanCreaUsage;
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

    // The download is always UTF-8 bytes; a header still declaring the source
    // encoding (ANSEL, ANSI, UNICODE, …) would make other software misdecode it.
    ensureUtf8Charset(preview.records, mainDataset);

    const text = serializeGedcom(preview.records, downloadOptions(mainDataset));
    // Reuse the exact names shown in the preview dialog (already date-stamped).
    downloadText(preview.files[0], text);
    downloadText(preview.files[1], formatReport(preview.report, "GED Save change report"));

    // The saved file is the new main baseline — refresh the cache so a reload
    // restores the saved state (the confirmed decisions are now baked in and
    // cleared below, so the persisted session debounce will write them away).
    if (persistEnabled) {
      void saveFile("main", {
        fileName: lastMainFile?.fileName ?? `${preview.base}.ged`,
        blob: new Blob([text]),
        savedAt: Date.now(),
      });
    }

    // The downloaded file is the new main baseline — rebuild the live dataset
    // from the same records so the app reflects exactly what was saved, instead
    // of leaving merged-in fields stuck on stale pre-merge data (mergeDecisions
    // only ever wrote them into a clone for serialization).
    const rebuilt = buildDataset({
      version: mainDataset.version,
      // The saved text declares (and is) UTF-8 — see ensureUtf8Charset above —
      // so the new baseline's charset must agree with it.
      charset: "UTF-8",
      records: preview.records,
      warnings: mainDataset.warnings,
      eol: mainDataset.eol,
      finalNewline: mainDataset.finalNewline,
    });
    Object.assign(mainDataset, rebuilt);
    dirty.resetOnSave(mainDataset);
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
    // The cached main text (written just above) now equals the live dataset,
    // so drop the "dataset is edited" flag and mark the main cached — the
    // debounce (sole main writer) then leaves it alone until the next edit.
    setEditVersion(0);
    editVersionRef.current = 0;
    persistence.mainCachedRef.current = true;
  }

  function handleRemoveFromSave(id: string, kind: "individual" | "family") {
    if (!mainDataset || !preview) return;
    const patches: RecordPatch[] = [];

    if (kind === "individual") {
      const snapshot = dirty.personSnapshots.current.get(id);
      const indi = mainDataset.individuals.get(id);
      if (indi) {
        const beforeIndi = cloneRaw(indi.raw);
        if (dirty.loadedPersonIds.current.has(id) && snapshot) {
          indi.raw.value = snapshot.value;
          indi.raw.children = snapshot.children.map(cloneNode);
          rebuildIndividual(mainDataset, indi);
          patches.push({ type: "individual", id, before: beforeIndi, after: cloneRaw(indi.raw) });
        } else {
          // Snapshot the person's families and all their members: pruning a
          // family that drops below two members unlinks its survivors too.
          const affectedFamilyIds = [...indi.spouseOf, ...indi.childOf];
          const memberIds = new Set<string>();
          for (const famId of affectedFamilyIds) {
            const fam = mainDataset.families.get(famId);
            if (fam) for (const m of [fam.husband, fam.wife, ...fam.children]) if (m && m !== id) memberIds.add(m);
          }
          const before = snapshotRecords(mainDataset, memberIds, affectedFamilyIds);
          const recordIndex = mainDataset.records.findIndex((r) => r.xref === id);
          removeIndividual(mainDataset, indi);
          patches.push({ type: "individual", id, before: beforeIndi, after: null, ...(recordIndex !== -1 && { index: recordIndex }) });
          patches.push(...patchesFromSnapshots(mainDataset, before));
        }
      }
      // Keep snapshot for undo machinery — it is still needed for dirty tracking on undo/redo.
      dirty.removeDirty("individual", id);
    } else {
      const snapshot = dirty.familySnapshots.current.get(id);
      const fam = mainDataset.families.get(id);
      if (fam) {
        const beforeFam = cloneRaw(fam.raw);
        if (dirty.loadedFamilyIds.current.has(id) && snapshot) {
          fam.raw.value = snapshot.value;
          fam.raw.children = snapshot.children.map(cloneNode);
          rebuildFamily(mainDataset, fam);
          patches.push({ type: "family", id, before: beforeFam, after: cloneRaw(fam.raw) });
        } else {
          const memberIds = [fam.husband, fam.wife, ...fam.children].filter(Boolean) as string[];
          const memberBefores = new Map<string, GedNode>();
          for (const indiId of memberIds) {
            const indi = mainDataset.individuals.get(indiId);
            if (indi) memberBefores.set(indiId, cloneRaw(indi.raw));
          }
          const recordIndex = mainDataset.records.findIndex((r) => r.xref === id);
          removeFamily(mainDataset, fam);
          patches.push({ type: "family", id, before: beforeFam, after: null, ...(recordIndex !== -1 && { index: recordIndex }) });
          for (const [indiId, before] of memberBefores) {
            const indi = mainDataset.individuals.get(indiId);
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

    // The revert above mutated the live dataset, not the preview's records (an
    // independent clone) — re-derive them so the download actually drops what
    // the user just removed from the save. `id` is excluded from the event sort:
    // it has been restored to its pre-edit snapshot, so reordering it now would
    // write a change the user just asked to leave out. (`changedPersonIds` still
    // lists it here — `dirty.removeDirty` above only queued a state update.)
    // Built outside the updater below so it runs exactly once.
    const revertedRecords = buildEditSaveRecords(
      mainDataset.records,
      (xref) => xref !== id && isSortEligible(xref),
    );

    setPreview((prev) => {
      if (!prev) return null;
      const newReport = removeRecordFromReport(prev.report, id);
      if (newReport.changes.length === 0) return null;
      const newEditRecordIds = new Set(prev.editRecordIds);
      newEditRecordIds.delete(id);
      // A merge preview is the output of `mergeDecisions` and can't be rebuilt
      // here, so it keeps its records — unchanged from before this clone existed.
      const records = prev.isMerge ? prev.records : revertedRecords;
      return { ...prev, records, report: newReport, editRecordIds: newEditRecordIds };
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
        onCreatePerson={(name) => requestAddPerson(name)}
      />
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        themeMode={themeMode}
        onThemeMode={changeThemeMode}
        onClearCache={() => { setShowSettings(false); void persistence.handleClearCache(); }}
        detectedFormats={lastMainFile?.detectedFormats}
      />
      {confirmDialogElement}
    </>
  );

  const appFooter = <AppFooter onShortcuts={() => setShowShortcuts(true)} onLegal={openLegal} />;

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
            {(lastMainFile || compare.status === "loaded") && (
              <div className="app-head-file-pills">
                {lastMainFile && (
                  <button className="header-file-btn gm-file main" onClick={() => window.history.back()} title={`${t("tree.main")}: ${lastMainFile.fileName}`}>
                    {lastMainFile.fileName}
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
  if (treeView && mainDataset && compareDataset && matches) {
    treeOverlay = wrapTree(
      <CompareTree
        mainDs={mainDataset}
        compareDs={compareDataset}
        matches={matches}
        rootMainId={treeView.mainId}
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
        onOpenCharts={openCharts}
        onOpenInEdit={(id) => {
          window.history.back(); // close the tree overlay
          setNavigateToId(id);
          setMode("edit");
        }}
      />
    );
  } else if (chartsRootId && mainDataset) {
    treeOverlay = wrapTree(
      <ChartsHub
        // Remount when opened on a different person, so the hub's internal
        // root follows a fresh open instead of a stale earlier visit.
        key={chartsRootId}
        mainDs={mainDataset}
        initialRootId={chartsRootId}
        startId={startId}
        changedPersonIds={changedPersonIds}
        decisions={decisions}
        backLabel={t(chartsBackKey)}
        onBack={() => window.history.back()}
        onNavigate={(id) => {
          window.history.back(); // close the chart overlay
          setNavigateToId(id);
          setMode("edit");
        }}
        onPickStart={changeStart}
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
    <AutoMediaOffer main={main} />
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
            {(lastMainFile || compare.status === "loaded") && (
              <div className="app-head-file-pills">
                {lastMainFile && (
                  <button className="header-file-btn gm-file main" onClick={toggleInfoPanel} title={`${t("tree.main")}: ${lastMainFile.fileName} — ${t("header.filePill.hint")}`}>
                    {lastMainFile.fileName}
                    <span className="header-file-caret" aria-hidden="true">{infoPanelOpen ? "▴" : "▾"}</span>
                  </button>
                )}
                {compare.status === "loaded" && (
                  <button className="header-file-btn gm-file incoming" onClick={toggleInfoPanel} title={`${t("tree.incoming")}: ${compare.file.fileName} — ${t("header.filePill.hint")}`}>
                    {compare.file.fileName}
                    <span className="header-file-caret" aria-hidden="true">{infoPanelOpen ? "▴" : "▾"}</span>
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="lang-switcher">
            {mainDataset && (
              <button
                className="nav-btn icon-only"
                onClick={openChartsFromHeader}
                title={t("charts.header.tooltip")}
                aria-label={t("edit.charts.button")}
              >
                <ChartIcon size={18} />
              </button>
            )}
            {mainDataset && (
              <button
                className="nav-btn icon-only"
                onClick={() => setShowGlobalSearch(true)}
                title={t("globalSearch.tooltip")}
                aria-label={t("globalSearch.title")}
              >
                <SearchIcon size={18} />
              </button>
            )}
            {mainDataset && (
              <button
                className="nav-btn icon-only"
                onClick={() => requestAddPerson()}
                title={t("edit.addNewPerson.tooltip")}
                aria-label={t("edit.addNewPerson")}
              >
                <AddPersonIcon size={18} />
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
        {mainDataset && (
          <div className="app-head-controls">
            <StartPersonSelector
              individuals={mainDataset.individuals}
              startId={startId}
              onChange={changeStart}
              onClear={() => changeStart(undefined)}
              onStartClick={goToStartPerson}
              autoFocus={focusStart}
              onAutoFocused={() => setFocusStart(false)}
            />
            <div className="app-head-actions">
              {lastMainFile && (changedCount > 0 || confirmedCount > 0 || importCount > 0) && (
                <button
                  className="export-btn"
                  onClick={handleSave}
                  title={t("save.gedcom.tooltip")}
                >
                  <span className="export-btn-label-full">{t("save.gedcom")}</span>
                  <span className="export-btn-label-short">{t("save")}</span>
                  {" "}({new Set([...changedPersonIds, ...changedFamilyIds, ...changedRecordIds, ...confirmedMainIds]).size + importCount})
                </button>
              )}
              {lastMainFile && (canUndo || canRedo) && (
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
      {infoPanelOpen && lastMainFile && (
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
              title={t("load.main")}
              state={main}
              onLoad={(f, h) => loadFile("main", f, h)}
              accent="main"
              canVerify={!!mainHandle}
              onVerify={() => persistence.verifyNow("main")}
            />
            {showCompareInPanel && (
              <div className="loader-with-samples">
                <GedcomLoader
                  title={t("load.incoming")}
                  state={compare}
                  onLoad={(f, h) => loadFile("compare", f, h)}
                  onUnload={unloadCompare}
                  accent="incoming"
                  highlight={compare.status === "empty"}
                  tooltip={compare.status === "empty" ? t("load.incoming.tooltip") : undefined}
                  description={t("merge.intro.incomingHint")}
                  canVerify={!!compareHandle}
                  onVerify={() => persistence.verifyNow("compare")}
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

      {/* Main landing — shown before any main file has ever loaded; once one
          has, reloads/errors stay on this page (in the info panel above) instead
          of bouncing back here. */}
      {!lastMainFile && (
        <Landing
          mainState={main}
          onLoadFile={(f, h) => loadFile("main", f, h)}
          onLoadSample={(fileName) => loadSample("main", fileName)}
          onStartNew={startNewFile}
        />
      )}

      {/* Both modes stay mounted once the main is loaded — toggling visibility
          instead of conditionally rendering avoids re-mounting the (unvirtualized)
          match list from scratch on every Edit<->Merge switch, which was very
          noticeable with thousands of matches. The wrapper must reproduce the
          flex sizing `.edit-view`/`.main-split` expect from their parent (a
          `flex: 1 1 0; min-height: 0` column child of `.app`) — a plain
          `hidden` div would collapse to auto height and break the layout. */}
      {lastMainFile && mainDataset && (
        <>
          <div className={mode === "merge" ? modeLayerClass : modeLayerHiddenClass}>
            <ErrorBoundary resetKey={mainLoadGen} fallback={(error, reset) => <ErrorFallback error={error} reset={reset} />}>
            <MergeView
              matches={matches}
              sort={sort}
              onToggleSort={toggleSort}
              filters={filters}
              setFilters={handleFilters}
              visible={visible}
              visibleIndex={visibleIndex}
              visibleCount={visible.length}
              onSelectPrev={onSelectPrev}
              onSelectNext={onSelectNext}
              onSelect={select}
              decisions={decisions}
              showFilters={showFilters}
              setShowFilters={setShowFilters}
              startId={startId}
              mainDataset={mainDataset}
              openMatches={openMatches}
              setOpenMatches={setOpenMatches}
              current={current}
              compareDataset={compareDataset}
              onUpdateDecision={updateDecision}
              onOpenTree={openTree}
              canNavigatePerson={canNavigatePerson}
              onNavigatePerson={navigatePerson}
              compareRef={compareRef}
              active={mode === "merge" && !overlayOpen}
            />
            </ErrorBoundary>
          </div>
          <div className={mode === "edit" ? modeLayerClass : modeLayerHiddenClass}>
            <ErrorBoundary resetKey={mainLoadGen} fallback={(error, reset) => <ErrorFallback error={error} reset={reset} />}>
            <EditView
              // Remount on every main (re)load: Edit keeps per-person input
              // state keyed by xref, and a different file can reuse the same
              // xrefs — reusing the mounted tree would show the old file's
              // values (stale name/birth) mixed into the new dataset.
              key={`edit-${mainLoadGen}`}
              dataset={mainDataset}
              fileName={lastMainFile.fileName}
              startId={startId}
              changeStart={changeStart}
              onDirty={handleEditDirty}
              onShowCharts={openCharts}
              marriedNameTag={lastMainFile.marriedNameTag}
              navigateToId={navigateToId}
              onNavigated={() => setNavigateToId(undefined)}
              onPersonChange={setEditPersonId}
              matchCompareIdFor={matches ? (id) => indexByMain.get(id)?.compareId : undefined}
              matchOrder={matches ? visibleMainOrder : undefined}
              decisions={decisions}
              changedPersonIds={changedPersonIds}
              compareDataset={compareDataset}
              onUpdateDecision={updateDecisionForKey}
              onPushEdit={handlePushEdit}
              onPatchApplied={handlePatchApplied}
              pendingApply={pendingEditApply}
              onApplied={() => setPendingEditApply(null)}
              addPersonRequest={addPersonRequest}
              active={mode === "edit" && !overlayOpen}
            />
            </ErrorBoundary>
          </div>
          <div className={mode === "tools" ? modeLayerClass : modeLayerHiddenClass}>
            <ErrorBoundary resetKey={mainLoadGen} fallback={(error, reset) => <ErrorFallback error={error} reset={reset} />}>
            <ToolsView
              // Same remount-on-load rule as EditView: tool results (validation
              // report, duplicate pairs) computed from the previous dataset must
              // not survive into a newly loaded file.
              key={`tools-${mainLoadGen}`}
              dataset={mainDataset}
              editVersionRef={editVersionRef}
              fileName={lastMainFile.fileName}
              onNavigate={(id) => {
                // Tag the current entry as Tools and push an Edit entry, so the
                // browser Back button returns to the Tools tab we came from.
                window.history.replaceState({ ...window.history.state, gedMode: "tools" }, "");
                window.history.pushState({ gedMode: "edit", gedNavigateTo: id }, "");
                setNavigateToId(id);
                setMode("edit");
              }}
              active={mode === "tools"}
              onApplyPlaceRename={(from, to, scope) => { applyToolPatches(applyPlaceRename(mainDataset, from, to, scope)); }}
              onApplyGeocode={(assignments) => applyToolPatches(applyGeocode(mainDataset, assignments))}
              onApplyAddressCoords={(assignments) => applyToolPatches(applyAddressCoords(mainDataset, assignments))}
              onRenamePlaceValue={(from, to, addr) => applyToolPatches(renamePlaceValue(mainDataset, from, to, addr))}
              onMovePlaceForAddresses={(keys, toPlace, coord) => applyToolPatches(movePlaceForAddresses(mainDataset, keys, toPlace, coord))}
              startId={startId}
              onFixBrokenLinks={(only) => applyToolPatches(fixBrokenLinks(mainDataset, only))}
              onFixSexFromRole={() => applyToolPatches(fixSexFromRole(mainDataset))}
              onFixDates={() => applyToolPatches(fixDates(mainDataset))}
              onFixDuplicatePointers={() => applyToolPatches(fixDuplicatePointers(mainDataset))}
              onFillPlaceCoords={() => applyToolPatches(fillPlaceCoordsFromFile(mainDataset))}
              onMergeDuplicate={(survivorId, removedId, decision) =>
                applyToolPatches(mergeDuplicate(mainDataset, survivorId, removedId, decision, t)) > 0}
              rejectedDuplicates={rejectedDuplicates}
              onRejectDuplicate={(aId, bId) => {
                const next = new Set(rejectedDuplicates);
                next.add(duplicatePairKey(aId, bId));
                undoRedo.push({ mode: "rejectDup", before: new Set(rejectedDuplicates), after: next });
                dispatch({ type: "rejectedDuplicatesSet", pairs: next });
              }}
              onRejectDuplicatesBulk={(pairs) => {
                const next = new Set(rejectedDuplicates);
                for (const { aId, bId } of pairs) next.add(duplicatePairKey(aId, bId));
                if (next.size === rejectedDuplicates.size) return;
                undoRedo.push({ mode: "rejectDup", before: new Set(rejectedDuplicates), after: next });
                dispatch({ type: "rejectedDuplicatesSet", pairs: next });
              }}
              onUnrejectDuplicate={(aId, bId) => {
                const next = new Set(rejectedDuplicates);
                next.delete(duplicatePairKey(aId, bId));
                undoRedo.push({ mode: "rejectDup", before: new Set(rejectedDuplicates), after: next });
                dispatch({ type: "rejectedDuplicatesSet", pairs: next });
              }}
            />
            </ErrorBoundary>
          </div>
        </>
      )}
      {preview && (
        <SaveDialog
          report={preview.report}
          title={preview.title}
          files={preview.files}
          downloadLabel={preview.downloadLabel}
          mainRecordCount={preview.mainRecordCount}
          editRecordIds={preview.editRecordIds}
          integrityWarnings={preview.integrityWarnings}
          dataset={mainDataset}
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
      {/* While a full-page overlay is up, its own shell renders the modals —
          mounting them here too would duplicate every dialog in the DOM. */}
      {!treeOverlay && appModals}
    </div>
    </>
  );
}

export function App() {
  return (
    <SettingsProvider>
      <ChartSettingsProvider>
        <MediaFolderProvider>
          <MediaViewerProvider>
            <AppContent />
          </MediaViewerProvider>
        </MediaFolderProvider>
      </ChartSettingsProvider>
    </SettingsProvider>
  );
}

export type { SlotState };

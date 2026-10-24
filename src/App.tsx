import { Notice } from "./ui/Notice";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { type RecordPatch, type PendingEditApply, coalescePatches, dropNoopPatches, markMechanical } from "./ui/historyTypes";
import { cloneNode } from "./gedcom/node";
import { useUndoRedo } from "./edit-state/useUndoRedo";
import { useTheme } from "./ui/useTheme";
import { useMode, type Mode } from "./ui/useMode";
import { ChartTrailContext } from "./ui/ChartTrail";
import { useAppHistory } from "./ui/useAppHistory";
import { useMatchList } from "./ui/useMatchList";
import { useGedcomWorker } from "./ui/useGedcomWorker";
import { useAutoDismissToast } from "./ui/useAutoDismissToast";
import { withBusyCursor } from "./ui/busyCursor";
import { initialWorkspace, workspaceReducer, type SlotState } from "./state/workspace";
import { loadedFileFromParsed } from "./state/loadedFile";
import { useDirtyTracking } from "./edit-state/useDirtyTracking";
import { useTranslation } from "react-i18next";
import type { Dataset, Family, GedNode, Individual } from "./gedcom/types";
import { NOT_GEDCOM } from "./gedcom/parser";
import { isTableFile } from "./csv/compareCsv";
import { clearEventAuditStamps, noteCtx, rebuildNoteReferrers, pruneUnreferencedSource, setSourceRecordFields, setRepoRecordFields, setMediaInfo, bumpSourceCacheVersion, type SharedNoteCtx } from "./gedcom/edit";
import { detectPrivacyStyle, isPrivateNode, setPrivateFlag } from "./gedcom/private";
import { atEscapeFor, serializeGedcom } from "./gedcom/serialize";
import { completeStructure, outputOptions, ownVersion, prepareDownload, type OutputVersion } from "./save/outputFile";
import { formatReport, INDI_HANDLED, mergePlaceFormat, type ImportBranchRequest } from "./merge/merge";
import { branchImportRecords } from "./merge/branchSize";
import { materializeAdds, refreshJoins } from "./merge/materialize";
import { pendingBookLookups } from "./merge/linkPlacement";
import { eventOrderSignature, stampConfirmedDecision } from "./merge/applyFields";
import { individualFieldRows } from "./review/fields";
import { buildSavePreview, type SavePreview } from "./save/buildSavePreview";
import { savedBaseline } from "./save/savedBaseline";
import { canRemoveFromSave, removeFromSave, type RevertTracking } from "./ui/edit/removeFromSave";
import { defaultStartId, lifespanLabel } from "./match/relatives";
import type { MatchResult } from "./match/types";
import { connectScoreDetails, receiveScoreDetail, resetScoreDetails } from "./ui/scoreDetail";
import { datesTooltipOf, lifespanApproxOf } from "./gedcom/lifespan";
import type { DatasetRole, WorkerRequest, WorkerResponse } from "./worker/messages";
import { decisionKey, importKey, parseDecisionKey, parseImportKey, pinnedAdds, toggleDecisionStatus, withFreshDecision, type CandidateDecision, type ImportDirection, type MatchDecisionStatus } from "./review/types";
import { nowGedcomTime, nowUpdStamp, stampChanCrea, todayGedcom } from "./gedcom/chanCrea";
import { baseStem, downloadText } from "./ui/download";
import { AutoMediaOffer, GedcomLoader } from "./ui/GedcomLoader";
import { CompareTree } from "./ui/CompareTree";
import { ShortcutsModal } from "./ui/ShortcutsModal";
import { SettingsModal } from "./ui/SettingsModal";
import { KEY, isModalOpen, isEditableTarget, keyHint, modLabel, modShiftLabel } from "./keyboard/shortcuts";
import { HelpIcon } from "./ui/icons/HelpIcon";
import { MergeView } from "./ui/MergeView";
import { EditView } from "./ui/EditView";
import { ToolsView, type Tool, type ToolView } from "./ui/ToolsView";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { ErrorFallback } from "./ui/ErrorFallback";
import { applyPlaceRename } from "./tools/placeEdit";
import { applyGeocode, clearPlaceCoords, movePlaceForAddresses, renamePlaceValue, renamePlaceValues } from "./tools/geocode";
import { applyAddressCoords, removeAddress, renameAddress } from "./tools/addresses";
import { fixBrokenLinks } from "./tools/fixLinks";
import { fixSexFromRole } from "./tools/fixSex";
import { fixSwappedRoles } from "./tools/fixRoleSwap";
import { fixDates, fixNonStandardDates } from "./tools/fixDates";
import { fixDuplicatePointers } from "./tools/fixDuplicatePointers";
import { fixDuplicateFamilies } from "./tools/fixDuplicateFamilies";
import { fixDanglingRefs } from "./tools/fixDanglingRefs";
import { fixConformance } from "./tools/fixConformance";
import { fillPlaceCoordsFromFile } from "./tools/placeCoords";
import { tagTranslations } from "./tools/fixTranslationLang";
import { setPlaceTranslations } from "./tools/placeTranslations";
import { queueBookPages, readBookPages } from "./tools/sourceReshape";
import { fetchPageHtml } from "./normalize/urlMetadata";
import { createStandaloneSource } from "./ui/edit/standaloneSource";
import { useDateEntrySource } from "./ui/edit/DateEntryContext";
import { mergeDuplicateChain } from "./tools/mergeDuplicate";
import { mergeCluster } from "./tools/mergeCluster";
import { duplicatePairKey, parseDuplicatePairKey } from "./tools/duplicates";
import { SaveDialog } from "./ui/SaveDialog";
import { recordLabeller } from "./ui/recordLabel";
import { charsetNotices } from "./ui/charsetNotice";
import { useConfirmDialog } from "./ui/useConfirmDialog";
import { ChartsHub } from "./ui/ChartsHub";
import { Landing } from "./ui/Landing";
import { AppFooter } from "./ui/AppFooter";
import { PwaReloadPrompt } from "./ui/PwaReloadPrompt";
import { IconTipLayer } from "./ui/IconTip";
import { Wordmark } from "./ui/icons/LogoMark";
import { GearIcon } from "./ui/icons/GearIcon";
import { ChartIcon } from "./ui/icons/ChartIcon";
import { MediaFolderProvider, useMediaFolder } from "./ui/MediaFolderContext";
import { saveFile, deleteFile } from "./persist/idb";
import { LocalLoads, SUPERSEDED } from "./state/localLoad";
import { ChangeJournal, recordsPatch, type SyncMark } from "./state/mainSync";
import { hashFile } from "./persist/fingerprint";
import { useWorkspacePersistence } from "./persist/useWorkspacePersistence";
import { ChartSettingsProvider, useChartSettings } from "./ui/ChartSettingsContext";
import { DatasetProvider, SettingsProvider, useSetSettings, useSettingsSlice, useNameOf } from "./ui/SettingsContext";
import { TargetFormatContext, type TargetFormatValue } from "./ui/TargetFormatContext";
import { MAX_REMEMBERED_TARGETS, proposeTarget, rememberTarget, targetFileKey, targetFormatOverrides, writeTarget, type TargetMode } from "./normalize/target";
import { DatasetDerivationsProvider } from "./ui/DatasetDerivations";
import { onSettingsRequest, type SettingsTab } from "./ui/settingsBus";
import { GlobalSearchModal, type OpenHow, type SearchRowMeta } from "./ui/GlobalSearchModal";
import type { FilterContext } from "./ui/globalSearch";
import { useSearchIndex } from "./ui/useSearchIndex";
import { SearchIcon } from "./ui/icons/SearchIcon";
import { AddPersonIcon } from "./ui/icons/AddPersonIcon";
import { AppMenu, type AppMenuFile } from "./ui/AppMenu";
import { FILES_IN_MENU_QUERY, useCompactHeader, useMediaQuery, usePhone } from "./ui/usePhone";
import { NEW_FILE_BASENAME, newGedcomText, submitterName } from "./gedcom/newFile";
import { kinshipInfo, lineageClass } from "./match/kinship";
import { computeDistances, rankedCandidates } from "./match/distance";
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

/** The preferences AppContent reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const APP_SETTINGS_KEYS = ["persistWorkspace", "formatOverrides", "targetFormats", "targetNoticeHidden", "showKinship", "showXref", "saveReport", "allowLinkFetch", "authorName"] as const;

// MediaFolderProvider is mounted by the `App` wrapper below, *above* the
// full-page tree early-returns — so navigating into the Compare/Edit tree and
// back doesn't unmount it. In Firefox the picked folder is an in-memory
// Map<string,File> that can't be persisted to IndexedDB, so a remount there
// would silently lose it and force the user to re-pick the folder.
function AppContent() {
  const { t } = useTranslation();
  // A handful of fields, not the whole object: this component renders the entire app,
  // so subscribing to every preference meant any one of them changing
  // re-rendered everything.
  const settings = useSettingsSlice(APP_SETTINGS_KEYS);
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
  // The match list as the worker last sent it, in score order: a start-person
  // change arrives as a ranking of this list (see MatchSuccess).
  const matchListRef = useRef<MatchResult | null>(null);
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
  // The main file's target format (Settings → GEDCOM): the choice remembered
  // for it, or — opened for the first time — the one its own habits propose.
  // Every write follows it through `formatOverrides` below, which every
  // writer reads instead of the raw Settings (see TargetFormatContext).
  const setSettings = useSetSettings();
  const targetKey = lastMainFile ? targetFileKey(lastMainFile.fileName) : undefined;
  const targetProposal = useMemo(
    () => (lastMainFile ? proposeTarget(lastMainFile.dataset, lastMainFile.dialect, lastMainFile.detectedFormats) : undefined),
    [lastMainFile],
  );
  const storedTargetMode = targetKey ? settings.targetFormats[targetKey] : undefined;
  const targetMode = storedTargetMode ?? targetProposal?.mode ?? "file";
  const mainVersion = mainDataset?.version;
  const target = useMemo(() => writeTarget(targetMode, { version: mainVersion ?? "unknown" }), [targetMode, mainVersion]);
  const formatOverrides = useMemo(
    () => targetFormatOverrides(settings.formatOverrides, target),
    [settings.formatOverrides, target],
  );
  // Every date field, wherever it sits, writes a typed date in this file's style.
  useDateEntrySource(mainDataset, formatOverrides);
  const compareDataset = compare.status === "loaded" ? compare.file.dataset : undefined;
  // Phone layout: the header's ☰ menu, and whether it is open.
  const phone = usePhone();
  // 720–1100px: Add person, Settings and Help fold into a ☰, so the mode tabs
  // keep their place in the one header row.
  const compactHead = useCompactHeader() && !phone;
  // Below 880px the file pills would be a letter each: they move into the ☰.
  const filesInMenu = useMediaQuery(FILES_IN_MENU_QUERY);
  const [menuOpen, setMenuOpen] = useState(false);
  // The chart's header has a ☰ of its own: the app's stays mounted (hidden)
  // under the chart, and sharing one open flag opened both — the hidden one's
  // outside-click handler then closed the visible one before a click landed.
  const [chartMenuOpen, setChartMenuOpen] = useState(false);
  // Keeps current decisions accessible from stable useCallback closures.
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;
  // Same for the live main dataset (stable identity per load, but needed from
  // []-dep callbacks like setPairStatus).
  const mainDatasetRef = useRef(mainDataset);
  mainDatasetRef.current = mainDataset;
  const compareDatasetRef = useRef(compareDataset);
  compareDatasetRef.current = compareDataset;
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  // `setPairStatus` is a []-dep callback, so it would otherwise stamp snapshots
  // with the language that was active on first render.
  const tRef = useRef(t);
  tRef.current = t;
  // Same for the Settings → GEDCOM overrides: the snapshot's rows must be built
  // with the place format the merge itself will use (see stampMainRows).
  const formatOverridesRef = useRef(formatOverrides);
  formatOverridesRef.current = formatOverrides;

  /**
   * Stamp a decision being set to confirmed with the main side's current value
   * for every field the merge could overwrite, so that on save an "incoming"
   * choice can stand down for any field the user has edited since (see
   * `CandidateDecision.mainFields`).
   *
   * The rows are built exactly as `mergeDecisions` builds them — same dataset
   * pair, same place format (`mergePlaceFormat`, the main's habit plus the
   * Settings overrides), no ages — so the two sets of strings are comparable.
   * Re-stamped on every update while confirmed, including a change to a single
   * field choice: choosing again is a fresh decision about the value on screen
   * at that moment. The same stamp anchors each event-row choice to its
   * incoming event (`CandidateDecision.fieldAnchors`), reading the previous
   * decision to tell the choices this update made from earlier ones.
   */
  function stampMainRows(next: CandidateDecision, mainId: string, compareId: string): CandidateDecision {
    if (next.status !== "confirmed") return next;
    const mainDs = mainDatasetRef.current;
    const compareDs = compareDatasetRef.current;
    const mainIndi = mainDs?.individuals.get(mainId);
    const incoming = compareDs?.individuals.get(compareId);
    if (!mainDs || !compareDs || !mainIndi || !incoming) return next;
    const rejected = next.rejectedEvents?.length ? new Set(next.rejectedEvents) : undefined;
    const placeFmt = mergePlaceFormat(mainDs, formatOverridesRef.current);
    const rows = individualFieldRows(tRef.current, mainIndi, incoming, mainDs, compareDs, placeFmt, rejected);
    const prev = decisionsRef.current.get(decisionKey("individual", mainId, compareId));
    return stampConfirmedDecision(next, prev, rows, INDI_HANDLED);
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
  // The editVersion at which the live dataset last matched the cached main
  // blob (0 on load, advanced on save). "Is the dataset edited?" is
  // editVersion !== this — not editVersion > 0 — because confirming a save
  // rebuilds the dataset in place and must bump editVersion like any other
  // mutation (every memo and panel keyed on it has to see the new baseline,
  // even in a merge-only session where it still sat at 0) without making the
  // freshly-saved dataset look edited to the persistence writer.
  const cleanEditVersionRef = useRef(0);
  // Which records each bump changed, so the copies of the main kept elsewhere
  // (the workers', the cached serialization) take only those records.
  const changeJournal = useRef(new ChangeJournal()).current;
  // The edit version the gedcom worker's copy of the main was built from, as a
  // journal mark. The worker matches a compare against *its* main, so when
  // this drifts from editVersionRef the worker is brought up to date before a
  // compare loads (see loadFile).
  const workerMainVersionRef = useRef<SyncMark | undefined>(undefined);
  /** Advance the edit version. `patches` names the records the change
   *  touched; null says it may have touched any (a save's rebuild). */
  const bumpEdit = useCallback((patches: readonly RecordPatch[] | null) => {
    editVersionRef.current += 1;
    changeJournal.record(editVersionRef.current, patches && patches.map((p) => p.id));
    setEditVersion((v) => v + 1);
  }, [changeJournal]);

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
  // A panel that needs a setting can send the reader straight to its tab —
  // see settingsBus for why this is a subscription rather than a prop.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  useEffect(
    () =>
      onSettingsRequest((tab) => {
        setSettingsTab(tab);
        setShowSettings(true);
      }),
    [],
  );
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  // Outstanding "create a new, unattached person" request handed to Edit mode —
  // see EditView's `addPersonRequest`. The nonce only grows, so each request is
  // acted on exactly once even when the same name is asked for twice.
  const [addPersonRequest, setAddPersonRequest] = useState<{ nonce: number; name?: string }>();
  // The pending save dialog's payload — see `SavePreview` for the field docs.
  const [preview, setPreview] = useState<SavePreview | null>(null);
  // The GEDCOM version the save dialog opens on: the file's own, unless the
  // reader came from Tools → Health check's "Save as GEDCOM …".
  const [previewVersion, setPreviewVersion] = useState<OutputVersion | undefined>(undefined);
  // The save is reading the pages of books it is about to write sources for —
  // see `handleSave`. Holds the Save button until the answers are in.
  const [readingSources, setReadingSources] = useState(false);
  // Brief confirmation shown after a successful download; auto-dismisses.
  const [saveToast, setSaveToast] = useAutoDismissToast();
  // Bumped whenever a Tools pass changes records (see applyToolPatches).
  const [toolEditGen, setToolEditGen] = useState(0);
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
  // Where Tools stands: which tool, and which of its pages. Held here, not in
  // ToolsView, because both are browser-history steps — the entry the app is on
  // records them, and a Back press puts them back (see ToolView).
  const [tool, setTool] = useState<Tool>("places");
  const [toolView, setToolView] = useState<ToolView>("tree");

  // Light/dark theme mode + applied `data-theme`, in a self-contained hook.
  const { themeMode, changeThemeMode } = useTheme();

  // App-styled confirmation dialog as a promise (`confirmDialog(...)`), in a hook.
  const { confirmDialog, choiceDialog, confirmDialogElement } = useConfirmDialog();

  // The main thread's own copies of the GEDCOM datasets, built from the same
  // bytes the worker parses — no dataset crosses the worker boundary (see
  // ParseSuccess.dataset). Lives for the app's lifetime, like the worker's state.
  const localLoads = useRef(new LocalLoads()).current;

  // Dispatch a message from the GEDCOM worker to the right state. Invoked on
  // every worker message via useGedcomWorker's latest-handler ref.
  const handleWorkerMessage = async (msg: WorkerResponse): Promise<void> => {
      if (msg.type === "mainOutOfStep") {
        // The worker's main did not take the edits sent to it (see
        // syncWorkerMain): send the whole file. The worker holds what came
        // after the patch until it arrives.
        if (lastMainFile) void refeedWorkerMain(serializeMainForWorker(lastMainFile.dataset), lastMainFile.fileName);
        return;
      }
      if (msg.type === "matching") {
        if (matchedTimerRef.current != null) {
          window.clearTimeout(matchedTimerRef.current);
          matchedTimerRef.current = null;
        }
        if (matchingStartRef.current === null) matchingStartRef.current = performance.now();
        dispatch({ type: "matchingStarted" });
        return;
      }
      if (msg.type === "scoreDetail") {
        receiveScoreDetail(msg.mainId, msg.compareId, msg.generation, msg.components);
        return;
      }
      if (msg.type === "matched") {
        // A new list replaces the one held here; a start-person change sends
        // only the new order of the list already held.
        if (msg.result) {
          matchListRef.current = msg.result;
          resetScoreDetails();
        }
        const list = matchListRef.current;
        if (!list) return;
        const result: MatchResult = msg.ranking ? { individuals: rankedCandidates(list.individuals, msg.ranking) } : list;
        const applyMatched = () => {
          matchingStartRef.current = null;
          matchedTimerRef.current = null;
          dispatch({ type: "matched", result });
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
            if (restored.decisions.length) {
              // Joins left to the save are worked out when a decision changes,
              // so a session saved before they existed carries none.
              const mainDs = mainDatasetRef.current;
              const compareDs = compareDatasetRef.current;
              const decisions = new Map(restored.decisions);
              dispatch({
                type: "decisionsSet",
                decisions: mainDs && compareDs
                  ? refreshJoins(mainDs, compareDs, result, decisions, tRef.current, formatOverridesRef.current)
                  : decisions,
              });
            }
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
      if (msg.type === "matchFailed") {
        // The files are fine — only the match pipeline threw. Stop the spinner
        // and say so; the slots (and their cached files) stay as they are.
        if (matchedTimerRef.current != null) {
          window.clearTimeout(matchedTimerRef.current);
          matchedTimerRef.current = null;
        }
        matchingStartRef.current = null;
        dispatch({ type: "matchingStopped" });
        persistence.hydratedRef.current = true; // a failed restore must not block persistence
        setSaveToast(t("match.failed", { message: msg.message }));
        return;
      }
      // A parse (or parse failure) for a file the user has since superseded:
      // when the slot is already loading a *different* file, this response
      // belongs to the earlier load — accepting it would show stale data and,
      // for the main, hand the dirty-tracking baseline the wrong dataset. The
      // newer load's own response is on its way and wins by arriving last.
      if (msg.type === "parsed" || msg.type === "error") {
        const slot = msg.role === "main" ? main : compare;
        if (slot.status === "loading" && slot.fileName !== msg.fileName) return;
      }
      if (msg.type === "parsed") {
        // The dataset the message stands for is this side's own copy (or, for
        // a table compare, the one the message carries); a copy this side
        // failed to build while the worker succeeded is reported as a failed
        // slot rather than left spinning. The copy may still be building: the
        // queue below holds every later message until this one is done.
        const dataset = await localLoads.resolve(msg);
        // A newer load of the slot overtook the build: its own answer follows.
        if (dataset === SUPERSEDED) return;
        if (!dataset) {
          dispatch({ type: "slotError", role: msg.role, fileName: msg.fileName, message: t("load.unreadable") });
          void deleteFile(msg.role);
          persistence.hydratedRef.current = true;
          return;
        }
        const file = loadedFileFromParsed(msg, dataset);
        // slotLoaded also records lastMainFile when role is "main".
        dispatch({ type: "slotLoaded", role: msg.role, file });
        if (msg.role === "main") {
          // The worker built its main from the same bytes as this one: it
          // holds the edit version the load reset to (see loadFile).
          workerMainVersionRef.current = changeJournal.mark(editVersionRef.current);
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
        // The worker has no i18n: it names the not-a-GEDCOM case by a code.
        const message = msg.message === NOT_GEDCOM ? t("load.notGedcom") : msg.message;
        dispatch({ type: "slotError", role: msg.role, fileName: msg.fileName, message });
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
  // Worker messages are handled one at a time, in order: a `parsed` waits for
  // this side's own copy of the dataset, which is built in slices (see
  // LocalLoads), and nothing that follows it may overtake it. Messages from a
  // worker since torn down (resetWorker) are dropped unhandled.
  const handleWorkerMessageRef = useRef(handleWorkerMessage);
  handleWorkerMessageRef.current = handleWorkerMessage;
  const workerQueueRef = useRef<Promise<void>>(Promise.resolve());
  const workerEpochRef = useRef(0);
  const queueWorkerMessage = useCallback((msg: WorkerResponse) => {
    const epoch = workerEpochRef.current;
    workerQueueRef.current = workerQueueRef.current
      .then(() => (epoch === workerEpochRef.current ? handleWorkerMessageRef.current(msg) : undefined))
      .catch((err: unknown) => console.error("gedcom worker message:", err));
  }, []);
  const { post, reset: respawnWorker } = useGedcomWorker(queueWorkerMessage, handleWorkerFailure);
  const resetWorker = () => {
    workerEpochRef.current++;
    respawnWorker();
  };
  // A match row's score tooltip asks the worker for the pair's breakdown.
  useEffect(() => {
    connectScoreDetails((mainId, compareId, generation) => post({ type: "scoreDetail", mainId, compareId, generation }));
    return () => connectScoreDetails(undefined);
  }, [post]);
  // Every load goes through here: this side decodes the bytes, the worker
  // gets them, and this side builds the same dataset in slices meanwhile.
  const feed = useCallback(
    (msg: WorkerRequest, transfer?: Transferable[]) => localLoads.feed(post, msg, transfer),
    [localLoads, post],
  );

  // The media folder's remembered handle lives in its own IndexedDB; clearing
  // locally stored data has to drop it along with the workspace.
  const { clearFolder: clearMediaFolder } = useMediaFolder();

  // Opt-in IndexedDB persistence: startup hydration (re-feeding cached files
  // through the worker), the debounced session/main writer, the enable toggle,
  // and the on-disk external-change checks. Returns the restore-coordination
  // refs the worker handlers above and the load/save flows below share.
  const persistence = useWorkspacePersistence({
    persistEnabled: settings.persistWorkspace,
    workspace, mainDataset, editVersion, cleanEditVersionRef, changeJournal, dirty, undoRedo,
    sortEligiblePersonIdsRef, post: feed, dispatch, autoStartRef,
    loadFile, confirmDialog, setSaveToast, clearMediaFolder,
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
    const file = new File([newGedcomText(new Date(), settings.authorName)], `${NEW_FILE_BASENAME}.ged`, { type: "text/plain" });
    void loadFile("main", file);
    setMode("edit");
  }

  async function loadSample(role: DatasetRole, fileName: string) {
    // A stale deploy answers a missing sample with the host's fallback HTML
    // (status 200 or 404 alike): checked here, and by the parser refusing a
    // file with no records, so an HTML page never lands in the slot.
    let blob: Blob;
    try {
      const res = await fetch(`samples/${fileName}`);
      if (!res.ok) throw new Error(String(res.status));
      blob = await res.blob();
    } catch {
      dispatch({ type: "slotError", role, fileName, message: t("load.unreadable") });
      return;
    }
    loadFile(role, new File([blob], fileName, { type: "text/plain" }));
  }

  async function loadFile(role: DatasetRole, file: File, handle?: FileSystemFileHandle) {
    // Also guards a reload triggered by the external-change check below: if
    // there's unsaved work, this asks before discarding it exactly as it would
    // for any other replace.
    if (role === "main" && (changedCount > 0 || confirmedCount > 0 || importCount > 0)) {
      if (!(await confirmDialog(t("load.mainReplaceConfirm"), t("confirm.continue")))) return;
    }
    // A user-initiated load supersedes any in-flight startup restore, so enable
    // session persistence (and stop expecting the cached compare to arrive).
    // Only once the load is going ahead: a cancelled prompt must leave the
    // pending restore in place, not discard it.
    persistence.userLoadedRef.current = true;
    persistence.hydratedRef.current = true;
    persistence.expectCompareRef.current = false;
    persistence.pendingSessionRef.current = null;
    persistence.pendingEditStateRef.current = null;
    if (role === "compare" && (confirmedCount > 0 || importCount > 0)) {
      if (!(await confirmDialog(t("load.incomingReplaceConfirm"), t("confirm.continue")))) return;
    }

    // macOS hands back filenames in decomposed (NFD) form, e.g. "Kovačič" as
    // c + combining caron. Our subset fonts don't carry the combining marks, so
    // the accent mispositions; normalize to NFC (precomposed) for display.
    const fileName = file.name.normalize("NFC");
    const isCsv = role === "compare" && isTableFile(fileName);
    dispatch({ type: "slotLoading", role, fileName });
    // Read the bytes first, before a single thing is torn down. A file can
    // refuse to be read — moved or renamed between the picker and here, a
    // cloud folder's placeholder that never materializes, permission lost —
    // and that has to surface as an error the reader can see. Unguarded it
    // rejected into nothing: the slot stayed "loading" and the spinner ran
    // forever, exactly what `handleWorkerFailure` exists to prevent further
    // down the same pipeline. Failing here also leaves the file already open
    // untouched, since none of the state below has been reset yet.
    // The hash is fixed at this fresh load — carried unchanged through every
    // later cache write for this file (see StoredFile's originalHash).
    let originalHash: string;
    let buffer: ArrayBuffer;
    try {
      originalHash = await hashFile(file);
      buffer = await file.arrayBuffer();
    } catch {
      dispatch({ type: "slotError", role, fileName, message: t("load.unreadable") });
      return;
    }
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
    clearMatchState();
    if (role === "main") {
      undoRedo.clearAll();
      dirty.prepareForLoad();
      setEditVersion(0); // new file → dataset matches the cached original again
      editVersionRef.current = 0;
      changeJournal.reset();
      cleanEditVersionRef.current = 0;
      sortEligiblePersonIdsRef.current = new Set();
      setChartsRootId(null);
      dispatch({ type: "setStart", id: undefined }); // start person is opt-in; reset on (re)load
      dispatch({ type: "rejectedDuplicatesCleared" }); // rejects reference this main's xrefs only
      autoStartRef.current = false; // allow the default start person for the new file
    } else {
      // Incoming reload: edit entries remain valid (they only touch main data).
      // Drop merge entries whose field comparisons reference the old incoming file.
      undoRedo.dropMergeEntries();
    }
    const newMsg: WorkerRequest = isCsv
      ? { type: "parseCsv", fileName, buffer }
      : {
          type: "parse", role, fileName, buffer, formatOverrides: settings.formatOverrides,
          ...(role === "main" ? { target: settings.targetFormats[targetFileKey(fileName)] ?? "propose" } : {}),
        };

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
        feed(newMsg, [buffer]); // new main first
        await refeedCompare(); // kept compare second (re-parsed from its raw bytes)
      } else if (keptMain) {
        await refeedWorkerMain(serializeMainForWorker(keptMain.dataset), keptMain.fileName);
        feed(newMsg, [buffer]); // new compare last
      }
      return;
    }
    // A compare is matched against the worker's copy of the main, which is
    // the file as loaded (or as last saved). Edits made since — a person
    // deleted, one added — are not in it, so a compare loaded now would match
    // people who no longer exist and miss those who do. Bring the worker's
    // copy up to date first.
    const workerMain = workerMainVersionRef.current;
    if (role === "compare" && keptMain && (workerMain?.version !== editVersionRef.current || !changeJournal.since(workerMain))) {
      await syncWorkerMain(keptMain.dataset, keptMain.fileName);
    }
    feed(newMsg, [buffer]); // transfer ownership — avoids copying large files
  }

  function serializeMainForWorker(ds: Dataset): string {
    return serializeGedcom(ds.records, { eol: ds.eol, finalNewline: ds.finalNewline, atEscape: atEscapeFor(ds.version) });
  }

  /** Bring the worker's main up to the live one by sending only the records
   *  edited since the version it holds — re-sending the whole file cost ~10 s
   *  on a 500k-person file (serialize, then a worker re-parse). Falls back to
   *  the whole file when the journal cannot say what changed, or when most of
   *  the file did; the worker asks for it too should its copy not take the
   *  patch (`mainOutOfStep`). */
  async function syncWorkerMain(ds: Dataset, fileName: string): Promise<void> {
    const version = editVersionRef.current;
    const changed = changeJournal.since(workerMainVersionRef.current);
    if (changed?.size === 0) {
      // Edited only in name (a restored workspace starts at version 1).
      workerMainVersionRef.current = changeJournal.mark(version);
      return;
    }
    const patch = changed && recordsPatch(ds, changed);
    if (!patch) return refeedWorkerMain(serializeMainForWorker(ds), fileName);
    post({ type: "patchMain", patch, formatOverrides });
    workerMainVersionRef.current = changeJournal.mark(version);
  }

  /** Silently rebuild the worker's main from `text` (the main thread's current
   *  main file, serialized) without touching this side's main file or the edit
   *  tracking bound to it, and restore the kinship ranking's start person.
   *  Records which edit version the worker now holds. */
  async function refeedWorkerMain(text: string, fileName: string): Promise<void> {
    const mark = changeJournal.mark(editVersionRef.current);
    const mainBuf = await new Blob([text]).arrayBuffer();
    post(
      { type: "parse", role: "main", fileName, buffer: mainBuf, silent: true, formatOverrides },
      [mainBuf],
    );
    if (startId) post({ type: "setStart", id: startId }); // restore kinship ranking
    workerMainVersionRef.current = mark;
  }

  /** Re-parse the currently-loaded compare from its retained raw bytes — used to
   *  restock a freshly-recreated worker after a hard-abort (see loadFile). */
  async function refeedCompare() {
    const blob = persistence.compareBlobRef.current;
    if (!blob || compare.status !== "loaded") return;
    const fileName = compare.file.fileName;
    const isCsv = isTableFile(fileName);
    const buffer = await blob.arrayBuffer();
    feed(
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
    clearMatchState();
    setSelectedId(null);
    feed({ type: "clearCompare" });
  }

  /**
   * Drop everything derived from the current match result: the result itself,
   * decisions, branch-import requests, the pending save preview — and a
   * `matched` still held back by the minimum-spinner timer, which would
   * otherwise fire *after* this clear and resurrect a match list whose
   * incoming file is gone. Shared by loadFile and unloadCompare so neither
   * can forget a step the other remembered.
   */
  function clearMatchState() {
    if (matchedTimerRef.current != null) {
      window.clearTimeout(matchedTimerRef.current);
      matchedTimerRef.current = null;
    }
    matchingStartRef.current = null;
    dispatch({ type: "matchesCleared" });
    dispatch({ type: "decisionsCleared" });
    dispatch({ type: "importBranchesCleared" });
    setPendingEditApply(null);
    setPreview(null);
    setOpenMatches(false);
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
        dirty.hydrate(es, main.file.dataset);
        undoRedo.hydrate(es.undo, es.redo);
        // No cached compare coming → merge entries in the hydrated history
        // reference an incoming file that won't exist. Drop them, or undoing
        // one would resurrect decisions with nothing to merge against.
        if (!persistence.expectCompareRef.current) undoRedo.dropMergeEntries();
        sortEligiblePersonIdsRef.current = new Set(es.sortEligiblePersonIds);
        setEditVersion(1); // mark dataset as edited so further edits keep persisting
        editVersionRef.current = 1; // keep the sync ref on the same counter
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
  // mainLoadGen: two loads can overlap (load A, load B before A parses) with
  // `status` reading "loaded" for both — the generation counter bumps per
  // slotLoaded, so the baseline is re-taken from the file that actually won.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main.status, mainLoadGen]);

  // A newly loaded file puts Tools back on the front page of whichever tool is
  // open: the worklist that was on screen belongs to the file that is gone.
  // Not a step of the reader's own, so it records no entry — the entry we are
  // on is simply brought up to date (see useAppHistory's page sync).
  useEffect(() => {
    setToolView("tree");
  }, [mainLoadGen]);

  // When the main finishes loading, default the start person to its root
  // individual if present. Attempted once per file (autoStartRef), so a user
  // who later clears the start person isn't overridden.
  useEffect(() => {
    if (main.status !== "loaded" || autoStartRef.current) return;
    const ds = main.file.dataset;
    // A tree just started holds nobody, so there is no one to be the start
    // person yet. Leave the attempt open (this runs again on every edit) and
    // the first person added takes the role.
    if (ds.individuals.size === 0) return;
    autoStartRef.current = true;
    if (startId) return;
    // A file of one is that one person — no point asking.
    const start = defaultStartId(ds) ?? (ds.individuals.size === 1 ? ds.individuals.keys().next().value : undefined);
    // With no evident root the start person stays unset: Edit's kinship chip
    // offers "Set start person" on every person until one is chosen.
    if (start) changeStart(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main.status, editVersion]);

  // In merge mode, also attempt once when first match results arrive (covers
  // the case where main loaded before the worker finished computing matches).
  useEffect(() => {
    if (!matches || autoStartRef.current) return;
    autoStartRef.current = true;
    if (startId) return;
    const ds = main.status === "loaded" ? main.file.dataset : undefined;
    const start = ds ? defaultStartId(ds) : undefined;
    if (start) changeStart(start);
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
  // The person a Back/Forward press restored, kept apart from `navigateToId` so
  // Edit can tell "the browser moved me" from "open this person".
  const [historyPersonId, setHistoryPersonId] = useState<string | undefined>(undefined);

  // Browser-history/overlay state machine: the full-page overlays (Compare
  // Tree / Charts hub), popstate restoration of mode/selection/navigation, and
  // the unsaved-changes leave guards (history entry + beforeunload).
  const {
    treeView, treeTrail, stepTreeTrail, chartsRootId, setChartsRootId, chartsBackKey, chartsFromId, chartsTrail, stepChartsTrail,
    overlayOpen, overlayOpenRef, hasUnsavedChangesRef,
    openTree, rerootTree, showInMatches, changeTreeMode, openCharts,
    discardAndReload, recordEditPerson, navigateFromOverlay, goToPageFromOverlay,
    navigateFromPage, selectFromPage, goToPage, canGoBack, goBackPage,
  } = useAppHistory({
    confirmDialog, current, editPersonId, mode, setMode, setSelectedId, setNavigateToId, setChartKind,
    tool, toolView, setTool: (t) => setTool(t as Tool), setToolView: (v) => setToolView(v as ToolView),
    setHistoryPersonId,
    hasPerson: (id) => !!mainDatasetRef.current?.individuals.has(id),
  });

  // A file opened for the first time keeps the target it was proposed.
  const targetFormatsRef = useRef(settings.targetFormats);
  targetFormatsRef.current = settings.targetFormats;
  useEffect(() => {
    if (!targetKey || storedTargetMode || !targetProposal) return;
    setSettings({ targetFormats: rememberTarget(targetFormatsRef.current, targetKey, targetProposal.mode) });
  }, [targetKey, storedTargetMode, targetProposal, setSettings]);

  // A file kept in its own format says so each time it is opened — the reader
  // may want a GEDCOM version instead, and Settings → GEDCOM is where to
  // choose it — until Don't show again silences it for that file. Once per
  // load (`mainLoadGen`): a save's in-place rebuild is not an opening.
  const [targetNotice, setTargetNotice] = useState(false);
  const noticeGenRef = useRef(-1);
  const noticeHidden = !!targetKey && settings.targetNoticeHidden.includes(targetKey);
  useEffect(() => {
    if (targetMode !== "file" || noticeHidden) {
      setTargetNotice(false);
      return;
    }
    if (!targetKey || noticeGenRef.current === mainLoadGen) return;
    noticeGenRef.current = mainLoadGen;
    setTargetNotice(true);
  }, [mainLoadGen, targetKey, targetMode, noticeHidden]);
  const hideTargetNotice = () => {
    setTargetNotice(false);
    if (targetKey) {
      setSettings({ targetNoticeHidden: [...settings.targetNoticeHidden.filter((k) => k !== targetKey), targetKey].slice(-MAX_REMEMBERED_TARGETS) });
    }
  };

  // Choosing a GEDCOM version asks first — the choice changes what every
  // write does — and offers to bring the records the file already has to that
  // standard straight away, which Tools → Normalize & batch does. Cancel keeps
  // the format the file had. Going back to the file's own format needs no
  // question: it writes nothing differently from what the file already does.
  const setTargetMode = useCallback((next: TargetMode) => {
    if (!targetKey || next === targetMode) return;
    const remember = () => setSettings({ targetFormats: rememberTarget(targetFormatsRef.current, targetKey, next) });
    if (next === "file") return remember();
    void choiceDialog(
      t("target.switch", { version: next }),
      t("target.switch.normalize"),
      t("target.switch.only"),
    ).then((choice) => {
      if (choice === "cancel") return;
      remember();
      if (choice !== "confirm") return;
      setShowSettings(false);
      goToPage({ mode: "tools", tool: "normalize", toolView: "normalize" });
    });
  }, [targetKey, targetMode, setSettings, choiceDialog, t, goToPage]);
  const dialect = lastMainFile?.dialect;
  const targetFormat = useMemo<TargetFormatValue>(
    () => ({
      target,
      formatOverrides,
      proposal: targetProposal,
      setMode: setTargetMode,
      eventOffer: { version: target.version, strict: target.strict, dialectTags: new Set(dialect?.bareTags) },
    }),
    [target, formatOverrides, targetProposal, setTargetMode, dialect],
  );

  // A person a confirmed decision added ahead of the save is their new record:
  // their name — on either side of the comparison — opens it in Edit, even
  // when the matcher also paired them with someone else (that weaker
  // candidate is not who they are).
  const addedPerson = useMemo(() => {
    const pinned = pinnedAdds(decisions);
    const mainIds = new Set(pinned.values());
    return (side: "main" | "incoming", id: string): string | undefined => {
      const mainId = side === "main" ? (mainIds.has(id) ? id : undefined) : pinned.get(id);
      return mainId && mainDatasetRef.current?.individuals.has(mainId) ? mainId : undefined;
    };
  }, [decisions]);
  const canNavigatePerson = useCallback(
    (side: "main" | "incoming", id: string) =>
      (side === "main" ? indexByMain : indexByCompare).has(id) || !!addedPerson(side, id),
    [indexByMain, indexByCompare, addedPerson],
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

  // Prev/Next navigate within the filtered visible list; the index form is
  // what the list keys (Home, End, a step) ask for.
  const onSelectIndex = useCallback((idx: number) => {
    const c = visibleRef.current[Math.max(0, Math.min(visibleRef.current.length - 1, idx))];
    if (c) setSelectedId({ mainId: c.mainId, compareId: c.compareId });
  }, []);
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
  // so the browser Back button returns to where we were. The history helper
  // is rebuilt each render; read through a ref so this callback stays stable.
  const selectFromPageRef = useRef(selectFromPage);
  selectFromPageRef.current = selectFromPage;
  const navigateFromPageRef = useRef(navigateFromPage);
  navigateFromPageRef.current = navigateFromPage;
  const navigatePerson = useCallback(
    (side: "main" | "incoming", id: string) => {
      const added = addedPerson(side, id);
      if (added) { navigateFromPageRef.current(added); return; }
      const target = (side === "main" ? indexByMain : indexByCompare).get(id);
      if (!target) return;
      if (target.mainId === current?.mainId && target.compareId === current?.compareId) return;
      selectFromPageRef.current({ mainId: target.mainId, compareId: target.compareId });
      if (window.innerWidth <= 880) {
        setTimeout(() => { compareRef.current?.scrollIntoView({ behavior: "smooth" }); }, 50);
      }
    },
    [indexByMain, indexByCompare, current, addedPerson],
  );

  // Jump the compare view to one exact pair — a join the save will make, which
  // the review flags for inspection (see `CandidateDecision.joins`).
  const openPair = useCallback((mainId: string, compareId: string) => {
    selectFromPageRef.current({ mainId, compareId });
  }, []);

  function handleUndo() {
    const entry = undoRedo.undo();
    if (!entry) return;
    if (entry.mode === "edit") {
      if (entry.navigateTo) setNavigateToId(entry.navigateTo);
      if (!entry.stay) setMode("edit");
      setPendingEditApply({ patches: entry.patches, direction: "undo", navigateTo: entry.navigateTo, redoNavigateTo: entry.redoNavigateTo });
    } else if (entry.mode === "import") {
      dispatch({ type: "importBranchesSet", branches: entry.before });
    } else if (entry.mode === "rejectDup") {
      setMode("tools");
      dispatch({ type: "rejectedDuplicatesSet", pairs: entry.before });
    } else {
      setSelectedId({ mainId: entry.mainId, compareId: entry.compareId });
      setMode("merge");
      if (entry.patches) setPendingEditApply({ patches: entry.patches, direction: "undo" });
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
      if (!entry.stay) setMode("edit");
      setPendingEditApply({ patches: entry.patches, direction: "redo", navigateTo: entry.navigateTo, redoNavigateTo: entry.redoNavigateTo });
    } else if (entry.mode === "import") {
      dispatch({ type: "importBranchesSet", branches: entry.after });
    } else if (entry.mode === "rejectDup") {
      setMode("tools");
      dispatch({ type: "rejectedDuplicatesSet", pairs: entry.after });
    } else {
      setSelectedId({ mainId: entry.mainId, compareId: entry.compareId });
      setMode("merge");
      if (entry.patches) setPendingEditApply({ patches: entry.patches, direction: "redo" });
      requestAnimationFrame(() => {
        dispatch({ type: "decisionsSet", decisions: entry.after });
      });
    }
  }

  // Stable ref for keyboard handler (recreated each render but registered once).
  /** Undo/redo as the buttons and shortcuts run them: a whole-file Tools pass
   *  (pushed with `stay`) costs as much to take back as it did to apply, so
   *  that step runs a paint later, under the progress cursor. */
  function undoStep(direction: "undo" | "redo") {
    const run = direction === "undo" ? handleUndo : handleRedo;
    const next = undoRedo.peek(direction);
    if (next?.mode !== "edit" || !next.stay) return run();
    // EditView applies the patches a frame later; the cursor stays until it has.
    void withBusyCursor(() => new Promise<void>((resolve) => {
      patchesAppliedRef.current = resolve;
      run();
    }));
  }

  const globalShortcutRef = useRef({ undo: handleUndo, redo: handleRedo, save: () => {}, canSave: false, addPerson: () => {}, back: () => {} });
  globalShortcutRef.current.undo = () => undoStep("undo");
  globalShortcutRef.current.redo = () => undoStep("redo");

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

      // `?` / F1 toggle the shortcut cheat sheet. Allowed even with the sheet
      // itself open (so it toggles closed), but not stacked over another modal.
      // F1 works from inside a field too — where `?` is the character being
      // typed, and where an Edit user most wants to look a chord up.
      if (e.key === "F1" || (e.key === "?" && !editable)) {
        e.preventDefault();
        setShowShortcuts((v) => (!v && isModalOpen() ? v : !v));
        return;
      }

      if (editable) return;
      if (isModalOpen()) return;

      if (mod) {
        if (e.key === "z" && !e.shiftKey) { e.preventDefault(); globalShortcutRef.current.undo(); }
        else if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); globalShortcutRef.current.redo(); }
        return;
      }

      // Bare keys only from here: an Alt chord belongs to a view's own binding
      // (Alt+N is Edit's "add note"), and a key a view already handled must
      // not fire a second action.
      if (e.altKey || e.defaultPrevented) return;

      // ⌫ is the browser's Back, everywhere — one handler for the whole app,
      // so the key and the button can never disagree about where Back goes:
      // the person before in Edit, the match a relative was opened from in
      // Merge, the Tools page before, the page a chart was opened on. Swallowed
      // even with nowhere to go, so it never leaves the app on its own.
      if (e.key === "Backspace" && !e.shiftKey) {
        e.preventDefault();
        globalShortcutRef.current.back();
        return;
      }

      // `/` opens the whole-file global search from any mode (Merge/Edit/Tools).
      if (e.key === "/") {
        e.preventDefault();
        setShowGlobalSearch(true);
        return;
      }

      // `N` adds a new, unattached person from any mode — but not from a
      // full-page chart, where the new person would appear behind the overlay
      // with no sign anything happened.
      if (e.key.toLowerCase() === KEY.addPerson && !e.shiftKey && !overlayOpenRef.current) {
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
    // One step, not two: the person Merge has selected is opened *as* the
    // navigation, so Back returns to Merge rather than to a mode entry with the
    // person's own entry stacked on top of it.
    if (current) navigateFromPage(current.mainId);
    else goToPage({ mode: "edit" });
  }

  // Add a person attached to nobody — a new branch, or the first person in a
  // file that has none. The work happens in Edit mode (which owns the person
  // view and the name focus), so switch there and hand the request over —
  // from a chart, leaving it first (pushed on top, so Back returns to it).
  function requestAddPerson(name?: string) {
    if (!mainDataset) return;
    (overlayOpen ? goToPageFromOverlay : goToPage)({ mode: "edit" });
    setAddPersonRequest((prev) => ({ nonce: (prev?.nonce ?? 0) + 1, name }));
  }


  // Switch to Merge, pointing it at the match candidate for whichever person
  // Edit is currently showing (so the person carries over the other way too) —
  // falls back to leaving Merge's selection untouched when that person isn't
  // itself a match candidate.
  function switchToMerge() {
    const c = editPersonId ? allSorted.find((c) => c.mainId === editPersonId) : undefined;
    if (c) setSelectedId({ mainId: c.mainId, compareId: c.compareId });
    goToPage({ mode: "merge" });
  }

  // Switch to the maintenance Tools tab, which operates on the whole main file.
  function switchToTools() {
    goToPage({ mode: "tools" });
  }

  // Mode-switch shortcuts: fixed bare keys E / M / T (see KEY in keyboard/shortcuts).
  // Kept locale-independent — label-derived first letters collided across
  // translations (e.g. Slovenian "Urejanje"/"Združi") and weren't discoverable.
  const modeSwitchRef = useRef({ mode, switchToEdit, switchToMerge, switchToTools, leaveOverlayFor, openCharts: openChartsFromHeader });
  modeSwitchRef.current = { mode, switchToEdit, switchToMerge, switchToTools, leaveOverlayFor, openCharts: openChartsFromHeader };

  // A mode letter on a full-page chart leaves it for that mode, the person the
  // chart stands on carried along as a mode switch carries Merge's selection.
  // Pushed on top of the chart, so Back returns to it.
  function leaveOverlayFor(target: Mode) {
    const personId = chartsRootId ?? treeView?.mainId;
    if (target === "edit" && personId) return navigateFromOverlay(personId);
    if (target === "merge" && personId) {
      const c = allSorted.find((c) => c.mainId === personId);
      if (c) setSelectedId({ mainId: c.mainId, compareId: c.compareId });
    }
    goToPageFromOverlay({ mode: target });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isModalOpen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (overlayOpenRef.current) {
        // A chart that took the key (E on a selected node) has the say.
        if (e.defaultPrevented) return;
        const target = key === KEY.modeEdit ? "edit" : key === KEY.modeMerge ? "merge" : key === KEY.modeTools ? "tools" : undefined;
        if (target) { e.preventDefault(); modeSwitchRef.current.leaveOverlayFor(target); }
        return;
      }
      const { mode: cur, switchToEdit: se, switchToMerge: sme, switchToTools: st } = modeSwitchRef.current;
      if (key === KEY.modeEdit && cur !== "edit") { e.preventDefault(); se(); }
      else if (key === KEY.modeMerge && cur !== "merge") { e.preventDefault(); sme(); }
      else if (key === KEY.modeTools && cur !== "tools") { e.preventDefault(); st(); }
      else if (key === KEY.tree) {
        // V opens the charts from anywhere, as the header button does. Edit and
        // Merge answer it first with their own person or pair; this only
        // catches the key they left alone (Tools, an empty match list). Their
        // listeners may sit before or after this one on `window`, so wait for
        // the dispatch to finish before reading whether one of them took it.
        setTimeout(() => { if (!e.defaultPrevented) modeSwitchRef.current.openCharts(); });
      }
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

  /**
   * Record a decision change as one undo step, together with the people it
   * adds to (or takes back from) the main file right away — see
   * `materializeAdds`: a confirmed child, parent or partner becomes a record
   * of its own at once, so it can be edited before the save.
   */
  function commitDecisions(
    before: ReadonlyMap<string, CandidateDecision>,
    after: Map<string, CandidateDecision>,
    mainId: string,
    compareId: string,
  ) {
    const mainDs = mainDatasetRef.current;
    const compareDs = compareDatasetRef.current;
    const result = mainDs && compareDs && matchesRef.current
      ? materializeAdds(mainDs, compareDs, matchesRef.current, before, after, tRef.current, formatOverridesRef.current)
      : { decisions: after, patches: [] };
    const patches = dropNoopPatches(result.patches);
    undoRedo.pushRef.current({
      mode: "merge",
      before: new Map(before),
      after: result.decisions,
      mainId,
      compareId,
      ...(patches.length ? { patches } : {}),
    });
    dispatch({ type: "decisionsSet", decisions: result.decisions });
    if (patches.length) {
      dirty.captureSnapshotsForPush(patches);
      bumpEdit(patches);
    }
  }
  const commitDecisionsRef = useRef(commitDecisions);
  commitDecisionsRef.current = commitDecisions;

  function updateDecision(next: CandidateDecision) {
    if (!current) return;
    const key = decisionKey("individual", current.mainId, current.compareId);
    const wasRejected = decisions.get(key)?.status === "rejected";
    const after = withFreshDecision(decisions, key, stampMainRows(next, current.mainId, current.compareId));
    commitDecisions(decisions, after, current.mainId, current.compareId);
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
    commitDecisions(decisions, withFreshDecision(decisions, key, stampMainRows(next, mainId, compareId)), mainId, compareId);
  }

  // Set a pair's status while keeping the rest of its decision; clicking the
  // active status again clears it back to undecided. Used by the compare tree,
  // where a node may be a person that never appeared in the candidate list.
  const setPairStatus = useCallback(
    (mainId: string, compareId: string, status: MatchDecisionStatus) => {
      const key = decisionKey("individual", mainId, compareId);
      const before = decisionsRef.current;
      const next = toggleDecisionStatus(before.get(key), status);
      commitDecisionsRef.current(before, withFreshDecision(before, key, stampMainRows(next, mainId, compareId)), mainId, compareId);
    },
    [], // commitDecisionsRef/decisionsRef are stable refs — no re-registration needed
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
    (patches: RecordPatch[], navigateTo?: string, redoNavigateTo?: string, stay?: boolean) => {
      // A patch whose before and after are identical records nothing: pushing
      // it would create an empty undo step and CHAN-stamp an untouched record
      // at save time. Filtered here, centrally, so no caller has to remember.
      const real = dropNoopPatches(patches);
      if (real.length === 0) return;
      dirty.captureSnapshotsForPush(real);
      undoRedo.pushRef.current({ mode: "edit", patches: real, navigateTo, redoNavigateTo, ...(stay ? { stay } : {}) });
      bumpEdit(real);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /** Shared tail of every Tools-tab fix action: record the patch batch as one
   *  undo entry and mark each touched record dirty. Returns the patch count so
   *  callers can report how many records the fix touched.
   *
   *  `mechanical` marks the batch as a whole-file maintenance pass (Normalize,
   *  Naming, Geocoding, Health-check fixes, source organizing): its records
   *  keep their CHAN/`_UPD` change stamps at save time, because restating a
   *  value or writing a gazetteer coordinate is not new research. Deliberate
   *  per-record acts — a source edited by hand, a duplicate merged — stay
   *  substantive and stamp as every Edit-mode change does. */
  function applyToolPatches(rawPatches: RecordPatch[], mechanical = false): number {
    const patches = dropNoopPatches(rawPatches);
    if (!mainDataset || patches.length === 0) return 0;
    // Edit stays mounted behind Tools, its rows holding the values they last
    // showed: tell it the records changed under it.
    setToolEditGen((g) => g + 1);
    if (mechanical) {
      markMechanical(patches);
      // Sweep the event-level audit marks the pass left behind (its mutations
      // reuse edit helpers that set them): left in place, they would refresh
      // event CHANs on a later, unrelated save of the same record. The live
      // record and the patch's `after` clone both carry them; `before` keeps
      // its marks — undo must restore exactly the pre-batch state. This also
      // sweeps marks from earlier unsaved hand edits of the same record — the
      // record-level stamp survives (its substantive count stands), only the
      // per-event refresh is lost, and only on files that stamp per event.
      for (const p of patches) {
        if (p.after) clearEventAuditStamps(p.after);
        const live = p.type === "individual"
          ? mainDataset.individuals.get(p.id)?.raw
          : p.type === "family"
            ? mainDataset.families.get(p.id)?.raw
            : mainDataset.records.find((r) => r.xref === p.id);
        if (live) clearEventAuditStamps(live);
      }
    }
    // stay: undoing a whole-file tool batch keeps the user where they are —
    // there is no single person to show, and the Tools page they came from
    // re-scans itself off the edit version.
    handlePushEdit(patches, undefined, undefined, true);
    // Shared-record patches are flagged by the push itself (see
    // captureSnapshotsForPush): a record with no owner card behind it — e.g.
    // the date repair rewriting a SOUR's DATE — is its own dirty subject; with
    // an owner, the owner's patch in the same batch carries the flag.
    for (const p of patches) {
      if (p.type !== "record") dirty.markDirty(p.type, p.id, mainDataset);
    }
    return patches.length;
  }

  /** Run a mutation over the shared `SOUR`/`OBJE`/`NOTE` records (a Tools →
   *  Sources edit or removal) and apply the before/after diff as one undoable
   *  patch batch — the mutation may cascade (a URL retarget creates or prunes
   *  an `OBJE`, a note edit lands in the shared `NOTE` record), so diffing
   *  beats enumerating what it touched. */
  function applySharedRecordEdit(mutate: (records: GedNode[], notes: SharedNoteCtx) => void) {
    if (!mainDataset) return;
    const isShared = (r: GedNode) => (r.tag === "SOUR" || r.tag === "OBJE" || r.tag === "NOTE" || r.tag === "REPO") && !!r.xref;
    const before = new Map(mainDataset.records.filter(isShared).map((r) => [r.xref!, cloneNode(r)]));
    const notes = noteCtx(mainDataset.records, detectPrivacyStyle(mainDataset.records));
    mutate(mainDataset.records, notes);
    if (notes.changes.length) rebuildNoteReferrers(mainDataset, notes.changes);
    const after = new Map(mainDataset.records.filter(isShared).map((r) => [r.xref!, r] as const));
    const patches: RecordPatch[] = [];
    for (const xref of new Set([...before.keys(), ...after.keys()])) {
      const b = before.get(xref) ?? null;
      const a = after.get(xref);
      const aClone = a ? cloneNode(a) : null;
      if (JSON.stringify(b) !== JSON.stringify(aClone)) patches.push({ type: "record", id: xref, before: b, after: aClone });
    }
    applyToolPatches(patches);
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

  // Whole-file search index for the global search dialog, built in the
  // background in idle slices: right after a load, and again after a pause in
  // editing (editVersion) or a change of the name-display settings (nameOf).
  // It never runs inside a render or an edit commit — on a file of half a
  // million people it costs seconds — and the finished rows stay put, so
  // opening the dialog is free once it is ready and shows the build's
  // progress when it is not.
  const searchIndex = useSearchIndex(mainDataset, nameOf, editVersion, showGlobalSearch);

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

  // Cross-cutting lookups the search facets need but that aren't baked into the
  // (dataset-derived) rows: unsaved-edit, merge-decision, and kinship-hop per
  // person. The kinship hops are one BFS from the start person over the whole
  // file — a second on a very large one — so it runs only when a kinship facet
  // first asks, and is then kept until the start person or the dataset (via
  // edits) changes.
  const searchFilterContext = useMemo<FilterContext>(() => {
    let distances: Map<string, number> | undefined;
    const hops = () =>
      (distances ??= startId && mainDataset ? computeDistances(mainDataset, startId) : new Map<string, number>());
    return {
      isEdited: (id) => changedPersonIds.has(id),
      decisionOf: (id) => decisionByMain.get(id),
      kinshipHops: (id) => hops().get(id),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changedPersonIds, decisionByMain, startId, mainDataset, editVersion]);

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
      // The row writes bare years; the full dates ride along for their tooltip.
      const indi = mainDataset?.individuals.get(id);
      if (indi) {
        meta.dates = datesTooltipOf(indi) || undefined;
        meta.yearsApprox = lifespanApproxOf(indi);
      }
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
      else navigateFromPage(id);
      return;
    }
    // Mode-aware "open": staying in Merge only makes sense when Merge is the
    // active mode and the person is a match candidate — then land on their pair.
    // From Edit (or Tools, or for a non-candidate), open the person in Edit so
    // an edit-mode search never yanks the user into Merge.
    const candidate = mode === "merge" ? indexByMain.get(id) : undefined;
    if (candidate) {
      setSelectedId({ mainId: candidate.mainId, compareId: candidate.compareId });
      goToPage({ mode: "merge" });
    } else {
      navigateFromPage(id);
    }
  }

  const changedCount = changedPersonIds.size + changedFamilyIds.size + changedRecordIds.size;

  // Called by EditView after undo/redo patches have been applied to the dataset.
  // Delegates to useDirtyTracking which handles all the case logic as pure ops.
  const patchesAppliedRef = useRef<(() => void) | null>(null);
  const handlePatchApplied = useCallback(
    (patches: RecordPatch[], direction: "undo" | "redo") => {
      patchesAppliedRef.current?.();
      patchesAppliedRef.current = null;
      if (!mainDataset) return;
      dirty.onPatchApplied(patches, direction, mainDataset);
      bumpEdit(patches);
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

  // The people and families the marked branches would add, so the Save badge
  // counts a whole branch by its size, not as one.
  const importRecordCount = useMemo(
    () => mainDataset && compareDataset && importRequests.length
      ? branchImportRecords(importRequests, mainDataset, compareDataset, decisions, matches).size
      : 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [importRequests, mainDataset, compareDataset, decisions, matches, editVersion],
  );

  hasUnsavedChangesRef.current = changedCount > 0 || confirmedCount > 0 || importCount > 0;

  async function handleTitleClick() {
    // Whatever the current mode: unsaved edits are lost by a reload whether
    // the user is looking at them or at the match list.
    if (!hasUnsavedChangesRef.current) {
      discardAndReload();
      return;
    }
    // Pass the reload as the dialog's synchronous confirm action; the awaited
    // result is only used to no-op on cancel.
    await confirmDialog(t("app.reloadConfirm"), t("confirm.reload"), discardAndReload);
  }

  /**
   * An individual whose events the save may reorder — see
   * `buildEditSaveRecords`. Both halves are required, and each rules out a
   * different way of reordering events nobody asked to touch:
   *
   * - the ref says the person was edited by hand rather than swept by a
   *   whole-file maintenance pass (a date repair puts dates right; it does not
   *   get to restack the record around them);
   * - the signature says that hand edit was *structural* — it added, removed,
   *   retagged or re-dated an event. Completing a burial place used to qualify
   *   too, and moved the person's untouched death event up the record.
   *
   * A person created this session has no snapshot and no original order to
   * preserve, so canonical order is the only order they have ever had.
   */
  function isSortEligible(xref: string) {
    if (!changedPersonIds.has(xref) || !sortEligiblePersonIdsRef.current.has(xref)) return false;
    const raw = mainDataset?.individuals.get(xref)?.raw;
    if (!raw) return false;
    const snapshot = dirty.personSnapshots.current.get(xref);
    return !snapshot || eventOrderSignature(snapshot) !== eventOrderSignature(raw);
  }

  /** Gather the live workspace state `buildSavePreview` reads. Kept as its own
   *  function so the wiring stays readable next to the one-line `handleSave`. */
  function savePreviewInput(mainDs: Dataset, fileName: string) {
    return {
      main: mainDs,
      mainFileName: fileName,
      homeId: startId,
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
      baseline: dirty.ensureBaseline(),
      personSnapshots: dirty.personSnapshots.current,
      familySnapshots: dirty.familySnapshots.current,
      recordSnapshots: dirty.recordSnapshots.current,
      isSortEligible,
      isSubstantive: dirty.isSubstantive,
      now: new Date(),
      formatOverrides,
      t,
    };
  }

  /**
   * The books a confirmed match will need a source minted for, read in the
   * background from the moment it is confirmed — reviewing the next candidate
   * takes far longer than a page fetch, so by the time the save runs the
   * answers are usually already in this session's cache and it opens at once
   * instead of holding the button (see `queueBookPages`). Only what the reader
   * has allowed: with link lookups off, nothing is requested here either.
   *
   * Each decision is queued once. A book already read, already queued, or
   * already asked and silent costs nothing, so re-running over the whole map is
   * cheap; what a merge would only *cite* (the file has that book) asks nothing.
   */
  const queuedDecisionsRef = useRef(new Set<string>());
  useEffect(() => { queuedDecisionsRef.current = new Set(); }, [compareDataset]);
  useEffect(() => {
    if (!settings.allowLinkFetch || !mainDataset || !compareDataset) return;
    const records: (Individual | Family)[] = [];
    for (const [key, decision] of decisions) {
      if (decision.status !== "confirmed" || queuedDecisionsRef.current.has(key)) continue;
      queuedDecisionsRef.current.add(key);
      const parsed = parseDecisionKey(key);
      const incoming = parsed && compareDataset.individuals.get(parsed.compareId);
      if (!incoming) continue;
      records.push(incoming);
      for (const famId of incoming.spouseOf) {
        const fam = compareDataset.families.get(famId);
        if (fam) records.push(fam);
      }
    }
    if (records.length) queueBookPages(pendingBookLookups(mainDataset.records, records), fetchPageHtml);
  }, [decisions, mainDataset, compareDataset, settings.allowLinkFetch]);

  /**
   * Open the save preview — with one detour: a merge that mints a source for
   * an incoming link names it from the address alone, so where the reader has
   * allowed link lookups the books' own pages are read first and the merge is
   * run again over the answers. Most will have been read already, as matches
   * were confirmed; this waits only for what is left. A link the merge only cites (the file already
   * has that book) asks nothing of the network, and neither does a save with
   * lookups switched off; both open the preview straight away.
   */
  // A file is worth saving with nothing changed when the save itself changes
  // it: converting it to the other GEDCOM version its target format holds it
  // to, or supplying the header, trailer or submitter the version requires.
  const saveWithoutChanges = useMemo(
    () =>
      !!mainDataset &&
      ((target.strict && target.version !== ownVersion(mainDataset)) ||
        completeStructure(mainDataset.records, target.version, false).length > 0),
    // The records change in place; the edit version says when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mainDataset, target, editVersion],
  );

  async function openSavePreview(convertTo?: OutputVersion) {
    if (!mainDataset || main.status !== "loaded") return;
    // A strict target format saves in its own version, converting a file
    // that is in the other one.
    if (!convertTo && target.strict && target.version !== ownVersion(mainDataset)) convertTo = target.version;
    // Converting, or repairing the file's structure, is a reason to save on its
    // own, changed or not.
    const force = !!convertTo || saveWithoutChanges;
    const next = buildSavePreview({ ...savePreviewInput(mainDataset, main.file.fileName), force });
    if (!next) return;
    setPreviewVersion(convertTo);
    if (!settings.allowLinkFetch || next.pendingSourceLookups.length === 0 || readingSources) {
      setPreview(next);
      return;
    }
    setReadingSources(true);
    const read = await readBookPages(next.pendingSourceLookups, fetchPageHtml).catch(() => 0);
    setReadingSources(false);
    // Nothing answered — the offline titles the first pass wrote still stand,
    // and building the same preview twice would only cost the user a wait.
    const enriched = read > 0 ? buildSavePreview({ ...savePreviewInput(mainDataset, main.file.fileName), force }) : null;
    setPreview(enriched ?? next);
  }
  function handleSave(convertTo?: OutputVersion) {
    return withBusyCursor(() => openSavePreview(convertTo));
  }

  // Feed the live save action + its enabled state to the Ctrl/Cmd+S handler.
  globalShortcutRef.current.save = () => void handleSave();
  globalShortcutRef.current.canSave = !!lastMainFile && (changedCount > 0 || confirmedCount > 0 || importCount > 0 || saveWithoutChanges);
  globalShortcutRef.current.addPerson = () => requestAddPerson();
  globalShortcutRef.current.back = goBackPage;

  function handleEditDirty(type: "individual" | "family", id: string) {
    if (!mainDataset) return;
    dirty.markDirty(type, id, mainDataset);
    if (type === "individual") sortEligiblePersonIdsRef.current.add(id);
  }

  /** Dirty state for a completed edit, decided per record from what it now
   *  holds — so a record the edit put back the way it was stops counting as
   *  unsaved (see `reconcile`). For edits whose reach is known only afterwards,
   *  from the patches they turned out to produce. */
  function handleEditRecordsSettled(patches: RecordPatch[]) {
    if (!mainDataset) return;
    for (const p of patches) {
      if (p.type === "record") continue;
      const stillDirty = dirty.reconcile(p.type, p.id, mainDataset);
      if (stillDirty && p.type === "individual") sortEligiblePersonIdsRef.current.add(p.id);
    }
  }

  /** @param excludedTags vendor tags the reader unticked in the preview — the
   *  dialog has already stripped them from the tree, and the report says so. */
  function handleConfirmSave(excludedTags: string[], version: OutputVersion) {
    if (!preview || !mainDataset) return;

    // What this save does to the file as a whole rather than to one record —
    // the report says each of them out loud, since none of them shows up as a
    // change to any single person.
    const fileNotes = charsetNotices(mainDataset, t);
    if (excludedTags.length) {
      fileNotes.push(t("changeReport.note.tagsRemoved", {
        tags: excludedTags.join(", "),
        count: excludedTags.reduce((n, tag) => n + (preview.report.customTags[tag]?.length ?? 0), 0),
      }));
    }

    const usage = mainDataset.chanCreaUsage;
    // Every convention the file might keep, not just CHAN/CREA on people: a
    // MyHeritage file stamps `_UPD` and no CHAN at all, and a file may stamp
    // only its sources. `stampChanCrea` writes nothing where a flag is off.
    if (Object.values(usage).some(Boolean)) {
      // Only substantively changed records get a fresh stamp; a record touched
      // solely by maintenance passes keeps the change date the file gave it —
      // see `SavePreview.stampRecordIds`.
      const stampIds = preview.stampRecordIds;
      const newIds = new Set(
        preview.report.changes.filter((c) => c.newRecord).map((c) => c.recordId),
      );
      const stampNow = new Date();
      if (stampIds.size > 0) {
        stampChanCrea(
          preview.records,
          stampIds,
          newIds,
          usage,
          todayGedcom(stampNow),
          nowGedcomTime(stampNow),
          nowUpdStamp(stampNow),
        );
        fileNotes.push(t("changeReport.note.stamped", { count: stampIds.size }));
      }
      const unstampedCount = [
        ...new Set([...preview.editRecordIds, ...Object.keys(preview.report.recordKinds)]),
      ].filter((id) => !stampIds.has(id)).length;
      if (unstampedCount > 0) {
        fileNotes.push(t("changeReport.note.unstamped", { count: unstampedCount }));
      }
    }

    // The download is always UTF-8 bytes, stamped by GED Merge, and a complete
    // file: a missing header, trailer or declaration is supplied, and said so.
    // Saved in the other GEDCOM version, the records are converted first (see
    // convertVersion) and the report lists what the conversion rewrote.
    const from = ownVersion(mainDataset);
    const { fixes, conversion } = prepareDownload(preview.records, mainDataset, version, undefined, settings.authorName);
    for (const fix of fixes) fileNotes.push(t(`preview.fix.${fix}`, { name: submitterName(settings.authorName) }));
    if (conversion) {
      fileNotes.push(t("changeReport.note.converted", { from, to: version, count: conversion.length }));
      for (const change of conversion) fileNotes.push(`  ${change}`);
    }

    const text = serializeGedcom(preview.records, outputOptions(mainDataset, version));
    // Reuse the exact names shown in the preview dialog (already date-stamped).
    downloadText(preview.files[0], text);
    // The change report is a second download, which some browsers decline to
    // take — and it says what the preview has just shown. So it is written only
    // for a reader who asked for it in the dialog.
    if (settings.saveReport) {
      downloadText(preview.files[1], formatReport(preview.report, {
        t,
        mainFileName: lastMainFile?.fileName,
        savedFileName: preview.files[0],
        compareFileName: preview.isMerge && compare.status === "loaded" ? compare.file.fileName : undefined,
        savedAt: new Date(),
        fileNotes,
        // Headed like the preview's cards the reader has just been through.
        labelOf: recordLabeller(preview.report, mainDataset, nameOf),
      }));
    }

    // A save can name the file better than it was created with — a tree started
    // from nothing arrives as `new-tree` and leaves under its family's surname
    // (see `newFileBase`). Carry that onto the open file so the header, the
    // cache and the next save all agree with what was just downloaded. Undated:
    // the stamp belongs to each download, not to the file being worked on.
    const savedFileName = `${preview.base}.ged`;
    const renamed = !!lastMainFile && lastMainFile.fileName !== savedFileName
      && baseStem(lastMainFile.fileName) !== preview.base;
    const mainFileName = renamed ? savedFileName : lastMainFile?.fileName ?? savedFileName;
    if (renamed) dispatch({ type: "mainRenamed", fileName: savedFileName });

    // The saved file is the new main baseline — refresh the cache so a reload
    // restores the saved state (the confirmed decisions are now baked in and
    // cleared below, so the persisted session debounce will write them away).
    if (persistEnabled) {
      void saveFile("main", { fileName: mainFileName, blob: new Blob([text]), savedAt: Date.now() });
    }

    // The downloaded file is the new main baseline — rebuild the live dataset
    // from the same records (see savedBaseline).
    Object.assign(mainDataset, savedBaseline(mainDataset, preview.records, version));
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
    setSaveToast(t("save.toast", { count: settings.saveReport ? preview.files.length : 1 }));
    setPreview(null);
    // The saved file is the new baseline — undo/redo entries refer to a state
    // that no longer exists, so there's nothing left to meaningfully undo into.
    undoRedo.clearAll();
    // The in-place rebuild above changed the dataset like any edit would, so
    // every memo and panel keyed on editVersion must see a bump — in a
    // merge-only session the counter still sits at 0, and without the bump
    // global search and kinship would keep serving the pre-merge dataset.
    bumpEdit(null);
    // The cached main text (written just above) equals the rebuilt dataset:
    // remember this version as clean and mark the main cached — the debounce
    // (sole main writer) then leaves it alone until the next edit.
    cleanEditVersionRef.current = editVersionRef.current;
    persistence.mainCachedRef.current = true;
    // The worker's main is still the file as loaded; matched against it, a
    // later compare would report people this save just imported as new. Hand
    // it the saved text so its copy is the new baseline too. After the bump
    // above, so the version it records is the one the rebuilt dataset has.
    void refeedWorkerMain(text, mainFileName);
  }

  /** What the dirty tracking knows about a record "Remove from save" would
   *  take out (see `removeFromSave`). */
  function revertTracking(id: string, kind: "individual" | "family"): RevertTracking {
    dirty.ensureBaseline();
    const ownedRecords: [string, GedNode][] = [];
    for (const [xref, snap] of dirty.recordSnapshots.current) {
      if (snap.owner?.kind === kind && snap.owner.id === id) ownedRecords.push([xref, snap.value]);
    }
    return {
      loaded: (kind === "individual" ? dirty.loadedPersonIds : dirty.loadedFamilyIds).current.has(id),
      snapshot: (kind === "individual" ? dirty.personSnapshots : dirty.familySnapshots).current.get(id),
      ownedRecords,
      wasLoadedRecord: (xref) => dirty.baseline.current.has(xref),
    };
  }

  function canRemoveRecordFromSave(id: string, kind: "individual" | "family") {
    return !!mainDataset && canRemoveFromSave(mainDataset, kind, id, revertTracking(id, kind));
  }

  function handleRemoveFromSave(id: string, kind: "individual" | "family") {
    if (!mainDataset || !preview) return;
    const patches = removeFromSave(mainDataset, kind, id, revertTracking(id, kind));
    if (patches.length === 0) return;
    // Keep the snapshot for undo machinery — it is still needed for dirty
    // tracking on undo/redo.
    dirty.removeDirty(kind, id);
    // Snapshot the batch before pushing it, exactly as `handlePushEdit` does:
    // taking a record out of the save unlinks (or prunes) everyone around it,
    // and those records really are changed. Without this they'd reach the
    // file with no snapshot and no dirty flag — changed, and unreported.
    dirty.captureSnapshotsForPush(patches);
    undoRedo.push({ mode: "edit", patches, navigateTo: id });
    // Every record the cascade touched is decided from what it now holds — one
    // the removal put back the way the file had it (the parent a deleted new
    // child was added to) is clean again. The record being taken out of the
    // save is not dirty: `dirty.removeDirty` above said so.
    handleEditRecordsSettled(patches.filter((p) => p.id !== id));
    bumpEdit(patches);
    // The preview was built from the dirty state and the records as they were;
    // the removal changed both. Built again once the dirty state above has
    // landed, by the same function that built it — so the download, the report
    // and the CHAN stamps all agree with the file again, for a merge too.
    setPreviewRebuild((n) => n + 1);
  }

  const [previewRebuild, setPreviewRebuild] = useState(0);
  const rebuildPreviewRef = useRef(() => {});
  rebuildPreviewRef.current = () => {
    if (!preview || !mainDataset || main.status !== "loaded") return;
    setPreview(buildSavePreview(savePreviewInput(mainDataset, main.file.fileName)));
  };
  useEffect(() => {
    if (previewRebuild) rebuildPreviewRef.current();
  }, [previewRebuild]);

  // Modals and the page footer are shared between the main app shell and the
  // full-page tree views, so they're built once here. The User's Guide and the
  // Privacy/Terms pages are standalone static pages (opened from the footer),
  // not in-app modals.
  const appModals = (
    <>
      <ShortcutsModal
        isOpen={showShortcuts}
        onClose={() => setShowShortcuts(false)}
        context={overlayOpen ? "chart" : mainDataset ? mode : undefined}
      />
      <GlobalSearchModal
        isOpen={showGlobalSearch}
        onClose={() => setShowGlobalSearch(false)}
        rows={searchIndex.rows}
        indexProgress={searchIndex.ready ? undefined : searchIndex.progress}
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
        initialTab={settingsTab}
      />
      {confirmDialogElement}
      {/* Save is in the header on a chart too, so its preview and toast must
          show over the chart rather than in the hidden app beneath it. */}
      {preview && (
        <SaveDialog
          report={preview.report}
          title={preview.title}
          records={preview.records}
          beforeRecords={preview.beforeRecords}
          files={preview.files}
          downloadLabel={preview.downloadLabel}
          editRecordIds={preview.editRecordIds}
          integrityWarnings={preview.integrityWarnings}
          dataset={mainDataset}
          initialVersion={previewVersion}
          onConfirm={(excludedTags, version) => void withBusyCursor(() => handleConfirmSave(excludedTags, version))}
          onClose={() => setPreview(null)}
          onNavigate={(id) => {
            setPreview(null);
            // Opened in Edit as a step of its own — from Merge or Tools, a bare
            // setNavigateToId only moved the Edit view hidden behind them.
            if (overlayOpen) navigateFromOverlay(id);
            else navigateFromPage(id);
          }}
          onRemove={handleRemoveFromSave}
          canRemove={canRemoveRecordFromSave}
          onOpenPair={(mainId, compareId) => {
            setPreview(null);
            setSelectedId({ mainId, compareId });
            (overlayOpen ? goToPageFromOverlay : goToPage)({ mode: "merge" });
          }}
        />
      )}
      {saveToast && (
        <div className="save-toast" role="status" onClick={() => setSaveToast(null)}>
          {saveToast}
        </div>
      )}
    </>
  );

  // Panel is forced open whenever Merge mode has no matches yet; otherwise
  // follows the user's showInfoPanel toggle.
  const infoPanelOpen = showInfoPanel || (mode === "merge" && !matches);
  const canClosePanel = !(mode === "merge" && !matches);
  // Show the incoming column in the panel when in Merge mode or a file was loaded.
  const showCompareInPanel = mode === "merge" || compare.status !== "empty";

  function toggleInfoPanel() {
    if (canClosePanel) setShowInfoPanel((p) => !p);
  }

  /** From the ☰ menu, where the panel is out of sight: always open, never toggle. */
  function openInfoPanel() {
    setShowInfoPanel(true);
  }

  // ── Header pieces ────────────────────────────────────────────────────────
  // On a phone the header is one row — brand, mode tabs, ☰ — and everything the
  // desktop header shows beside them (file pills, start person, the four icon
  // buttons) moves into the ☰ menu. The two pieces that swap places between the
  // layouts are built once here and placed by `phone` below.
  const modeTabs = (onChart: boolean) => {
    const tab = (m: Mode, label: string, tooltip: string, key: string, go: () => void) => (
      <button
        className={`seg-btn ${!onChart && mode === m ? "active" : ""}`}
        onClick={() => { if (onChart) leaveOverlayFor(m); else if (mode !== m) go(); }}
        title={keyHint(tooltip, key.toUpperCase())}
      >
        {label}
      </button>
    );
    return (
      <div className="mode-tabs">
        {tab("edit", t("mode.edit"), t("mode.edit.tooltip"), KEY.modeEdit, switchToEdit)}
        {tab("merge", t("mode.merge"), t("mode.merge.tooltip"), KEY.modeMerge, switchToMerge)}
        {tab("tools", t("mode.tools"), t("mode.tools.tooltip"), KEY.modeTools, switchToTools)}
      </div>
    );
  };
  // From a chart, the file pills and the ☰'s files leave the chart for the
  // page it was opened over, with the file panel open there.
  const openFilesFromChart = () => {
    leaveOverlayFor(mode);
    setShowInfoPanel(true);
  };
  const menuFiles: AppMenuFile[] = [
    ...(lastMainFile ? [{ label: t("tree.main"), fileName: lastMainFile.fileName, accent: "main" as const }] : []),
    ...(compare.status === "loaded" ? [{ label: t("tree.incoming"), fileName: compare.file.fileName, accent: "incoming" as const }] : []),
  ];
  const hasSaveAction = !!lastMainFile && (changedCount > 0 || confirmedCount > 0 || importCount > 0 || saveWithoutChanges);
  const hasHistoryAction = !!lastMainFile && (canUndo || canRedo);
  // Save · Undo · Redo. On a wider screen they sit in the header row for good —
  // disabled while there is nothing to save or undo — so they never pop in and
  // shove the row about. On a phone they keep their own row, shown only when
  // one of them has something to do.
  const fileActions = (persistent: boolean) => (
    <div className="app-head-actions">
      {(persistent || hasHistoryAction) && (
        <>
          <button className={persistent ? "nav-btn icon-only undo-btn" : "tree-open-btn undo-btn"} onClick={() => undoStep("undo")} disabled={!canUndo} title={keyHint(t("undo.tooltip"), modLabel("Z"))} aria-label={t("undo")}>
            ↩{!persistent && <> <span className="undo-btn-label">{t("undo")}</span></>}
          </button>
          <button className={persistent ? "nav-btn icon-only undo-btn" : "tree-open-btn undo-btn"} onClick={() => undoStep("redo")} disabled={!canRedo} title={keyHint(t("redo.tooltip"), modShiftLabel("Z"))} aria-label={t("redo")}>
            {!persistent && <><span className="undo-btn-label">{t("redo")}</span> </>}↪
          </button>
        </>
      )}
      {(persistent || hasSaveAction) && (
        <button
          className="export-btn"
          onClick={() => void handleSave()}
          disabled={readingSources || !hasSaveAction}
          title={readingSources ? t("save.readingSources") : hasSaveAction ? keyHint(t("save.gedcom.tooltip"), modLabel("S")) : t("save.nothing.tooltip")}
        >
          {readingSources ? (
            <span>{t("save.readingSources")}</span>
          ) : (
            <>
              <span className="export-btn-label-full">{t("save.gedcom")}</span>
              <span className="export-btn-label-short">{t("save")}</span>
              {hasSaveAction && <>{" "}({new Set([...changedPersonIds, ...changedFamilyIds, ...changedRecordIds, ...confirmedMainIds]).size + importRecordCount})</>}
            </>
          )}
        </button>
      )}
    </div>
  );

  // The one app header, on the app's pages and on a full-page chart alike, so
  // every control keeps its place wherever the user is. On a chart no mode tab
  // is lit — the chart is not a mode — and the tabs, the file pills and Add
  // person each leave the chart (pushed on top of it, so Back returns to it).
  const appHeader = (onChart: boolean) => (
    <header className={onChart ? "app-head tree-shell-head" : "app-head"}>
      <div className="app-head-top">
        <div className="app-head-brand">
          <h1 onClick={handleTitleClick} className="brand-clickable" title={t("app.brand.tooltip")}>
            {/* One header row on a phone: the lockup steps down so the mode
                tabs and ☰ fit beside it. */}
            <Wordmark size={phone ? 17 : 22} />
          </h1>
          {/* Below 880px (and on a phone) the ☰ lists the files instead. */}
          {!filesInMenu && (lastMainFile || compare.status === "loaded") && (
            <div className="app-head-file-pills">
              {lastMainFile && (
                <button className="header-file-btn gm-file main" onClick={onChart ? openFilesFromChart : toggleInfoPanel} title={`${t("tree.main")}: ${lastMainFile.fileName} — ${t("header.filePill.hint")}`}>
                  <span className="header-file-name">{lastMainFile.fileName}</span>
                  <span className="header-file-caret" aria-hidden="true">{!onChart && infoPanelOpen ? "▴" : "▾"}</span>
                </button>
              )}
              {compare.status === "loaded" && (
                <button className="header-file-btn gm-file incoming" onClick={onChart ? openFilesFromChart : toggleInfoPanel} title={`${t("tree.incoming")}: ${compare.file.fileName} — ${t("header.filePill.hint")}`}>
                  <span className="header-file-name">{compare.file.fileName}</span>
                  <span className="header-file-caret" aria-hidden="true">{!onChart && infoPanelOpen ? "▴" : "▾"}</span>
                </button>
              )}
            </div>
          )}
        </div>
        {/* One row: brand · mode tabs (centred) · file actions + tools. A phone
            keeps the tabs here too, but its Save/Undo/Redo drop to a row of
            their own below, shown only when there is something to save or undo. */}
        {mainDataset && modeTabs(onChart)}
        <div className="lang-switcher">
          {!phone && mainDataset && (
            <>
              {fileActions(true)}
              <span className="app-head-divider" aria-hidden="true" />
            </>
          )}
          {!phone && mainDataset && (
            <button
              className={`nav-btn icon-only charts-open-btn${onChart ? " active" : ""}`}
              onClick={onChart ? undefined : openChartsFromHeader}
              aria-pressed={onChart || undefined}
              title={keyHint(t("charts.header.tooltip"), KEY.tree.toUpperCase())}
              aria-label={t("edit.charts.button")}
            >
              <ChartIcon size={18} />
            </button>
          )}
          {!phone && mainDataset && (
            <button
              className="nav-btn icon-only"
              onClick={() => setShowGlobalSearch(true)}
              title={keyHint(t("globalSearch.tooltip"), "/")}
              aria-label={t("globalSearch.title")}
            >
              <SearchIcon size={18} />
            </button>
          )}
          {!phone && !compactHead && mainDataset && (
            <button
              className="nav-btn icon-only"
              onClick={() => requestAddPerson()}
              title={keyHint(t("edit.addNewPerson.tooltip"), KEY.addPerson.toUpperCase())}
              aria-label={t("edit.addNewPerson")}
            >
              <AddPersonIcon size={18} />
            </button>
          )}
          {!phone && !compactHead && (
            <button
              className="nav-btn icon-only"
              onClick={() => setShowSettings(true)}
              title={t("settings.title")}
              aria-label={t("settings.title")}
            >
              <GearIcon size={18} />
            </button>
          )}
          {!phone && !compactHead && (
            <button
              className="nav-btn icon-only shortcuts-btn"
              onClick={() => setShowShortcuts(true)}
              title={keyHint(t("shortcuts.title"), "?")}
              aria-label={t("shortcuts.title")}
            >
              <HelpIcon size={18} />
            </button>
          )}
          {/* The ☰ is the phone header's one button from the landing page on,
              so it never changes identity under the user's thumb — with no
              file loaded it simply holds less. */}
          {phone && (
            <AppMenu
              open={onChart ? chartMenuOpen : menuOpen}
              onOpenChange={onChart ? setChartMenuOpen : setMenuOpen}
              files={menuFiles}
              onOpenFiles={onChart ? openFilesFromChart : openInfoPanel}
              onCharts={mainDataset ? openChartsFromHeader : undefined}
              onSearch={mainDataset ? () => setShowGlobalSearch(true) : undefined}
              onAddPerson={mainDataset ? () => requestAddPerson() : undefined}
              onSettings={() => setShowSettings(true)}
              onShortcuts={() => setShowShortcuts(true)}
            />
          )}
          {/* Narrow desktop: Charts and Search stay in the row, so the ☰ holds
              the three icons it displaces — and, below 880px, the files. */}
          {compactHead && (
            <AppMenu
              open={onChart ? chartMenuOpen : menuOpen}
              onOpenChange={onChart ? setChartMenuOpen : setMenuOpen}
              files={filesInMenu ? menuFiles : []}
              onOpenFiles={onChart ? openFilesFromChart : openInfoPanel}
              onAddPerson={mainDataset ? () => requestAddPerson() : undefined}
              onSettings={() => setShowSettings(true)}
              onShortcuts={() => setShowShortcuts(true)}
            />
          )}
        </div>
      </div>
      {phone && mainDataset && (hasSaveAction || hasHistoryAction) && (
        <div className="app-head-controls">
          {fileActions(false)}
        </div>
      )}
    </header>
  );

  const appFooter = <AppFooter onShortcuts={() => setShowShortcuts(true)} />;

  // Full-page tree views (Compare / the Charts hub) keep the app's own header
  // and footer around the tree so the page never feels detached from the rest
  // of the app. Not on a phone: the shell is a fixed frame around a canvas that
  // wants every pixel, and the view's own Back button is one tap from it.
  const wrapTree = (content: React.ReactNode) => (
    <div className="app tree-shell">
      {!phone && appHeader(true)}
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
    const mainDs = mainDataset;
    const compareDs = compareDataset;
    // A pair is named by its main-file person, or the incoming one when the
    // main side is empty.
    const pairLabel = ({ mainId, compareId }: { mainId: string; compareId: string }) => {
      const indi = (mainId && mainDs.individuals.get(mainId)) || (compareId && compareDs.individuals.get(compareId));
      return indi ? lifespanLabel(indi) : mainId || compareId;
    };
    treeOverlay = wrapTree(
      <ChartTrailContext.Provider value={{ labels: treeTrail.items.map(pairLabel), idx: treeTrail.idx, onStep: stepTreeTrail }}>
      <CompareTree
        mainDs={mainDataset}
        compareDs={compareDataset}
        matches={matches}
        rootMainId={treeView.mainId}
        rootCompareId={treeView.compareId}
        mode={treeView.mode}
        onModeChange={changeTreeMode}
        onReroot={rerootTree}
        onBack={goBackPage}
        onShowInMatches={showInMatches}
        decisions={decisions}
        changedPersonIds={changedPersonIds}
        onDecide={setPairStatus}
        importBranches={importBranches}
        onToggleImport={toggleImportBranch}
        startId={startId}
        onOpenInEdit={navigateFromOverlay}
      />
      </ChartTrailContext.Provider>
    );
  } else if (chartsRootId && mainDataset) {
    const ds = mainDataset;
    const personLabel = (id: string) => {
      const indi = ds.individuals.get(id);
      return indi ? lifespanLabel(indi) : id;
    };
    // Back names the person it returns to, apart from whoever the chart now
    // shows — the E key and "Open in Edit" are for that one.
    const backLabel = chartsFromId && ds.individuals.has(chartsFromId)
      ? t("charts.back.withPerson", { back: t(chartsBackKey), name: personLabel(chartsFromId) })
      : t(chartsBackKey);
    treeOverlay = wrapTree(
      <ChartTrailContext.Provider value={{ labels: chartsTrail.ids.map(personLabel), idx: chartsTrail.idx, onStep: stepChartsTrail }}>
        <ChartsHub
          mainDs={ds}
          rootId={chartsRootId}
          // Re-rooting joins the hub's trail (openCharts) rather than stacking
          // history entries, so Back leaves the hub in one press.
          onRootChange={(id) => openCharts(id)}
          startId={startId}
          changedPersonIds={changedPersonIds}
          decisions={decisions}
          backLabel={backLabel}
          onBack={goBackPage}
          onNavigate={navigateFromOverlay}
          onPickStart={changeStart}
          onOpenGeocode={() => goToPageFromOverlay({ mode: "tools", tool: "places", toolView: "geocode" })}
        />
      </ChartTrailContext.Provider>
    );
  }

  return (
    <DatasetProvider dataset={mainDataset}>
    <TargetFormatContext.Provider value={targetFormat}>
    <DatasetDerivationsProvider dataset={mainDataset} version={editVersion} changes={changeJournal}>
    <PwaReloadPrompt />
    <IconTipLayer />
    {treeOverlay}
    <div className="app" style={treeOverlay ? { display: "none" } : undefined}>
      {appHeader(false)}
      {/* The open questions about the loaded file, under the header and in the
          flow: they push the view down rather than cover it, stack one under
          another, and each stays until it is answered. */}
      <div className="notice-stack">
        {targetNotice && (
          <Notice
            className="target-notice"
            message={targetProposal?.software
              ? t("target.kept.software", { software: targetProposal.software })
              : t("target.kept")}
            actions={[
              {
                label: t("target.notice.settings"),
                primary: true,
                onClick: () => {
                  setTargetNotice(false);
                  setSettingsTab("format");
                  setShowSettings(true);
                },
              },
              { label: t("target.notice.hide"), onClick: hideTargetNotice },
              { label: t("help.close"), onClick: () => setTargetNotice(false) },
            ]}
          />
        )}
        <AutoMediaOffer main={main} />
      </div>

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
          onShortcuts={() => setShowShortcuts(true)}
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
              onSelectIndex={onSelectIndex}
              onSelect={select}
              decisions={decisions}
              changedPersonIds={changedPersonIds}
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
              onShowCharts={openCharts}
              canNavigatePerson={canNavigatePerson}
              onNavigatePerson={navigatePerson}
              onOpenPair={openPair}
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
              onRecordsSettled={handleEditRecordsSettled}
              onShowCharts={openCharts}
              marriedNameTag={lastMainFile.marriedNameTag}
              navigateToId={navigateToId}
              onNavigated={() => setNavigateToId(undefined)}
              historyToId={historyPersonId}
              onHistoryNavigated={() => setHistoryPersonId(undefined)}
              // Back is the browser's, so it walks the pages in the order they
              // were visited — the people opened one after another, and the
              // Tools tab or chart a person was opened from.
              canGoBack={canGoBack}
              onGoBack={goBackPage}
              onPersonChange={(id, fromHistory) => {
                setEditPersonId(id);
                // Every person opened in Edit is a browser-history step, so
                // Back walks back through them like Edit's own Back button —
                // except the ones a Back press itself brought back, which are
                // the app arriving on an entry rather than making one.
                recordEditPerson(id, fromHistory);
              }}
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
              externalEditGen={toolEditGen}
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
              changeJournal={changeJournal}
              editVersion={editVersion}
              fileName={lastMainFile.fileName}
              // Tags the current entry as Tools and pushes an Edit entry, so
              // Back — the browser's, Edit's own button, ⌫ — returns to the
              // Tools tab the person was opened from.
              onNavigate={navigateFromPage}
              active={mode === "tools"}
              // The open tool and its open page are the app's, because each is
              // a step: going to either is a page the browser Back button can
              // undo, and a tool's own Back button walks up to its front page.
              tool={tool}
              view={toolView}
              onToolChange={(next) => goToPage({ tool: next, toolView: "tree" })}
              onViewChange={(next) => goToPage({ toolView: next })}
              onAddSource={(fields) =>
                applyToolPatches(
                  createStandaloneSource(mainDataset.records, fields, {
                    sourceLayout: formatOverrides.sourceLayout ?? "auto",
                    standard: formatOverrides.standard,
                  }).extraPatches,
                )
              }
              onEditSource={(sourceXref, fields) =>
                applySharedRecordEdit((records, notes) => {
                  const node = records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
                  if (node) setSourceRecordFields(records, node, fields, notes, formatOverrides);
                })
              }
              onRemoveSource={(sourceXref) => applySharedRecordEdit(() => pruneUnreferencedSource(mainDataset, sourceXref))}
              onEditRepo={(repoXref, fields) =>
                applySharedRecordEdit((records, notes) => {
                  const node = records.find((r) => r.tag === "REPO" && r.xref === repoXref);
                  if (node) setRepoRecordFields(records, node, fields, notes);
                })
              }
              onEditMediaInfo={(objeXref, fields) =>
                applySharedRecordEdit((records) => {
                  const node = records.find((r) => r.tag === "OBJE" && r.xref === objeXref);
                  if (!node) return;
                  setMediaInfo(node, fields, records, formatOverrides);
                  if (isPrivateNode(node) !== fields.private) setPrivateFlag(node, fields.private, formatOverrides.privacy ?? detectPrivacyStyle(records), records);
                  bumpSourceCacheVersion(records);
                })
              }
              onApplyPlaceRename={(from, to, scope) => { applyToolPatches(applyPlaceRename(mainDataset, from, to, scope), true); }}
              onApplyGeocode={(assignments) => applyToolPatches(applyGeocode(mainDataset, assignments), true)}
              onApplyAddressCoords={(assignments) => applyToolPatches(applyAddressCoords(mainDataset, assignments), true)}
              onClearPlaceCoords={(pairs) => applyToolPatches(clearPlaceCoords(mainDataset, pairs), true)}
              onRenamePlaceValue={(from, to, addr) => applyToolPatches(renamePlaceValue(mainDataset, from, to, addr), true)}
              onApplyOfficialNames={(renames) => {
                // One batch → one undo step — and one pass over the records
                // per concern: every row's rename in a single walk, then every
                // coordinate in a single applyGeocode (row-by-row walks froze
                // the tab when "Use official names" took hundreds of rows).
                // Coalesced because the two passes patch the same records —
                // otherwise undo applies both befores and the later
                // (already-renamed) one wins, undoing only the coordinate.
                // A rewording with no register match behind it (the
                // place/address split) brings no coordinate to write.
                const coords = new Map(
                  renames.filter((r) => r.assignment).map((r) => [r.to, r.assignment!] as const),
                );
                return applyToolPatches(
                  coalescePatches([
                    ...renamePlaceValues(mainDataset, renames),
                    ...(coords.size ? applyGeocode(mainDataset, coords) : []),
                  ]),
                  true,
                );
              }}
              onRenameAddresses={(renames) =>
                // One batch → one undo step, the way the official-name renames
                // above are applied: a list of houses taken from the register in
                // a single act must come back in a single act too. Coalesced
                // because two houses of one village share records.
                //
                // An empty `to` is the rename field emptied — the house's events
                // are to carry no address at all, which is a removal and not a
                // rewrite, and travels this same path so that it lands in the
                // same single undo step.
                applyToolPatches(
                  coalescePatches(
                    renames.flatMap((r) =>
                      r.to.trim()
                        ? renameAddress(mainDataset, r.rawKeys, r.from, r.to)
                        : removeAddress(mainDataset, r.rawKeys, r.from),
                    ),
                  ),
                  true,
                )
              }
              onMovePlaceForAddresses={(keys, toPlace, coord) => applyToolPatches(movePlaceForAddresses(mainDataset, keys, toPlace, coord), true)}
              startId={startId}
              onFixBrokenLinks={(only) => applyToolPatches(fixBrokenLinks(mainDataset, only), true)}
              onFixSexFromRole={(only) => applyToolPatches(fixSexFromRole(mainDataset, only), true)}
              onFixSwappedRoles={(only) => applyToolPatches(fixSwappedRoles(mainDataset, only), true)}
              onFixDates={(only) => applyToolPatches(fixDates(mainDataset, only), true)}
              onFixNonStandardDates={(only) => applyToolPatches(fixNonStandardDates(mainDataset, formatOverrides, only), true)}
              onFixDuplicatePointers={(only) => applyToolPatches(fixDuplicatePointers(mainDataset, only), true)}
              onFixDuplicateFamilies={(only) => applyToolPatches(fixDuplicateFamilies(mainDataset, only), true)}
              onFixDanglingRefs={(only) => applyToolPatches(fixDanglingRefs(mainDataset, only), true)}
              onFixConformance={(kind, only) => applyToolPatches(fixConformance(mainDataset, kind, only), true)}
              onFillPlaceCoords={() => applyToolPatches(fillPlaceCoordsFromFile(mainDataset), true)}
              onTagTranslations={(choices) => applyToolPatches(tagTranslations(mainDataset, choices), true)}
              onSetPlaceTranslations={(values, list) => applyToolPatches(setPlaceTranslations(mainDataset, values, list), true)}
              onApplyBatchPatches={(patches) => applyToolPatches(patches, true)}
              onMergeDuplicate={(survivorId, removedId, decision, alsoMerge) => {
                // Ticked parents/partners merge first: their families fold
                // together on their own, so this pair then finds one set of
                // parents instead of having to drop a link. Ticked children go
                // last, once the pair's families are one and their own merge has
                // no parents choice left to make (see `mergeDuplicateChain`).
                const step = (r: { survivorId: string; removedId: string }) => ({
                  survivorId: r.survivorId,
                  removedId: r.removedId,
                  decision: { status: "confirmed" as const, fields: {} },
                });
                const steps = [
                  ...alsoMerge.filter((r) => r.when === "before").map(step),
                  { survivorId, removedId, decision },
                  ...alsoMerge.filter((r) => r.when === "after").map(step),
                ];
                if (applyToolPatches(mergeDuplicateChain(mainDataset, steps, t)) === 0) return false;
                // The absorbed records are gone from the dataset. Anything still
                // pointing at one would render the "no person" empty state, so
                // follow it to the survivor it was merged into.
                for (const step of steps) {
                  if (editPersonId === step.removedId) setNavigateToId(step.survivorId);
                  if (startId === step.removedId) changeStart(step.survivorId);
                }
                return true;
              }}
              onMergeCluster={(survivorId, memberIds, groups) => {
                // One person entered N times: the planner turns the cluster
                // (and the ticked relative groups) into a chain of the very
                // merges the pairwise button runs — see `mergeCluster`.
                const { patches, removedIds, survivorOf } = mergeCluster(
                  mainDataset,
                  survivorId,
                  memberIds,
                  groups,
                  t,
                );
                if (applyToolPatches(patches) === 0) return [];
                // Anything still pointing at an absorbed record would render
                // the "no person" empty state; follow it to the record it was
                // merged into (a group's records fold into their own survivor).
                for (const removed of removedIds) {
                  const keep = survivorOf.get(removed);
                  if (!keep) continue;
                  if (editPersonId === removed) setNavigateToId(keep);
                  if (startId === removed) changeStart(keep);
                }
                return removedIds;
              }}
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
      {appFooter}
      {/* While a full-page overlay is up, its own shell renders the modals —
          mounting them here too would duplicate every dialog in the DOM. */}
      {!treeOverlay && appModals}
    </div>
    </DatasetDerivationsProvider>
    </TargetFormatContext.Provider>
    </DatasetProvider>
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

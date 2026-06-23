import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { type RecordPatch, type PendingEditApply, cloneRaw } from "./ui/historyTypes";
import { useTranslation } from "react-i18next";
import type { Dataset, GedNode } from "./gedcom/types";
import { buildDataset } from "./gedcom/builder";
import { rebuildIndividual, rebuildFamily, removeIndividual, removeFamily } from "./gedcom/edit";
import { serializeGedcom } from "./gedcom/serialize";
import { mergeDecisions, formatReport, type ChangeReport } from "./merge/merge";
import { buildEditReport, enrichEditReport, combineReports, removeRecordFromReport } from "./gedcom/editReport";
import { defaultHomeId } from "./match/relatives";
import type { NormalizationReport, PlaceLayout, SourceLayout } from "./normalize/types";
import type { DatasetRole, WorkerResponse } from "./worker/messages";
import type { MatchResult } from "./match/types";
import { decisionKey, type CandidateDecision, type MatchDecisionStatus } from "./review/types";
import { downloadText } from "./ui/download";
import { GedcomLoader } from "./ui/GedcomLoader";
import { CompareTree } from "./ui/CompareTree";
import { HelpModal } from "./ui/HelpModal";
import { LegalModal } from "./ui/LegalModal";
import { MergeView } from "./ui/MergeView";
import { EditView } from "./ui/EditView";
import { SaveDialog } from "./ui/SaveDialog";
import { EditTree } from "./ui/EditTree";
import { Landing } from "./ui/Landing";
import { Wordmark } from "./ui/icons/LogoMark";
import type { TreeMode } from "./tree/compareTree";
import {
  applyFilters,
  applySort,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  nextSort,
  STATUS_RANK,
  type Candidate,
  type Filters,
  type SortKey,
  type SortState,
} from "./ui/matchView";

interface LoadedFile {
  fileName: string;
  dataset: Dataset;
  report?: NormalizationReport;
  placeLayout?: PlaceLayout;
  dateFormat?: string;
  sourceLayout?: SourceLayout;
}

type SlotState =
  | { status: "empty" }
  | { status: "loading"; fileName: string }
  | { status: "loaded"; file: LoadedFile }
  | { status: "error"; fileName: string; message: string };

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

const LANG_FLAGS: Record<string, string> = { en: "🇬🇧", sl: "🇸🇮" };

// Reuses the landing.samples.<key>.name translation keys, so the sample
// label is only defined once per language.
const SAMPLE_FILES = [
  { file: "EuropeRoyalFamilies.ged", key: "europe" },
  { file: "EnglishTudorRoyalFamily.ged", key: "tudor" },
  { file: "USPresidents.ged", key: "presidents" },
];

type Theme = "light" | "dark";
const THEME_KEY = "gedmerge.theme";

type Mode = "merge" | "edit";
const MODE_KEY = "gedmerge.mode";
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

/** Current theme from the <html data-theme> the inline boot script set, else
 * the OS preference. */
function detectTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function App() {
  const { t, i18n } = useTranslation();

  const workerRef = useRef<Worker | null>(null);
  // Whether we've already attempted the one-time default home person for the
  // currently loaded master, so a user who clears it isn't re-defaulted.
  const autoHomeRef = useRef(false);
  // Timestamp the "matching" spinner started, and the pending timer delaying
  // its "matched" result — see MIN_MATCHING_DISPLAY_MS below.
  const matchingStartRef = useRef<number | null>(null);
  const matchedTimerRef = useRef<number | null>(null);
  const [master, setMaster] = useState<SlotState>({ status: "empty" });
  const [compare, setCompare] = useState<SlotState>({ status: "empty" });
  // The most recently *successfully* loaded master file, kept around while a
  // reload is in progress so the Merge/Edit views stay mounted (showing the
  // previous data) instead of falling back to the landing page while
  // `master` is transiently "loading" or "error".
  const [lastMasterFile, setLastMasterFile] = useState<LoadedFile | null>(null);
  const [matches, setMatches] = useState<MatchResult | null>(null);
  const [matching, setMatching] = useState(false);
  const [homeId, setHomeId] = useState<string | undefined>(undefined);
  // When the first matches arrive with no home person, focus the picker so the
  // user can start typing immediately.
  const [focusHome, setFocusHome] = useState(false);
  const [decisions, setDecisions] = useState<Map<string, CandidateDecision>>(new Map());
  // Keeps current decisions accessible from stable useCallback closures.
  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;
  // Tracks whether there are unsaved changes — updated each render so the
  // stable popstate handler can check without stale-closure issues.
  const hasUnsavedChangesRef = useRef(false);

  // ── Unified undo/redo (edit + merge in one stack) ─────────────────────────
  type UndoEntry =
    | { mode: "edit"; patches: RecordPatch[]; navigateTo?: string; redoNavigateTo?: string }
    | { mode: "merge"; before: Map<string, CandidateDecision>; after: Map<string, CandidateDecision>; masterId: string; compareId: string };
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  // Queued edit-patch apply: consumed by EditView once it is mounted.
  const [pendingEditApply, setPendingEditApply] = useState<PendingEditApply | null>(null);

  // Matches list view state.
  const [sort, setSort] = useState<SortState[]>(DEFAULT_SORT);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedId, setSelectedId] = useState<{ masterId: string; compareId: string } | null>(null);
  const [showFilters, setShowFilters] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [showLegal, setShowLegal] = useState(false);
  const [legalPage, setLegalPage] = useState<"privacy" | "terms">("privacy");
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
  const [showMobileWarning, setShowMobileWarning] = useState(
    () => window.innerWidth <= 880 && !localStorage.getItem("mobileWarningDismissed")
  );
  // Brief confirmation shown after a successful download; auto-dismisses.
  const [saveToast, setSaveToast] = useState<string | null>(null);
  useEffect(() => {
    if (!saveToast) return;
    const id = setTimeout(() => setSaveToast(null), 4000);
    return () => clearTimeout(id);
  }, [saveToast]);
  const compareRef = useRef<HTMLDivElement>(null);

  const [openMatches, setOpenMatches] = useState(false);

  // File-info panel: forced open when Merge has no matches yet; otherwise toggleable.
  const [showInfoPanel, setShowInfoPanel] = useState(false);

  // Merge / Edit mode; defaults to "edit" on first use.
  const [mode, setMode] = useState<Mode>(
    () => {
      const saved = localStorage.getItem(MODE_KEY);
      return saved === "merge" || saved === "edit" ? saved : "edit";
    },
  );
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // ignore storage failures (private mode); the in-memory choice still applies
    }
  }, [mode]);

  // Light/dark theme: auto-detected from the OS, overridable, and persisted.
  const [theme, setTheme] = useState<Theme>(detectTheme);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => {
    // Follow OS changes only while the user hasn't made an explicit choice.
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e: MediaQueryListEvent) => {
      if (!localStorage.getItem(THEME_KEY)) setTheme(e.matches ? "light" : "dark");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  function toggleTheme() {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(THEME_KEY, next);
      } catch {
        // ignore storage failures (private mode); the in-memory choice still applies
      }
      return next;
    });
  }

  // Full-page "Compare tree" view, kept in sync with browser history so the
  // back button returns to the main view.
  const [treeView, setTreeView] = useState<TreeView | null>(null);

  useEffect(() => {
    // Tag the initial history entry so navigating back past all SPA pushStates
    // (state === null) means the user is about to leave the app entirely.
    if (!window.history.state?.gedPage) {
      window.history.replaceState({ ...window.history.state, gedPage: "main" }, "");
    }

    function onPop(e: PopStateEvent) {
      // null state = browser navigated back before the SPA's initial entry.
      // Re-push a sentinel and ask for confirmation if there are unsaved changes.
      if (e.state === null) {
        if (hasUnsavedChangesRef.current) {
          window.history.pushState({ gedPage: "main" }, "");
          if (!window.confirm(t("app.navLeaveConfirm"))) return;
          // User confirmed leaving — actually go back now.
          window.history.back();
        }
        return;
      }
      const st = e.state as { gedTree?: TreeView; gedSel?: SelRef; gedEditTreeId?: string };
      setTreeView(st.gedTree ?? null);
      setEditTreeId(st.gedEditTreeId ?? null);
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
  function changeTreeMode(mode: TreeMode) {
    setTreeView((cur) => {
      if (!cur) return cur;
      const next = { ...cur, mode };
      window.history.replaceState({ gedTree: next }, "");
      return next;
    });
  }

  useEffect(() => {
    const worker = new Worker(new URL("./worker/gedcom.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "matching") {
        if (matchedTimerRef.current != null) {
          window.clearTimeout(matchedTimerRef.current);
          matchedTimerRef.current = null;
        }
        if (matchingStartRef.current === null) matchingStartRef.current = performance.now();
        setMatching(true);
        return;
      }
      if (msg.type === "matched") {
        const applyMatched = () => {
          matchingStartRef.current = null;
          matchedTimerRef.current = null;
          setMatches(msg.result);
          setMatching(false);
          setSelectedId(null);
          setOpenMatches(true);
          setShowInfoPanel(false);
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
      const setter = msg.role === "master" ? setMaster : setCompare;
      if (msg.type === "parsed") {
        const file: LoadedFile = { fileName: msg.fileName, dataset: msg.dataset };
        if (msg.report) file.report = msg.report;
        if (msg.placeLayout) file.placeLayout = msg.placeLayout;
        if (msg.dateFormat) file.dateFormat = msg.dateFormat;
        if (msg.sourceLayout) file.sourceLayout = msg.sourceLayout;
        setter({ status: "loaded", file });
        if (msg.role === "master") setLastMasterFile(file);
      } else {
        setter({ status: "error", fileName: msg.fileName, message: msg.message });
      }
    };

    return () => {
      if (matchedTimerRef.current != null) window.clearTimeout(matchedTimerRef.current);
      worker.terminate();
    };
  }, []);

  async function loadSample(role: DatasetRole, fileName: string) {
    const res = await fetch(`samples/${fileName}`);
    const blob = await res.blob();
    loadFile(role, new File([blob], fileName, { type: "text/plain" }));
  }

  async function loadFile(role: DatasetRole, file: File) {
    if (role === "master" && (changedCount > 0 || confirmedCount > 0)) {
      if (!window.confirm(t("load.masterReplaceConfirm"))) return;
    }
    if (role === "compare" && confirmedCount > 0) {
      if (!window.confirm(t("load.incomingReplaceConfirm"))) return;
    }

    const setter = role === "master" ? setMaster : setCompare;
    // macOS hands back filenames in decomposed (NFD) form, e.g. "Kovačič" as
    // c + combining caron. Our subset fonts don't carry the combining marks, so
    // the accent mispositions; normalize to NFC (precomposed) for display.
    const fileName = file.name.normalize("NFC");
    setter({ status: "loading", fileName });
    // Drop stale results + decisions; the worker will emit fresh matches once
    // both sides are (re)loaded and re-normalized.
    setMatches(null);
    setDecisions(new Map());
    setPendingEditApply(null);
    setPreview(null);
    setOpenMatches(false);
    if (role === "master") {
      undoStack.current = [];
      redoStack.current = [];
      setCanUndo(false);
      setCanRedo(false);
      setChangedPersonIds(new Set());
      setChangedFamilyIds(new Set());
      personSnapshots.current = new Map();
      familySnapshots.current = new Map();
      loadedPersonIds.current = new Set();
      loadedFamilyIds.current = new Set();
      setEditTreeId(null);
      setHomeId(undefined); // home person is opt-in; reset on (re)load
      setFocusHome(false);
      autoHomeRef.current = false; // allow the default home person for the new file
    } else {
      // Incoming reload: edit entries remain valid (they only touch master data).
      // Drop merge entries whose field comparisons reference the old incoming file.
      undoStack.current = undoStack.current.filter(e => e.mode === "edit");
      redoStack.current = redoStack.current.filter(e => e.mode === "edit");
      setCanUndo(undoStack.current.length > 0);
      setCanRedo(redoStack.current.length > 0);
    }
    const buffer = await file.arrayBuffer();
    const isCsv = role === "compare" && /\.csv$/i.test(fileName);
    workerRef.current?.postMessage(
      isCsv ? { type: "parseCsv", fileName, buffer } : { type: "parse", role, fileName, buffer },
      [buffer], // transfer ownership — avoids copying large files
    );
  }

  function changeHome(id: string | undefined) {
    setHomeId(id);
    workerRef.current?.postMessage({ type: "setHome", id: id ?? "" });
  }

  // Capture the set of IDs that exist at load time so we can later distinguish
  // "modified existing" from "newly added" when reverting via Remove from save.
  useEffect(() => {
    if (master.status !== "loaded") return;
    const ds = master.file.dataset;
    loadedPersonIds.current = new Set(ds.individuals.keys());
    loadedFamilyIds.current = new Set(ds.families.keys());
    personSnapshots.current = new Map();
    familySnapshots.current = new Map();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master.status]);

  // When the master finishes loading, default the home person to its root
  // individual if present. Attempted once per file (autoHomeRef), so a user
  // who later clears the home person isn't overridden.
  useEffect(() => {
    if (master.status !== "loaded" || autoHomeRef.current) return;
    autoHomeRef.current = true;
    if (homeId) return;
    const home = defaultHomeId(master.file.dataset);
    if (home) {
      changeHome(home);
    } else {
      setFocusHome(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [master.status]);

  // In merge mode, also attempt once when first match results arrive (covers
  // the case where master loaded before the worker finished computing matches).
  useEffect(() => {
    if (!matches || autoHomeRef.current) return;
    autoHomeRef.current = true;
    if (homeId) return;
    const ds = master.status === "loaded" ? master.file.dataset : undefined;
    const home = ds ? defaultHomeId(ds) : undefined;
    if (home) {
      changeHome(home);
    } else {
      setFocusHome(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  function toggleSort(key: SortKey) {
    setSort((prev) => nextSort(prev, key));
  }

  // Sorted (but not filtered) list — used for navigation across all matches
  // regardless of the active filter, and as the base for the filtered display.
  const allSorted = useMemo(() => {
    if (!matches) return [];
    const statusRank = (c: Candidate) =>
      STATUS_RANK[decisions.get(decisionKey("individual", c.masterId, c.compareId))?.status ?? "undecided"];
    return applySort(matches.individuals, sort, statusRank);
  }, [matches, sort, decisions]);

  // Filtered list for display — preserves the sort order of allSorted.
  const visible = useMemo(() => applyFilters(allSorted, filters), [allSorted, filters]);

  // Pair-key → position maps rebuilt only when the sorted/filtered list changes,
  // not on every prev/next click — turns the three find/findIndex scans below
  // from O(n) per navigation into O(1).
  const allSortedMap = useMemo(() => {
    const m = new Map<string, number>();
    allSorted.forEach((c, i) => m.set(`${c.masterId}|${c.compareId}`, i));
    return m;
  }, [allSorted]);
  const visibleMap = useMemo(() => {
    const m = new Map<string, number>();
    visible.forEach((c, i) => m.set(`${c.masterId}|${c.compareId}`, i));
    return m;
  }, [visible]);

  // The currently selected candidate (ID-based, survives filter changes).
  // Falls back to the first in allSorted when no explicit selection exists.
  const current = useMemo(() => {
    if (allSorted.length === 0) return undefined;
    if (!selectedId) return allSorted[0];
    const i = allSortedMap.get(`${selectedId.masterId}|${selectedId.compareId}`);
    return i !== undefined ? allSorted[i] : allSorted[0];
  }, [allSorted, allSortedMap, selectedId]);

  // Index of current in the visible (filtered) list — -1 when filtered out.
  const visibleIndex = useMemo(() => {
    if (!current) return -1;
    return visibleMap.get(`${current.masterId}|${current.compareId}`) ?? -1;
  }, [visibleMap, current]);

  // Index of current in allSorted — used for prev/next navigation bounds.
  const allSortedIndex = useMemo(() => {
    if (!current) return 0;
    return allSortedMap.get(`${current.masterId}|${current.compareId}`) ?? 0;
  }, [allSortedMap, current]);

  // Person id -> candidate, so a relative's name can jump to their own match.
  // A person with several candidates resolves to the first (highest-ranked) one.
  // Built over allSorted so navigation works regardless of the active filter.
  const indexByMaster = useMemo(() => {
    const m = new Map<string, Candidate>();
    allSorted.forEach((c) => { if (!m.has(c.masterId)) m.set(c.masterId, c); });
    return m;
  }, [allSorted]);
  const indexByCompare = useMemo(() => {
    const m = new Map<string, Candidate>();
    allSorted.forEach((c) => { if (!m.has(c.compareId)) m.set(c.compareId, c); });
    return m;
  }, [allSorted]);

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


  function dismissMobileWarning() {
    localStorage.setItem("mobileWarningDismissed", "true");
    setShowMobileWarning(false);
  }

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

  // Keyboard navigation within the filtered visible list (ignored while typing).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      if (visibleRef.current.length === 0) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        const idx = Math.max(0, visibleIndexRef.current - 1);
        const c = visibleRef.current[idx];
        if (c) setSelectedId({ masterId: c.masterId, compareId: c.compareId });
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        const idx = Math.min(visibleRef.current.length - 1, visibleIndexRef.current + 1);
        const c = visibleRef.current[idx];
        if (c) setSelectedId({ masterId: c.masterId, compareId: c.compareId });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible.length]);

  // Stable ref so useCallback closures with empty deps can call pushUnified.
  const pushUnifiedRef = useRef((_entry: UndoEntry) => {});

  function pushUnified(entry: UndoEntry) {
    if (undoStack.current.length >= 100) undoStack.current.shift();
    undoStack.current.push(entry);
    redoStack.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }
  pushUnifiedRef.current = pushUnified;

  function handleUndo() {
    const entry = undoStack.current.pop();
    if (!entry) return;
    redoStack.current.push(entry);
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(true);
    if (entry.mode === "edit") {
      if (entry.navigateTo) setNavigateToId(entry.navigateTo);
      setMode("edit");
      setPendingEditApply({ patches: entry.patches, direction: "undo", navigateTo: entry.navigateTo, redoNavigateTo: entry.redoNavigateTo });
    } else {
      setSelectedId({ masterId: entry.masterId, compareId: entry.compareId });
      setMode("merge");
      requestAnimationFrame(() => {
        setDecisions(entry.before);
      });
    }
  }

  function handleRedo() {
    const entry = redoStack.current.pop();
    if (!entry) return;
    undoStack.current.push(entry);
    setCanUndo(true);
    setCanRedo(redoStack.current.length > 0);
    if (entry.mode === "edit") {
      const navId = entry.redoNavigateTo ?? entry.navigateTo;
      if (navId) setNavigateToId(navId);
      setMode("edit");
      setPendingEditApply({ patches: entry.patches, direction: "redo", navigateTo: entry.navigateTo, redoNavigateTo: entry.redoNavigateTo });
    } else {
      setSelectedId({ masterId: entry.masterId, compareId: entry.compareId });
      setMode("merge");
      requestAnimationFrame(() => {
        setDecisions(entry.after);
      });
    }
  }

  // Stable ref for keyboard handler (recreated each render but registered once).
  const undoRedoRef = useRef({ undo: handleUndo, redo: handleRedo });
  undoRedoRef.current = { undo: handleUndo, redo: handleRedo };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undoRedoRef.current.undo(); }
      else if ((e.key === "z" && e.shiftKey) || e.key === "y") { e.preventDefault(); undoRedoRef.current.redo(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [navigateToId, setNavigateToId] = useState<string | undefined>(undefined);

  // Mode-switch shortcuts: first letter of each mode label in the active language.
  const modeSwitchRef = useRef({ editKey: "", mergeKey: "", mode, setMode, current, setNavigateToId });
  modeSwitchRef.current = {
    editKey: t("mode.edit").charAt(0).toLowerCase(),
    mergeKey: t("mode.merge").charAt(0).toLowerCase(),
    mode,
    setMode,
    current,
    setNavigateToId,
  };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      const { editKey, mergeKey, mode: cur, setMode: sm, current: cand, setNavigateToId: setNav } = modeSwitchRef.current;
      if (key === editKey && cur !== "edit") {
        e.preventDefault();
        if (cand) setNav(cand.masterId);
        sm("edit");
      }
      else if (key === mergeKey && cur !== "merge") { e.preventDefault(); sm("merge"); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateDecision(next: CandidateDecision) {
    if (!current) return;
    const key = decisionKey("individual", current.masterId, current.compareId);
    const before = new Map(decisions);
    const after = new Map(decisions).set(key, next);
    pushUnified({ mode: "merge", before, after, masterId: current.masterId, compareId: current.compareId });
    setDecisions(after);
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
    pushUnified({ mode: "merge", before, after, masterId, compareId });
    setDecisions(after);
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
      pushUnifiedRef.current({ mode: "merge", before: new Map(before), after, masterId, compareId });
      setDecisions(after);
    },
    [],
  );

  const handlePushEdit = useCallback(
    (patches: RecordPatch[], navigateTo?: string, redoNavigateTo?: string) => {
      // Capture pre-edit snapshot on first dirty for each record (patch.before is the
      // correct pre-edit state, unlike onDirty which fires after the mutation).
      for (const patch of patches) {
        if (patch.before !== null) {
          if (patch.type === "individual" && !personSnapshots.current.has(patch.id)) {
            personSnapshots.current.set(patch.id, cloneRaw(patch.before));
          } else if (patch.type === "family" && !familySnapshots.current.has(patch.id)) {
            familySnapshots.current.set(patch.id, cloneRaw(patch.before));
          }
        }
      }
      pushUnifiedRef.current({ mode: "edit", patches, navigateTo, redoNavigateTo });
    },
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

  // Edit mode change tracking — lifted from EditView so the header Save button can see counts.
  const [changedPersonIds, setChangedPersonIds] = useState<Set<string>>(new Set());
  const [changedFamilyIds, setChangedFamilyIds] = useState<Set<string>>(new Set());
  const changedCount = changedPersonIds.size + changedFamilyIds.size;
  // IDs present when the master was loaded (to distinguish edits vs. new additions).
  const loadedPersonIds = useRef<Set<string>>(new Set());
  const loadedFamilyIds = useRef<Set<string>>(new Set());
  // Raw-node snapshots taken at first-dirty time, used to revert "Remove from save".
  const personSnapshots = useRef<Map<string, GedNode>>(new Map());
  const familySnapshots = useRef<Map<string, GedNode>>(new Map());

  // Called by EditView after undo/redo patches have been applied to the dataset.
  // Cleans up changedPersonIds/changedFamilyIds for any record that has returned
  // to its original pre-edit state so the Save button count stays accurate.
  const handlePatchApplied = useCallback(
    (patches: RecordPatch[], direction: "undo" | "redo") => {
      if (!masterDataset) return;
      for (const patch of patches) {
        // Generic top-level records (e.g. a SOUR/OBJE from "Add Source") ride along
        // with the citing individual/family's own patch — no dirty-tracking of their own.
        if (patch.type === "record") continue;
        const appliedState = direction === "undo" ? patch.before : patch.after;
        if (appliedState === null) {
          // Record was removed (undo of creation, or redo of deletion) — clean up.
          if (patch.type === "individual") {
            personSnapshots.current.delete(patch.id);
            setChangedPersonIds((prev) => { const s = new Set(prev); s.delete(patch.id); return s; });
          } else {
            familySnapshots.current.delete(patch.id);
            setChangedFamilyIds((prev) => { const s = new Set(prev); s.delete(patch.id); return s; });
          }
          continue;
        }
        // Record exists — check if it matches the original snapshot.
        const snapshot = patch.type === "individual"
          ? personSnapshots.current.get(patch.id)
          : familySnapshots.current.get(patch.id);
        if (direction === "redo" && patch.before === null) {
          // Redo of a creation: re-mark dirty (no snapshot, it's a new record).
          if (patch.type === "individual") {
            setChangedPersonIds((prev) => prev.has(patch.id) ? prev : new Set(prev).add(patch.id));
          } else {
            setChangedFamilyIds((prev) => prev.has(patch.id) ? prev : new Set(prev).add(patch.id));
          }
          continue;
        }
        const record = patch.type === "individual"
          ? masterDataset.individuals.get(patch.id)?.raw
          : masterDataset.families.get(patch.id)?.raw;
        if (snapshot !== undefined && record && JSON.stringify(record) === JSON.stringify(snapshot)) {
          // Record is back to its pre-edit state — remove from dirty tracking.
          if (patch.type === "individual") {
            personSnapshots.current.delete(patch.id);
            setChangedPersonIds((prev) => { const s = new Set(prev); s.delete(patch.id); return s; });
          } else {
            familySnapshots.current.delete(patch.id);
            setChangedFamilyIds((prev) => { const s = new Set(prev); s.delete(patch.id); return s; });
          }
        } else if (direction === "redo") {
          // Redo of modification: re-mark dirty (it was cleaned by a prior undo).
          if (patch.type === "individual") {
            setChangedPersonIds((prev) => prev.has(patch.id) ? prev : new Set(prev).add(patch.id));
          } else {
            setChangedFamilyIds((prev) => prev.has(patch.id) ? prev : new Set(prev).add(patch.id));
          }
          // Restore snapshot if it was cleared when the record was cleaned.
          if (snapshot === undefined && patch.before !== null) {
            if (patch.type === "individual") {
              personSnapshots.current.set(patch.id, cloneRaw(patch.before));
            } else {
              familySnapshots.current.set(patch.id, cloneRaw(patch.before));
            }
          }
        } else {
          // Undo restored a record that isn't back to its original state (e.g. undoing a
          // "Remove from save" revert) — re-add to dirty tracking so the save button reflects it.
          if (patch.type === "individual") {
            setChangedPersonIds((prev) => prev.has(patch.id) ? prev : new Set(prev).add(patch.id));
          } else {
            setChangedFamilyIds((prev) => prev.has(patch.id) ? prev : new Set(prev).add(patch.id));
          }
        }
      }
    },
    [masterDataset],
  );

  const confirmedCount = useMemo(() => {
    let n = 0;
    for (const d of decisions.values()) if (d.status === "confirmed") n++;
    return n;
  }, [decisions]);

  hasUnsavedChangesRef.current = changedCount > 0 || confirmedCount > 0;

  // Warn before leaving the page when there are unsaved changes.
  useEffect(() => {
    if (changedCount === 0 && confirmedCount === 0) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [changedCount, confirmedCount]);

  function handleTitleClick() {
    const hasChanges = mode === "edit" ? changedCount > 0 : confirmedCount > 0;
    if (!hasChanges || window.confirm(t("app.reloadConfirm"))) {
      window.location.reload();
    }
  }

  function handleSave() {
    if (!masterDataset || master.status !== "loaded") return;
    const base = master.file.fileName.replace(/\.ged$/i, "");
    const editRecordIds = new Set([...changedPersonIds, ...changedFamilyIds]);
    const isMerge = confirmedCount > 0;

    const editReport = changedCount > 0
      ? enrichEditReport(
          buildEditReport(changedPersonIds, changedFamilyIds, masterDataset, loadedPersonIds.current, loadedFamilyIds.current, personSnapshots.current, familySnapshots.current),
          masterDataset, personSnapshots.current, familySnapshots.current, t,
        )
      : null;

    let records: GedNode[];
    let report: ChangeReport;
    let masterRecordCount: number | undefined;
    if (isMerge) {
      const compareDs = compareDataset!;
      const { records: mergedRecords, report: mergeReport } = mergeDecisions(
        masterDataset, compareDs, decisions, matches ?? { individuals: [] }, t,
      );
      records = mergedRecords;
      report = editReport ? combineReports(editReport, mergeReport) : mergeReport;
      masterRecordCount = masterDataset.individuals.size + masterDataset.families.size;
    } else {
      records = masterDataset.records;
      report = editReport!;
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

  function handleEditDirty(type: "individual" | "family", id: string) {
    if (type === "individual") {
      if (!personSnapshots.current.has(id) && masterDataset) {
        const indi = masterDataset.individuals.get(id);
        if (indi) personSnapshots.current.set(id, JSON.parse(JSON.stringify(indi.raw)) as GedNode);
      }
      setChangedPersonIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    } else {
      if (!familySnapshots.current.has(id) && masterDataset) {
        const fam = masterDataset.families.get(id);
        if (fam) familySnapshots.current.set(id, JSON.parse(JSON.stringify(fam.raw)) as GedNode);
      }
      setChangedFamilyIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    }
  }

  function handleConfirmSave() {
    if (!preview || !masterDataset) return;
    const text = serializeGedcom(preview.records, {
      eol: masterDataset.eol,
      finalNewline: masterDataset.finalNewline,
    });
    downloadText(`${preview.base}.gedmerge.ged`, text);
    downloadText(`${preview.base}.gedmerge.report.txt`, formatReport(preview.report, "GED Save change report"));

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
    loadedPersonIds.current = new Set(masterDataset.individuals.keys());
    loadedFamilyIds.current = new Set(masterDataset.families.keys());
    personSnapshots.current = new Map();
    familySnapshots.current = new Map();

    // These confirmed decisions are now baked into the live dataset — clear them
    // so the pending-changes count doesn't still include them. Always replace the
    // map (even when nothing was confirmed) so EditView's merge-generation bump
    // remounts event rows and drops their stale "dirty since edit" highlighting.
    setDecisions((prev) => {
      const next = new Map(prev);
      for (const [key, d] of next) if (d.status === "confirmed") next.delete(key);
      return next;
    });
    setSaveToast(t("save.toast", { count: preview.files.length }));
    setPreview(null);
    setChangedPersonIds(new Set());
    setChangedFamilyIds(new Set());
  }

  function handleRemoveFromSave(id: string, kind: "individual" | "family") {
    if (!masterDataset || !preview) return;
    const patches: RecordPatch[] = [];

    if (kind === "individual") {
      const snapshot = personSnapshots.current.get(id);
      const indi = masterDataset.individuals.get(id);
      if (indi) {
        const beforeIndi = cloneRaw(indi.raw);
        if (loadedPersonIds.current.has(id) && snapshot) {
          indi.raw.value = snapshot.value;
          indi.raw.children = JSON.parse(JSON.stringify(snapshot.children)) as GedNode[];
          rebuildIndividual(masterDataset, indi);
          patches.push({ type: "individual", id, before: beforeIndi, after: cloneRaw(indi.raw) });
        } else {
          const affectedFamilyIds = [...indi.spouseOf, ...indi.childOf];
          const famBefores = new Map<string, GedNode>();
          for (const famId of affectedFamilyIds) {
            const fam = masterDataset.families.get(famId);
            if (fam) famBefores.set(famId, cloneRaw(fam.raw));
          }
          removeIndividual(masterDataset, indi);
          patches.push({ type: "individual", id, before: beforeIndi, after: null });
          for (const [famId, before] of famBefores) {
            const fam = masterDataset.families.get(famId);
            patches.push({ type: "family", id: famId, before, after: fam ? cloneRaw(fam.raw) : null });
          }
        }
      }
      // Keep snapshot for undo machinery — it is still needed for dirty tracking on undo/redo.
      setChangedPersonIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    } else {
      const snapshot = familySnapshots.current.get(id);
      const fam = masterDataset.families.get(id);
      if (fam) {
        const beforeFam = cloneRaw(fam.raw);
        if (loadedFamilyIds.current.has(id) && snapshot) {
          fam.raw.value = snapshot.value;
          fam.raw.children = JSON.parse(JSON.stringify(snapshot.children)) as GedNode[];
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
      setChangedFamilyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }

    if (patches.length > 0) {
      pushUnified({ mode: "edit", patches, navigateTo: id });
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

  // Full-page compare tree takes over the whole view when open.
  if (treeView && masterDataset && compareDataset && matches) {
    return (
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
        decisions={decisions}
        onDecide={setPairStatus}
        homeId={homeId}
      />
    );
  }

  // Edit Tree takes over the full page when open.
  if (editTreeId && masterDataset) {
    return (
      <EditTree
        masterDs={masterDataset}
        rootId={editTreeId}
        homeId={homeId}
        changedPersonIds={changedPersonIds}
        decisions={decisions}
        onBack={() => window.history.back()}
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
    <div className="app">
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
          </div>
          <div className="mode-tabs">
            <button
              className={`seg-btn ${mode === "edit" ? "active" : ""}`}
              onClick={() => setMode("edit")}
              title={t("mode.edit.tooltip")}
            >
              {t("mode.edit")}
            </button>
            <button
              className={`seg-btn ${mode === "merge" ? "active" : ""}`}
              onClick={() => setMode("merge")}
              title={t("mode.merge.tooltip")}
            >
              {t("mode.merge")}
            </button>
          </div>
          <div className="lang-switcher">
            <button
              className="nav-btn icon-only"
              style={{ marginRight: "8px" }}
              onClick={toggleTheme}
              title={theme === "dark" ? t("theme.light") : t("theme.dark")}
              aria-label={theme === "dark" ? t("theme.light") : t("theme.dark")}
            >
              {theme === "dark" ? "🌙" : "☀️"}
            </button>
            <div className="lang-select-wrapper">
              <span aria-hidden="true">{LANG_FLAGS[i18n.language]} {i18n.language.toUpperCase()} ▾</span>
              <select className="lang-select" value={i18n.language} onChange={(e) => i18n.changeLanguage(e.target.value)} aria-label="Language">
                <option value="en">🇬🇧 English (EN)</option>
                <option value="sl">🇸🇮 Slovenščina (SL)</option>
              </select>
            </div>
          </div>
        </div>
        {(lastMasterFile || compare.status === "loaded") && (
          <div className="app-head-files">
            {lastMasterFile && (
              <button className="header-file-btn gm-file master" onClick={toggleInfoPanel} title={t("load.master")}>
                {lastMasterFile.fileName}
              </button>
            )}
            {compare.status === "loaded" && (
              <button className="header-file-btn gm-file incoming" onClick={toggleInfoPanel} title={t("load.incoming")}>
                {compare.file.fileName}
              </button>
            )}
            {lastMasterFile && ((canUndo || canRedo) || (changedCount > 0 || confirmedCount > 0)) && (
              <div className="app-head-right">
                {(changedCount > 0 || confirmedCount > 0) && (
                  <button
                    className="export-btn"
                    onClick={handleSave}
                    title={t("save.gedcom.tooltip")}
                  >
                    {t("save.gedcom")} ({changedCount + confirmedCount})
                  </button>
                )}
                {(canUndo || canRedo) && (
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
            )}
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
              homeId={homeId}
              masterDataset={masterDataset}
              changeHome={changeHome}
              focusHome={focusHome}
              setFocusHome={setFocusHome}
              openMatches={openMatches}
              setOpenMatches={setOpenMatches}
              current={current}
              compareDataset={compareDataset}
              onUpdateDecision={updateDecision}
              onOpenTree={openTree}
              canNavigatePerson={canNavigatePerson}
              onNavigatePerson={navigatePerson}
              compareRef={compareRef}
              onEdit={current ? () => { setNavigateToId(current.masterId); setMode("edit"); } : undefined}
              active={mode === "merge"}
            />
          </div>
          <div style={mode === "edit" ? modeLayerStyle : modeLayerHiddenStyle}>
            <EditView
              dataset={masterDataset}
              fileName={lastMasterFile.fileName}
              homeId={homeId}
              changeHome={changeHome}
              onDirty={handleEditDirty}
              onShowTree={(id) => openEditTree(id)}
              navigateToId={navigateToId}
              onMerge={matches ? (id) => {
                const c = allSorted.find((c) => c.masterId === id);
                if (c) setSelectedId({ masterId: c.masterId, compareId: c.compareId });
                setMode("merge");
              } : undefined}
              canMerge={matches ? (id) => allSorted.some((c) => c.masterId === id) : undefined}
              decisions={decisions}
              compareDataset={compareDataset}
              onUpdateDecision={updateDecisionForKey}
              onPushEdit={handlePushEdit}
              onPatchApplied={handlePatchApplied}
              pendingApply={pendingEditApply}
              onApplied={() => setPendingEditApply(null)}
              active={mode === "edit"}
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
      <HelpModal isOpen={showHelp} onClose={() => setShowHelp(false)} />
      <LegalModal isOpen={showLegal} onClose={() => setShowLegal(false)} page={legalPage} />
      <footer className="app-footer">
        <a href="https://luka.renko.fyi" target="_blank" rel="noopener noreferrer">
          © 2026 Luka Renko
        </a>
        <span className="app-footer-sep">·</span>
        <a
          href="guide/"
          className="app-footer-link"
          onClick={(e) => { e.preventDefault(); setShowHelp(true); }}
        >
          {t("help.title")}
        </a>
        <span className="app-footer-sep">·</span>
        <button
          className="app-footer-link"
          onClick={() => { setLegalPage("privacy"); setShowLegal(true); }}
        >
          {t("footer.privacy")}
        </button>
        <span className="app-footer-sep">·</span>
        <button
          className="app-footer-link"
          onClick={() => { setLegalPage("terms"); setShowLegal(true); }}
        >
          {t("footer.terms")}
        </button>
        <span className="app-footer-sep">·</span>
        <a href="mailto:support@gedmerge.com">{t("footer.contact")}</a>
      </footer>
    </div>
  );
}

export type { SlotState };

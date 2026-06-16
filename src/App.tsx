import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GedNode } from "./gedcom/types";
import { serializeGedcom } from "./gedcom/serialize";
import { mergeDecisions, formatReport, type ChangeReport } from "./merge/merge";
import { defaultHomeId } from "./match/relatives";
import type { NormalizationReport, PlaceLayout } from "./normalize/types";
import type { DatasetRole, WorkerResponse } from "./worker/messages";
import type { MatchResult } from "./match/types";
import { decisionKey, type CandidateDecision, type MatchDecisionStatus } from "./review/types";
import { downloadText } from "./ui/download";
import { GedcomLoader } from "./ui/GedcomLoader";
import { CompareTree } from "./ui/CompareTree";
import { HelpModal } from "./ui/HelpModal";
import { MergeView } from "./ui/MergeView";
import { EditView } from "./ui/EditView";
import { EditPreview } from "./ui/EditPreview";
import { EditTree } from "./ui/EditTree";
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

type Theme = "light" | "dark";
const THEME_KEY = "gedmerge.theme";

type Mode = "merge" | "edit";
const MODE_KEY = "gedmerge.mode";

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
  const [master, setMaster] = useState<SlotState>({ status: "empty" });
  const [compare, setCompare] = useState<SlotState>({ status: "empty" });
  const [matches, setMatches] = useState<MatchResult | null>(null);
  const [matching, setMatching] = useState(false);
  const [homeId, setHomeId] = useState<string | undefined>(undefined);
  // When the first matches arrive with no home person, focus the picker so the
  // user can start typing immediately.
  const [focusHome, setFocusHome] = useState(false);
  const [decisions, setDecisions] = useState<Map<string, CandidateDecision>>(new Map());

  // Matches list view state.
  const [sort, setSort] = useState<SortState[]>(DEFAULT_SORT);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showFilters, setShowFilters] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [preview, setPreview] = useState<{
    records: GedNode[];
    report: ChangeReport;
    base: string;
  } | null>(null);
  const [showMobileWarning, setShowMobileWarning] = useState(
    () => window.innerWidth <= 880 && !localStorage.getItem("mobileWarningDismissed")
  );
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
    function onPop(e: PopStateEvent) {
      const st = (e.state ?? {}) as { gedTree?: TreeView; gedSel?: SelRef };
      setTreeView(st.gedTree ?? null);
      // Restore a remembered compare selection (set when a person link pushed it).
      if (st.gedSel) {
        const { masterId, compareId } = st.gedSel;
        const idx = visibleRef.current.findIndex((c) => c.masterId === masterId && c.compareId === compareId);
        if (idx >= 0) {
          setSelectedIndex(idx);
        }
      }
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  /** Record the current compare selection in the current history entry so the
   *  browser Back button returns here after a person-link or tree push. */
  function rememberSelection() {
    const cur = visible[safeIndex];
    if (cur) window.history.replaceState({ gedSel: { masterId: cur.masterId, compareId: cur.compareId } }, "");
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
        setMatching(true);
        return;
      }
      if (msg.type === "matched") {
        setMatches(msg.result);
        setMatching(false);
        setSelectedIndex(0);
        setOpenMatches(true);
        setShowInfoPanel(false);
        return;
      }
      const setter = msg.role === "master" ? setMaster : setCompare;
      if (msg.type === "parsed") {
        const file: LoadedFile = { fileName: msg.fileName, dataset: msg.dataset };
        if (msg.report) file.report = msg.report;
        if (msg.placeLayout) file.placeLayout = msg.placeLayout;
        if (msg.dateFormat) file.dateFormat = msg.dateFormat;
        setter({ status: "loaded", file });
      } else {
        setter({ status: "error", fileName: msg.fileName, message: msg.message });
      }
    };

    return () => worker.terminate();
  }, []);

  async function loadFile(role: DatasetRole, file: File) {
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
    setChangedPersonIds(new Set());
    setChangedFamilyIds(new Set());
    setEditPreviewOpen(false);
    setEditTreeId(null);
    setHomeId(undefined); // home person is opt-in; reset on (re)load
    setFocusHome(false);
    autoHomeRef.current = false; // allow the default home person for the new file
    setOpenMatches(false);
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

  // When the first results for a freshly loaded master arrive, default the home
  // person to the master's root individual if present. Attempted once per file
  // (autoHomeRef), so a user who later clears the home person isn't overridden.
  useEffect(() => {
    if (!matches || autoHomeRef.current) return;
    autoHomeRef.current = true;
    if (homeId) return; // user already chose before the first result
    const ds = master.status === "loaded" ? master.file.dataset : undefined;
    const home = ds ? defaultHomeId(ds) : undefined;
    if (home) {
      changeHome(home);
    } else {
      // No conventional root person to default to — focus the picker instead.
      setFocusHome(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  function toggleSort(key: SortKey) {
    setSort((prev) => nextSort(prev, key));
  }

  // Filtered + sorted list of individual matches. The status rank lets the
  // "status" sort group rows by the user's decision (and re-groups live as
  // decisions change).
  const visible = useMemo(() => {
    if (!matches) return [];
    const statusRank = (c: Candidate) =>
      STATUS_RANK[decisions.get(decisionKey("individual", c.masterId, c.compareId))?.status ?? "undecided"];
    return applySort(applyFilters(matches.individuals, filters), sort, statusRank);
  }, [matches, filters, sort, decisions]);

  const safeIndex = visible.length === 0 ? 0 : Math.min(selectedIndex, visible.length - 1);
  const current = visible[safeIndex];

  // Person id -> index in the visible list, so a relative's name can jump to
  // their own match row. A person with several candidates resolves to the first
  // (highest-ranked) one present in the list. Built per column: master ids on the
  // master side, compare ids on the incoming side.
  const indexByMaster = useMemo(() => {
    const m = new Map<string, number>();
    visible.forEach((c, i) => { if (!m.has(c.masterId)) m.set(c.masterId, i); });
    return m;
  }, [visible]);
  const indexByCompare = useMemo(() => {
    const m = new Map<string, number>();
    visible.forEach((c, i) => { if (!m.has(c.compareId)) m.set(c.compareId, i); });
    return m;
  }, [visible]);

  // popstate reads the live list to resolve a remembered selection; a ref keeps
  // its handler (registered once) from closing over a stale `visible`.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const canNavigatePerson = useCallback(
    (side: "master" | "incoming", id: string) =>
      (side === "master" ? indexByMaster : indexByCompare).has(id),
    [indexByMaster, indexByCompare],
  );


  function dismissMobileWarning() {
    localStorage.setItem("mobileWarningDismissed", "true");
    setShowMobileWarning(false);
  }

  // Stable identity so memoized candidate rows don't re-render on every keystroke
  // or filter toggle (only the rows whose own props change re-render).
  const select = useCallback((index: number) => {
    setSelectedIndex(index);
    if (window.innerWidth <= 880) {
      setTimeout(() => {
        compareRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 50);
    }
  }, []);

  // Jump the compare view to a relative's own match row, pushing a history entry
  // so the browser Back button returns to where we were.
  const navigatePerson = useCallback(
    (side: "master" | "incoming", id: string) => {
      const idx = (side === "master" ? indexByMaster : indexByCompare).get(id);
      if (idx == null || idx === safeIndex) return; // unknown or already selected
      const cur = visible[safeIndex];
      if (cur) window.history.replaceState({ gedSel: { masterId: cur.masterId, compareId: cur.compareId } }, "");
      const target = visible[idx];
      window.history.pushState({ gedSel: { masterId: target.masterId, compareId: target.compareId } }, "");
      select(idx);
    },
    [indexByMaster, indexByCompare, visible, safeIndex, select],
  );

  // Keyboard navigation across the filtered list (ignored while typing).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        return;
      }
      if (visible.length === 0) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => Math.max(0, Math.min(i, visible.length - 1) - 1));
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => Math.min(visible.length - 1, i + 1));
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible.length]);

  function updateDecision(next: CandidateDecision) {
    if (!current) return;
    const key = decisionKey("individual", current.masterId, current.compareId);
    setDecisions((prev) => new Map(prev).set(key, next));
  }

  // Set a pair's status while keeping its field choices; clicking the active
  // status again clears it back to undecided. Used by the compare tree, where a
  // node may be a person that never appeared in the candidate list.
  const setPairStatus = useCallback(
    (masterId: string, compareId: string, status: MatchDecisionStatus) => {
      const key = decisionKey("individual", masterId, compareId);
      setDecisions((prev) => {
        const cur = prev.get(key);
        const nextStatus = cur?.status === status ? "undecided" : status;
        return new Map(prev).set(key, { status: nextStatus, fields: cur?.fields ?? {} });
      });
    },
    [],
  );

  const masterDataset = master.status === "loaded" ? master.file.dataset : undefined;
  const compareDataset = compare.status === "loaded" ? compare.file.dataset : undefined;

  // Edit Tree: full-page tree view for the edit mode.
  const [editTreeId, setEditTreeId] = useState<string | null>(null);

  // Edit mode change tracking — lifted from EditView so the header Save button can see counts.
  const [changedPersonIds, setChangedPersonIds] = useState<Set<string>>(new Set());
  const [changedFamilyIds, setChangedFamilyIds] = useState<Set<string>>(new Set());
  const changedCount = changedPersonIds.size + changedFamilyIds.size;
  const [editPreviewOpen, setEditPreviewOpen] = useState(false);

  const confirmedCount = useMemo(() => {
    let n = 0;
    for (const d of decisions.values()) if (d.status === "confirmed") n++;
    return n;
  }, [decisions]);

  function saveEdit() {
    if (!masterDataset || master.status !== "loaded") return;
    const text = serializeGedcom(masterDataset.records, {
      eol: masterDataset.eol,
      finalNewline: masterDataset.finalNewline,
    });
    downloadText(master.file.fileName, text);
    setChangedPersonIds(new Set());
    setChangedFamilyIds(new Set());
    setEditPreviewOpen(false);
  }

  function handleSave() {
    if (mode === "edit") setEditPreviewOpen(true);
    else openPreview();
  }

  function handleEditDirty(type: "individual" | "family", id: string) {
    if (type === "individual") {
      setChangedPersonIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    } else {
      setChangedFamilyIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    }
  }

  // Run the (non-destructive) merge and open the preview; nothing is written yet.
  function openPreview() {
    if (!masterDataset || !compareDataset) return;
    const matchResult = matches ?? { individuals: [] };
    const { records, report } = mergeDecisions(masterDataset, compareDataset, decisions, matchResult, t);
    const base =
      master.status === "loaded" ? master.file.fileName.replace(/\.ged$/i, "") : "merged";
    setPreview({ records, report, base });
  }

  // Confirmed from the preview: serialize and download the merged file + report.
  function confirmExport() {
    if (!preview || !masterDataset) return;
    const merged = serializeGedcom(preview.records, {
      eol: masterDataset.eol,
      finalNewline: masterDataset.finalNewline,
    });
    downloadText(`${preview.base}.merged.ged`, merged);
    downloadText(`${preview.base}.merge-report.txt`, formatReport(preview.report));
    setPreview(null);
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
      />
    );
  }

  // Edit Tree takes over the full page when open.
  if (editTreeId && masterDataset) {
    return (
      <EditTree
        masterDs={masterDataset}
        rootId={editTreeId}
        changedPersonIds={changedPersonIds}
        onBack={() => setEditTreeId(null)}
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
            <h1
              onClick={master.status === "loaded" ? toggleInfoPanel : undefined}
              className={master.status === "loaded" ? "brand-clickable" : undefined}
            >
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
              onClick={() => setShowHelp(true)}
              title={t("help.button")}
            >
              ?
            </button>
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
        {(master.status === "loaded" || compare.status === "loaded") && (
          <div className="app-head-files">
            {master.status === "loaded" && (
              <button className="header-file-btn gm-file master" onClick={toggleInfoPanel} title={t("load.master")}>
                {master.file.fileName}
              </button>
            )}
            {compare.status === "loaded" && (
              <button className="header-file-btn gm-file incoming" onClick={toggleInfoPanel} title={t("load.incoming")}>
                {compare.file.fileName}
              </button>
            )}
            {master.status === "loaded" && (mode === "edit" ? changedCount > 0 : confirmedCount > 0) && (
              <button
                className="export-btn"
                onClick={handleSave}
                title={mode === "edit" ? t("save.gedcom.edit.tooltip") : t("save.gedcom.merge.tooltip")}
              >
                {t("save.gedcom")} ({mode === "edit" ? changedCount : confirmedCount})
              </button>
            )}
          </div>
        )}
      </header>

      {/* File info panel — forced open in Merge before matches; toggleable otherwise */}
      {infoPanelOpen && master.status === "loaded" && (
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
              <GedcomLoader
                title={t("load.incoming")}
                state={compare}
                onLoad={(f) => loadFile("compare", f)}
                accent="incoming"
                highlight={compare.status === "empty"}
                tooltip={compare.status === "empty" ? t("load.incoming.tooltip") : undefined}
                description={t("merge.intro.incomingHint")}
              />
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

      {/* Master landing — shown before any master file is loaded */}
      {master.status !== "loaded" && (
        <div className="landing">
          <ul className="landing-bullets">
            <li>{t("intro.bullet1")}</li>
            <li>{t("intro.bullet2")}</li>
            <li>{t("intro.bullet3")}</li>
          </ul>
          <div className="landing-master">
            <GedcomLoader
              title={t("load.master")}
              state={master}
              onLoad={(f) => loadFile("master", f)}
              accent="master"
              highlight={master.status === "empty"}
              tooltip={master.status === "empty" ? t("load.master.tooltip") : undefined}
              description={t("intro.masterHint")}
            />
          </div>
        </div>
      )}

      {master.status === "loaded" && masterDataset && (
        mode === "merge" ? (
          <MergeView
            matches={matches}
            sort={sort}
            onToggleSort={toggleSort}
            filters={filters}
            setFilters={setFilters}
            setSelectedIndex={setSelectedIndex}
            visible={visible}
            safeIndex={safeIndex}
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
            preview={preview}
            onConfirmExport={confirmExport}
            onClosePreview={() => setPreview(null)}
          />
        ) : (
          <EditView
            dataset={masterDataset}
            fileName={master.file.fileName}
            homeId={homeId}
            onDirty={handleEditDirty}
            onShowTree={(id) => setEditTreeId(id)}
          />
        )
      )}
      {editPreviewOpen && masterDataset && master.status === "loaded" && (
        <EditPreview
          changedPersonIds={changedPersonIds}
          changedFamilyIds={changedFamilyIds}
          dataset={masterDataset}
          fileName={master.file.fileName}
          onConfirm={saveEdit}
          onClose={() => setEditPreviewOpen(false)}
        />
      )}
      <HelpModal isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
}

export type { SlotState };

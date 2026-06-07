import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "./gedcom/types";
import { serializeGedcom } from "./gedcom/serialize";
import { mergeDecisions, formatReport } from "./merge/merge";
import type { NormalizationReport } from "./normalize/types";
import type { DatasetRole, WorkerResponse } from "./worker/messages";
import type { MatchResult } from "./match/types";
import { decisionKey, type CandidateDecision, type MatchKind } from "./review/types";
import { GedcomLoader } from "./ui/GedcomLoader";
import { HomePersonSelector } from "./ui/HomePersonSelector";
import { MatchResults } from "./ui/MatchResults";
import { ComparePanel } from "./ui/ComparePanel";
import { CompareTree } from "./ui/CompareTree";
import { Section } from "./ui/Section";
import { HelpModal } from "./ui/HelpModal";
import type { TreeMode } from "./tree/compareTree";
import {
  applyFilters,
  applySort,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  nextSort,
  sexClass,
  type Filters,
  type SortKey,
  type SortState,
} from "./ui/matchView";

interface LoadedFile {
  fileName: string;
  dataset: Dataset;
  report?: NormalizationReport;
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

const LANG_FLAGS: Record<string, string> = { en: "🇬🇧", sl: "🇸🇮" };

/** GEDCOM xref of "person 1" — the conventional root individual, used as the
 * default home person when present. */
const DEFAULT_HOME_ID = "@I1@";

/** Trigger a client-side download of a text file (no server round-trip). */
function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
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
  const [decisions, setDecisions] = useState<Map<string, CandidateDecision>>(new Map());

  // Matches list view state.
  const [tab, setTab] = useState<MatchKind>("individual");
  const [sort, setSort] = useState<SortState[]>(DEFAULT_SORT);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showFilters, setShowFilters] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [showMobileWarning, setShowMobileWarning] = useState(
    () => window.innerWidth <= 880 && !localStorage.getItem("mobileWarningDismissed")
  );
  const compareRef = useRef<HTMLDivElement>(null);

  // Collapsible sections.
  const [openLoad, setOpenLoad] = useState(true);
  const [openCompare, setOpenCompare] = useState(false);
  const [openMatches, setOpenMatches] = useState(false);

  // Full-page "Compare tree" view, kept in sync with browser history so the
  // back button returns to the main view.
  const [treeView, setTreeView] = useState<TreeView | null>(null);

  useEffect(() => {
    function onPop(e: PopStateEvent) {
      setTreeView((e.state?.gedTree as TreeView | undefined) ?? null);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function openTree(masterId: string, compareId: string) {
    const view: TreeView = { masterId, compareId, mode: "ancestors" };
    window.history.pushState({ gedTree: view }, "");
    setTreeView(view);
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
        // Land on the first match and reveal the compare + matches sections.
        setSelectedIndex(0);
        setOpenLoad(false);
        setOpenCompare(true);
        setOpenMatches(true);
        return;
      }
      const setter = msg.role === "master" ? setMaster : setCompare;
      if (msg.type === "parsed") {
        const file: LoadedFile = { fileName: msg.fileName, dataset: msg.dataset };
        if (msg.report) file.report = msg.report;
        setter({ status: "loaded", file });
      } else {
        setter({ status: "error", fileName: msg.fileName, message: msg.message });
      }
    };

    return () => worker.terminate();
  }, []);

  async function loadFile(role: DatasetRole, file: File) {
    const setter = role === "master" ? setMaster : setCompare;
    setter({ status: "loading", fileName: file.name });
    // Drop stale results + decisions; the worker will emit fresh matches once
    // both sides are (re)loaded and re-normalized.
    setMatches(null);
    setDecisions(new Map());
    setHomeId(undefined); // home person is opt-in; reset on (re)load
    autoHomeRef.current = false; // allow the default home person for the new file
    setOpenCompare(false);
    setOpenMatches(false);
    setOpenLoad(true);
    const buffer = await file.arrayBuffer();
    workerRef.current?.postMessage(
      { type: "parse", role, fileName: file.name, buffer },
      [buffer], // transfer ownership — avoids copying large files
    );
  }

  function changeHome(id: string | undefined) {
    setHomeId(id);
    workerRef.current?.postMessage({ type: "setHome", id: id ?? "" });
  }

  // When the first results for a freshly loaded master arrive, default the home
  // person to the root individual (@I1@) if present. Attempted once per file
  // (autoHomeRef), so a user who later clears the home person isn't overridden.
  useEffect(() => {
    if (!matches || autoHomeRef.current) return;
    autoHomeRef.current = true;
    if (homeId) return; // user already chose before the first result
    const ds = master.status === "loaded" ? master.file.dataset : undefined;
    if (ds?.individuals.has(DEFAULT_HOME_ID)) changeHome(DEFAULT_HOME_ID);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  function toggleSort(key: SortKey) {
    setSort((prev) => nextSort(prev, key));
  }

  // Filtered + sorted list for the active tab.
  const visible = useMemo(() => {
    if (!matches) return [];
    const raw = tab === "individual" ? matches.individuals : matches.families;
    return applySort(applyFilters(raw, filters), sort);
  }, [matches, tab, filters, sort]);

  const safeIndex = visible.length === 0 ? 0 : Math.min(selectedIndex, visible.length - 1);
  const current = visible[safeIndex];

  const confirmedCount = useMemo(() => {
    let n = 0;
    for (const d of decisions.values()) if (d.status === "confirmed") n++;
    return n;
  }, [decisions]);

  function dismissMobileWarning() {
    localStorage.setItem("mobileWarningDismissed", "true");
    setShowMobileWarning(false);
  }

  function select(index: number) {
    setSelectedIndex(index);
    setOpenCompare(true);
    if (window.innerWidth <= 880) {
      setTimeout(() => {
        compareRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 50);
    }
  }

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
    const key = decisionKey(tab, current.masterId, current.compareId);
    setDecisions((prev) => new Map(prev).set(key, next));
  }

  const masterDataset = master.status === "loaded" ? master.file.dataset : undefined;
  const compareDataset = compare.status === "loaded" ? compare.file.dataset : undefined;

  function exportMerged() {
    if (!masterDataset || !compareDataset) return;
    const matchResult = matches ?? { individuals: [], families: [] };
    const { records, report } = mergeDecisions(masterDataset, compareDataset, decisions, matchResult, t);
    const merged = serializeGedcom(records, {
      eol: masterDataset.eol,
      finalNewline: masterDataset.finalNewline,
    });
    const base =
      master.status === "loaded" ? master.file.fileName.replace(/\.ged$/i, "") : "merged";
    downloadText(`${base}.merged.ged`, merged);
    downloadText(`${base}.merge-report.txt`, formatReport(report));
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
        onBack={() => window.history.back()}
      />
    );
  }

  const bothLoaded = master.status === "loaded" && compare.status === "loaded";
  const loadSubtitle = bothLoaded ? (
    <>
      {confirmedCount > 0 && (
        <div className="header-center" onClick={(e) => e.stopPropagation()}>
          <button className="export-btn" onClick={exportMerged} title={t("export.tooltip")}>
            {t("export.merged")} ({confirmedCount})
          </button>
        </div>
      )}
      <span>
        {master.status === "loaded" && master.file.fileName}
        {" ↔ "}
        {compare.status === "loaded" && compare.file.fileName}
      </span>
    </>
  ) : undefined;
  const matchesSubtitle = matching ? (
    <div className="matches-tabs-header matching" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      {t("matches.calculating")}
    </div>
  ) : matches ? (
    <>
      <div className="matches-tabs-header">
        <div className="tabs" onClick={(e) => e.stopPropagation()}>
          <button
            className={tab === "individual" ? "tab active" : "tab"}
            onClick={() => { setTab("individual"); setSelectedIndex(0); }}
          >
            {t("matches.individuals")} ({matches.individuals.length})
          </button>
          <button
            className={tab === "family" ? "tab active" : "tab"}
            onClick={() => { setTab("family"); setSelectedIndex(0); }}
          >
            {t("matches.families")} ({matches.families.length})
          </button>
        </div>
      </div>
      <div className="matches-actions" onClick={(e) => e.stopPropagation()}>
        <span className="muted">
          {t("list.count", { visible: visible.length, total: tab === "individual" ? matches.individuals.length : matches.families.length })}
        </span>
        <button
          className={`nav-btn icon-only ${showFilters ? "active" : ""}`}
          onClick={() => setShowFilters((s) => !s)}
          title={t("filter.title")}
        >
          <svg style={{ display: "block" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon></svg>
        </button>
      </div>
    </>
  ) : undefined;
  const compareSubtitle = current ? (
    <>
      <div className={`compare-header-info ${sexClass(current)}`}>{current.title}</div>
      <div className="compare-nav-header">
        <button
          className="nav-btn icon-only"
          onClick={(e) => { e.stopPropagation(); setSelectedIndex((i) => Math.max(0, i - 1)); }}
        disabled={safeIndex <= 0}
        title={t("nav.prev")}
      >
        ‹
      </button>
      <span className="nav-pos">
        {t("nav.pos", { current: safeIndex + 1, total: visible.length })}
      </span>
      <button
        className="nav-btn icon-only"
        onClick={(e) => { e.stopPropagation(); setSelectedIndex((i) => Math.min(visible.length - 1, i + 1)); }}
        disabled={safeIndex >= visible.length - 1}
        title={t("nav.next")}
      >
        ›
      </button>
    </div>
    </>
  ) : undefined;

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
          <h1>{t("app.title")}</h1>
          <div className="lang-switcher">
            <button
              className="nav-btn icon-only"
              style={{ marginRight: "8px" }}
              onClick={() => setShowHelp(true)}
              title={t("help.button")}
            >
              ?
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
        <p className="subtitle">
          {t("app.subtitle")}
        </p>
      </header>

      <Section
        title={t("section.load")}
        subtitle={loadSubtitle}
        open={openLoad}
        onToggle={() => setOpenLoad((o) => !o)}
      >
        <div className="loaders">
          <GedcomLoader
            title={t("load.master")}
            state={master}
            onLoad={(f) => loadFile("master", f)}
            highlight={master.status === "empty"}
            tooltip={master.status === "empty" ? t("load.master.tooltip") : undefined}
          />
          <GedcomLoader
            title={t("load.incoming")}
            state={compare}
            onLoad={(f) => loadFile("compare", f)}
            highlight={master.status === "loaded" && compare.status === "empty"}
            tooltip={master.status === "loaded" && compare.status === "empty" ? t("load.incoming.tooltip") : undefined}
          />
        </div>
      </Section>

      <div className="main-split">
        <div className="split-pane split-matches">
          <Section
            title={t("section.matches")}
            subtitle={matchesSubtitle}
            open={openMatches}
            onToggle={() => setOpenMatches((o) => !o)}
            disabled={!matches && !matching}
          >
            {matches ? (
              <MatchResults
                result={matches}
                tab={tab}
                sort={sort}
                onToggleSort={toggleSort}
                filters={filters}
                onFilters={(f) => {
                  setFilters(f);
                  setSelectedIndex(0);
                }}
                list={visible}
                selectedIndex={safeIndex}
                onSelect={select}
                decisions={decisions}
                showFilters={showFilters}
                homeControl={
                  masterDataset && (
                    <HomePersonSelector
                      individuals={masterDataset.individuals}
                      homeId={homeId}
                      onChange={changeHome}
                      onClear={() => changeHome(undefined)}
                    />
                  )
                }
              />
            ) : !matching ? (
              <p className="muted">{t("matches.empty")}</p>
            ) : null}
          </Section>
        </div>

        <div className="split-pane split-compare" ref={compareRef}>
          <Section
            title={t("section.compare")}
            subtitle={compareSubtitle}
            open={openCompare}
            onToggle={() => setOpenCompare((o) => !o)}
            disabled={!current}
          >
            {current && masterDataset && compareDataset ? (
              <ComparePanel
                kind={tab}
                candidate={current}
                masterDs={masterDataset}
                compareDs={compareDataset}
                decision={decisions.get(decisionKey(tab, current.masterId, current.compareId))}
                onChange={updateDecision}
                onOpenTree={
                  tab === "individual"
                    ? () => openTree(current.masterId, current.compareId)
                    : undefined
                }
              />
            ) : (
              <p className="muted">
                {matches ? t("compare.empty") : t("matches.empty")}
              </p>
            )}
          </Section>
        </div>
      </div>
      <HelpModal isOpen={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
}

export type { SlotState };

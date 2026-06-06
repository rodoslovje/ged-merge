import { useEffect, useMemo, useRef, useState } from "react";
import type { Dataset } from "./gedcom/types";
import type { NormalizationReport } from "./normalize/types";
import type { DatasetRole, WorkerResponse } from "./worker/messages";
import type { MatchResult } from "./match/types";
import { decisionKey, type CandidateDecision, type MatchKind } from "./review/types";
import { GedcomLoader } from "./ui/GedcomLoader";
import { HomePersonSelector } from "./ui/HomePersonSelector";
import { MatchResults } from "./ui/MatchResults";
import { ComparePanel } from "./ui/ComparePanel";
import { Section } from "./ui/Section";
import {
  applyFilters,
  applySort,
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  nextSort,
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

export function App() {
  const workerRef = useRef<Worker | null>(null);
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

  // Collapsible sections.
  const [openLoad, setOpenLoad] = useState(true);
  const [openCompare, setOpenCompare] = useState(false);
  const [openMatches, setOpenMatches] = useState(false);

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

  function select(index: number) {
    setSelectedIndex(index);
    setOpenCompare(true);
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

  const loadSubtitle =
    master.status === "loaded" && compare.status === "loaded"
      ? `${master.file.fileName} ↔ ${compare.file.fileName}`
      : undefined;
  const matchesSubtitle = matches
    ? `${matches.individuals.length} individuals · ${matches.families.length} families`
    : undefined;
  const compareSubtitle = current ? `${safeIndex + 1} of ${visible.length}` : undefined;

  return (
    <div className="app">
      <header className="app-head">
        <h1>GedMerge</h1>
        <p className="subtitle">
          Compare and merge GEDCOM files entirely in your browser. Nothing is uploaded.
        </p>
      </header>

      <Section
        title="1 · Load GEDCOM"
        subtitle={loadSubtitle}
        open={openLoad}
        onToggle={() => setOpenLoad((o) => !o)}
      >
        <div className="loaders">
          <GedcomLoader
            title="Master GEDCOM"
            state={master}
            onLoad={(f) => loadFile("master", f)}
          />
          <GedcomLoader
            title="Incoming GEDCOM"
            state={compare}
            onLoad={(f) => loadFile("compare", f)}
          />
        </div>
      </Section>

      <Section
        title="2 · Compare"
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
            index={safeIndex}
            total={visible.length}
            onPrev={() => setSelectedIndex((i) => Math.max(0, i - 1))}
            onNext={() => setSelectedIndex((i) => Math.min(visible.length - 1, i + 1))}
          />
        ) : (
          <p className="muted">
            {matches
              ? "No match selected — pick one from the Matches list."
              : "Load both files to calculate matches."}
          </p>
        )}
      </Section>

      <Section
        title="3 · Matches"
        subtitle={matchesSubtitle}
        open={openMatches}
        onToggle={() => setOpenMatches((o) => !o)}
        disabled={!matches && !matching}
      >
        {matching ? (
          <div className="matching" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            Calculating matches…
          </div>
        ) : matches ? (
          <MatchResults
            result={matches}
            tab={tab}
            onTab={(t) => {
              setTab(t);
              setSelectedIndex(0);
            }}
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
        ) : (
          <p className="muted">Load both files to calculate matches.</p>
        )}
      </Section>
    </div>
  );
}

export type { SlotState };

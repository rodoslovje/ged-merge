import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import { validateDataset, type ValidationReport, type IssueCategory } from "../tools/validate";
import { findDuplicates, makeDuplicatePair, type DuplicatePair } from "../tools/duplicates";
import { bulkNormalize } from "../tools/bulkNormalize";
import { buildSourceTree, type SourceTree, type SourceUse, type RepoGroup, type SourceEntry, type MediaEntry } from "../tools/sources";
import { buildPlaceTree, countDistinctPlaces, type PlaceNode, type PlaceTree, UNSPECIFIED, UNSPECIFIED_PLACE } from "../tools/places";
import { collectPlaceSegments, previewPlaceRename, type PlaceRenamePreview } from "../tools/placeEdit";
import { collectNodeUseIds } from "../tools/places";
import { countryCode } from "../gedcom/countryCode";
import { serializeGedcom } from "../gedcom/serialize";
import { downloadText } from "./download";
import { individualFieldRows } from "../review/fields";
import { duplicateDefaults, relatedSeparateRecords } from "../tools/mergeDuplicate";
import { defaultChoice, type CandidateDecision, type FieldChoice, type FieldRow } from "../review/types";
import { type PersonNav } from "./ReadOnlyCompare";
import { FieldValue, LinkIcons, RelativeGrid } from "./FieldValue";
import { SourceRefs } from "./SourceRef";
import { ConfirmDialog } from "./ConfirmDialog";
import { PersonLink } from "./PersonLink";
import { MediaThumb, type MediaGalleryItem } from "./PersonPhotos";
import { mediaMetaRows } from "./PhotoViewer";

type Tool = "validate" | "duplicates" | "normalize" | "sources" | "places";

const TOOLS: Tool[] = ["validate", "duplicates", "normalize", "sources", "places"];

/** Max issue rows rendered at once — keeps an unvirtualized list responsive on
 *  files with thousands of findings; the rest are summarized as "…and N more". */
const MAX_ROWS = 1000;

interface Props {
  /** The live master dataset — every tool operates on the whole file. */
  dataset: Dataset;
  /** Master file name, used to name the normalized download. */
  fileName: string;
  /** Jump to a person/family record in Edit mode. */
  onNavigate: (id: string) => void;
  /** True when the Tools tab is the visible mode. */
  active: boolean;
  /** Rename a place segment in the given records and push to the undo stack. */
  onApplyPlaceRename: (from: string, to: string, scope: Set<string>) => void;
  /** Remove all broken family pointers and push to the undo stack. Returns the
   *  number of records changed, so the panel can re-validate and report. */
  onFixBrokenLinks: () => number;
  /** Merge a duplicate pair: fold the removed record into the survivor (kept)
   *  per the field choices, mutating the dataset in place and pushing to undo.
   *  Returns true when the merge applied (records changed). */
  onMergeDuplicate: (survivorId: string, removedId: string, decision: CandidateDecision) => boolean;
}

type AsyncState<T> =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: T };

/** Let React paint the "working…" state before a blocking computation runs. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function ToolsView({ dataset, fileName, onNavigate, active, onApplyPlaceRename, onFixBrokenLinks, onMergeDuplicate }: Props) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<Tool>("validate");

  // Cheap whole-file counts for the header overview; recomputed only per dataset.
  const stats = useMemo(() => ({
    indi: dataset.individuals.size,
    fam: dataset.families.size,
    sources: dataset.records.filter((r) => r.tag === "SOUR" && r.xref).length,
    places: countDistinctPlaces(dataset),
  }), [dataset]);

  return (
    <div className="tools-view">
      <div className="tools-head">
        <p className="tools-stats">{t("tools.stats", stats)}</p>
      </div>
      <div className="tools-subtabs" role="tablist">
        {TOOLS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tool === id}
            className={`tools-tab ${tool === id ? "active" : ""}`}
            onClick={() => setTool(id)}
          >
            <span className="tools-tab-label">{t(`tools.tool.${id}`)}</span>
            <span className="tools-tab-desc">{t(`tools.tool.${id}.desc`)}</span>
          </button>
        ))}
      </div>
      <div className="tools-panel">
        {tool === "validate" && (
          <ValidatePanel dataset={dataset} onNavigate={onNavigate} active={active} onFixBrokenLinks={onFixBrokenLinks} />
        )}
        {tool === "duplicates" && (
          <DuplicatesPanel dataset={dataset} onNavigate={onNavigate} active={active} onMergeDuplicate={onMergeDuplicate} />
        )}
        {tool === "normalize" && (
          <NormalizePanel dataset={dataset} fileName={fileName} active={active} />
        )}
        {tool === "sources" && (
          <SourcesPanel dataset={dataset} onNavigate={onNavigate} active={active} />
        )}
        {tool === "places" && (
          <PlacesPanel dataset={dataset} onNavigate={onNavigate} active={active} onApplyPlaceRename={onApplyPlaceRename} />
        )}
      </div>
    </div>
  );
}

// ── Validation ─────────────────────────────────────────────────────────────

const CATEGORIES: IssueCategory[] = [
  "brokenLink",
  "deathBeforeBirth",
  "futureDate",
  "missingVitals",
  "missingName",
  "missingSex",
  "orphan",
];

function ValidatePanel({
  dataset,
  onNavigate,
  active,
  onFixBrokenLinks,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
  onFixBrokenLinks: () => number;
}) {
  const { t } = useTranslation();
  // Only compute once the tab is actually shown, then memoize per dataset.
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [filter, setFilter] = useState<IssueCategory | "all">("all");
  const [query, setQuery] = useState("");
  // Transient confirmation after a one-button fix: how many records were repaired.
  const [fixedCount, setFixedCount] = useState<number | null>(null);

  function handleFixLinks() {
    const changed = onFixBrokenLinks();
    setFixedCount(changed);
    // App mutated the live dataset in place — re-validate to refresh the list.
    setReport(validateDataset(dataset));
    setFilter("all");
  }

  useEffect(() => {
    setReport(null);
    setFilter("all");
    setQuery("");
    setFixedCount(null);
  }, [dataset]);

  useEffect(() => {
    if (active && !report) setReport(validateDataset(dataset));
  }, [active, report, dataset]);

  const q = useDebounced(query).trim().toLowerCase();

  const shown = useMemo(() => {
    if (!report) return [];
    const byCat = filter === "all" ? report.issues : report.issues.filter((i) => i.category === filter);
    return q ? byCat.filter((i) => i.subject.toLowerCase().includes(q)) : byCat;
  }, [report, filter, q]);

  if (!report) return <div className="tools-loading">{t("tools.running")}</div>;

  const total = report.issues.length;
  return (
    <>
      {fixedCount !== null && (
        <p className="tools-clean tools-clean--ok">
          {fixedCount > 0
            ? t("tools.validate.fixLinksDone", { count: fixedCount })
            : t("tools.validate.fixLinksNone")}
        </p>
      )}
      {total === 0 ? (
        <p className="tools-clean">{t("tools.validate.clean")}</p>
      ) : (
        <>
          {report.counts.brokenLink > 0 && (
            <div className="tools-fix-bar">
              <button className="nav-btn tools-run" onClick={handleFixLinks}>
                {t("tools.validate.fixLinks", { count: report.counts.brokenLink })}
              </button>
              <span className="tools-fix-hint">{t("tools.validate.fixLinksHint")}</span>
            </div>
          )}
          <div className="tools-filter-row">
            <TreeSearch value={query} onChange={setQuery} />
            <div className="tools-chips">
              {CATEGORIES.filter((c) => report.counts[c] > 0).map((c) => (
                <button
                  key={c}
                  className={`tools-chip ${filter === c ? "active" : ""}`}
                  onClick={() => setFilter(c)}
                >
                  {t(`tools.validate.cat.${c}`)} <span className="tools-chip-count">{report.counts[c]}</span>
                </button>
              ))}
              <button
                className={`tools-chip ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                {t("tools.validate.all")} <span className="tools-chip-count">{total}</span>
              </button>
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="tools-clean">{t("tools.search.noMatch")}</p>
          ) : (
            <>
              <ul className="tools-issues">
                {shown.slice(0, MAX_ROWS).map((issue, i) => (
                  <li key={`${issue.id}-${issue.category}-${i}`} className={`tools-issue sev-${issue.severity}`}>
                    <PersonLink dataset={dataset} id={issue.id} fallback={issue.subject} onNavigate={onNavigate} />
                    <span className="tools-issue-msg">{t(issue.messageKey, issue.messageVars)}</span>
                  </li>
                ))}
              </ul>
              {shown.length > MAX_ROWS && (
                <p className="tools-more">{t("tools.validate.more", { count: shown.length - MAX_ROWS })}</p>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

// ── Duplicates ───────────────────────────────────────────────────────────────

function DuplicatesPanel({
  dataset,
  onNavigate,
  active,
  onMergeDuplicate,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
  onMergeDuplicate: (survivorId: string, removedId: string, decision: CandidateDecision) => boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<AsyncState<DuplicatePair[]>>({ status: "idle" });
  // Pair whose side-by-side comparison is expanded inline, keyed "aId-bId".
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Keyboard-highlighted pair (index into the currently shown list).
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  selectedRef.current = selected;
  const listRef = useRef<HTMLUListElement>(null);
  // Mirror `expanded` so the keydown handler (which doesn't re-subscribe on
  // every open/close) can read the live value.
  const expandedRef = useRef<string | null>(null);
  expandedRef.current = expanded;

  // Apply a merge, then drop from the list the merged pair and any other pair
  // that referenced the now-removed record (it no longer exists).
  function handleMerge(survivorId: string, removedId: string, decision: CandidateDecision) {
    if (!onMergeDuplicate(survivorId, removedId, decision)) return;
    setExpanded(null);
    setState((s) =>
      s.status === "done"
        ? { status: "done", result: s.result.filter((p) => p.aId !== removedId && p.bId !== removedId) }
        : s,
    );
  }

  // Open a related pair surfaced from inside an open comparison (a spouse/parent
  // that is a separate record on each side). Reuse the pair if it's already in
  // the list, otherwise synthesize and prepend it, then clear any filter and
  // expand it so the user can complete that merge too.
  function openPair(aId: string, bId: string) {
    if (state.status !== "done") return;
    const pair = state.result.find(
      (p) => (p.aId === aId && p.bId === bId) || (p.aId === bId && p.bId === aId),
    );
    if (!pair) {
      const made = makeDuplicatePair(dataset, aId, bId);
      if (!made) return;
      setState({ status: "done", result: [made, ...state.result] });
      setQuery("");
      setSelected(0); // prepended → top of the (unfiltered) list
      setExpanded(`${made.aId}-${made.bId}`);
      return;
    }
    setQuery("");
    setSelected(state.result.indexOf(pair));
    setExpanded(`${pair.aId}-${pair.bId}`);
  }

  useEffect(() => {
    setState({ status: "idle" });
    setExpanded(null);
    setQuery("");
    setSelected(0);
  }, [dataset]);

  // Run the (potentially heavy) scan the first time the tab is shown, letting
  // React paint the "working…" state before the blocking computation.
  useEffect(() => {
    if (!active || state.status !== "idle") return;
    let cancelled = false;
    setState({ status: "running" });
    void nextTick().then(() => {
      if (!cancelled) setState({ status: "done", result: findDuplicates(dataset) });
    });
    return () => { cancelled = true; };
  }, [active, state.status, dataset]);

  const q = useDebounced(query).trim().toLowerCase();
  const pairs = state.status === "done" ? state.result : null;
  const shown = useMemo(() => {
    if (!pairs) return [];
    return q ? pairs.filter((p) => someMatch(q, p.aLabel, p.bLabel)) : pairs;
  }, [pairs, q]);

  // Keep the highlight inside the (re)filtered list: a new filter starts at the
  // top; merging out a pair clamps to the last remaining one.
  useEffect(() => { setSelected(0); }, [q]);
  useEffect(() => {
    setSelected((i) => (shown.length === 0 ? 0 : Math.min(i, shown.length - 1)));
  }, [shown.length]);

  // Bring the keyboard-highlighted pair into view as it moves.
  useEffect(() => {
    (listRef.current?.children[selected] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Left/Right step the highlight between candidate pairs; Up/Down scroll the
  // surrounding list (when it overflows) so a long list can be read without
  // moving the selection. Mirrors the Merge view's compare-panel shortcuts.
  useEffect(() => {
    if (!active || shown.length === 0) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // Step the highlight; if a candidate is already open, keep the compare
      // open and stick it to the one we land on.
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const next = e.key === "ArrowLeft"
          ? Math.max(0, selectedRef.current - 1)
          : Math.min(shown.length - 1, selectedRef.current + 1);
        setSelected(next);
        if (expandedRef.current !== null) {
          const p = shown[next];
          if (p) setExpanded(`${p.aId}-${p.bId}`);
        }
        return;
      }
      if (e.key === "Enter") {
        const p = shown[selectedRef.current];
        if (!p) return;
        e.preventDefault();
        const key = `${p.aId}-${p.bId}`;
        setExpanded((cur) => (cur === key ? null : key));
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const el = listRef.current?.closest(".tools-view") as HTMLElement | null;
        if (!el || el.scrollHeight <= el.clientHeight) return;
        e.preventDefault();
        el.scrollBy({ top: e.key === "ArrowDown" ? 96 : -96, behavior: "smooth" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, shown]);

  if (state.status !== "done") return <div className="tools-loading">{t("tools.duplicates.running")}</div>;

  return (
    <>
      {state.result.length === 0 ? (
        <p className="tools-clean">{t("tools.duplicates.none")}</p>
      ) : (
        <>
          <div className="tools-filter-row">
            <TreeSearch value={query} onChange={setQuery} />
            <p className="tools-summary">{t("tools.duplicates.found", { count: state.result.length })}</p>
          </div>
          {shown.length === 0 ? (
            <p className="tools-clean">{t("tools.search.noMatch")}</p>
          ) : (
            <ul className="tools-pairs" ref={listRef}>
              {shown.map((p, i) => {
                const key = `${p.aId}-${p.bId}`;
                const open = expanded === key;
                return (
                  <li key={key} className={`tools-pair ${i === selected ? "selected" : ""}`}>
                    <div className="tools-pair-row" onMouseDown={() => setSelected(i)}>
                      <button
                        className={`tools-pair-toggle ${open ? "open" : ""}`}
                        onClick={() => setExpanded(open ? null : key)}
                        title={open ? t("tools.duplicates.hideCompare") : t("tools.duplicates.showCompare")}
                        aria-expanded={open}
                      >
                        ▶
                      </button>
                      <span className={`tools-cat cat-${p.category}`}>{Math.round(p.score)}</span>
                      <PersonLink dataset={dataset} id={p.aId} fallback={p.aLabel} onNavigate={onNavigate} />
                      <span className="tools-pair-sep">↔</span>
                      <PersonLink dataset={dataset} id={p.bId} fallback={p.bLabel} onNavigate={onNavigate} />
                    </div>
                    {open && (
                      <DuplicateCompare
                        dataset={dataset}
                        pair={p}
                        onNavigate={onNavigate}
                        onMerge={handleMerge}
                        onOpenPair={openPair}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </>
  );
}

const CHOICES: FieldChoice[] = ["master", "incoming", "both"];

/**
 * Editable side-by-side comparison of one duplicate pair. Both records live in
 * the same master dataset, so each column navigates into Edit mode. The left
 * (master) record is the survivor; per-field M/I/B controls choose what it keeps
 * — seeded by `duplicateDefaults` (more precise dates win, one-sided fields are
 * combined). The Merge button (behind a confirmation) folds the right record
 * into the left and deletes it.
 */
function DuplicateCompare({
  dataset,
  pair,
  onNavigate,
  onMerge,
  onOpenPair,
}: {
  dataset: Dataset;
  pair: DuplicatePair;
  onNavigate: (id: string) => void;
  onMerge: (survivorId: string, removedId: string, decision: CandidateDecision) => void;
  onOpenPair: (aId: string, bId: string) => void;
}) {
  const { t } = useTranslation();
  const a = dataset.individuals.get(pair.aId);
  const b = dataset.individuals.get(pair.bId);
  const rows = useMemo(
    () => individualFieldRows(t, a, b, dataset, dataset),
    [t, a, b, dataset],
  );
  // Relatives (spouses/parents) that are a separate record on each side: until
  // they're merged too, this merge can't fold their shared families/children.
  const related = useMemo(() => relatedSeparateRecords(rows), [rows]);
  const [fields, setFields] = useState<Record<string, FieldChoice>>(() => duplicateDefaults(rows));
  const [confirming, setConfirming] = useState(false);
  // Re-seed defaults if the underlying rows change (e.g. dataset edited elsewhere).
  useEffect(() => { setFields(duplicateDefaults(rows)); }, [rows]);

  const nav: PersonNav = {
    linkable: (id) => dataset.individuals.has(id),
    onNavigate,
  };
  const setChoice = (key: string, c: FieldChoice) => setFields((f) => ({ ...f, [key]: c }));

  function renderChoiceCell(row: FieldRow, choice: FieldChoice) {
    if (row.state === "conflict" || row.state === "incoming-only") {
      return CHOICES.map((c) => (
        <button
          key={c}
          className={`choice ${c}${choice === c ? " active" : ""}`}
          title={t(`choice.${c}.title`)}
          onClick={() => setChoice(row.key, c)}
        >
          {t(`choice.${c}.label`)}
        </button>
      ));
    }
    if (row.state === "agree") return <span className="muted">=</span>;
    return <span className="gm-master-tag">{t("compare.keepMaster")}</span>;
  }

  return (
    <div className="tools-pair-compare">
      <table className="compare">
        <thead>
          <tr className="compare-head">
            <th />
            <th className="compare-col compare-col-master">{t("tools.duplicates.surviving")}</th>
            <th className="compare-col compare-col-incoming">{t("tools.duplicates.candidate")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.isGroupHeader) {
              const isEventHeader = !!row.isEventHeader;
              return (
                <tr key={row.key} className={isEventHeader ? "group-header-row event-header-row" : "group-header-row"}>
                  <td colSpan={4} className={isEventHeader ? "group-header-cell event-header-cell" : "group-header-cell"}>
                    {row.label}
                  </td>
                </tr>
              );
            }
            const choice = fields[row.key] ?? defaultChoice(row);
            const hasSources = !!(row.masterSources || row.incomingSources || row.masterLinkIcons || row.incomingLinkIcons);
            return (
              <tr key={row.key} className={`field ${row.state}`}>
                <td className="f-label">{row.displayLabel ?? row.label}</td>
                {row.relatives ? (
                  <td className="f-rel" colSpan={3}>
                    <RelativeGrid
                      pairs={row.relatives}
                      masterChosen={choice !== "incoming"}
                      incomingChosen={choice !== "master"}
                      masterPerson={nav}
                      incomingPerson={nav}
                      renderChoice={() => renderChoiceCell(row, choice)}
                    />
                  </td>
                ) : hasSources ? (
                  <>
                    <td className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} masterSources={row.masterSources} />
                      {row.masterLinkIcons?.length ? <LinkIcons urls={row.masterLinkIcons} otherUrls={row.incomingLinkIcons} /> : null}
                    </td>
                    <td className={choice !== "master" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} masterSources={row.incomingSources} compareAgainst={row.masterSources} />
                      {row.incomingLinkIcons?.length ? <LinkIcons urls={row.incomingLinkIcons} otherUrls={row.masterLinkIcons} /> : null}
                    </td>
                  </>
                ) : (
                  <>
                    <td className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"} title={row.masterTitle}>
                      <FieldValue
                        text={row.master}
                        links={row.masterLinks}
                        linkIcons={row.masterLinkIcons}
                        otherLinkIcons={row.incomingLinkIcons}
                        person={row.masterRefs ? { refs: row.masterRefs, ...nav } : undefined}
                      />
                    </td>
                    <td className={choice !== "master" ? "f-val gm-data chosen" : "f-val gm-data"} title={row.incomingTitle}>
                      <FieldValue
                        text={row.incoming}
                        links={row.incomingLinks}
                        otherLinks={row.masterLinks}
                        linkIcons={row.incomingLinkIcons}
                        otherLinkIcons={row.masterLinkIcons}
                        person={row.incomingRefs ? { refs: row.incomingRefs, ...nav } : undefined}
                      />
                    </td>
                  </>
                )}
                {row.relatives ? null : <td className="f-choice">{renderChoiceCell(row, choice)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {related.length > 0 && (
        <div className="tools-related-hint">
          <span>{t("tools.duplicates.relatedHint")}</span>{" "}
          {related.map((r, i) => (
            <span key={`${r.aId}-${r.bId}`}>
              {i > 0 && ", "}
              <button
                className="tools-issue-link"
                title={t("tools.duplicates.relatedOpen")}
                onClick={() => onOpenPair(r.aId, r.bId)}
              >
                {r.label}
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="tools-merge-bar">
        <span className="tools-merge-hint">{t("tools.duplicates.survivorHint", { name: pair.aLabel })}</span>
        <button className="nav-btn primary tools-run" onClick={() => setConfirming(true)}>
          {t("tools.duplicates.merge")}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          danger
          message={t("tools.duplicates.mergeConfirm", { survivor: pair.aLabel, removed: pair.bLabel })}
          confirmLabel={t("tools.duplicates.merge")}
          onConfirm={() => {
            setConfirming(false);
            onMerge(pair.aId, pair.bId, { status: "confirmed", fields });
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

// ── Bulk normalize ───────────────────────────────────────────────────────────

function NormalizePanel({ dataset, fileName, active }: { dataset: Dataset; fileName: string; active: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<AsyncState<{ dataset: Dataset; report: NormalizationReport }>>({ status: "idle" });
  // Which passes the user wants applied on download; the preview report above
  // always reflects all three so the counts show what each would change.
  const [selected, setSelected] = useState<NormalizeOptions>({ dates: true, places: true, links: true, names: true });

  useEffect(() => {
    setState({ status: "idle" });
    setSelected({ dates: true, places: true, links: true, names: true });
  }, [dataset]);

  // Run the preview the first time the tab is shown, letting React paint the
  // "working…" state before the blocking computation.
  useEffect(() => {
    if (!active || state.status !== "idle") return;
    let cancelled = false;
    setState({ status: "running" });
    void nextTick().then(() => {
      if (!cancelled) setState({ status: "done", result: bulkNormalize(dataset) });
    });
    return () => { cancelled = true; };
  }, [active, state.status, dataset]);

  function download() {
    // Re-run with only the selected passes so the download honors the checkboxes.
    const { dataset: out } = bulkNormalize(dataset, selected);
    const base = fileName.replace(/\.ged$/i, "");
    const text = serializeGedcom(out.records, {
      eol: dataset.eol,
      finalNewline: dataset.finalNewline,
    });
    downloadText(`${base}.normalized.ged`, text);
  }

  if (state.status !== "done") return <div className="tools-loading">{t("tools.normalize.running")}</div>;

  return (
    <>
      {state.status === "done" && (() => {
        const { report } = state.result;
        const changed = report.datesChanged + report.placesReshaped + report.linksConverted + report.nameVariantsReshaped + report.unknownNamesReshaped;
        if (changed === 0) return <p className="tools-clean tools-clean--ok">{t("tools.normalize.none")}</p>;
        const counts = {
          dates: report.datesChanged,
          places: report.placesReshaped,
          links: report.linksConverted,
          // The "names" pass also cleans unknown-name placeholders (NN, ____).
          names: report.nameVariantsReshaped + report.unknownNamesReshaped,
        };
        const toggle = (key: keyof NormalizeOptions) =>
          setSelected((s) => ({ ...s, [key]: !s[key] }));
        // Selected sum guards the download: only passes that are both checked
        // and actually change something count toward "anything to apply".
        const selectedChanges =
          (selected.dates ? counts.dates : 0) +
          (selected.places ? counts.places : 0) +
          (selected.links ? counts.links : 0) +
          (selected.names ? counts.names : 0);
        return (
          <>
            <p className="tools-intro">{t("tools.normalize.intro")}</p>
            <ul className="tools-norm-summary">
              <NormCheck label={t("tools.normalize.dates", { count: counts.dates })}
                checked={selected.dates} count={counts.dates} onChange={() => toggle("dates")} />
              <NormCheck label={t("tools.normalize.places", { count: counts.places })}
                checked={selected.places} count={counts.places} onChange={() => toggle("places")} />
              <NormCheck label={t("tools.normalize.links", { count: counts.links })}
                checked={selected.links} count={counts.links} onChange={() => toggle("links")} />
              <NormCheck label={t("tools.normalize.names", { count: counts.names })}
                checked={selected.names} count={counts.names} onChange={() => toggle("names")} />
            </ul>
            {selected.dates && <NormExamples title={t("tools.normalize.exDates")} examples={report.dateExamples} />}
            {selected.places && <NormExamples title={t("tools.normalize.exPlaces")} examples={report.placeExamples} />}
            {selected.links && <NormExamples title={t("tools.normalize.exLinks")} examples={report.linkExamples} />}
            {selected.names && <NormExamples title={t("tools.normalize.exNames")} examples={[...report.nameVariantExamples, ...report.unknownNameExamples]} />}
            <button className="nav-btn tools-run" onClick={download} disabled={selectedChanges === 0}>
              {t("tools.normalize.download")}
            </button>
          </>
        );
      })()}
    </>
  );
}

/** One selectable normalization-count row: a checkbox in front of the count.
 *  Passes with nothing to change are disabled — there is nothing to opt into. */
function NormCheck({
  label,
  checked,
  count,
  onChange,
}: {
  label: string;
  checked: boolean;
  count: number;
  onChange: () => void;
}) {
  return (
    <li>
      <label className={`tools-norm-check ${count === 0 ? "disabled" : ""}`}>
        <input type="checkbox" checked={checked && count > 0} disabled={count === 0} onChange={onChange} />
        <span>{label}</span>
      </label>
    </li>
  );
}

function NormExamples({ title, examples }: { title: string; examples: { before: string; after: string }[] }) {
  if (!examples.length) return null;
  return (
    <div className="tools-examples">
      <div className="tools-examples-title">{title}</div>
      <ul>
        {examples.map((e, i) => (
          <li key={i}>
            <span className="tools-ex-from">{e.before}</span>
            <span className="tools-pair-sep">→</span>
            <span className="tools-ex-to">{e.after}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Shared usage list ────────────────────────────────────────────────────────

/** Records that cite a source/media or use a place; each navigates into Edit. */
function UsageList({ dataset, uses, onNavigate }: { dataset: Dataset; uses: SourceUse[]; onNavigate: (id: string) => void }) {
  const { t } = useTranslation();
  if (uses.length === 0) return null;
  return (
    <ul className="tools-usage">
      {uses.slice(0, MAX_ROWS).map((u, i) => (
        <li key={`${u.persons.map((p) => p.id).join("-")}-${i}`}>
          {u.persons.map((p, j) => (
            <span key={p.id}>
              {j > 0 && <span className="tools-usage-amp">&amp;</span>}
              <PersonLink dataset={dataset} id={p.id} fallback={p.label} onNavigate={onNavigate} />
            </span>
          ))}
        </li>
      ))}
      {uses.length > MAX_ROWS && (
        <li className="tools-more">{t("tools.validate.more", { count: uses.length - MAX_ROWS })}</li>
      )}
    </ul>
  );
}

/** Lightbox side panel for a media object: the person/family records that
 *  reference the image (the descriptive caption rows are supplied separately as
 *  the photo's `meta`). `onNavigate` closes the lightbox before jumping to the
 *  record in Edit mode. */
function MediaDetails({
  dataset,
  media,
  onNavigate,
}: {
  dataset: Dataset;
  media: MediaEntry;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="media-lightbox-uses-head">
        {t("tools.sources.referencedBy", { count: media.usedBy.length })}
      </div>
      {media.usedBy.length > 0 ? (
        <UsageList dataset={dataset} uses={media.usedBy} onNavigate={onNavigate} />
      ) : (
        <p className="tools-clean">{t("tools.sources.referencedByNone")}</p>
      )}
    </>
  );
}

/**
 * One `TreeRow` per `MediaEntry` in a group (a source's media, or an unattached
 * bucket). The group's local-file photos form a single navigable tray: each
 * thumbnail opens the viewer on its own photo with prev/next across the
 * siblings. URL-only entries show `iconFor(m)` instead. The tray (and each
 * photo's index in it) is computed once for the whole group.
 */
function MediaRows({
  entries,
  dataset,
  onNavigate,
  isOpen,
  toggle,
  rowKey,
  iconFor,
}: {
  entries: MediaEntry[];
  dataset: Dataset;
  onNavigate: (id: string) => void;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  rowKey: (m: MediaEntry) => string;
  iconFor: (m: MediaEntry) => string;
}) {
  const { t } = useTranslation();
  const { items, indexOf } = useMemo(() => {
    const photos = entries.filter((m) => !m.url && m.file);
    const items: MediaGalleryItem[] = photos.map((m) => ({
      file: m.file!,
      title: m.title || m.xref,
      meta: mediaMetaRows(m, t),
      details: (close: () => void) => (
        <MediaDetails dataset={dataset} media={m} onNavigate={(id) => { close(); onNavigate(id); }} />
      ),
    }));
    return { items, indexOf: new Map(photos.map((m, i) => [m, i] as const)) };
  }, [entries, dataset, onNavigate, t]);

  return (
    <>
      {entries.map((m) => {
        const photoIndex = indexOf.get(m);
        const key = rowKey(m);
        return (
          <TreeRow
            key={key}
            open={isOpen(key)}
            onToggle={() => toggle(key)}
            hasChildren={m.usedBy.length > 0}
            count={m.usedBy.length || undefined}
            href={m.url}
            titleText={m.url ?? m.file}
            label={
              <span className="tools-tree-meta">
                {photoIndex !== undefined && m.file ? (
                  <MediaThumb file={m.file} icon={iconFor(m)} gallery={items} index={photoIndex} />
                ) : (
                  iconFor(m)
                )}{" "}
                {m.title || m.xref}
              </span>
            }
          >
            <UsageList dataset={dataset} uses={m.usedBy} onNavigate={onNavigate} />
          </TreeRow>
        );
      })}
    </>
  );
}

/** A collapsible tree row: a ▶ toggle, a label, a usage count, and nested content. */
function TreeRow({
  open,
  onToggle,
  hasChildren,
  label,
  count,
  href,
  titleText,
  prominent,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  hasChildren: boolean;
  label: ReactNode;
  count?: number;
  href?: string;
  /** Tooltip shown on hover over the label — e.g. a media link or filename. */
  titleText?: string;
  /** Emphasize the label as a top-level grouping (e.g. a repository). */
  prominent?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className="tools-tree-node">
      <div className="tools-tree-row">
        {hasChildren ? (
          <button
            className={`tools-pair-toggle ${open ? "open" : ""}`}
            onClick={onToggle}
            aria-expanded={open}
          >
            ▶
          </button>
        ) : (
          <span className="tools-tree-bullet">·</span>
        )}
        <span
          className={`tools-tree-label${hasChildren ? " clickable" : ""}${prominent ? " lead" : ""}`}
          title={titleText}
          onClick={hasChildren ? onToggle : undefined}
        >
          {label}
        </span>
        {href && (
          <a className="tools-tree-link" href={href} target="_blank" rel="noreferrer" title={href}>
            ↗
          </a>
        )}
        {count != null && <span className="tools-chip-count">{count}</span>}
      </div>
      {open && hasChildren && <div className="tools-tree-children">{children}</div>}
    </li>
  );
}

/** Returns `value` delayed by `delay` ms — updates only after typing pauses,
 * so the tree isn't re-filtered on every keystroke. */
function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ── Sources explorer ─────────────────────────────────────────────────────────

/** True when any of the strings contain `q` (already lower-cased). */
const someMatch = (q: string, ...vals: (string | undefined)[]) =>
  vals.some((v) => v?.toLowerCase().includes(q));

/** Keep media whose title/xref/file matches `q`. */
const mediaMatches = (m: MediaEntry, q: string) => someMatch(q, m.title, m.xref, m.file, m.url);

/** Keep sources whose own fields, or any of their media, match `q`. */
const sourceMatches = (src: SourceEntry, q: string) =>
  someMatch(q, src.title, src.xref, src.filingNumber, src.tooltip) ||
  src.media.some((m) => mediaMatches(m, q));

/** Prune the repo list to those matching `q` (whole subtree kept on a repo-level
 * match; otherwise only matching sources are retained). Repos/sources that
 * survive solely as ancestors of a deeper match are collected in `openRepos` /
 * `openSources` so they expand down to (not past) the matching entries. */
function filterRepos(repos: RepoGroup[], q: string): {
  repos: RepoGroup[];
  openRepos: Set<RepoGroup>;
  openSources: Set<SourceEntry>;
} {
  const out: RepoGroup[] = [];
  const openRepos = new Set<RepoGroup>();
  const openSources = new Set<SourceEntry>();
  for (const repo of repos) {
    if (someMatch(q, repo.name, repo.xref, repo.tooltip)) {
      out.push(repo);
      continue;
    }
    const sources = repo.sources.filter((s) => sourceMatches(s, q));
    if (sources.length === 0) continue;
    const kept = { ...repo, sources };
    out.push(kept);
    openRepos.add(kept);
    for (const s of sources) {
      // Source kept only because one of its media matched → open it to reveal that medium.
      if (!someMatch(q, s.title, s.xref, s.filingNumber, s.tooltip)) openSources.add(s);
    }
  }
  return { repos: out, openRepos, openSources };
}

/** Keys to also open below a source that funnels into a single medium with no
 * citations of its own. */
function srcDescendants(src: SourceEntry): string[] {
  return src.media.length === 1 && src.usedBy.length === 0 ? [`m:${src.media[0].xref}`] : [];
}

/** Keys to also open below a repo that holds exactly one source (drilling on
 * through that source's own single-child chain). */
function repoDescendants(repo: RepoGroup): string[] {
  if (repo.sources.length !== 1) return [];
  const src = repo.sources[0];
  return [`s:${src.xref}`, ...srcDescendants(src)];
}

function SourcesPanel({
  dataset,
  onNavigate,
  active,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<SourceTree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  useEffect(() => {
    setTree(null);
    setOpen(new Set());
    setQuery("");
  }, [dataset]);

  useEffect(() => {
    if (active && !tree) setTree(buildSourceTree(dataset));
  }, [active, tree, dataset]);

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Expand `key` and, unless it's already open, also open its single-child
  // chain so one click drills down to the first branching level.
  const openWith = (key: string, descendants: string[]) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      next.add(key);
      for (const k of descendants) next.add(k);
      return next;
    });

  const q = useDebounced(query).trim().toLowerCase();
  const filtering = q.length > 0;

  const filtered = useMemo(() => {
    if (!tree) return null;
    if (!filtering) return { tree, openRepos: new Set<RepoGroup>(), openSources: new Set<SourceEntry>() };
    const { repos, openRepos, openSources } = filterRepos(tree.repos, q);
    return {
      tree: {
        ...tree,
        repos,
        unattachedLinks: tree.unattachedLinks.filter((m) => mediaMatches(m, q)),
        unattachedMedia: tree.unattachedMedia.filter((m) => mediaMatches(m, q)),
      },
      openRepos,
      openSources,
    };
  }, [tree, filtering, q]);

  // Filtering expands ancestors down to (not past) the matches; the user expands further.
  const isOpen = (key: string) => open.has(key);

  if (!tree || !filtered) return <div className="tools-loading">{t("tools.running")}</div>;

  const empty =
    filtered.tree.repos.length === 0 &&
    filtered.tree.unattachedLinks.length === 0 &&
    filtered.tree.unattachedMedia.length === 0;

  const unattachedGroup = (key: string, labelKey: string, icon: string, entries: typeof tree.unattachedMedia) => {
    if (entries.length === 0) return false;
    return (
      <TreeRow
        open={isOpen(key) || filtering}
        onToggle={() => toggle(key)}
        hasChildren
        count={entries.length}
        label={t(labelKey)}
      >
        <ul className="tools-tree">
          <MediaRows
            entries={entries}
            dataset={dataset}
            onNavigate={onNavigate}
            isOpen={isOpen}
            toggle={toggle}
            rowKey={(m) => `${key}:${m.xref}`}
            iconFor={() => icon}
          />
        </ul>
      </TreeRow>
    );
  };

  return (
    <>
      <div className="tools-filter-row">
        <TreeSearch value={query} onChange={setQuery} />
        <p className="tools-summary">
          {t("tools.sources.summary", {
            repos: tree.repoCount,
            sources: tree.sourceCount,
            media: tree.mediaCount,
          })}
        </p>
      </div>
      {empty ? (
        <p className="tools-clean">{filtering ? t("tools.search.noMatch") : t("tools.sources.none")}</p>
      ) : (
        <ul className="tools-tree">
          {filtered.tree.repos.map((repo, ri) => {
            const repoKey = `r:${repo.xref ?? "none"}:${ri}`;
            return (
              <TreeRow
                key={repoKey}
                open={isOpen(repoKey) || filtered.openRepos.has(repo)}
                onToggle={() => openWith(repoKey, repoDescendants(repo))}
                hasChildren={repo.sources.length > 0}
                count={repo.sources.length}
                href={repo.url}
                titleText={repo.tooltip || repo.xref}
                prominent
                label={repo.xref ? repo.name || repo.xref : t("tools.sources.noRepo")}
              >
                <ul className="tools-tree">
                  {repo.sources.map((src) => {
                    const srcKey = `s:${src.xref}`;
                    const hasKids = src.media.length > 0 || src.usedBy.length > 0;
                    return (
                      <TreeRow
                        key={srcKey}
                        open={isOpen(srcKey) || filtered.openSources.has(src)}
                        onToggle={() => openWith(srcKey, srcDescendants(src))}
                        hasChildren={hasKids}
                        count={src.usedBy.length}
                        titleText={src.tooltip || src.xref}
                        label={
                          <>
                            {src.title || src.xref}
                            {src.filingNumber && (
                              <span className="tools-tree-meta"> · {src.filingNumber}</span>
                            )}
                          </>
                        }
                      >
                        <MediaRows
                          entries={src.media}
                          dataset={dataset}
                          onNavigate={onNavigate}
                          isOpen={isOpen}
                          toggle={toggle}
                          rowKey={(m) => `m:${m.xref}`}
                          iconFor={(m) => (m.url ? "🔗" : "🖼")}
                        />
                        {src.usedBy.length > 0 && (
                          <div className="tools-usage-block">
                            <UsageList dataset={dataset} uses={src.usedBy} onNavigate={onNavigate} />
                          </div>
                        )}
                      </TreeRow>
                    );
                  })}
                </ul>
              </TreeRow>
            );
          })}
          {unattachedGroup("unattachedLinks", "tools.sources.unattachedLinks", "🔗", filtered.tree.unattachedLinks)}
          {unattachedGroup("unattached", "tools.sources.unattached", "🖼", filtered.tree.unattachedMedia)}
        </ul>
      )}
    </>
  );
}

// ── Places explorer ──────────────────────────────────────────────────────────

/** Prune a place node to those whose name matches `q` (already lower-cased)
 * anywhere in the subtree. A node matching by name keeps its whole subtree;
 * otherwise only matching descendant branches are retained. Paths of nodes that
 * survive solely as ancestors of a match are collected in `autoOpen` so they can
 * be expanded down to (but not past) the matching entries. */
function filterPlaceNode(node: PlaceNode, q: string, path: string, autoOpen: Set<string>): PlaceNode | null {
  if (node.name.toLowerCase().includes(q)) return node;
  const children: PlaceNode[] = [];
  for (const child of node.children) {
    const kept = filterPlaceNode(child, q, `${path}/${child.name}`, autoOpen);
    if (kept) children.push(kept);
  }
  if (children.length === 0) return null;
  autoOpen.add(path);
  return { ...node, children };
}

function PlacesPanel({
  dataset,
  onNavigate,
  active,
  onApplyPlaceRename,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
  onApplyPlaceRename: (from: string, to: string, scope: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<PlaceTree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  useEffect(() => {
    setTree(null);
    setOpen(new Set());
    setQuery("");
  }, [dataset]);

  useEffect(() => {
    if (active && !tree) setTree(buildPlaceTree(dataset));
  }, [active, tree, dataset]);

  // Expanding a place opens it and then keeps drilling through any single-child
  // chain (a node with exactly one sub-place and no usages of its own), so one
  // click lands on the first level that actually offers a choice. Collapsing
  // just closes the clicked node.
  const togglePlace = (node: PlaceNode, path: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(path)) {
        next.delete(path);
        return next;
      }
      let cur: PlaceNode = node;
      let curPath = path;
      next.add(curPath);
      while (cur.children.length === 1 && cur.uses.length === 0) {
        cur = cur.children[0];
        curPath = `${curPath}/${cur.name}`;
        next.add(curPath);
      }
      return next;
    });

  const q = useDebounced(query).trim().toLowerCase();
  const filtering = q.length > 0;

  const { roots, autoOpen } = useMemo(() => {
    const ao = new Set<string>();
    if (!tree) return { roots: [] as PlaceNode[], autoOpen: ao };
    if (!filtering) return { roots: tree.roots, autoOpen: ao };
    const r = tree.roots
      .map((node) => filterPlaceNode(node, q, node.name, ao))
      .filter((n): n is PlaceNode => n !== null);
    return { roots: r, autoOpen: ao };
  }, [tree, filtering, q]);

  // Filtering expands ancestors down to (not past) the matches; the user expands further.
  const isOpen = (key: string) => autoOpen.has(key) || open.has(key);

  // All distinct segments for rename autocomplete — recomputed whenever the tree rebuilds.
  const allSegments = useMemo(() => tree ? collectPlaceSegments(dataset) : [], [tree, dataset]);

  function handleRename(from: string, to: string, scope: Set<string>) {
    // Capture the path of `from` in the current tree before rebuild so we can
    // derive the correct destination path (avoids opening the wrong "Wayne" in
    // a different state when multiple nodes share the target name).
    let fromPath: string | null = null;
    if (tree) {
      const findFrom = (node: PlaceNode, path: string): boolean => {
        if (node.name === from) { fromPath = path; return true; }
        for (const child of node.children) {
          if (findFrom(child, `${path}/${child.name}`)) return true;
        }
        return false;
      };
      for (const root of tree.roots) { if (findFrom(root, root.name)) break; }
    }

    onApplyPlaceRename(from, to, scope);
    const newTree = buildPlaceTree(dataset);
    setTree(newTree);

    // Build the expected path: substitute `to` for `from`, or remove the segment when deleting.
    const expectedPath = fromPath
      ? to
        ? (fromPath as string).split("/").map(s => s === from ? to : s).join("/")
        : (fromPath as string).split("/").filter(s => s !== from).join("/")
      : null;

    const toOpen = new Set<string>();
    if (expectedPath) {
      const parts = expectedPath.split("/");
      for (let i = 1; i <= parts.length; i++) toOpen.add(parts.slice(0, i).join("/"));
    }
    setOpen(toOpen);
  }

  if (!tree) return <div className="tools-loading">{t("tools.running")}</div>;

  return (
    <>
      <div className="tools-filter-row">
        <TreeSearch value={query} onChange={setQuery} />
        <p className="tools-summary">
          {t("tools.places.summary", { countries: tree.countryCount, distinct: tree.distinctCount, uses: tree.totalUses })}
        </p>
      </div>
      {roots.length === 0 ? (
        <p className="tools-clean">{filtering ? t("tools.search.noMatch") : t("tools.places.none")}</p>
      ) : (
        <ul className="tools-tree">
          {roots.map((node) => (
            <PlaceTreeRow
              key={node.name}
              dataset={dataset}
              node={node}
              path={node.name}
              depth={0}
              isOpen={isOpen}
              toggle={togglePlace}
              onNavigate={onNavigate}
              onRename={handleRename}
              allSegments={allSegments}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function PlaceTreeRow({
  dataset,
  node,
  path,
  depth,
  isOpen,
  toggle,
  onNavigate,
  onRename,
  allSegments,
}: {
  dataset: Dataset;
  node: PlaceNode;
  path: string;
  depth: number;
  isOpen: (key: string) => boolean;
  toggle: (node: PlaceNode, path: string) => void;
  onNavigate: (id: string) => void;
  onRename: (from: string, to: string, scope: Set<string>) => void;
  allSegments: string[];
}) {
  const { t } = useTranslation();
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const debouncedRename = useDebounced(renameValue, 250);

  const nodeScope = useMemo(() => collectNodeUseIds(node), [node]);

  const hasChildren = node.children.length > 0 || node.uses.length > 0;
  const open = isOpen(path);
  const isSynthetic = node.name === UNSPECIFIED || node.name === UNSPECIFIED_PLACE;
  const name =
    node.name === UNSPECIFIED
      ? t("tools.places.unspecified")
      : node.name === UNSPECIFIED_PLACE
        ? t("tools.places.unspecifiedPlace")
        : node.name;
  const code = depth === 0 && !isSynthetic ? countryCode(node.name) : undefined;
  const flag = code ? [...code.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join("") : undefined;
  const labelNode = flag ? <>{flag} {name}</> : name;

  // Compute rename preview whenever the value differs from the current name.
  const preview = useMemo((): PlaceRenamePreview | null => {
    const target = debouncedRename.trim();
    if (!editing || target === node.name) return null;
    return previewPlaceRename(dataset, node.name, target, nodeScope);
  }, [editing, debouncedRename, node.name, dataset, nodeScope]);

  function openEdit() {
    setRenameValue(node.name);
    setEditing(true);
  }

  function handleApply() {
    const target = renameValue.trim();
    if (target === node.name) return;
    onRename(node.name, target, nodeScope);
    setEditing(false);
    setRenameValue("");
  }

  const datalistId = `place-segs-${uid}`;
  const targetTrimmed = renameValue.trim();
  const applyDisabled = targetTrimmed === node.name;
  // Show "Delete" when target is cleared; "Merge" when it already exists.
  const isDelete = !applyDisabled && targetTrimmed === "";
  const isMerge = !applyDisabled && !isDelete && allSegments.includes(targetTrimmed);

  return (
    <li className={node.isAddress ? "tools-tree-node tools-tree-addr" : "tools-tree-node"}>
      <div className="tools-tree-row">
        {hasChildren ? (
          <button
            className={`tools-pair-toggle ${open ? "open" : ""}`}
            onClick={() => toggle(node, path)}
            aria-expanded={open}
          >
            ▶
          </button>
        ) : (
          <span className="tools-tree-bullet">·</span>
        )}
        <span
          className={`tools-tree-label${hasChildren ? " clickable" : ""}${depth === 0 ? " lead" : ""}`}
          onClick={hasChildren ? () => toggle(node, path) : undefined}
        >
          {labelNode}
        </span>
        <span className="tools-chip-count">{node.count}</span>
        {!isSynthetic && !editing && (
          <button
            className="tools-place-edit-btn"
            onClick={openEdit}
            title={t("tools.places.rename.open")}
          >
            ✏︎
          </button>
        )}
        {editing && (
          <button
            className="tools-place-edit-btn tools-place-edit-cancel"
            onClick={() => setEditing(false)}
            title={t("tools.places.rename.cancel")}
          >
            ✕
          </button>
        )}
      </div>

      {editing && (
        <div className="tools-place-rename">
          <datalist id={datalistId}>
            {allSegments.map((s) => <option key={s} value={s} />)}
          </datalist>
          <input
            type="text"
            className="tools-place-rename-input"
            value={renameValue}
            list={datalistId}
            autoFocus
            placeholder={t("tools.places.rename.placeholder")}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !applyDisabled) handleApply();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          {preview && (
            <span className="tools-place-rename-hint">
              {preview.affectedCount > 0
                ? t("tools.places.rename.count", { count: preview.affectedCount })
                : t("tools.places.rename.noMatch")}
            </span>
          )}
          <button
            className="nav-btn primary tools-place-rename-apply"
            onClick={handleApply}
            disabled={applyDisabled}
          >
            {isDelete ? t("tools.places.rename.delete") : isMerge ? t("tools.places.rename.merge") : t("tools.places.rename.apply")}
          </button>
        </div>
      )}

      {open && hasChildren && (
        <div className="tools-tree-children">
          <ul className="tools-tree">
            {node.children.map((child) => (
              <PlaceTreeRow
                key={child.name}
                dataset={dataset}
                node={child}
                path={`${path}/${child.name}`}
                depth={depth + 1}
                isOpen={isOpen}
                toggle={toggle}
                onNavigate={onNavigate}
                onRename={onRename}
                allSegments={allSegments}
              />
            ))}
          </ul>
          <UsageList dataset={dataset} uses={node.uses} onNavigate={onNavigate} />
        </div>
      )}
    </li>
  );
}

/** Shared search box for the Sources/Places explorers. A clear button appears
 *  once there's text to clear. */
function TreeSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="tools-search">
      <input
        type="text"
        className="tools-search-input"
        placeholder={t("tools.search.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="tools-search-clear"
          onClick={() => onChange("")}
          title={t("tools.search.clear")}
          aria-label={t("tools.search.clear")}
        >
          ✕
        </button>
      )}
    </div>
  );
}

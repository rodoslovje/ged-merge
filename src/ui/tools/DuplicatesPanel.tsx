import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import {
  makeDuplicatePair,
  duplicatePairKey,
  clusterDuplicates,
  type DuplicatePair,
  type DuplicateCluster,
} from "../../tools/duplicates";
import { categorize, DEFAULT_CONFIG, type MatchCategory } from "../../match/types";
import { individualFieldRows } from "../../review/fields";
import { duplicateDefaults, relatedSeparateRecords } from "../../tools/mergeDuplicate";
import { defaultChoice, type CandidateDecision, type FieldChoice, type FieldRow } from "../../review/types";
import { type PersonNav } from "../ReadOnlyCompare";
import { KEY, isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { FieldValue, LinkIcons, RelativeGrid } from "../FieldValue";
import { SourceRefs } from "../SourceRef";
import { ConfirmDialog } from "../ConfirmDialog";
import { PersonLink } from "../PersonLink";
import { type ToolsScans } from "../useToolsScans";
import { useVirtualList } from "../useVirtualList";
import { ToolsError, ToolsLoading, TreeSearch, someMatch, useDebounced } from "./shared";

export function DuplicatesPanel({
  dataset,
  scans,
  onNavigate,
  active,
  onMergeDuplicate,
  rejectedDuplicates,
  onRejectDuplicate,
  onUnrejectDuplicate,
}: {
  dataset: Dataset;
  scans: ToolsScans;
  onNavigate: (id: string) => void;
  active: boolean;
  onMergeDuplicate: (survivorId: string, removedId: string, decision: CandidateDecision) => boolean;
  rejectedDuplicates: Set<string>;
  onRejectDuplicate: (aId: string, bId: string) => void;
  onUnrejectDuplicate: (aId: string, bId: string) => void;
}) {
  const { t } = useTranslation();
  // The scan result lives in the ToolsView-level cache, so it survives
  // switching sub-tabs or modes while the (minutes-long) scan keeps running.
  const state = scans.duplicates;
  // Pair whose side-by-side comparison is expanded inline, keyed "aId-bId".
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Toggles the list between active candidates and previously-rejected pairs.
  const [showRejected, setShowRejected] = useState(false);
  // Keyboard-highlighted pair (index into the currently shown list).
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  selectedRef.current = selected;
  const listRef = useRef<HTMLUListElement>(null);
  // Mirror `expanded` so the keydown handler (which doesn't re-subscribe on
  // every open/close) can read the live value.
  const expandedRef = useRef<string | null>(null);
  expandedRef.current = expanded;
  // Field choices of expanded comparisons, keyed "aId-bId". Kept up here so
  // they survive the row scrolling out of the virtual window, which unmounts
  // its DuplicateCompare.
  const fieldsCache = useRef(new Map<string, Record<string, FieldChoice>>());

  // Apply a merge, then drop from the list the merged pair and any other pair
  // that referenced the now-removed record (it no longer exists). Jumps to
  // whatever takes the merged pair's old place in the (pre-merge) shown list —
  // same auto-advance as rejecting a pair — so the panel doesn't just go blank.
  function handleMerge(survivorId: string, removedId: string, decision: CandidateDecision) {
    if (!onMergeDuplicate(survivorId, removedId, decision)) return;
    const idx = shown.findIndex((p) => p.aId === survivorId && p.bId === removedId);
    const remaining = shown.filter((p) => p.aId !== removedId && p.bId !== removedId);
    scans.updateDuplicates((pairs) => pairs.filter((p) => p.aId !== removedId && p.bId !== removedId));
    if (remaining.length === 0) {
      setExpanded(null);
      return;
    }
    const nextIdx = Math.min(idx < 0 ? 0 : idx, remaining.length - 1);
    const next = remaining[nextIdx];
    setSelected(nextIdx);
    setExpanded(`${next.aId}-${next.bId}`);
  }

  // Dismiss a pair as not-a-duplicate: persisted via the parent, so it won't
  // resurface next time the scan runs. The pair itself stays in `state.result`
  // (unlike a merge, nothing about the dataset changed) — it just moves from
  // the active list into the rejected one via the `rejectedDuplicates` filter.
  // Jumps to whatever takes its old place in the (pre-reject) shown list —
  // same auto-advance behavior as rejecting a match in Merge — so the panel
  // doesn't just go blank.
  function handleReject(aId: string, bId: string) {
    const idx = shown.findIndex((p) => p.aId === aId && p.bId === bId);
    onRejectDuplicate(aId, bId);
    const remaining = shown.filter((p) => !(p.aId === aId && p.bId === bId));
    if (remaining.length === 0) {
      setExpanded(null);
      return;
    }
    const nextIdx = Math.min(idx < 0 ? 0 : idx, remaining.length - 1);
    const next = remaining[nextIdx];
    setSelected(nextIdx);
    setExpanded(`${next.aId}-${next.bId}`);
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
      scans.updateDuplicates((pairs) => [made, ...pairs]);
      setQuery("");
      setSelected(0); // prepended → top of the (unfiltered) list
      setExpanded(`${made.aId}-${made.bId}`);
      return;
    }
    setQuery("");
    const idx = shown.indexOf(pair);
    if (idx >= 0) {
      setSelected(idx);
    } else {
      // Filtered out by the (just-cleared) search — move it to the front so
      // the opened comparison is actually on screen.
      scans.updateDuplicates((pairs) => [pair, ...pairs.filter((p) => p !== pair)]);
      setSelected(0);
    }
    setExpanded(`${pair.aId}-${pair.bId}`);
  }

  useEffect(() => {
    setExpanded(null);
    setQuery("");
    setSelected(0);
    setShowRejected(false);
    fieldsCache.current.clear();
  }, [dataset]);

  // Start the (potentially minutes-long) scan the first time the tab is shown.
  // It runs in the tools worker and its state lives in the ToolsView-level
  // cache, so browsing to another tab or mode neither cancels nor restarts it.
  useEffect(() => {
    if (active) scans.ensure("duplicates");
  }, [active, scans]);

  const q = useDebounced(query).trim().toLowerCase();
  const pairs = state.status === "done" ? state.result : null;
  const rejectedCount = useMemo(
    () => (pairs ?? []).filter((p) => rejectedDuplicates.has(duplicatePairKey(p.aId, p.bId))).length,
    [pairs, rejectedDuplicates],
  );
  const shown = useMemo(() => {
    if (!pairs) return [];
    const base = pairs.filter((p) => rejectedDuplicates.has(duplicatePairKey(p.aId, p.bId)) === showRejected);
    return q ? base.filter((p) => someMatch(q, p.aLabel, p.bLabel)) : base;
  }, [pairs, q, rejectedDuplicates, showRejected]);

  // An index-scale file produces six-figure pair counts — only the rows near
  // the viewport are mounted, so the whole score-sorted list stays browsable.
  // The scroll container is the ancestor `.tools-view`.
  const virtual = useVirtualList({ count: shown.length, estimate: 34, itemsKey: shown });

  // Keep the highlight inside the (re)filtered list: a new filter starts at the
  // top; merging out a pair clamps to the last remaining one.
  useEffect(() => { setSelected(0); }, [q]);
  useEffect(() => {
    setSelected((i) => (shown.length === 0 ? 0 : Math.min(i, shown.length - 1)));
  }, [shown.length]);

  // Bring the keyboard-highlighted pair into view as it moves.
  const { scrollToIndex } = virtual;
  useEffect(() => {
    scrollToIndex(selected);
  }, [selected, scrollToIndex]);

  // Left/Right step the highlight between candidate pairs; Up/Down scroll the
  // surrounding list (when it overflows) so a long list can be read without
  // moving the selection. Mirrors the Merge view's compare-panel shortcuts.
  useEffect(() => {
    if (!active || shown.length === 0) return;
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isModalOpen()) return;
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

  if (state.status === "error") return <ToolsError message={state.message} />;
  if (state.status === "cancelled") {
    return (
      <div className="tools-loading">
        <div className="parsing-status">{t("tools.scan.cancelled")}</div>
        <button className="nav-btn tools-run" onClick={() => scans.refresh("duplicates")}>
          {t("tools.scan.rerun")}
        </button>
      </div>
    );
  }
  if (state.status !== "done") {
    return (
      <ToolsLoading
        label={t("tools.duplicates.running")}
        progress={state.status === "running" ? state.progress : undefined}
        onCancel={scans.cancelDuplicates}
      />
    );
  }

  return (
    <>
      {state.result.length === 0 ? (
        <p className="tools-clean">{t("tools.duplicates.none")}</p>
      ) : (
        <>
          <div className="tools-filter-row">
            <TreeSearch value={query} onChange={setQuery} />
            {rejectedCount > 0 && (
              <button className="tools-chip tools-dup-toggle" onClick={() => setShowRejected((v) => !v)}>
                {showRejected ? t("tools.duplicates.showActive") : (
                  <>{t("tools.duplicates.showRejected")} <span className="tools-chip-count">{rejectedCount}</span></>
                )}
              </button>
            )}
            <p className="tools-summary">
              {showRejected
                ? t("tools.duplicates.rejectedCount", { count: rejectedCount })
                : t("tools.duplicates.found", { count: state.result.length - rejectedCount })}
            </p>
          </div>
          {shown.length === 0 ? (
            <p className="tools-clean">
              {q
                ? t("tools.search.noMatch")
                : showRejected
                  ? t("tools.duplicates.noneRejected")
                  : t("tools.duplicates.allRejected")}
            </p>
          ) : (
            <ul className="tools-pairs" ref={listRef}>
              <li className="v-spacer" style={{ height: virtual.padTop }} ref={virtual.topRef} aria-hidden />
              {shown.slice(virtual.start, virtual.end).map((p, j) => {
                const i = virtual.start + j;
                const key = `${p.aId}-${p.bId}`;
                const open = !showRejected && expanded === key;
                return (
                  <li key={key} className={`tools-pair ${i === selected ? "selected" : ""}${i % 2 ? " zebra" : ""}`}>
                    <div className="tools-pair-row" onMouseDown={() => setSelected(i)}>
                      {showRejected ? (
                        <span className="tools-pair-toggle-spacer" aria-hidden="true" />
                      ) : (
                        <button
                          className={`tools-pair-toggle ${open ? "open" : ""}`}
                          onClick={() => setExpanded(open ? null : key)}
                          title={open ? t("tools.duplicates.hideCompare") : t("tools.duplicates.showCompare")}
                          aria-expanded={open}
                        >
                          ▶
                        </button>
                      )}
                      <span className={`tools-cat cat-${p.category}`}>{Math.round(p.score)}</span>
                      <PersonLink dataset={dataset} id={p.aId} fallback={p.aLabel} onNavigate={onNavigate} />
                      <span className="tools-pair-sep">↔</span>
                      <PersonLink dataset={dataset} id={p.bId} fallback={p.bLabel} onNavigate={onNavigate} />
                      {showRejected && (
                        <button
                          className="tools-issue-link tools-pair-unreject"
                          onClick={() => onUnrejectDuplicate(p.aId, p.bId)}
                        >
                          {t("tools.duplicates.unreject")}
                        </button>
                      )}
                    </div>
                    {open && (
                      <DuplicateCompare
                        dataset={dataset}
                        pair={p}
                        fieldsCache={fieldsCache.current}
                        onNavigate={onNavigate}
                        onMerge={handleMerge}
                        onReject={handleReject}
                        onOpenPair={openPair}
                      />
                    )}
                  </li>
                );
              })}
              <li className="v-spacer" style={{ height: virtual.padBottom }} ref={virtual.bottomRef} aria-hidden />
            </ul>
          )}
        </>
      )}
    </>
  );
}

const CHOICES: FieldChoice[] = ["main", "incoming", "both"];

/**
 * Editable side-by-side comparison of one duplicate pair. Both records live in
 * the same main dataset, so each column navigates into Edit mode. The left
 * (main) record is the survivor; per-field M/I/B controls choose what it keeps
 * — seeded by `duplicateDefaults` (more precise dates win, one-sided fields are
 * combined). The Merge button (behind a confirmation) folds the right record
 * into the left and deletes it.
 */
function DuplicateCompare({
  dataset,
  pair,
  fieldsCache,
  onNavigate,
  onMerge,
  onReject,
  onOpenPair,
}: {
  dataset: Dataset;
  pair: DuplicatePair;
  fieldsCache: Map<string, Record<string, FieldChoice>>;
  onNavigate: (id: string) => void;
  onMerge: (survivorId: string, removedId: string, decision: CandidateDecision) => void;
  onReject: (aId: string, bId: string) => void;
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
  // Choices live in the panel-level cache too, so they survive this component
  // unmounting when its row leaves the virtual window.
  const cacheKey = `${pair.aId}-${pair.bId}`;
  const [fields, setFieldsState] = useState<Record<string, FieldChoice>>(
    () => fieldsCache.get(cacheKey) ?? duplicateDefaults(rows),
  );
  const setFields = (next: Record<string, FieldChoice>) => {
    fieldsCache.set(cacheKey, next);
    setFieldsState(next);
  };
  const [confirming, setConfirming] = useState(false);
  // Re-seed defaults if the underlying rows change (e.g. dataset edited
  // elsewhere) — but not on mount, or remounting would drop cached choices.
  const seededRows = useRef(rows);
  useEffect(() => {
    if (seededRows.current === rows) return;
    seededRows.current = rows;
    const seeded = duplicateDefaults(rows);
    fieldsCache.set(cacheKey, seeded);
    setFieldsState(seeded);
  }, [rows, cacheKey, fieldsCache]);

  // C/R mirror the Merge view's confirm/reject shortcuts: C opens the merge
  // confirmation (same as clicking Merge), R rejects immediately (same as
  // clicking Reject — reversible from the Rejected list, so no confirm needed).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isModalOpen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === KEY.confirm) { e.preventDefault(); setConfirming(true); return; }
      if (key === KEY.reject) { e.preventDefault(); onReject(pair.aId, pair.bId); return; }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pair, onReject]);

  const nav: PersonNav = {
    linkable: (id) => dataset.individuals.has(id),
    onNavigate,
  };
  const setChoice = (key: string, c: FieldChoice) => setFields({ ...fields, [key]: c });

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
    return <span className="gm-main-tag">{t("compare.keepMain")}</span>;
  }

  return (
    <div className="tools-pair-compare">
      <table className="compare">
        <thead>
          <tr className="compare-head">
            <th />
            <th className="compare-col compare-col-main">{t("tools.duplicates.surviving")}</th>
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
            const hasSources = !!(row.mainSources || row.incomingSources || row.mainLinkIcons || row.incomingLinkIcons);
            return (
              <tr key={row.key} className={`field ${row.state}`}>
                <td className="f-label">{row.displayLabel ?? row.label}</td>
                {row.relatives ? (
                  <td className="f-rel" colSpan={3}>
                    <RelativeGrid
                      pairs={row.relatives}
                      mainChosen={choice !== "incoming"}
                      incomingChosen={choice !== "main"}
                      mainPerson={nav}
                      incomingPerson={nav}
                      renderChoice={() => renderChoiceCell(row, choice)}
                    />
                  </td>
                ) : hasSources ? (
                  <>
                    <td className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} mainSources={row.mainSources} />
                      {row.mainLinkIcons?.length ? <LinkIcons urls={row.mainLinkIcons} otherUrls={row.incomingLinkIcons} /> : null}
                    </td>
                    <td className={choice !== "main" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} mainSources={row.incomingSources} compareAgainst={row.mainSources} />
                      {row.incomingLinkIcons?.length ? <LinkIcons urls={row.incomingLinkIcons} otherUrls={row.mainLinkIcons} /> : null}
                    </td>
                  </>
                ) : (
                  <>
                    <td className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"} title={row.mainTitle}>
                      <FieldValue
                        text={row.main}
                        links={row.mainLinks}
                        linkIcons={row.mainLinkIcons}
                        otherLinkIcons={row.incomingLinkIcons}
                        person={row.mainRefs ? { refs: row.mainRefs, ...nav } : undefined}
                      />
                    </td>
                    <td className={choice !== "main" ? "f-val gm-data chosen" : "f-val gm-data"} title={row.incomingTitle}>
                      <FieldValue
                        text={row.incoming}
                        links={row.incomingLinks}
                        otherLinks={row.mainLinks}
                        linkIcons={row.incomingLinkIcons}
                        otherLinkIcons={row.mainLinkIcons}
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
        <button
          className="nav-btn primary tools-run"
          title={t("compare.decisionTooltip", { action: t("tools.duplicates.merge"), key: KEY.confirm.toUpperCase() })}
          onClick={() => setConfirming(true)}
        >
          {t("tools.duplicates.merge")}
        </button>
        <button
          className="nav-btn"
          title={t("compare.decisionTooltip", { action: t("tools.duplicates.reject"), key: KEY.reject.toUpperCase() })}
          onClick={() => onReject(pair.aId, pair.bId)}
        >
          {t("tools.duplicates.reject")}
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { xrefLabel } from "../../gedcom/nameDisplay";
import { individualFieldRows } from "../../review/fields";
import {
  PARENTS_KEY,
  duplicateDefaults,
  hasParentsOnMain,
  isParentRow,
  relatedMergeOrder,
  relatedSeparateRecords,
} from "../../tools/mergeDuplicate";
import { defaultChoice, type CandidateDecision, type FieldChoice, type FieldRow } from "../../review/types";
import { rowCanKeepBoth } from "../../merge/applyFields";
import { type PersonNav } from "../ReadOnlyCompare";
import { KEY, isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { useStickyHeaderInset } from "../usePhone";
import { FieldValue, LinkIcons, RelativeGrid } from "../FieldValue";
import { SourceRefs } from "../SourceRef";
import { SelectMenu } from "../DropdownMenu";
import { ConfirmDialog } from "../ConfirmDialog";
import { PersonLink } from "../PersonLink";
import { type ToolsScans } from "../useToolsScans";
import { useVirtualList } from "../useVirtualList";
import { ToolsError, ToolsLoading, TreeSearch, someMatch, useDebounced } from "./shared";
import { ToolSummary } from "./ToolSummary";

/** Default score floor for the duplicates list. Index-scale files produce
 *  thousands of weak pairs; starting high keeps the list actionable, and the
 *  score picker reveals the rest on demand. */
const DEFAULT_MIN_SCORE = 85;
const SCORE_STEPS = [50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100];
const CAT_COLOR: Record<MatchCategory, string> = {
  strong: "var(--state-match)",
  probable: "var(--state-minor)",
  weak: "var(--muted)",
};

/** A relative the user ticked to merge along with the pair being merged. The
 *  survivor is the side the open comparison keeps (its left/main column), and
 *  `when` says which side of the pair's own merge this one belongs on — see
 *  `relatedMergeOrder`. */
export interface RelatedMerge {
  survivorId: string;
  removedId: string;
  when: "before" | "after";
}

/** Score floor for the child pairs offered alongside a merge. Unlike parents and
 *  partners (structural: one father, one spouse per family), children are paired
 *  by name similarity across two sibling sets, so a weak pair is more likely to
 *  be two different people who share a name than one person twice. */
const RELATED_CHILD_MIN_SCORE = DEFAULT_CONFIG.probableThreshold * 100;

/** A flattened list row: either a cluster header or a duplicate pair. */
type Row =
  | { kind: "cluster"; cluster: DuplicateCluster; key: string }
  | { kind: "pair"; pair: DuplicatePair; key: string; clustered: boolean };

export function DuplicatesPanel({
  dataset,
  scans,
  onNavigate,
  active,
  onMergeDuplicate,
  rejectedDuplicates,
  onRejectDuplicate,
  onRejectDuplicatesBulk,
  onUnrejectDuplicate,
}: {
  dataset: Dataset;
  scans: ToolsScans;
  onNavigate: (id: string) => void;
  active: boolean;
  onMergeDuplicate: (
    survivorId: string,
    removedId: string,
    decision: CandidateDecision,
    alsoMerge: RelatedMerge[],
  ) => boolean;
  rejectedDuplicates: Set<string>;
  onRejectDuplicate: (aId: string, bId: string) => void;
  onRejectDuplicatesBulk: (pairs: Array<{ aId: string; bId: string }>) => void;
  onUnrejectDuplicate: (aId: string, bId: string) => void;
}) {
  const { t } = useTranslation();
  // The scan result lives in the ToolsView-level cache, so it survives
  // switching sub-tabs or modes while the (minutes-long) scan keeps running.
  const state = scans.duplicates;
  // Pair whose side-by-side comparison is expanded inline, keyed "aId-bId".
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Only pairs scoring at least this show; index-scale files start high.
  const [minScore, setMinScore] = useState(DEFAULT_MIN_SCORE);
  // Multi-pair clusters whose member pairs are currently unfolded. Empty by
  // default → blobs start collapsed to one header row each.
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  // Toggles the list between active candidates and previously-rejected pairs.
  const [showRejected, setShowRejected] = useState(false);
  // Keyboard-highlighted row (index into the flattened display list).
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  selectedRef.current = selected;
  const listRef = useRef<HTMLUListElement>(null);
  // Mirror `expanded` so the keydown handler (which doesn't re-subscribe on
  // every open/close) can read the live value.
  const expandedRef = useRef<string | null>(null);
  expandedRef.current = expanded;
  // Row key of a pair opened from a related-records hint, until the rows
  // recompute and it can be scrolled into view (see the effect below).
  const pendingOpenKey = useRef<string | null>(null);
  // Field choices of expanded comparisons, keyed "aId-bId". Kept up here so
  // they survive the row scrolling out of the virtual window, which unmounts
  // its DuplicateCompare.
  const fieldsCache = useRef(new Map<string, Record<string, FieldChoice>>());

  const pk = (p: DuplicatePair) => duplicatePairKey(p.aId, p.bId);

  useEffect(() => {
    setExpanded(null);
    setQuery("");
    setMinScore(DEFAULT_MIN_SCORE);
    setExpandedClusters(new Set());
    setSelected(0);
    setShowRejected(false);
    pendingOpenKey.current = null;
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
  // Active/rejected split + text search, before the score filter (so we can
  // count what the score filter hides).
  const searched = useMemo(() => {
    if (!pairs) return [];
    const base = pairs.filter((p) => rejectedDuplicates.has(duplicatePairKey(p.aId, p.bId)) === showRejected);
    return q ? base.filter((p) => someMatch(q, p.aLabel, p.bLabel)) : base;
  }, [pairs, q, rejectedDuplicates, showRejected]);
  const shown = useMemo(() => searched.filter((p) => p.score >= minScore), [searched, minScore]);
  const hiddenByScore = searched.length - shown.length;

  // Group the visible pairs into connected clusters (skipped for the flat
  // rejected list). A multi-pair cluster is a same-name blob the user can fold
  // away or dismiss wholesale; a lone pair stays a plain row.
  const clusters = useMemo(
    () => (showRejected ? [] : clusterDuplicates(shown)),
    [shown, showRejected],
  );

  // Flatten clusters → display rows. A collapsed multi-pair cluster still shows
  // the one pair whose comparison is open, so the open compare is never hidden.
  const rows = useMemo<Row[]>(() => {
    if (showRejected) return shown.map((p) => ({ kind: "pair", pair: p, key: `${p.aId}-${p.bId}`, clustered: false }));
    const out: Row[] = [];
    for (const c of clusters) {
      if (c.pairs.length === 1) {
        const p = c.pairs[0];
        out.push({ kind: "pair", pair: p, key: `${p.aId}-${p.bId}`, clustered: false });
        continue;
      }
      out.push({ kind: "cluster", cluster: c, key: `cluster-${c.id}` });
      const unfolded = expandedClusters.has(c.id);
      for (const p of c.pairs) {
        if (unfolded || `${p.aId}-${p.bId}` === expanded) {
          out.push({ kind: "pair", pair: p, key: `${p.aId}-${p.bId}`, clustered: true });
        }
      }
    }
    return out;
  }, [showRejected, shown, clusters, expandedClusters, expanded]);
  const rowsRef = useRef<Row[]>(rows);
  rowsRef.current = rows;

  // The pairs in display order, for the auto-advance after merge/reject.
  const orderedPairs = useMemo(
    () => rows.filter((r): r is Extract<Row, { kind: "pair" }> => r.kind === "pair").map((r) => r.pair),
    [rows],
  );
  const orderedPairsRef = useRef(orderedPairs);
  orderedPairsRef.current = orderedPairs;

  // After a pair leaves the active list (merged away or rejected), open and
  // highlight whatever takes its place, so the panel keeps flowing rather than
  // going blank. Content-keyed (by pair), so it survives the rows recomputing.
  const advancePast = (isRemoved: (p: DuplicatePair) => boolean) => {
    const list = orderedPairsRef.current;
    const removedAt = list.findIndex(isRemoved);
    const remaining = list.filter((p) => !isRemoved(p));
    if (remaining.length === 0) {
      setExpanded(null);
      return;
    }
    const next = remaining[Math.min(removedAt < 0 ? 0 : removedAt, remaining.length - 1)];
    setExpanded(`${next.aId}-${next.bId}`);
    const rowIdx = rowsRef.current.findIndex((r) => r.kind === "pair" && r.key === `${next.aId}-${next.bId}`);
    if (rowIdx >= 0) setSelected(rowIdx);
  };

  // Apply a merge, drop the merged pair and any other pair referencing the
  // now-removed record, then advance to the next pair. `alsoMerge` carries the
  // relatives the user ticked: they merge either side of this pair (see
  // `mergeDuplicateChain`), so their records leave the list too.
  function handleMerge(
    survivorId: string,
    removedId: string,
    decision: CandidateDecision,
    alsoMerge: RelatedMerge[] = [],
  ) {
    if (!onMergeDuplicate(survivorId, removedId, decision, alsoMerge)) return;
    const gone = new Set([removedId, ...alsoMerge.map((r) => r.removedId)]);
    scans.updateDuplicates((pairs) => pairs.filter((p) => !gone.has(p.aId) && !gone.has(p.bId)));
    advancePast((p) => gone.has(p.aId) || gone.has(p.bId));
  }

  // Dismiss a pair as not-a-duplicate: persisted via the parent so it won't
  // resurface on a re-scan. The pair stays in `state.result` (nothing about the
  // dataset changed) — it just moves into the rejected list — and we advance to
  // the next active pair.
  function handleReject(aId: string, bId: string) {
    const key = duplicatePairKey(aId, bId);
    onRejectDuplicate(aId, bId);
    advancePast((p) => pk(p) === key);
  }

  // Dismiss every pair in a cluster at once (one undoable step). Close the open
  // compare if it belonged to this blob.
  function dismissCluster(cluster: DuplicateCluster) {
    const openKeys = new Set(cluster.pairs.map((p) => `${p.aId}-${p.bId}`));
    onRejectDuplicatesBulk(cluster.pairs.map((p) => ({ aId: p.aId, bId: p.bId })));
    setExpanded((cur) => (cur && openKeys.has(cur) ? null : cur));
  }

  // Unfolding anything — a cluster's pair rows, or a pair's side-by-side
  // comparison — pushes the newly-revealed content below the row that opened it.
  // Scroll that row to the top of the viewport so what just opened is in view.
  // The scroll runs from an effect, once the rows (and the virtual model's
  // measurements) have updated — see below.
  const pinTargetRow = useRef(0);
  const [pinTick, setPinTick] = useState(0);
  const pinRowToTop = useCallback((rowIndex: number) => {
    pinTargetRow.current = rowIndex;
    setPinTick((t) => t + 1);
  }, []);

  // Stable identity so the keydown handler (subscribed once per `active`) can
  // call it without re-subscribing; the live set is read through a mirror ref.
  const expandedClustersRef = useRef(expandedClusters);
  expandedClustersRef.current = expandedClusters;
  const toggleCluster = useCallback((id: string, rowIndex?: number) => {
    const willExpand = !expandedClustersRef.current.has(id);
    setExpandedClusters((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (willExpand && rowIndex !== undefined) pinRowToTop(rowIndex);
  }, [pinRowToTop]);

  // Same for a single pair's comparison: opening it pins its row to the top.
  const togglePair = useCallback((key: string, rowIndex?: number) => {
    // A manual open takes the selection back from any pending open-pair jump.
    pendingOpenKey.current = null;
    const willOpen = expandedRef.current !== key;
    setExpanded(willOpen ? key : null);
    if (willOpen && rowIndex !== undefined) pinRowToTop(rowIndex);
  }, [pinRowToTop]);

  // Open a related pair surfaced from inside an open comparison (a spouse/parent
  // that is a separate record on each side). Reuse the pair if it's already in
  // the list, otherwise synthesize and prepend it, then lift whatever filter
  // hides it and expand it so the user can complete that merge too.
  function openPair(aId: string, bId: string) {
    if (state.status !== "done") return;
    const key = duplicatePairKey(aId, bId);
    const existing = state.result.find((p) => duplicatePairKey(p.aId, p.bId) === key);
    const pair = existing ?? makeDuplicatePair(dataset, aId, bId);
    if (!pair) return;
    if (!existing) scans.updateDuplicates((pairs) => [pair, ...pairs]);
    // Only lift the filters that would actually hide this pair: each one that
    // changes resets the row selection, which would fight the scroll below.
    if (rejectedDuplicates.has(key)) onUnrejectDuplicate(pair.aId, pair.bId);
    if (showRejected) setShowRejected(false);
    if (q && !someMatch(q, pair.aLabel, pair.bLabel)) setQuery("");
    if (pair.score < minScore) setMinScore(Math.floor(pair.score));
    const rowKey = `${pair.aId}-${pair.bId}`;
    setExpanded(rowKey);
    // The pair can sit anywhere in the (virtualized) list, and inside a
    // collapsed cluster — without scrolling to it the click looks like it did
    // nothing. The effect below jumps there once the rows have recomputed.
    pendingOpenKey.current = rowKey;
  }

  // An index-scale file produces six-figure pair counts — only the rows near
  // the viewport are mounted, so the whole score-sorted list stays browsable.
  // The scroll container is the ancestor `.tools-view`.
  // The phone layout scrolls the document under a sticky app header, so a row
  // pinned to `scrollTop` lands behind it — an unfolded pair's own header row
  // was hidden and the comparison started mid-screen.
  const headerInset = useStickyHeaderInset();
  const virtual = useVirtualList({ count: rows.length, estimate: 34, itemsKey: rows, scrollMargin: headerInset });

  // A new filter/search starts the highlight at the top; a shrinking list
  // clamps it to the last remaining row. A pending open-pair jump owns the
  // selection instead — its own filter changes must not send the list home.
  useEffect(() => {
    if (pendingOpenKey.current) return;
    setSelected(0);
  }, [q, minScore, showRejected]);
  useEffect(() => {
    setSelected((i) => (rows.length === 0 ? 0 : Math.min(i, rows.length - 1)));
  }, [rows.length]);

  // Bring the keyboard-highlighted row into view as it moves.
  const { scrollToIndex } = virtual;
  useEffect(() => {
    scrollToIndex(selected);
  }, [selected, scrollToIndex]);

  // After a cluster or a pair comparison is unfolded, pin its row to the top.
  useEffect(() => {
    if (pinTick === 0) return;
    scrollToIndex(pinTargetRow.current, "start");
  }, [pinTick, scrollToIndex]);

  // A pair opened from a related-records hint: as soon as the rows include it
  // (the search box clears on a debounce, so that can take a beat), highlight
  // it and pin it to the top of the viewport.
  useEffect(() => {
    const key = pendingOpenKey.current;
    if (!key) return;
    const idx = rows.findIndex((r) => r.kind === "pair" && r.key === key);
    if (idx < 0) return;
    pendingOpenKey.current = null;
    setSelected(idx);
    pinRowToTop(idx);
  }, [rows, pinRowToTop]);

  // Left/Right step the highlight between rows; Enter toggles the selected row
  // (unfold a cluster, or open/close a pair's comparison); Up/Down scroll the
  // surrounding list. Mirrors the Merge view's compare-panel shortcuts.
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isModalOpen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const list = rowsRef.current;
      if (list.length === 0) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const next = e.key === "ArrowLeft"
          ? Math.max(0, selectedRef.current - 1)
          : Math.min(list.length - 1, selectedRef.current + 1);
        setSelected(next);
        // If a comparison is already open, stick it to the pair we land on.
        const row = list[next];
        if (expandedRef.current !== null && row?.kind === "pair") setExpanded(row.key);
        return;
      }
      if (e.key === "Enter") {
        const row = list[selectedRef.current];
        if (!row) return;
        e.preventDefault();
        if (row.kind === "cluster") toggleCluster(row.cluster.id, selectedRef.current);
        else togglePair(row.key, selectedRef.current);
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
  }, [active, toggleCluster, togglePair]);

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
            {!showRejected && (
              <label className="tools-dup-score" title={t("tools.duplicates.scoreFilter")}>
                <SelectMenu
                  className="score-select"
                  value={String(minScore)}
                  style={{ color: CAT_COLOR[categorize(minScore / 100, DEFAULT_CONFIG)] }}
                  onChange={(v) => setMinScore(Number(v))}
                  options={SCORE_STEPS.map((v) => ({
                    value: String(v),
                    label: v === 100 ? "100" : `≥ ${v}`,
                  }))}
                />
              </label>
            )}
            {rejectedCount > 0 && (
              <button className="tools-chip tools-dup-toggle" onClick={() => setShowRejected((v) => !v)}>
                {showRejected ? t("tools.duplicates.showActive") : (
                  <>{t("tools.duplicates.showRejected")} <span className="tools-chip-count">{rejectedCount}</span></>
                )}
              </button>
            )}
            <ToolSummary>
              {showRejected
                ? t("tools.duplicates.rejectedCount", { count: rejectedCount })
                : t("tools.duplicates.found", { count: state.result.length - rejectedCount })}
              {!showRejected && hiddenByScore > 0 && (
                <>
                  {" · "}
                  <button
                    className="tools-issue-link"
                    title={t("tools.duplicates.hiddenByScoreTip")}
                    onClick={() => setMinScore(50)}
                  >
                    {t("tools.duplicates.hiddenByScore", { count: hiddenByScore })}
                  </button>
                </>
              )}
            </ToolSummary>
          </div>
          {rows.length === 0 ? (
            <p className="tools-clean">
              {q || hiddenByScore > 0
                ? t("tools.search.noMatch")
                : showRejected
                  ? t("tools.duplicates.noneRejected")
                  : t("tools.duplicates.allRejected")}
            </p>
          ) : (
            <ul className="tools-pairs" ref={listRef}>
              <li className="v-spacer" style={{ height: virtual.padTop }} ref={virtual.topRef} aria-hidden />
              {rows.slice(virtual.start, virtual.end).map((row, j) => {
                const i = virtual.start + j;
                if (row.kind === "cluster") {
                  const c = row.cluster;
                  const unfolded = expandedClusters.has(c.id);
                  return (
                    <li key={row.key} className={`tools-dup-cluster-head ${i === selected ? "selected" : ""}`}>
                      <div className="tools-pair-row" onMouseDown={() => setSelected(i)}>
                        <button
                          className={`tools-pair-toggle ${unfolded ? "open" : ""}`}
                          onClick={() => toggleCluster(c.id, i)}
                          title={unfolded ? t("tools.duplicates.cluster.collapse") : t("tools.duplicates.cluster.expand")}
                          aria-expanded={unfolded}
                        >
                          ▶
                        </button>
                        <span className={`tools-cat cat-${categorize(Math.round(c.maxScore) / 100, DEFAULT_CONFIG)}`}>
                          {Math.round(c.maxScore)}
                        </span>
                        {/* The cluster's representative record, rendered like
                            every other person reference (name-order preference,
                            record id, lifespan). */}
                        <span className="tools-dup-cluster-label">
                          <PersonLink
                            dataset={dataset}
                            id={c.pairs[0].aId}
                            fallback={c.pairs[0].aLabel}
                            onNavigate={onNavigate}
                            forceXref
                          />
                        </span>
                        <span
                          className="tools-dup-cluster-meta"
                          title={t("tools.duplicates.cluster.recordIds", {
                            ids: c.memberIds.map(xrefLabel).join(", "),
                          })}
                        >
                          {t("tools.duplicates.cluster.records", { count: c.memberIds.length })}
                          {" · "}
                          {t("tools.duplicates.cluster.pairs", { count: c.pairs.length })}
                        </span>
                        <button
                          className="tools-issue-link tools-dup-cluster-dismiss"
                          title={t("tools.duplicates.cluster.rejectAllTitle")}
                          onClick={() => dismissCluster(c)}
                        >
                          {t("tools.duplicates.cluster.rejectAll")}
                        </button>
                      </div>
                    </li>
                  );
                }
                const p = row.pair;
                const key = row.key;
                const open = !showRejected && expanded === key;
                return (
                  <li
                    key={key}
                    className={`tools-pair ${row.clustered ? "tools-pair-clustered" : ""} ${i === selected ? "selected" : ""}${i % 2 ? " zebra" : ""}`}
                  >
                    <div className="tools-pair-row" onMouseDown={() => setSelected(i)}>
                      {showRejected ? (
                        <span className="tools-pair-toggle-spacer" aria-hidden="true" />
                      ) : (
                        <button
                          className={`tools-pair-toggle ${open ? "open" : ""}`}
                          onClick={() => togglePair(key, i)}
                          title={open ? t("tools.duplicates.hideCompare") : t("tools.duplicates.showCompare")}
                          aria-expanded={open}
                        >
                          ▶
                        </button>
                      )}
                      <span className={`tools-cat cat-${categorize(Math.round(p.score) / 100, DEFAULT_CONFIG)}`}>{Math.round(p.score)}</span>
                      {/* Record ids always show here: telling two look-alike
                          records apart is this tool's whole job. */}
                      <PersonLink dataset={dataset} id={p.aId} fallback={p.aLabel} onNavigate={onNavigate} forceXref />
                      {/* Phone layout breaks the row here, so each person gets
                          a full line and the ↔ leads the second one (see
                          `.tools-pair-break`). Inert on wider screens. */}
                      <span className="tools-pair-break" aria-hidden="true" />
                      <span className="tools-pair-sep">↔</span>
                      <PersonLink dataset={dataset} id={p.bId} fallback={p.bLabel} onNavigate={onNavigate} forceXref />
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
                        active={active}
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
  active,
  pair,
  fieldsCache,
  onNavigate,
  onMerge,
  onReject,
  onOpenPair,
}: {
  dataset: Dataset;
  /** Whether the Tools view is the one on screen — this panel stays mounted
   *  behind Edit/Merge (CSS display), so window-level shortcuts must not fire
   *  from a hidden comparison. */
  active: boolean;
  pair: DuplicatePair;
  fieldsCache: Map<string, Record<string, FieldChoice>>;
  onNavigate: (id: string) => void;
  onMerge: (survivorId: string, removedId: string, decision: CandidateDecision, alsoMerge: RelatedMerge[]) => void;
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
  // Relatives that are a separate record on each side. Spouses and parents come
  // first: until they're merged too, this merge can't fold their shared
  // families. Children come after: the merge folds them into one family happily
  // enough, and leaves them there as two siblings unless they're merged too.
  // All scored like any other pair, so the user can see how alike they are
  // before ticking them.
  const related = useMemo(
    () =>
      relatedSeparateRecords(rows)
        .map((r) => ({
          ...r,
          when: relatedMergeOrder(r.relation),
          score: makeDuplicatePair(dataset, r.aId, r.bId)?.score,
        }))
        // Weak child pairs are more often two same-named siblings than one
        // person twice, so they aren't offered at all.
        .filter((r) => r.relation !== "child" || (r.score ?? 0) >= RELATED_CHILD_MIN_SCORE),
    [rows, dataset],
  );
  const relatedBefore = related.filter((r) => r.when === "before");
  const relatedAfter = related.filter((r) => r.when === "after");
  // The relatives ticked to merge with this pair, keyed `aId|bId`. Off by
  // default — merging someone is the user's call, never a side effect of
  // another merge.
  const [alsoMerge, setAlsoMerge] = useState<Set<string>>(new Set());
  const relatedKey = (r: { aId: string; bId: string }) => `${r.aId}|${r.bId}`;
  const relatedMerges: RelatedMerge[] = related
    .filter((r) => alsoMerge.has(relatedKey(r)))
    .map((r) => ({ survivorId: r.aId, removedId: r.bId, when: r.when }));
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
  // A confirm dialog left open when the user switches views would stay mounted
  // (the Tools view hides with CSS display) and its overlay makes isModalOpen()
  // dead-key the visible view — so leaving the view withdraws the question.
  useEffect(() => {
    if (!active) setConfirming(false);
  }, [active]);
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
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isModalOpen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (key === KEY.confirm) { e.preventDefault(); setConfirming(true); return; }
      if (key === KEY.reject) { e.preventDefault(); onReject(pair.aId, pair.bId); return; }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, pair, onReject]);

  const nav: PersonNav = {
    linkable: (id) => dataset.individuals.has(id),
    onNavigate,
  };
  const setChoice = (key: string, c: FieldChoice) => setFields({ ...fields, [key]: c });

  // The parents block is one either/or choice: father and mother are two slots
  // of the same family, and a person has one set of parents. So the buttons sit
  // once on the "Parents" header and the two rows below only show what each
  // choice keeps — see `parentsChoice` in mergeDuplicate.
  const hasParentRows = rows.some((r) => isParentRow(r.key));
  const parentsChoice = fields[PARENTS_KEY] ?? (hasParentsOnMain(rows) ? "main" : "incoming");

  function renderParentsChoice() {
    return CHOICES.map((c) => (
      <button
        key={c}
        className={`choice ${c}${parentsChoice === c ? " active" : ""}`}
        title={t(`tools.duplicates.parents.${c}`)}
        onClick={() => setChoice(PARENTS_KEY, c)}
      >
        {t(`choice.${c}.label`)}
      </button>
    ));
  }

  function renderChoiceCell(row: FieldRow, choice: FieldChoice) {
    if (isParentRow(row.key)) return null; // driven by the shared Parents control
    if (row.state === "conflict" || row.state === "incoming-only") {
      // Same rule as the Merge compare panel: a single-cardinality field can't
      // keep two values, so "Both" isn't offered where it would just replace.
      const offered = rowCanKeepBoth(row.key) ? CHOICES : CHOICES.filter((c) => c !== "both");
      return offered.map((c) => (
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

  /** The confirmation's sentence about the ticked relatives on one side of the
   *  pair's own merge — empty when none of them are ticked. */
  function confirmAlsoClause(when: "before" | "after", key: string): string {
    const picked = related.filter((r) => r.when === when && alsoMerge.has(relatedKey(r)));
    if (picked.length === 0) return "";
    return ` ${t(key, { count: picked.length, names: picked.map((r) => r.label).join(", ") })}`;
  }

  /** One block of related records to merge along with this pair (those that go
   *  before it, those that go after), each with its own tick box and score. */
  function renderRelated(list: typeof related, hint: string) {
    if (list.length === 0) return null;
    return (
      <div className="tools-related-hint">
        <span>{hint}</span>
        <ul className="tools-related-list">
          {list.map((r) => {
            const key = relatedKey(r);
            const tip = t(
              r.when === "after" ? "tools.duplicates.relatedMergeAfter" : "tools.duplicates.relatedMergeToo",
              { name: r.label },
            );
            return (
              <li key={key} className="tools-related-pick">
                {/* Tick = merge this pair too; the name still opens their own
                    comparison, for a look before committing. */}
                <input
                  type="checkbox"
                  checked={alsoMerge.has(key)}
                  title={tip}
                  aria-label={tip}
                  onChange={(e) => {
                    const next = new Set(alsoMerge);
                    if (e.target.checked) next.add(key);
                    else next.delete(key);
                    setAlsoMerge(next);
                  }}
                />
                {r.score !== undefined && (
                  <span className={`tools-cat cat-${categorize(Math.round(r.score) / 100, DEFAULT_CONFIG)}`}>
                    {Math.round(r.score)}
                  </span>
                )}
                <button
                  className="tools-issue-link"
                  title={t("tools.duplicates.relatedOpen")}
                  onClick={() => onOpenPair(r.aId, r.bId)}
                >
                  {r.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
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
              // The parents header carries the block's single choice.
              if (row.key === "parents.header" && hasParentRows) {
                return (
                  <tr key={row.key} className="group-header-row">
                    <td colSpan={3} className="group-header-cell">{row.label}</td>
                    <td className="f-choice">{renderParentsChoice()}</td>
                  </tr>
                );
              }
              return (
                <tr key={row.key} className={isEventHeader ? "group-header-row event-header-row" : "group-header-row"}>
                  <td colSpan={4} className={isEventHeader ? "group-header-cell event-header-cell" : "group-header-cell"}>
                    {row.label}
                  </td>
                </tr>
              );
            }
            const choice = isParentRow(row.key) ? parentsChoice : fields[row.key] ?? defaultChoice(row);
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
      {renderRelated(relatedBefore, t("tools.duplicates.relatedHint"))}
      {renderRelated(relatedAfter, t("tools.duplicates.relatedChildHint"))}
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
          // Both sides usually carry the same name, so the ids and the
          // left/right wording are what tells the two records apart.
          message={
            t("tools.duplicates.mergeConfirm", {
              survivor: `${pair.aLabel} ${xrefLabel(pair.aId)}`,
              removed: `${pair.bLabel} ${xrefLabel(pair.bId)}`,
            }) +
            confirmAlsoClause("before", "tools.duplicates.mergeConfirmAlso") +
            confirmAlsoClause("after", "tools.duplicates.mergeConfirmAlsoAfter")
          }
          confirmLabel={t("tools.duplicates.merge")}
          onConfirm={() => {
            setConfirming(false);
            onMerge(pair.aId, pair.bId, { status: "confirmed", fields }, relatedMerges);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

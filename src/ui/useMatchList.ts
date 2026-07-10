import { useMemo } from "react";
import { applySort, STATUS_RANK, visibleCandidates, type Candidate, type Filters, type SortState } from "./matchView";
import { decisionKey, type CandidateDecision } from "../review/types";
import type { MatchResult } from "../match/types";

/** Selection reference: the main/compare pair the merge view is focused on. */
export interface SelRef {
  mainId: string;
  compareId: string;
}

/**
 * The merge view's "match list" view-model: pure derivation from the raw match
 * result plus the active sort/filter/decisions/selection. No state, refs or DOM
 * — the stateful setters and navigation callbacks stay in the component.
 *
 * `allSorted` is the full ranked list (navigation ignores the filter); `visible`
 * is that list after the display filter. `current` is the selected candidate,
 * resolved by id so it survives filter and sort changes.
 */
export interface MatchListView {
  /** Full ranked list, unfiltered — the base for navigation and display. */
  allSorted: Candidate[];
  /** `allSorted` after the active display filter, in the same order. */
  visible: Candidate[];
  /** Main ids in `visible` order, deduped to the first candidate per main. */
  visibleMainOrder: string[];
  /** The selected candidate (id-based), falling back to the first in `allSorted`. */
  current: Candidate | undefined;
  /** Index of `current` in `visible`, or -1 when filtered out. */
  visibleIndex: number;
  /** Index of `current` in `allSorted` — navigation bounds. */
  allSortedIndex: number;
  /** Main id → first (highest-ranked) candidate, for jumping to a relative. */
  indexByMain: Map<string, Candidate>;
  /** Compare id → first candidate. */
  indexByCompare: Map<string, Candidate>;
}

export function useMatchList(params: {
  matches: MatchResult | null;
  sort: SortState[];
  filters: Filters;
  decisions: Map<string, CandidateDecision>;
  selectedId: SelRef | null;
}): MatchListView {
  const { matches, sort, filters, decisions, selectedId } = params;

  // Sorted (but not filtered) list — used for navigation across all matches
  // regardless of the active filter, and as the base for the filtered display.
  const allSorted = useMemo(() => {
    if (!matches) return [];
    const statusRank = (c: Candidate) =>
      STATUS_RANK[decisions.get(decisionKey("individual", c.mainId, c.compareId))?.status ?? "undecided"];
    return applySort(matches.individuals, sort, statusRank);
  }, [matches, sort, decisions]);

  // Filtered list for display — preserves the sort order of allSorted. Also
  // drops rejected matches (see `visibleCandidates`).
  const visible = useMemo(
    () => visibleCandidates(allSorted, filters, decisions),
    [allSorted, filters, decisions],
  );

  // Main ids in `visible`'s order, deduped to one entry per main (first
  // candidate wins, matching `indexByMain` below) — lets Edit's Left/Right
  // step through the same filtered match list Merge's Left/Right/Prev/Next
  // use, without needing the full candidate objects.
  const visibleMainOrder = useMemo(() => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const c of visible) {
      if (!seen.has(c.mainId)) { seen.add(c.mainId); order.push(c.mainId); }
    }
    return order;
  }, [visible]);

  // Pair-key → position maps rebuilt only when the sorted/filtered list changes,
  // not on every prev/next click — turns the three find/findIndex scans below
  // from O(n) per navigation into O(1).
  const allSortedMap = useMemo(() => {
    const m = new Map<string, number>();
    allSorted.forEach((c, i) => m.set(`${c.mainId}|${c.compareId}`, i));
    return m;
  }, [allSorted]);
  const visibleMap = useMemo(() => {
    const m = new Map<string, number>();
    visible.forEach((c, i) => m.set(`${c.mainId}|${c.compareId}`, i));
    return m;
  }, [visible]);

  // The currently selected candidate (ID-based, survives filter changes).
  // Falls back to the first in allSorted when no explicit selection exists.
  const current = useMemo(() => {
    if (allSorted.length === 0) return undefined;
    if (!selectedId) return allSorted[0];
    const i = allSortedMap.get(`${selectedId.mainId}|${selectedId.compareId}`);
    return i !== undefined ? allSorted[i] : allSorted[0];
  }, [allSorted, allSortedMap, selectedId]);

  // Index of current in the visible (filtered) list — -1 when filtered out.
  const visibleIndex = useMemo(() => {
    if (!current) return -1;
    return visibleMap.get(`${current.mainId}|${current.compareId}`) ?? -1;
  }, [visibleMap, current]);

  // Index of current in allSorted — used for prev/next navigation bounds.
  const allSortedIndex = useMemo(() => {
    if (!current) return 0;
    return allSortedMap.get(`${current.mainId}|${current.compareId}`) ?? 0;
  }, [allSortedMap, current]);

  // Person id -> candidate, so a relative's name can jump to their own match.
  // A person with several candidates resolves to the first (highest-ranked) one.
  // Built over allSorted so navigation works regardless of the active filter.
  const indexByMain = useMemo(() => {
    const m = new Map<string, Candidate>();
    allSorted.forEach((c) => { if (!m.has(c.mainId)) m.set(c.mainId, c); });
    return m;
  }, [allSorted]);
  const indexByCompare = useMemo(() => {
    const m = new Map<string, Candidate>();
    allSorted.forEach((c) => { if (!m.has(c.compareId)) m.set(c.compareId, c); });
    return m;
  }, [allSorted]);

  return {
    allSorted,
    visible,
    visibleMainOrder,
    current,
    visibleIndex,
    allSortedIndex,
    indexByMain,
    indexByCompare,
  };
}

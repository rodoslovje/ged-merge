import { useEffect, useRef, useState } from "react";
import type { Dataset, Individual } from "../gedcom/types";
import { startSearchIndex, type SearchRow } from "./globalSearch";

export interface SearchIndexState {
  /** The sorted index — empty until `ready`. */
  rows: SearchRow[];
  /** False while a build is running (or waiting to start after an edit). */
  ready: boolean;
  /** Share of the running build done, 0…1; 1 when ready. */
  progress: number;
}

const IDLE: SearchIndexState = { rows: [], ready: true, progress: 1 };

/** Quiet time after an edit before the index is rebuilt, so a run of edits
 *  costs one rebuild rather than one per commit. */
const EDIT_DEBOUNCE_MS = 2000;
/** Slice budget while the dialog is open and waiting: long enough to make
 *  headway, short enough that the dialog keeps painting between slices. */
const URGENT_BUDGET_MS = 14;
/** Slice budget and gap when no idle deadline is available (no
 *  `requestIdleCallback`): small slices, well apart, so the page stays fluid. */
const BACKGROUND_BUDGET_MS = 6;
const BACKGROUND_GAP_MS = 30;
/** How long an idle slice may be postponed by a busy page before it runs anyway. */
const IDLE_TIMEOUT_MS = 1000;

/**
 * The whole-file search index, built in the background so the search dialog
 * opens at once even on a file of half a million people.
 *
 * A new dataset (or a change of name-display settings) starts a build right
 * away; an edit waits {@link EDIT_DEBOUNCE_MS} first. The build runs in
 * time-bounded slices — in idle callbacks while the dialog is closed, back to
 * back (yielding only to paint) while it is open and waiting — and publishes
 * its progress only while the dialog is open, since nothing else shows it.
 * The finished rows stay until the next change, so reopening costs nothing.
 */
export function useSearchIndex(
  dataset: Dataset | undefined,
  nameOf: (indi: Individual) => string,
  /** Bumped by every edit commit; the index is rebuilt after a pause. */
  editVersion: number,
  /** True while the dialog is open — the build then runs at full speed. */
  urgent: boolean,
): SearchIndexState {
  const [state, setState] = useState<SearchIndexState>(IDLE);
  const urgentRef = useRef(urgent);
  urgentRef.current = urgent;
  // Re-schedules the running build under the current urgency; a no-op when
  // nothing is building.
  const rescheduleRef = useRef<() => void>(() => {});
  // Which dataset the last build was for: the same one again means an edit,
  // which gets the debounce; a new one is indexed immediately.
  const indexedRef = useRef<Dataset | undefined>(undefined);

  useEffect(() => {
    const afterEdit = indexedRef.current === dataset;
    indexedRef.current = dataset;
    if (!dataset) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    let idle: number | undefined;
    let shownPercent = -1;
    const build = startSearchIndex(dataset.individuals, nameOf, dataset.records);
    setState({ rows: [], ready: false, progress: 0 });

    const clearPending = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      if (idle !== undefined && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      timer = idle = undefined;
    };
    const schedule = () => {
      clearPending();
      if (urgentRef.current) {
        timer = window.setTimeout(() => run(URGENT_BUDGET_MS), 0);
      } else if (typeof requestIdleCallback === "function") {
        idle = requestIdleCallback((deadline) => run(Math.max(deadline.timeRemaining(), 2)), {
          timeout: IDLE_TIMEOUT_MS,
        });
      } else {
        timer = window.setTimeout(() => run(BACKGROUND_BUDGET_MS), BACKGROUND_GAP_MS);
      }
    };
    const run = (budgetMs: number) => {
      if (cancelled) return;
      if (build.step(budgetMs)) {
        setState({ rows: build.rows, ready: true, progress: 1 });
        return;
      }
      if (urgentRef.current) {
        const percent = Math.floor(build.progress * 100);
        if (percent !== shownPercent) {
          shownPercent = percent;
          setState({ rows: [], ready: false, progress: build.progress });
        }
      }
      schedule();
    };

    rescheduleRef.current = schedule;
    if (afterEdit && !urgentRef.current) timer = window.setTimeout(schedule, EDIT_DEBOUNCE_MS);
    else schedule();
    return () => {
      cancelled = true;
      clearPending();
      rescheduleRef.current = () => {};
    };
  }, [dataset, nameOf, editVersion]);

  // The dialog opened mid-build (or mid-debounce): switch to full speed now
  // rather than at the next idle slice.
  useEffect(() => {
    if (urgent) rescheduleRef.current();
  }, [urgent]);

  return state;
}

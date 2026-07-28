import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Individual } from "../gedcom/types";
import { buildFindEntries, findHits, findOffChart, type FindEntry, type FindSource } from "./chartFind";

/** How long a found node keeps its flash highlight. */
const FLASH_MS = 1600;

export interface ChartFind {
  query: string;
  setQuery: (q: string) => void;
  /** Positions on the chart matching the query — recomputed as the user types. */
  hits: FindEntry[];
  /** 1-based position within {@link hits} of the node currently shown; 0 before
   *  the first jump (so the box can show a bare count until then). */
  position: number;
  /** Jump to the next (+1) or previous (−1) position, wrapping around. */
  step: (dir: 1 | -1) => void;
  /** The node just jumped to, for a brief highlight; cleared after a moment. */
  hitKey: string | null;
  /** Why the last jump found nothing: nobody by that name at all, or somebody in
   *  the file who simply isn't drawn on this chart. Null while there's a hit. */
  miss: "none" | "offChart" | null;
  /** The off-chart person offered for re-rooting (set with `miss === "offChart"`). */
  offChart: Individual | undefined;
  /** Re-root the chart on the off-chart person, so they come into view. */
  goToOffChart: () => void;
  /** Empty the box (Esc / the clear button). */
  clear: () => void;
}

/**
 * Find-in-chart state: matches the query against the people drawn on the current
 * chart, cycles through the positions they occupy, and centres each one.
 *
 * The whole-file fallback only runs on an actual jump, never per keystroke — it
 * scans every individual, which is fine once per Enter and wasteful on a large
 * file otherwise.
 *
 * @param sources the chart's nodes in layout order (memoize in the caller).
 * @param individuals the main file, for the "not in this chart" fallback.
 * @param onReveal centre the canvas on a node key (`revealNode`).
 * @param onSetRoot re-root the chart on a person; omit to drop the offer.
 */
export function useChartFind(
  sources: FindSource[],
  individuals: Map<string, Individual>,
  onReveal: (key: string) => void,
  onSetRoot?: (id: string) => void,
): ChartFind {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(-1);
  const [hitKey, setHitKey] = useState<string | null>(null);
  const [miss, setMiss] = useState<"none" | "offChart" | null>(null);
  const [offChart, setOffChart] = useState<Individual | undefined>(undefined);

  const entries = useMemo(() => buildFindEntries(sources), [sources]);
  const hits = useMemo(() => findHits(entries, query), [entries, query]);

  // A new query — or a new chart under it (re-root, direction flip, chart type)
  // — invalidates where we were in the cycle and any stale "not found" verdict.
  useEffect(() => {
    setCursor(-1);
    setMiss(null);
    setOffChart(undefined);
  }, [entries, query]);

  // Drop the highlight once it has had its moment. Re-armed on every jump.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);
  const flash = useCallback((key: string) => {
    setHitKey(key);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setHitKey(null), FLASH_MS);
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (!hits.length) {
        // Nothing here — is there anybody by that name elsewhere in the file?
        const elsewhere = onSetRoot ? findOffChart(individuals, query, new Set(entries.map((e) => e.id))) : undefined;
        setOffChart(elsewhere);
        setMiss(query.trim() ? (elsewhere ? "offChart" : "none") : null);
        return;
      }
      setMiss(null);
      const next = (cursor + dir + hits.length) % hits.length;
      setCursor(next);
      onReveal(hits[next].key);
      flash(hits[next].key);
    },
    [hits, cursor, entries, individuals, query, onReveal, onSetRoot, flash],
  );

  const goToOffChart = useCallback(() => {
    if (offChart && onSetRoot) onSetRoot(offChart.id);
    setMiss(null);
    setOffChart(undefined);
  }, [offChart, onSetRoot]);

  const clear = useCallback(() => {
    setQuery("");
    setMiss(null);
    setOffChart(undefined);
    setHitKey(null);
  }, []);

  return {
    query,
    setQuery,
    hits,
    position: cursor < 0 ? 0 : cursor + 1,
    step,
    hitKey,
    miss,
    offChart,
    goToOffChart,
    clear,
  };
}

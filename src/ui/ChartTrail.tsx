import { createContext, useContext } from "react";
import { useTranslation } from "react-i18next";
import { ArrowIcon } from "./icons/ArrowIcon";
import { DropdownMenu } from "./DropdownMenu";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";
import { CHART_KEY, keyHint } from "../keyboard/shortcuts";
import type { ChartsTrail } from "./useAppHistory";

// The people the Charts hub has been drawn for since it opened: ‹ › step
// between them, the ▾ list jumps to any of them. Re-roots used to be browser
// history entries, so getting back to Edit took one Back per person; now the
// hub is one entry and this trail is how the reader retraces the people.
// Provided by App around the hub only, so the Compare Tree (which shares
// ChartPage) draws nothing.

export interface ChartTrailValue {
  trail: ChartsTrail;
  onStep: (idx: number) => void;
  /** "Name 1817–1921" for a trail entry. */
  labelOf: (id: string) => string;
}

export const ChartTrailContext = createContext<ChartTrailValue | null>(null);

export function ChartTrailNav() {
  const ctx = useContext(ChartTrailContext);
  const { t } = useTranslation();
  const trail = ctx?.trail;
  const idx = trail?.idx ?? 0;
  const len = trail?.ids.length ?? 0;
  useChartShortcuts({
    onTrail: ctx && len > 1 ? (step) => ctx.onStep(idx + step) : undefined,
  });
  // A trail of one is just the chart: nothing to step to yet.
  if (!ctx || !trail || len < 2) return null;
  const prev = keyHint(t("charts.trail.prev"), CHART_KEY.trailBack);
  const next = keyHint(t("charts.trail.next"), CHART_KEY.trailForward);
  return (
    <div className="chart-trail" role="group" aria-label={t("charts.trail.list")}>
      <button className="tree-open-btn chart-trail-btn" onClick={() => ctx.onStep(idx - 1)} disabled={idx === 0} title={prev} aria-label={prev}>
        <ArrowIcon dir="left" size={14} />
      </button>
      <DropdownMenu
        className="tree-open-btn chart-trail-btn"
        title={t("charts.trail.list")}
        ariaLabel={t("charts.trail.list")}
        current={String(idx)}
        onSelect={(v) => ctx.onStep(Number(v))}
        // Newest first, the way a recent list reads.
        groups={[{ items: trail.ids.map((id, i) => ({ value: String(i), label: ctx.labelOf(id) })).reverse() }]}
        // A drawn chevron at the arrows' size and weight: the ▾ glyph came out
        // too small to read as a menu beside them.
        trigger={
          <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="5,9 12,16 19,9" />
          </svg>
        }
      />
      <button className="tree-open-btn chart-trail-btn" onClick={() => ctx.onStep(idx + 1)} disabled={idx === len - 1} title={next} aria-label={next}>
        <ArrowIcon dir="right" size={14} />
      </button>
    </div>
  );
}

import { useTranslation } from "react-i18next";
import type { LegendEntry } from "../chart/nodeColor";

// The colour key on a chart: one chip per category of the Color axis in
// force, with its head-count, laid over the canvas's top-left corner so
// the canvas keeps its size (a row above it moved the whole chart whenever an
// axis came or went). Where the host can hide a group (the Contemporaries
// chart), the chips are toggles; elsewhere they only name the colours.

interface Props {
  entries: LegendEntry[];
  /** Groups currently hidden (toggling hosts only). */
  hidden?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
}

export function ChartLegend({ entries, hidden, onToggle }: Props) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <div className="kin-legend chart-legend" role="group" aria-label={t("kin.legend")}>
      {entries.map((e) => {
        const off = hidden?.has(e.key) ?? false;
        const body = (
          <>
            <span className="map-kind-dot" style={{ background: e.color }} />
            {e.label} <span className="kin-legend-count">{e.count}</span>
          </>
        );
        return onToggle ? (
          <button
            key={e.key}
            type="button"
            className={`map-kind-chip${off ? "" : " active"}`}
            aria-pressed={!off}
            title={t("kin.legend.toggle")}
            onClick={() => onToggle(e.key)}
          >
            {body}
          </button>
        ) : (
          <span key={e.key} className="map-kind-chip active chart-legend-chip">
            {body}
          </span>
        );
      })}
    </div>
  );
}

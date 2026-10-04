import { useTranslation } from "react-i18next";
import type { LegendEntry } from "../chart/nodeColor";

// The colour key of a chart: one chip per category of the Color axis in
// force, with its head-count. A band along the bottom of the canvas wrap: the
// wrap keeps its size (a row above it moved the whole chart whenever an axis
// came or went), and the scrolling canvas ends above the band, so nothing of
// the chart is ever under it. Where the host can hide a group (the
// Contemporaries chart), the chips are toggles; elsewhere they only name the
// colours.

interface Props {
  entries: LegendEntry[];
  /** Groups currently hidden (toggling hosts only). */
  hidden?: ReadonlySet<string>;
  onToggle?: (key: string) => void;
  /** Percentage of the colour a host tints its marks with, where it tints them
   *  rather than filling them flat. A key that shows a colour the chart never
   *  paints is not a key: the dot takes the same mix the marks do. */
  tint?: number;
}

export function ChartLegend({ entries, hidden, onToggle, tint }: Props) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <div className="kin-legend chart-legend" role="group" aria-label={t("kin.legend")}>
      {entries.map((e) => {
        const off = hidden?.has(e.key) ?? false;
        const body = (
          <>
            <span
              className="map-kind-dot"
              style={{ background: tint === undefined ? e.color : `color-mix(in srgb, ${e.color} ${tint}%, var(--panel))` }}
            />
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
          <span key={e.key} className="map-kind-chip active">
            {body}
          </span>
        );
      })}
    </div>
  );
}

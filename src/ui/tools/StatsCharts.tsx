import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { tipProps } from "../IconTip";

// The few chart forms the statistics need, drawn as plain HTML bars in the
// theme's tokens: a column chart for ordered buckets (ages, months, centuries),
// a ranked bar list for categories (names, completeness), and a stat tile for
// single numbers. Every bar is a button — it lists the people behind it.

export interface Column {
  key: string;
  /** The axis label under the column. */
  label: string;
  value: number;
  /** Hover text: the label and the value in words. */
  tip: string;
  /** Rows behind the column; a column with none is not clickable. */
  count: number;
  /** The column stands for no data at all (as opposed to a value of zero); defaults to `count === 0`. */
  empty?: boolean;
}

/** Show values over the columns only where they still fit side by side. */
const VALUE_LABELS_UP_TO = 13;

export function ColumnChart({
  columns,
  onPick,
  picked,
  tone,
  format = (v) => String(v),
}: {
  columns: Column[];
  onPick: (key: string) => void;
  picked?: string;
  /** Colour the bars by sex rather than in the accent. */
  tone?: "male" | "female";
  format?: (value: number) => string;
}) {
  const max = Math.max(1, ...columns.map((c) => c.value));
  const labelled = columns.length <= VALUE_LABELS_UP_TO;
  return (
    <div className={`stats-columns${tone ? ` stats-${tone}` : ""}`}>
      {columns.map((c) => (
        <button
          key={c.key}
          type="button"
          className={`stats-col${picked === c.key ? " picked" : ""}`}
          disabled={c.count === 0}
          onClick={() => onPick(c.key)}
          {...tipProps(c.tip)}
        >
          <span className="stats-col-plot">
            {labelled && !(c.empty ?? c.count === 0) && <span className="stats-col-value">{format(c.value)}</span>}
            <span className="stats-col-bar" style={{ height: `${(100 * c.value) / max}%` }} />
          </span>
          <span className="stats-col-label">{c.label}</span>
        </button>
      ))}
    </div>
  );
}

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  /** The value as shown at the row's end. */
  display: string;
  tip?: string;
  count: number;
}

/** A ranked list of horizontal bars, the first `limit` shown until asked for all. */
export function BarList({
  rows,
  onPick,
  picked,
  limit,
  max: fixedMax,
}: {
  rows: BarRow[];
  onPick: (key: string) => void;
  picked?: string;
  limit?: number;
  /** The value a full bar stands for (100 for percentages); the largest row otherwise. */
  max?: number;
}) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const max = fixedMax ?? Math.max(1, ...rows.map((r) => r.value));
  const shown = limit && !all ? rows.slice(0, limit) : rows;
  if (!rows.length) return <p className="muted stats-empty">{t("stats.empty")}</p>;
  return (
    <div className="stats-bars">
      {shown.map((r) => (
        <button
          key={r.key}
          type="button"
          className={`stats-bar${picked === r.key ? " picked" : ""}`}
          disabled={r.count === 0}
          onClick={() => onPick(r.key)}
          {...(r.tip ? tipProps(r.tip) : {})}
        >
          <span className="stats-bar-label">{r.label}</span>
          <span className="stats-bar-track">
            <span className="stats-bar-fill" style={{ width: `${(100 * r.value) / max}%` }} />
          </span>
          <span className="stats-bar-value">{r.display}</span>
        </button>
      ))}
      {limit !== undefined && rows.length > limit && (
        <button type="button" className="tools-issue-link stats-more" onClick={() => setAll((a) => !a)}>
          {all ? t("stats.showFewer") : t("stats.showAll", { count: rows.length })}
        </button>
      )}
    </div>
  );
}

/** One headline number. Clickable when it stands for a list of people. */
export function StatTile({
  label,
  value,
  sub,
  onClick,
  picked,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  onClick?: () => void;
  picked?: boolean;
}) {
  const body = (
    <>
      <span className="stats-tile-value">{value}</span>
      <span className="stats-tile-label">{label}</span>
      {sub && <span className="stats-tile-sub">{sub}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={`stats-tile${picked ? " picked" : ""}`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="stats-tile">{body}</div>
  );
}

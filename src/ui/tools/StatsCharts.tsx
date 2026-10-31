import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { tipProps } from "../IconTip";

// The few chart forms the statistics need, drawn as plain HTML bars in the
// theme's tokens: a column chart for ordered buckets (ages, months, centuries),
// a ranked bar list for categories (names, completeness), and a stat tile for
// single numbers. Every bar is a button — it lists the people behind it.

/** What a chart, row or tile is about when it is about one sex only: it then
 *  wears that sex's colour (see `.stats-male` / `.stats-female`). */
export type Tone = "male" | "female";

export const toneClass = (tone: Tone | undefined) => (tone ? ` stats-${tone}` : "");

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
  labelEvery = 1,
}: {
  columns: Column[];
  onPick: (key: string) => void;
  picked?: string;
  tone?: Tone;
  format?: (value: number) => string;
  /** Write every n-th axis label only, where wide labels would run together;
   *  the hover tip still names every column. */
  labelEvery?: number;
}) {
  const max = Math.max(1, ...columns.map((c) => c.value));
  const labelled = columns.length <= VALUE_LABELS_UP_TO;
  return (
    // With every other label blank, a written one may spill over its blank neighbours.
    <div className={`stats-columns${toneClass(tone)}${labelEvery > 1 ? " spread" : ""}`}>
      {columns.map((c, i) => (
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
          <span className="stats-col-label">{i % labelEvery === 0 ? c.label : " "}</span>
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
  /** The row is about one sex only, in a list that mixes them. */
  tone?: Tone;
  /** How good a share is, where the row measures the data's own quality — the bar wears the status colour. */
  status?: "good" | "fair" | "poor";
}

/** A ranked list of horizontal bars, the first `limit` of them — the card that holds the list offers the rest. */
export function BarList({
  rows,
  onPick,
  picked,
  limit,
  max: fixedMax,
  tone,
}: {
  rows: BarRow[];
  onPick: (key: string) => void;
  picked?: string;
  limit?: number;
  /** The value a full bar stands for (100 for percentages); the largest row otherwise. */
  max?: number;
  tone?: Tone;
}) {
  const { t } = useTranslation();
  const max = fixedMax ?? Math.max(1, ...rows.map((r) => r.value));
  const shown = limit ? rows.slice(0, limit) : rows;
  if (!rows.length) return <p className="muted stats-empty">{t("stats.empty")}</p>;
  return (
    <div className={`stats-bars${toneClass(tone)}`}>
      {shown.map((r) => (
        <button
          key={r.key}
          type="button"
          className={`stats-bar${picked === r.key ? " picked" : ""}${toneClass(r.tone)}${r.status ? ` stats-status-${r.status}` : ""}`}
          disabled={r.count === 0}
          onClick={() => onPick(r.key)}
          // A label is cut to one line, so a row without a tip of its own shows it whole.
          {...((r.tip ?? (typeof r.label === "string" ? r.label : undefined)) ? tipProps(r.tip ?? (r.label as string)) : {})}
        >
          <span className="stats-bar-label">{r.label}</span>
          <span className="stats-bar-track">
            <span className="stats-bar-fill" style={{ width: `${(100 * r.value) / max}%` }} />
          </span>
          <span className="stats-bar-value">{r.display}</span>
        </button>
      ))}
    </div>
  );
}

/** One side's share in a {@link PairBarList} row. */
export interface PairValue {
  /** 0–100. */
  value: number;
  display: string;
  tip?: string;
  /** Rows behind the bar; a bar with none is not clickable. */
  count: number;
}

export interface PairRow {
  key: string;
  label: string;
  a?: PairValue;
  b?: PairValue;
}

/**
 * Two shares side by side per row — the father's side and the mother's — each
 * in its line's colour, under a legend naming the two. Either bar lists its
 * own people.
 */
export function PairBarList({
  rows,
  names,
  onPick,
  picked,
  limit,
}: {
  rows: PairRow[];
  /** What the two bars stand for, in the legend. */
  names: [string, string];
  onPick: (key: string, side: "a" | "b") => void;
  /** `key:a` or `key:b`. */
  picked?: string;
  /** Show the first rows only — the card that holds the list offers the rest. */
  limit?: number;
}) {
  const { t } = useTranslation();
  if (!rows.length) return <p className="muted stats-empty">{t("stats.empty")}</p>;
  const bar = (r: PairRow, side: "a" | "b") => {
    const v = r[side];
    if (!v) return <span className="stats-pair-cell" />;
    return (
      <button
        type="button"
        className={`stats-pair-cell stats-pair-${side}${picked === `${r.key}:${side}` ? " picked" : ""}`}
        disabled={v.count === 0}
        onClick={() => onPick(r.key, side)}
        {...tipProps(v.tip ?? `${names[side === "a" ? 0 : 1]}: ${v.display}`)}
      >
        <span className="stats-bar-track"><span className="stats-bar-fill" style={{ width: `${v.value}%` }} /></span>
        <span className="stats-bar-value">{v.display}</span>
      </button>
    );
  };
  return (
    <div className="stats-pairs">
      <div className="stats-pair-legend">
        <span />
        <span className="stats-pair-a">{names[0]}</span>
        <span className="stats-pair-b">{names[1]}</span>
      </div>
      {(limit ? rows.slice(0, limit) : rows).map((r) => (
        <div key={r.key} className="stats-pair-row">
          <span className="stats-bar-label">{r.label}</span>
          {bar(r, "a")}
          {bar(r, "b")}
        </div>
      ))}
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
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  onClick?: () => void;
  picked?: boolean;
  /** A number about one sex only carries that sex's colour as a stripe. */
  tone?: Tone;
}) {
  const body = (
    <>
      <span className="stats-tile-value">{value}</span>
      <span className="stats-tile-label">{label}</span>
      {sub && <span className="stats-tile-sub">{sub}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={`stats-tile${picked ? " picked" : ""}${toneClass(tone)}`} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={`stats-tile${toneClass(tone)}`}>{body}</div>
  );
}

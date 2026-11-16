import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { tipProps } from "../IconTip";

// The Places page's three charts: a flow from the parents' birth places to the
// children's, a grid of places by decade, and births by decade stacked by
// place. Every ribbon, cell and part is a button — it lists the people behind it.

/** A place's colour: a hue index into the place palette, or the grey of the
 *  other places or of no place at all. */
export type Swatch = number | "other" | "none";

/** Well apart around the wheel, the commonest places first. */
const HUES = [235, 340, 75, 150, 25, 195, 290, 110];

/** The CSS colour a swatch paints with (the theme sets lightness and chroma). */
export function swatchStyle(s: Swatch): CSSProperties {
  const color = s === "other" ? "var(--muted)"
    : s === "none" ? "var(--border-2)"
      // Past the palette the hues come round again, darker, so no two places share a colour.
      : `oklch(calc(var(--stats-place-l) - ${0.16 * Math.floor(s / HUES.length)}) var(--stats-place-c) ${HUES[s % HUES.length]})`;
  return { "--stats-bar": color } as CSSProperties;
}

export interface FlowNodeView {
  key: string;
  label: ReactNode;
  count: number;
  /** Hover text: the full place and its pairs. */
  tip: string;
  swatch: Swatch;
}

export interface FlowView {
  key: string;
  from: string;
  to: string;
  count: number;
  tip: string;
}

/** The gap between two nodes of a side, px. */
const NODE_GAP = 8;

/** A label line's height, px: a thin node still takes a line, so its label
 *  stands beside it, clear of its neighbours'. */
const LABEL_LINE = 17;

/** How much height a node takes: its pairs, or a label's line. */
const slotOf = (h: number) => Math.max(h, LABEL_LINE - NODE_GAP);

/** The height a side's nodes take, in px. */
function sideHeight(nodes: FlowNodeView[], unit: number): number {
  return nodes.reduce((n, x) => n + slotOf(x.count * unit), 0) + NODE_GAP * Math.max(0, nodes.length - 1);
}

/** Where a side's nodes stand, centred in the chart's height. */
function stack(nodes: FlowNodeView[], unit: number, height: number) {
  let y = (height - sideHeight(nodes, unit)) / 2;
  const at = new Map<string, { top: number; height: number }>();
  for (const n of nodes) {
    const h = n.count * unit;
    const slot = slotOf(h);
    // A thin node sits in the middle of its line.
    at.set(n.key, { top: y + (slot - h) / 2, height: h });
    y += slot + NODE_GAP;
  }
  return at;
}

/** Each node's label centre: on the node, pushed apart where thin nodes
 *  would set their labels on top of each other, and kept inside the chart. */
function labelTops(nodes: { top: number; height: number }[], height: number): number[] {
  const tops = nodes.map((p) => p.top + p.height / 2);
  for (let i = 1; i < tops.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + LABEL_LINE);
  const floor = height - LABEL_LINE / 2;
  if (tops.length && tops[tops.length - 1] > floor) tops[tops.length - 1] = floor;
  for (let i = tops.length - 2; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - LABEL_LINE);
  return tops;
}

/**
 * A two-column flow (Sankey): the parents' places on the left, the children's
 * on the right, a ribbon as thick as the pairs between them.
 */
export function FlowChart({
  from: parents,
  to: children,
  flows,
  heads,
  onPick,
  picked,
  format,
}: {
  /** The parents' places, left, and the children's, right. */
  from: FlowNodeView[];
  to: FlowNodeView[];
  flows: FlowView[];
  heads: [string, string];
  onPick: (key: string) => void;
  picked?: string;
  format: (n: number) => string;
}) {
  const { t } = useTranslation();
  if (!flows.length) return <p className="muted stats-empty">{t("stats.empty")}</p>;
  const base = Math.max(300, 38 * Math.max(parents.length, children.length));
  const total = flows.reduce((n, f) => n + f.count, 0);
  const unit = Math.min(
    (base - NODE_GAP * (parents.length - 1)) / total,
    (base - NODE_GAP * (children.length - 1)) / total,
  );
  // The lines the thin nodes take may need a little more than the base height.
  const height = Math.ceil(Math.max(base, sideHeight(parents, unit), sideHeight(children, unit)));
  const left = stack(parents, unit, height);
  const right = stack(children, unit, height);
  const leftIndex = new Map(parents.map((n, i) => [n.key, i]));
  const rightIndex = new Map(children.map((n, i) => [n.key, i]));
  const swatchOf = new Map(parents.map((n) => [n.key, n.swatch]));

  // Within a node the ribbons keep the other side's order, so they cross as
  // little as they can.
  const leftOffset = new Map<string, number>();
  const rightOffset = new Map<string, number>();
  const ribbons = flows.map((f) => {
    const h = f.count * unit;
    const l = left.get(f.from)!;
    const r = right.get(f.to)!;
    return { f, h, l, r };
  });
  const byLeft = [...ribbons].sort((a, b) => leftIndex.get(a.f.from)! - leftIndex.get(b.f.from)! || rightIndex.get(a.f.to)! - rightIndex.get(b.f.to)!);
  const y0 = new Map<string, number>();
  for (const x of byLeft) {
    const off = leftOffset.get(x.f.from) ?? 0;
    y0.set(x.f.key, x.l.top + off);
    leftOffset.set(x.f.from, off + x.h);
  }
  const byRight = [...ribbons].sort((a, b) => rightIndex.get(a.f.to)! - rightIndex.get(b.f.to)! || leftIndex.get(a.f.from)! - leftIndex.get(b.f.from)!);
  const y1 = new Map<string, number>();
  for (const x of byRight) {
    const off = rightOffset.get(x.f.to) ?? 0;
    y1.set(x.f.key, x.r.top + off);
    rightOffset.set(x.f.to, off + x.h);
  }
  // Thick ribbons first, thin ones over them, so none hides under another.
  const drawn = [...ribbons].sort((a, b) => b.h - a.h);

  type At = Map<string, { top: number; height: number }>;
  const labels = (nodes: FlowNodeView[], at: At, side: "from" | "to") => {
    const tops = labelTops(nodes.map((n) => at.get(n.key)!), height);
    return (
    <div className={`stats-flow-labels ${side}`}>
      {nodes.map((n, i) => {
        return (
          <span key={n.key} className="stats-flow-label" style={{ top: tops[i] }} {...tipProps(n.tip)}>
            <span className="stats-flow-name">{n.label}</span> <span className="muted">{format(n.count)}</span>
          </span>
        );
      })}
    </div>
    );
  };
  const bars =(nodes: FlowNodeView[], at: At) => (
    <div className="stats-flow-nodes">
      {nodes.map((n) => {
        const p = at.get(n.key)!;
        return <span key={n.key} className="stats-flow-node" style={{ ...swatchStyle(n.swatch), top: p.top, height: Math.max(2, p.height) }} />;
      })}
    </div>
  );

  return (
    <div className="stats-flow-wrap">
      <div className="stats-flow-heads">
        <span>{heads[0]}</span>
        <span>{heads[1]}</span>
      </div>
      <div className="stats-flow" style={{ height }}>
        {labels(parents, left, "from")}
        {bars(parents, left)}
        <svg className="stats-flow-links" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" style={{ height }}>
          {drawn.map(({ f, h }) => {
            const a = y0.get(f.key)!;
            const b = y1.get(f.key)!;
            const d = `M0 ${a} C50 ${a} 50 ${b} 100 ${b} L100 ${b + h} C50 ${b + h} 50 ${a + h} 0 ${a + h} Z`;
            return (
              <path
                key={f.key}
                d={d}
                role="button"
                className={picked === f.key ? "picked" : undefined}
                style={swatchStyle(swatchOf.get(f.from) ?? "other")}
                onClick={() => onPick(f.key)}
                {...tipProps(f.tip, { acts: true })}
              />
            );
          })}
        </svg>
        {/* The right side's bars, then its labels, mirror the left's. */}
        {bars(children, right)}
        {labels(children, right, "to")}
      </div>
    </div>
  );
}

export interface GridRow {
  key: string;
  label: ReactNode;
  tip: string;
  /** People per decade (its first year). */
  cells: Map<number, number>;
}

/**
 * Places down, decades across, the births of each in a cell shaded by how
 * many there are.
 */
export function DecadeGrid({
  rows,
  first,
  last,
  max,
  onPick,
  picked,
  tip,
  decadeLabel,
  format,
}: {
  rows: GridRow[];
  first: number;
  last: number;
  max: number;
  onPick: (row: string, decade: number) => void;
  /** `row:decade`. */
  picked?: string;
  tip: (row: GridRow, decade: number, count: number) => string;
  /** A decade's axis label: "1820s". */
  decadeLabel: (decade: number) => string;
  format: (n: number) => string;
}) {
  const decades: number[] = [];
  for (let d = first; d <= last; d += 10) decades.push(d);
  const every = decades.length > 16 ? 2 : 1;
  return (
    <div className="stats-grid-scroll">
      <div className="stats-decades" style={{ gridTemplateColumns: `minmax(6em, 11em) repeat(${decades.length}, minmax(28px, 1fr))` }}>
        <span />
        {decades.map((d, i) => <span key={d} className="stats-decade-head">{i % every === 0 ? decadeLabel(d) : ""}</span>)}
        {rows.map((r) => (
          <div key={r.key} className="stats-decade-row">
            <span className="stats-decade-label" {...tipProps(r.tip)}>{r.label}</span>
            {decades.map((d) => {
              const n = r.cells.get(d) ?? 0;
              if (!n) return <span key={d} className="stats-decade-cell empty" />;
              // From a pale tint for one birth to the full accent for the most.
              const share = Math.round(25 + (75 * n) / max);
              const key = `${r.key}:${d}`;
              return (
                <button
                  key={d}
                  type="button"
                  className={`stats-decade-cell${share > 60 ? " strong" : ""}${picked === key ? " picked" : ""}`}
                  style={{ "--stats-share": `${share}%` } as CSSProperties}
                  onClick={() => onPick(r.key, d)}
                  {...tipProps(tip(r, d, n), { acts: true })}
                >
                  {format(n)}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export interface StackPart {
  key: string;
  label: ReactNode;
  /** The legend's count. */
  count: number;
  swatch: Swatch;
}

export interface StackColumnView {
  key: string;
  label: string;
  /** People per part, in the order of the parts. */
  values: number[];
  tips: string[];
  top?: string;
}

/** Columns stacked from many parts, the first at the floor, with a legend of the parts. */
export function MultiStackChart({
  parts,
  columns,
  onPick,
  picked,
  format,
}: {
  parts: StackPart[];
  columns: StackColumnView[];
  onPick: (column: string, part: number) => void;
  /** `column:part`. */
  picked?: string;
  format: (n: number) => string;
}) {
  const { t } = useTranslation();
  if (!columns.length) return <p className="muted stats-empty">{t("stats.empty")}</p>;
  let max = 1;
  for (const c of columns) max = Math.max(max, c.values.reduce((a, b) => a + b, 0));
  const every = Math.max(1, Math.ceil(columns.length / 12));
  const labelled = columns.length <= 13;
  return (
    <div className="stats-stacked">
      <div className={`stats-columns${every > 1 ? " spread" : ""}`}>
        {columns.map((c, i) => (
          <div key={c.key} className="stats-col">
            <span className="stats-col-plot">
              {c.top && labelled && <span className="stats-col-value">{c.top}</span>}
              {c.values.map((v, p) => ({ v, p })).reverse().map(({ v, p }) => v > 0 && (
                <button
                  key={p}
                  type="button"
                  className={`stats-col-bar stats-place-part${picked === `${c.key}:${p}` ? " picked" : ""}`}
                  style={{ ...swatchStyle(parts[p].swatch), height: `${(100 * v) / max}%` }}
                  onClick={() => onPick(c.key, p)}
                  {...tipProps(c.tips[p], { acts: true })}
                />
              ))}
            </span>
            <span className="stats-col-label">{i % every === 0 ? c.label : " "}</span>
          </div>
        ))}
      </div>
      <div className="stats-pair-legend stats-place-legend">
        {parts.map((p) => (
          <span key={p.key} style={swatchStyle(p.swatch)}>
            {p.label} ({format(p.count)})
          </span>
        ))}
      </div>
    </div>
  );
}

import { useTranslation } from "react-i18next";
import type { GedNode } from "../gedcom/types";
import { PAD } from "../chart/treeLayout";
import type { FanChart, FanSegment } from "../chart/fanLayout";
import type { TreeNode } from "../chart/personTree";
import { TreeNodePhoto } from "./PersonMedia";
import type { MediaRefContext } from "./MediaViewer";
import { NodeBadge } from "./TreeNodeBox";
import { sexColorVar } from "./sex";

/** A small badge dot a host can attach to a segment (decision / modified / import). */
export interface FanBadge {
  /** Class for themed circle + text fill (e.g. `tree-node-decision confirmed`). */
  cls?: string;
  letter: string;
  /** Explicit circle fill / text fill when not driven by a class. */
  fill?: string;
  textFill?: string;
  /** Hover explanation, when the badge means more than its letter (the
   *  generation limit's "+N, not shown"). */
  title?: string;
}

interface Props {
  chart: FanChart;
  /** Canvas zoom (1 = native): scales the rendered SVG while the `viewBox` stays
   *  native, so the radial chart stays crisp at any scale. */
  zoom?: number;
  /** State colour for a node's wedge border + tinted fill (matches `TreeNodeBox`). */
  colorOf: (node: TreeNode) => string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Segment just jumped to by find-in-chart; flashes so it's spotted at a glance. */
  flashKey?: string | null;
  /** Photo sources, shared with the tree views' `TreeNodePhoto`. */
  mainRecords: GedNode[];
  compareRecords?: GedNode[];
  mainRefCtx?: MediaRefContext;
  compareRefCtx?: MediaRefContext;
  /** Optional badge dot per node. */
  badgeOf?: (node: TreeNode) => FanBadge | undefined;
}

const arcId = (seg: FanSegment, i: number) => `fa-${seg.gen}-${seg.slot}-${i}`;

/**
 * The radial body for the Fan / Circle ancestor charts. Renders the same
 * `svg.tree-svg` skeleton the layered tree views use (so pan, the minimap, and
 * the SVG/PDF export all work unchanged), filling it with one annular sector per
 * ancestor: a state-coloured wedge, a given-name / surname / lifespan label that
 * curves along the ring (or reads radially on the narrow outer rings), an
 * optional inner-ring photo rotated to the arc, and an optional status badge.
 */
export function FanChartBody({
  chart,
  zoom = 1,
  colorOf,
  selectedKey,
  onSelect,
  flashKey,
  mainRecords,
  compareRecords,
  mainRefCtx,
  compareRefCtx,
  badgeOf,
}: Props) {
  const { t } = useTranslation();
  const curved = chart.segments.filter((s) => s.curved);
  return (
    <svg className="tree-svg" width={chart.width * zoom} height={chart.height * zoom} viewBox={`0 0 ${chart.width} ${chart.height}`} role="img">
      <g transform={`translate(${PAD},${PAD})`}>
        {/* Per-line baselines the curved labels ride on. Kept in the same
            translated group as the wedges so their coordinates line up. */}
        <defs>
          {curved.map((seg) => (
            <g key={seg.key}>
              {seg.lines.map((l, i) => l.arc && <path key={i} id={arcId(seg, i)} d={l.arc} />)}
            </g>
          ))}
          {chart.marriages.map((m, i) =>
            m.lines.map((l, j) => <path key={`${m.key}-${j}`} id={`fm-${i}-${j}`} d={l.arc} />),
          )}
        </defs>
        {chart.segments.map((seg) => (
          <Segment
            key={seg.key}
            seg={seg}
            color={colorOf(seg.node)}
            selected={seg.key === selectedKey}
            flashed={seg.key === flashKey}
            onSelect={onSelect}
            clickHint={t("tree.node.clickHint")}
            mainRecords={mainRecords}
            compareRecords={compareRecords}
            mainRefCtx={mainRefCtx}
            compareRefCtx={compareRefCtx}
            badge={badgeOf?.(seg.node)}
          />
        ))}
        {/* Marriage collars: a thin band in the reserved lane between each couple
            and their child, with the year / place centred on it. */}
        {chart.marriages.map((m) => (
          <path key={m.key} className="fan-marriage-band" d={m.d} />
        ))}
        {chart.marriages.map((m, i) =>
          m.lines.map((l, j) => (
            <text
              key={`${m.key}-${j}`}
              className="fan-marriage gm-data"
              fontSize={m.fontPx}
              dominantBaseline="middle"
            >
              <textPath href={`#fm-${i}-${j}`} startOffset="50%" textAnchor="middle">
                {l.text}
              </textPath>
            </text>
          )),
        )}
      </g>
    </svg>
  );
}

function Segment({
  seg,
  color,
  selected,
  flashed,
  onSelect,
  clickHint,
  mainRecords,
  compareRecords,
  mainRefCtx,
  compareRefCtx,
  badge,
}: {
  seg: FanSegment;
  color: string;
  selected: boolean;
  flashed: boolean;
  onSelect: (key: string) => void;
  clickHint: string;
  mainRecords: GedNode[];
  compareRecords?: GedNode[];
  mainRefCtx?: MediaRefContext;
  compareRefCtx?: MediaRefContext;
  badge?: FanBadge;
}) {
  const { node } = seg;
  const nameFill = sexColorVar(node.sex) ?? "var(--text)";
  const lineProps = (l: FanSegment["lines"][number]) =>
    l.kind === "years"
      ? { className: "fan-label-year gm-data", fontSize: seg.fontPx * 0.85 }
      : {
          className: "fan-label-name",
          fontSize: seg.fontPx,
          style: { fill: nameFill, ...(seg.light ? { fontWeight: 400 } : null) },
        };
  return (
    <g className={`fan-node${selected ? " selected" : ""}${flashed ? " find-hit" : ""}`} onClick={() => onSelect(seg.key)}>
      <title>{clickHint}</title>
      <path
        className="fan-sector"
        d={seg.d}
        fill={`color-mix(in srgb, ${color} 16%, var(--panel))`}
        stroke={selected ? color : `color-mix(in srgb, ${color} 50%, var(--panel))`}
        strokeWidth={selected ? 2.5 : 0.75}
      />
      {seg.photo && (
        <g transform={`translate(${seg.photo.cx},${seg.photo.cy}) rotate(${seg.photo.rot})`}>
          <TreeNodePhoto
            node={node}
            mainRecords={mainRecords}
            compareRecords={compareRecords}
            mainRefCtx={mainRefCtx}
            compareRefCtx={compareRefCtx}
            x={-seg.photo.size / 2}
            y={-seg.photo.size / 2}
            size={seg.photo.size}
          />
        </g>
      )}
      {seg.curved ? (
        seg.lines.map((l, i) => (
          <text key={i} {...lineProps(l)} dominantBaseline="middle">
            <textPath href={`#${arcId(seg, i)}`} startOffset="50%" textAnchor="middle">
              {l.text}
            </textPath>
          </text>
        ))
      ) : (
        <g transform={seg.labelTransform}>
          {seg.lines.map((l, i) => (
            <text key={i} {...lineProps(l)} x={0} y={l.dy} textAnchor="middle" dominantBaseline="middle">
              {l.text}
            </text>
          ))}
        </g>
      )}
      {badge && (
        <NodeBadge
          x={seg.badge.x}
          y={seg.badge.y}
          cls={`fan-badge ${badge.cls ?? ""}`}
          fill={badge.fill}
          textFill={badge.textFill}
          letter={badge.letter}
          title={badge.title}
        />
      )}
    </g>
  );
}

import { useTranslation } from "react-i18next";
import type { GedNode } from "../gedcom/types";
import { PAD } from "../tree/treeLayout";
import type { FanChart, FanSegment } from "../tree/fanLayout";
import type { TreeNode } from "../tree/compareTree";
import { TreeNodePhoto } from "./PersonPhotos";
import type { PhotoRefContext } from "./PhotoViewer";
import { sexColorVar } from "./sex";

/** A small badge dot a host can attach to a segment (decision / modified / import). */
export interface FanBadge {
  /** Class for themed circle + text fill (e.g. `tree-node-decision confirmed`). */
  cls?: string;
  letter: string;
  /** Explicit circle fill / text fill when not driven by a class. */
  fill?: string;
  textFill?: string;
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
  /** Photo sources, shared with the tree views' `TreeNodePhoto`. */
  masterRecords: GedNode[];
  compareRecords?: GedNode[];
  masterRefCtx?: PhotoRefContext;
  compareRefCtx?: PhotoRefContext;
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
  masterRecords,
  compareRecords,
  masterRefCtx,
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
        </defs>
        {chart.segments.map((seg) => (
          <Segment
            key={seg.key}
            seg={seg}
            color={colorOf(seg.node)}
            selected={seg.key === selectedKey}
            onSelect={onSelect}
            clickHint={t("tree.node.clickHint")}
            masterRecords={masterRecords}
            compareRecords={compareRecords}
            masterRefCtx={masterRefCtx}
            compareRefCtx={compareRefCtx}
            badge={badgeOf?.(seg.node)}
          />
        ))}
      </g>
    </svg>
  );
}

function Segment({
  seg,
  color,
  selected,
  onSelect,
  clickHint,
  masterRecords,
  compareRecords,
  masterRefCtx,
  compareRefCtx,
  badge,
}: {
  seg: FanSegment;
  color: string;
  selected: boolean;
  onSelect: (key: string) => void;
  clickHint: string;
  masterRecords: GedNode[];
  compareRecords?: GedNode[];
  masterRefCtx?: PhotoRefContext;
  compareRefCtx?: PhotoRefContext;
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
    <g className={`fan-node${selected ? " selected" : ""}`} onClick={() => onSelect(seg.key)}>
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
            masterRecords={masterRecords}
            compareRecords={compareRecords}
            masterRefCtx={masterRefCtx}
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
        <g className={`fan-badge ${badge.cls ?? ""}`} transform={`translate(${seg.badge.x},${seg.badge.y})`}>
          <circle r={7} fill={badge.fill} />
          <text textAnchor="middle" dominantBaseline="central" x={0} y={0.5} fontSize={9} fontWeight={700} fill={badge.textFill}>
            {badge.letter}
          </text>
        </g>
      )}
    </g>
  );
}

import { useTranslation } from "react-i18next";
import type { GedNode } from "../gedcom/types";
import { NODE_W, PAD, type Flat, type Placed } from "../chart/treeLayout";
import type { NodeDisplayOptions } from "../chart/nodeDisplay";
import type { Lineage } from "../match/kinship";
import type { MediaRefContext } from "./MediaViewer";
import { NodeBadge, nodeStatusBadges, TreeNodeBox } from "./TreeNodeBox";

// The layered (tidy-tree / grid) diagram body shared by the Edit Tree and the
// Compare Tree: the connector paths and marriage labels from `flatten`, then
// one TreeNodeBox per node — coloured, badged, kinship-labelled and photo'd by
// the host's callbacks. The radial (fan/circle) counterpart is FanChartBody.

interface Props {
  flat: Flat;
  width: number;
  height: number;
  /** Canvas zoom (1 = native): scales the rendered SVG while the `viewBox`
   *  stays native, so the chart stays crisp at any scale. */
  zoom: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Node just jumped to by find-in-chart; flashes so it's spotted at a glance. */
  flashKey?: string | null;
  /** State colour for a node's border + tinted fill. */
  colorOf: (n: Placed) => string;
  /** Letter badge in themed status colours (decision / import), when any. */
  badgeOf?: (n: Placed) => { status: string; letter: string } | undefined;
  /** "Modified" badge for a main record with unsaved edits. */
  modifiedOf?: (n: Placed) => boolean;
  /** Whether to mark repeated positions (`TreeNode.repeat`) — follows the same
   *  Badges toggle as the status chips, so a badge-free chart stays clean. */
  showRepeat?: boolean;
  /** Take the view to the position a repeat points at (`TreeNode.repeatOf`). */
  onRepeatJump?: (key: string) => void;
  kinshipOf?: (n: Placed) => string | undefined;
  lineageOf?: (n: Placed) => Lineage | undefined;
  /** Photo sources; the compare side is optional (single-file views). */
  mainRecords: GedNode[];
  compareRecords?: GedNode[];
  mainRefCtx?: MediaRefContext;
  compareRefCtx?: MediaRefContext;
  display: NodeDisplayOptions;
  nodeH: number;
}

export function TreeSvg({
  flat,
  width,
  height,
  zoom,
  selectedKey,
  onSelect,
  flashKey,
  colorOf,
  badgeOf,
  modifiedOf,
  showRepeat = false,
  onRepeatJump,
  kinshipOf,
  lineageOf,
  mainRecords,
  compareRecords,
  mainRefCtx,
  compareRefCtx,
  display,
  nodeH,
}: Props) {
  const { t } = useTranslation();
  const modifiedLetter = t("edit.tree.modified").charAt(0);
  return (
    <svg className="tree-svg" width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`} role="img">
      <g transform={`translate(${PAD},${PAD})`}>
        {flat.edges.map((e) => (
          <path
            key={e.id}
            className={e.partner ? "tree-edge tree-edge-partner" : "tree-edge"}
            d={e.d}
          />
        ))}
        {flat.edges.map(
          (e) =>
            e.label && (
              <text
                key={`${e.id}-m`}
                className="tree-edge-label gm-data"
                x={e.label.x}
                y={e.label.y}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {e.label.text}
              </text>
            ),
        )}
        {flat.nodes.map((n) => {
          const badges = nodeStatusBadges(badgeOf?.(n), modifiedOf?.(n) ?? false, modifiedLetter);
          // The repeat marker sits in the box's own bottom-right corner rather
          // than after the lifespan: it belongs to the node, not to its status
          // row, and there it can't collide with the badges above.
          const repeatTo = showRepeat && n.repeat ? n.repeatOf : undefined;
          return (
            <g
              key={n.key}
              transform={`translate(${n.x},${n.y})`}
              className={`tree-node${n.key === selectedKey ? " selected" : ""}${n.key === flashKey ? " find-hit" : ""}`}
              onClick={() => onSelect(n.key)}
            >
              <title>{t("tree.node.clickHint")}</title>
              <TreeNodeBox
                name={n.name}
                years={n.years}
                age={n.age}
                place={n.place}
                sex={n.sex}
                color={colorOf(n)}
                kinship={kinshipOf?.(n)}
                kinshipLineage={lineageOf?.(n)}
                photo={{ node: n, mainRecords, compareRecords, mainRefCtx, compareRefCtx }}
                display={display}
                living={n.living}
                nodeH={nodeH}
                badges={badges}
              />
              {repeatTo && (
                <g
                  className="tree-node-repeat"
                  onClick={(e) => {
                    e.stopPropagation(); // the jump replaces the node's own select
                    onRepeatJump?.(repeatTo);
                  }}
                >
                  <NodeBadge x={NODE_W - 12} y={nodeH - 12} letter="→" cls="tree-node-repeat-badge" title={t("tree.node.repeatHint")} />
                </g>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

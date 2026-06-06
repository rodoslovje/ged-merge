import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import {
  buildCompareTree,
  buildMatchMaps,
  type NodeStatus,
  type TreeMode,
  type TreeNode,
} from "../tree/compareTree";

interface Props {
  masterDs: Dataset;
  compareDs: Dataset;
  matches: MatchResult;
  rootMasterId?: string;
  rootCompareId?: string;
  mode: TreeMode;
  onModeChange: (mode: TreeMode) => void;
  onBack: () => void;
}

const NODE_W = 184;
const NODE_H = 48;
const COL_GAP = 80;
const ROW_GAP = 18;
const COL_STEP = NODE_W + COL_GAP;
const ROW_STEP = NODE_H + ROW_GAP;
const PAD = 24;

/** Rectangle fill per comparison status (the colours requested in the spec). */
const STATUS_COLOR: Record<NodeStatus, string> = {
  match: "#2e7d32",
  minor: "#c8910a",
  major: "#c0392b",
  "master-only": "#0097a7",
  "incoming-only": "#8e44ad",
};

const LEGEND_ORDER: NodeStatus[] = [
  "match",
  "minor",
  "major",
  "master-only",
  "incoming-only",
];

const LEGEND_KEY: Record<NodeStatus, string> = {
  match: "tree.legend.match",
  minor: "tree.legend.minor",
  major: "tree.legend.major",
  "master-only": "tree.legend.masterOnly",
  "incoming-only": "tree.legend.incomingOnly",
};

interface Placed extends TreeNode {
  x: number;
  y: number;
  children: Placed[];
}

export function CompareTree({
  masterDs,
  compareDs,
  matches,
  rootMasterId,
  rootCompareId,
  mode,
  onModeChange,
  onBack,
}: Props) {
  const { t } = useTranslation();

  const rootMaster = rootMasterId ? masterDs.individuals.get(rootMasterId) : undefined;
  const rootIncoming = rootCompareId ? compareDs.individuals.get(rootCompareId) : undefined;

  const tree = useMemo(
    () =>
      buildCompareTree(
        rootMaster,
        rootIncoming,
        masterDs,
        compareDs,
        buildMatchMaps(matches),
        mode,
      ),
    [rootMaster, rootIncoming, masterDs, compareDs, matches, mode],
  );

  const laid = useMemo(() => (tree ? layout(tree) : undefined), [tree]);
  const rootName = tree?.name ?? "";

  return (
    <div className="tree-page">
      <div className="tree-toolbar">
        <button className="tree-back" onClick={onBack}>
          ← {t("tree.back")}
        </button>
        <h2 className="tree-title">
          {t("tree.title")}
          {rootName && <span className="muted"> · {rootName}</span>}
        </h2>
        <div className="tree-mode">
          <button
            className={mode === "ancestors" ? "active" : ""}
            onClick={() => onModeChange("ancestors")}
          >
            {t("tree.ancestors")}
          </button>
          <button
            className={mode === "descendants" ? "active" : ""}
            onClick={() => onModeChange("descendants")}
          >
            {t("tree.descendants")}
          </button>
        </div>
      </div>

      <div className="tree-legend">
        {LEGEND_ORDER.map((s) => (
          <span key={s} className="tree-legend-item">
            <span className="tree-swatch" style={{ background: STATUS_COLOR[s] }} />
            {t(LEGEND_KEY[s])}
          </span>
        ))}
      </div>

      <div className="tree-canvas">
        {laid ? (
          <TreeSvg laid={laid} />
        ) : (
          <p className="muted">{t("tree.empty")}</p>
        )}
      </div>
    </div>
  );
}

function TreeSvg({ laid }: { laid: { root: Placed; width: number; height: number } }) {
  const { root, width, height } = laid;
  const nodes: Placed[] = [];
  const edges: { id: string; d: string }[] = [];
  (function walk(n: Placed) {
    nodes.push(n);
    for (const c of n.children) {
      edges.push({ id: `${n.key}->${c.key}`, d: edgePath(n, c) });
      walk(c);
    }
  })(root);

  return (
    <svg className="tree-svg" width={width} height={height} role="img">
      <g transform={`translate(${PAD},${PAD})`}>
        {edges.map((e) => (
          <path key={e.id} className="tree-edge" d={e.d} />
        ))}
        {nodes.map((n) => (
          <g key={n.key} transform={`translate(${n.x},${n.y})`} className="tree-node">
            <title>{n.detail}</title>
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={10}
              ry={10}
              fill={STATUS_COLOR[n.status]}
            />
            <text className="tree-node-name" x={NODE_W / 2} y={19} textAnchor="middle">
              {truncate(n.name, 26)}
            </text>
            {n.years && (
              <text className="tree-node-year" x={NODE_W / 2} y={36} textAnchor="middle">
                b. {n.years}
              </text>
            )}
          </g>
        ))}
      </g>
    </svg>
  );
}

/** A smooth horizontal connector from a node's right edge to a child's left edge. */
function edgePath(parent: Placed, child: Placed): string {
  const x1 = parent.x + NODE_W;
  const y1 = parent.y + NODE_H / 2;
  const x2 = child.x;
  const y2 = child.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

/**
 * Left-to-right layered layout: depth sets the column (x), and leaves are stacked
 * top-to-bottom (y) while each parent is centred on the span of its children.
 */
function layout(root: TreeNode): { root: Placed; width: number; height: number } {
  let leaf = 0;
  const place = (node: TreeNode, depth: number): Placed => {
    const children = node.children.map((c) => place(c, depth + 1));
    const y =
      children.length === 0
        ? (leaf++ * ROW_STEP)
        : (children[0].y + children[children.length - 1].y) / 2;
    return { ...node, x: depth * COL_STEP, y, children };
  };
  const placed = place(root, 0);
  const depth = maxDepth(root);
  const leaves = Math.max(1, leaf);
  return {
    root: placed,
    width: depth * COL_STEP + NODE_W + PAD * 2,
    height: (leaves - 1) * ROW_STEP + NODE_H + PAD * 2,
  };
}

function maxDepth(node: TreeNode): number {
  return node.children.length === 0
    ? 0
    : 1 + Math.max(...node.children.map(maxDepth));
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

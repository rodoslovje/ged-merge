import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { individualFieldRows } from "../review/fields";
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

/** Maximum minimap extent (px); the tree is scaled to fit within this box. */
const MINIMAP_MAX_W = 220;
const MINIMAP_MAX_H = 160;

/** The visible window over the scrolling canvas, in content coordinates. */
interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

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
        t,
        rootMaster,
        rootIncoming,
        masterDs,
        compareDs,
        buildMatchMaps(matches),
        mode,
      ),
    [t, rootMaster, rootIncoming, masterDs, compareDs, matches, mode],
  );

  const laid = useMemo(() => (tree ? layout(tree) : undefined), [tree]);
  const flat = useMemo(() => (laid ? flatten(laid.root) : undefined), [laid]);
  const rootName = tree?.name ?? "";

  const nodesByKey = useMemo(() => {
    const map = new Map<string, Placed>();
    for (const n of flat?.nodes ?? []) if (!map.has(n.key)) map.set(n.key, n);
    return map;
  }, [flat]);

  const canvasRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ left: 0, top: 0, width: 0, height: 0 });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // A new tree (mode switch / different root) invalidates the old selection.
  useEffect(() => setSelectedKey(null), [laid]);

  const selected = selectedKey ? nodesByKey.get(selectedKey) : undefined;

  const syncViewport = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    setViewport({
      left: el.scrollLeft,
      top: el.scrollTop,
      width: el.clientWidth,
      height: el.clientHeight,
    });
  }, []);

  // Re-measure on first paint, whenever the laid-out tree changes, and on resize.
  useEffect(() => syncViewport(), [laid, syncViewport]);
  useEffect(() => {
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, [syncViewport]);

  const scrollTo = useCallback((left: number, top: number) => {
    const el = canvasRef.current;
    if (!el) return;
    el.scrollLeft = left; // browser clamps to range; onScroll re-syncs the rect
    el.scrollTop = top;
  }, []);

  // Select a node and bring it into view, centred in the canvas.
  const selectNode = useCallback(
    (key: string) => {
      setSelectedKey(key);
      const n = nodesByKey.get(key);
      const el = canvasRef.current;
      if (!n || !el) return;
      scrollTo(
        n.x + PAD + NODE_W / 2 - el.clientWidth / 2,
        n.y + PAD + NODE_H / 2 - el.clientHeight / 2,
      );
    },
    [nodesByKey, scrollTo],
  );

  const needsMinimap =
    !!laid &&
    viewport.width > 0 &&
    (laid.width > viewport.width + 1 || laid.height > viewport.height + 1);

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

      <TreeLegend nodes={flat?.nodes ?? []} selectedKey={selectedKey} onPick={selectNode} />

      <div className="tree-canvas-wrap">
        <div className="tree-canvas" ref={canvasRef} onScroll={syncViewport}>
          {laid && flat ? (
            <TreeSvg
              flat={flat}
              width={laid.width}
              height={laid.height}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
            />
          ) : (
            <p className="muted">{t("tree.empty")}</p>
          )}
        </div>
        {needsMinimap && laid && flat && (
          <Minimap
            nodes={flat.nodes}
            contentW={laid.width}
            contentH={laid.height}
            viewport={viewport}
            onScrollTo={scrollTo}
          />
        )}
        {selected && (
          <NodeCompare
            node={selected}
            masterDs={masterDs}
            compareDs={compareDs}
            onClose={() => setSelectedKey(null)}
          />
        )}
      </div>
    </div>
  );
}

interface Flat {
  nodes: Placed[];
  edges: { id: string; d: string }[];
}

/** Collect every node and parent→child connector path from the laid-out tree. */
function flatten(root: Placed): Flat {
  const nodes: Placed[] = [];
  const edges: { id: string; d: string }[] = [];
  (function walk(n: Placed) {
    nodes.push(n);
    for (const c of n.children) {
      edges.push({ id: `${n.key}->${c.key}`, d: edgePath(n, c) });
      walk(c);
    }
  })(root);
  return { nodes, edges };
}

function TreeSvg({
  flat,
  width,
  height,
  selectedKey,
  onSelect,
}: {
  flat: Flat;
  width: number;
  height: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { nodes, edges } = flat;
  return (
    <svg className="tree-svg" width={width} height={height} role="img">
      <g transform={`translate(${PAD},${PAD})`}>
        {edges.map((e) => (
          <path key={e.id} className="tree-edge" d={e.d} />
        ))}
        {nodes.map((n) => (
          <g
            key={n.key}
            transform={`translate(${n.x},${n.y})`}
            className={`tree-node${n.key === selectedKey ? " selected" : ""}`}
            onClick={() => onSelect(n.key)}
          >
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

/**
 * Overview map of the whole tree with a draggable rectangle marking the visible
 * window. Clicking or dragging on it recentres the main canvas there.
 */
function Minimap({
  nodes,
  contentW,
  contentH,
  viewport,
  onScrollTo,
}: {
  nodes: Placed[];
  contentW: number;
  contentH: number;
  viewport: Viewport;
  onScrollTo: (left: number, top: number) => void;
}) {
  const dragging = useRef(false);
  const scale = Math.min(MINIMAP_MAX_W / contentW, MINIMAP_MAX_H / contentH);
  const w = contentW * scale;
  const h = contentH * scale;

  const recentre = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    onScrollTo(x - viewport.width / 2, y - viewport.height / 2);
  };

  return (
    <svg
      className="tree-minimap"
      width={w}
      height={h}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        recentre(e);
      }}
      onPointerMove={(e) => dragging.current && recentre(e)}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      {nodes.map((n) => (
        <rect
          key={n.key}
          x={(n.x + PAD) * scale}
          y={(n.y + PAD) * scale}
          width={Math.max(1, NODE_W * scale)}
          height={Math.max(1, NODE_H * scale)}
          rx={1}
          fill={STATUS_COLOR[n.status]}
        />
      ))}
      <rect
        className="tree-minimap-viewport"
        x={viewport.left * scale}
        y={viewport.top * scale}
        width={viewport.width * scale}
        height={viewport.height * scale}
      />
    </svg>
  );
}

/**
 * Colour legend where each item is also a dropdown: it shows the category's
 * person count and, when opened, lists those people. Picking one highlights and
 * scrolls to it on the tree.
 */
function TreeLegend({
  nodes,
  selectedKey,
  onPick,
}: {
  nodes: Placed[];
  selectedKey: string | null;
  onPick: (key: string) => void;
}) {
  const { t } = useTranslation();
  const [openStatus, setOpenStatus] = useState<NodeStatus | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const grouped = useMemo(() => {
    const g: Record<NodeStatus, Placed[]> = {
      match: [],
      minor: [],
      major: [],
      "master-only": [],
      "incoming-only": [],
    };
    for (const n of nodes) g[n.status].push(n);
    for (const s of LEGEND_ORDER) g[s].sort((a, b) => a.name.localeCompare(b.name));
    return g;
  }, [nodes]);

  // Close the open dropdown when clicking outside the legend.
  useEffect(() => {
    if (!openStatus) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenStatus(null);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openStatus]);

  return (
    <div className="tree-legend" ref={ref}>
      {LEGEND_ORDER.map((s) => {
        const people = grouped[s];
        const open = openStatus === s;
        return (
          <div key={s} className="tree-legend-item">
            <button
              className={`tree-legend-btn${open ? " open" : ""}`}
              disabled={people.length === 0}
              onClick={() => setOpenStatus(open ? null : s)}
            >
              <span className="tree-swatch" style={{ background: STATUS_COLOR[s] }} />
              {t(LEGEND_KEY[s])} ({people.length})
            </button>
            {open && (
              <ul className="tree-legend-list">
                {people.map((n) => (
                  <li key={n.key}>
                    <button
                      className={`tree-person${n.key === selectedKey ? " active" : ""}`}
                      onClick={() => {
                        onPick(n.key);
                        setOpenStatus(null);
                      }}
                    >
                      <span className="tree-swatch" style={{ background: STATUS_COLOR[n.status] }} />
                      <span className="tree-person-name">{n.name}</span>
                      {n.years && <span className="muted"> · {n.years}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Floating Master↔Incoming field table for the selected person (top-right). */
function NodeCompare({
  node,
  masterDs,
  compareDs,
  onClose,
}: {
  node: Placed;
  masterDs: Dataset;
  compareDs: Dataset;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(
    () => individualFieldRows(t, node.master, node.incoming, masterDs, compareDs),
    [t, node, masterDs, compareDs],
  );

  return (
    <div className="tree-compare">
      <div className="tree-compare-head">
        <span className="tree-swatch" style={{ background: STATUS_COLOR[node.status] }} />
        <span className="tree-compare-title">
          {node.name}
          {node.years && <span className="muted"> · {node.years}</span>}
        </span>
        <button className="tree-compare-close" onClick={onClose} title={t("tree.close")}>
          ×
        </button>
      </div>
      <table className="tree-compare-table">
        <thead>
          <tr>
            <th />
            <th>{t("tree.master")}</th>
            <th>{t("tree.incoming")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className={`field ${row.state}`}>
              <td className="f-label">{row.label}</td>
              <td className="f-val">{cell(row.master, row.masterLinks)}</td>
              <td className="f-val">{cell(row.incoming, row.incomingLinks)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Render a field value as link icons when it carries attached links, else text. */
function cell(text: string, links: string[] | undefined) {
  if (!links || links.length === 0) return text;
  return (
    <span className="links">
      {links.map((url, i) => (
        <a
          key={i}
          href={/^https?:\/\//i.test(url) ? url : `https://${url}`}
          target="_blank"
          rel="noopener noreferrer"
          className="link-icon"
          title={url}
        >
          🔗
        </a>
      ))}
    </span>
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

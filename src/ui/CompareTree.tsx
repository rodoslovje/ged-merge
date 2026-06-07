import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, Sex } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { individualFieldRows } from "../review/fields";
import { FieldValue } from "./FieldValue";
import { sexColorVar, sexGlyph } from "./sex";
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

/** Per-status colour, drawn from the Heritage Pine node tokens so it follows the
   theme. Used for the node border, legend swatches, and minimap dots. */
const STATUS_COLOR: Record<NodeStatus, string> = {
  match: "var(--node-match)",
  minor: "var(--node-minor)",
  major: "var(--node-major)",
  "master-only": "var(--node-master)",
  "incoming-only": "var(--node-incoming)",
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
  partners: Placed[];
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
  const rootYears = tree?.years ?? "";

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
          {rootName && (
            <span className="muted">
              {" · "}
              <span className="tree-compare-title">{rootName}</span>
              {rootYears && <span className="gm-data"> {rootYears}</span>}
            </span>
          )}
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
  edges: { id: string; d: string; partner?: boolean }[];
}

/** Collect every node plus its child and partner connectors from the laid-out tree. */
function flatten(root: Placed): Flat {
  const nodes: Placed[] = [];
  const edges: Flat["edges"] = [];
  (function walk(n: Placed) {
    nodes.push(n);
    // Spouses sit in the same column, chained directly below the person; each
    // union's children branch from that spouse.
    let prev: Placed = n;
    for (const p of n.partners) {
      nodes.push(p);
      edges.push({ id: `${prev.key}~${p.key}`, d: partnerPath(prev, p), partner: true });
      prev = p;
      for (const c of p.children) {
        edges.push({ id: `${p.key}->${c.key}`, d: edgePath(p, c) });
        walk(c);
      }
    }
    // Children of a spouseless family connect to the person directly.
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
          <path
            key={e.id}
            className={e.partner ? "tree-edge tree-edge-partner" : "tree-edge"}
            d={e.d}
          />
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
              fill="var(--panel)"
              stroke={STATUS_COLOR[n.status]}
              strokeWidth={2}
            />
            <SexDot sex={n.sex} x={16} y={NODE_H / 2} />
            <text className="tree-node-name" x={32} y={19}>
              {truncate(n.name, 24)}
            </text>
            {n.years && (
              <text className="tree-node-year gm-data" x={32} y={36}>
                {n.years}
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
              <td className="f-val gm-data"><FieldValue text={row.master} links={row.masterLinks} /></td>
              <td className="f-val gm-data"><FieldValue text={row.incoming} links={row.incomingLinks} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

/** A short vertical link between a person and their spouse (same column). */
function partnerPath(person: Placed, partner: Placed): string {
  const x = person.x + 18;
  return `M${x},${person.y + NODE_H} L${x},${partner.y}`;
}

/**
 * Left-to-right layered layout. Depth sets the column (x). A person and their
 * spouses are stacked in that column as a series of "anchors"; each anchor's own
 * children occupy the next column, so children sit beside the spouse they belong
 * to. Every anchor reserves `max(1, Σ child rows)` rows and is centred on its
 * children, so the whole person group spans the sum of its anchors' rows and no
 * two subtrees overlap.
 */
function layout(root: TreeNode): { root: Placed; width: number; height: number } {
  const groupMemo = new Map<TreeNode, number>();
  const anchorRows = (children: TreeNode[]): number =>
    Math.max(1, children.reduce((s, c) => s + groupRows(c), 0));
  const groupRows = (node: TreeNode): number => {
    const cached = groupMemo.get(node);
    if (cached != null) return cached;
    let total = anchorRows(node.children);
    for (const p of node.partners) total += anchorRows(p.children);
    const v = Math.max(1, total);
    groupMemo.set(node, v);
    return v;
  };

  // Place one anchor's children (in the next column) and return where the anchor
  // itself should sit, vertically centred on them.
  const placeAnchor = (
    anchorChildren: TreeNode[],
    depth: number,
    top: number,
  ): { y: number; children: Placed[]; band: number } => {
    const childRows = anchorChildren.reduce((s, c) => s + groupRows(c), 0);
    const band = Math.max(1, childRows);
    let cursor = top + ((band - childRows) / 2) * ROW_STEP;
    const children = anchorChildren.map((c) => {
      const placed = place(c, depth, cursor);
      cursor += groupRows(c) * ROW_STEP;
      return placed;
    });
    const y =
      children.length > 0
        ? Math.max(
            top,
            Math.min(
              (children[0].y + children[children.length - 1].y) / 2,
              top + (band - 1) * ROW_STEP,
            ),
          )
        : top;
    return { y, children, band };
  };

  const place = (node: TreeNode, depth: number, top: number): Placed => {
    const x = depth * COL_STEP;
    let cursor = top;
    const self = placeAnchor(node.children, depth + 1, cursor);
    cursor += self.band * ROW_STEP;
    const partners: Placed[] = node.partners.map((p) => {
      const a = placeAnchor(p.children, depth + 1, cursor);
      cursor += a.band * ROW_STEP;
      return { ...p, x, y: a.y, children: a.children, partners: [] };
    });
    return { ...node, x, y: self.y, children: self.children, partners };
  };

  const placed = place(root, 0, 0);
  const total = groupRows(root);
  return {
    root: placed,
    width: maxDepth(root) * COL_STEP + NODE_W + PAD * 2,
    height: (total - 1) * ROW_STEP + NODE_H + PAD * 2,
  };
}

/** Generations deep: spouses share the person's column, but their children don't. */
function maxDepth(node: TreeNode): number {
  const kids = [...node.children, ...node.partners.flatMap((p) => p.children)];
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map(maxDepth));
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** A small sex-coloured ♀/♂ disc shown at the left of a tree node. */
function SexDot({ sex, x, y }: { sex: Sex; x: number; y: number }) {
  const color = sexColorVar(sex);
  if (!color) return null;
  return (
    <g className="tree-sex" transform={`translate(${x},${y})`}>
      <circle r={9} fill={color} fillOpacity={0.16} />
      <text x={0} y={0.5} textAnchor="middle" dominantBaseline="central" fontSize={11} fill={color}>
        {sexGlyph(sex)}
      </text>
    </g>
  );
}

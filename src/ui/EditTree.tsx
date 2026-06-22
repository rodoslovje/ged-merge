import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { buildCompareTree, type TreeMode, type TreeNode } from "../tree/compareTree";
import { kinshipLabel } from "../match/kinship";
import { sexClass, sexColorVar } from "./sex";

// ─── Constants (identical to CompareTree so node sizes match) ─────────────────
const NODE_W = 184;
const NODE_H = 48;
const COL_GAP = 80;
const ROW_GAP = 18;
const COL_STEP = NODE_W + COL_GAP;
const ROW_STEP = NODE_H + ROW_GAP;
const PAD = 24;
const MINIMAP_MAX_W = 220;
const MINIMAP_MAX_H = 160;

// Color for unmodified nodes (master pine green) and modified (amber/minor).
const COLOR_NORMAL = "var(--node-master)";
const COLOR_MODIFIED = "var(--node-minor)";

// Empty compare-side dataset — the tree builder needs a valid Dataset object
// but won't find any incoming individuals since all Maps are empty.
const EMPTY_DS = {
  version: "unknown" as const,
  charset: "UTF-8" as const,
  individuals: new Map(),
  families: new Map(),
  records: [],
  warnings: [],
  eol: "\r\n",
  finalNewline: true,
} as Dataset;

const EMPTY_MAPS = {
  masterToCompare: new Map<string, string>(),
  compareToMaster: new Map<string, string>(),
};

// ─── Internal layout types ────────────────────────────────────────────────────

interface Placed extends TreeNode {
  x: number;
  y: number;
  children: Placed[];
  partners: Placed[];
}

interface Flat {
  nodes: Placed[];
  edges: { id: string; d: string; partner?: boolean }[];
}

interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  masterDs: Dataset;
  rootId: string;
  homeId?: string;
  changedPersonIds: Set<string>;
  onBack: () => void;
}

export function EditTree({ masterDs, rootId, homeId, changedPersonIds, onBack }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TreeMode>("ancestors");
  const [currentRootId, setCurrentRootId] = useState(rootId);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ left: 0, top: 0, width: 0, height: 0 });
  const [panning, setPanning] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number; id: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  const rootPerson = masterDs.individuals.get(currentRootId);

  const tree = useMemo(
    () => rootPerson
      ? buildCompareTree(t, rootPerson, undefined, masterDs, EMPTY_DS, EMPTY_MAPS, mode)
      : undefined,
    [t, rootPerson, masterDs, mode],
  );

  const laid = useMemo(() => (tree ? layout(tree) : undefined), [tree]);
  const flat = useMemo(() => (laid ? flatten(laid.root) : undefined), [laid]);

  const nodesByKey = useMemo(() => {
    const m = new Map<string, Placed>();
    for (const n of flat?.nodes ?? []) if (!m.has(n.key)) m.set(n.key, n);
    return m;
  }, [flat]);

  // Deselect when the tree changes (mode switch or reroot).
  useEffect(() => setSelectedKey(null), [laid]);

  const selected = selectedKey ? nodesByKey.get(selectedKey) : undefined;

  const isModified = useCallback(
    (n: Placed) => !!n.master && changedPersonIds.has(n.master.id),
    [changedPersonIds],
  );
  const colorOf = useCallback(
    (n: Placed) => isModified(n) ? COLOR_MODIFIED : COLOR_NORMAL,
    [isModified],
  );

  // ── Viewport sync & scroll ────────────────────────────────────────────────

  const syncViewport = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    setViewport({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight });
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (el && laid) {
      el.scrollLeft = Math.max(0, laid.root.x);
      el.scrollTop = Math.max(0, laid.root.y + PAD + NODE_H / 2 - el.clientHeight / 2);
    }
    syncViewport();
  }, [laid, syncViewport]);

  useEffect(() => {
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, [syncViewport]);

  const scrollTo = useCallback((left: number, top: number) => {
    const el = canvasRef.current;
    if (!el) return;
    el.scrollLeft = left;
    el.scrollTop = top;
  }, []);

  // ── Pan handling ──────────────────────────────────────────────────────────

  const onPanStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    const el = canvasRef.current;
    if (!el) return;
    pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, id: e.pointerId, moved: false };
  }, []);

  const onPanMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    const el = canvasRef.current;
    if (!p || !el) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved) {
      if (Math.hypot(dx, dy) < 4) return;
      p.moved = true;
      el.setPointerCapture(p.id);
      setPanning(true);
    }
    el.scrollLeft = p.left - dx;
    el.scrollTop = p.top - dy;
  }, []);

  const onPanEnd = useCallback(() => {
    const p = pan.current;
    const el = canvasRef.current;
    if (!p) return;
    if (p.moved) {
      dragged.current = true;
      if (el?.hasPointerCapture(p.id)) el.releasePointerCapture(p.id);
      setPanning(false);
    }
    pan.current = null;
  }, []);

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (dragged.current) { e.stopPropagation(); dragged.current = false; }
  }, []);

  // ── Selection with auto-scroll ────────────────────────────────────────────

  function selectNode(key: string) {
    if (key === selectedKey) { setSelectedKey(null); return; }
    setSelectedKey(key);
    const n = nodesByKey.get(key);
    const el = canvasRef.current;
    if (!n || !el) return;
    el.scrollLeft = n.x + PAD + NODE_W / 2 - el.clientWidth / 2;
    el.scrollTop = n.y + PAD + NODE_H / 2 - el.clientHeight / 2;
  }

  // ── Derived counts for legend ─────────────────────────────────────────────

  const allNodes = flat?.nodes ?? [];
  const modifiedCount = allNodes.filter((n) => isModified(n)).length;
  const totalCount = allNodes.length;

  const needsMinimap =
    !!laid && viewport.width > 0 &&
    (laid.width > viewport.width + 1 || laid.height > viewport.height + 1);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="tree-page">
      <div className="tree-toolbar">
        <button className="tree-open-btn" onClick={onBack}>
          ← {t("edit.tree.back")}
        </button>
        <h2 className="tree-title">
          {t("edit.tree.title")}
          {tree && (
            <span className="tree-title-person">
              <span className="muted">{" · "}</span>
              <span className={`tree-title-name ${rootPerson ? sexClass(rootPerson.sex) : ""}`}>
                {tree.name}
              </span>
              {tree.years && <span className="tree-title-years gm-data">{tree.years}</span>}
            </span>
          )}
        </h2>
        <div className="tree-mode">
          <button className={mode === "ancestors" ? "active" : ""} onClick={() => setMode("ancestors")}>
            {t("tree.ancestors")}
          </button>
          <button className={mode === "descendants" ? "active" : ""} onClick={() => setMode("descendants")}>
            {t("tree.descendants")}
          </button>
        </div>
      </div>

      {/* Legend: two static items — unmodified and modified counts */}
      <div className="tree-legend">
        <div className="tree-legend-item">
          <span className="tree-legend-btn">
            <span className="tree-swatch" style={{ background: COLOR_NORMAL }} />
            {t("edit.tree.unmodified")} ({totalCount - modifiedCount})
          </span>
        </div>
        <div className="tree-legend-item">
          <span className="tree-legend-btn">
            <span className="tree-swatch" style={{ background: COLOR_MODIFIED }} />
            {t("edit.tree.modified")} ({modifiedCount})
          </span>
        </div>
      </div>

      <div className="tree-canvas-wrap">
        <div
          className={`tree-canvas${panning ? " panning" : ""}`}
          ref={canvasRef}
          onScroll={syncViewport}
          onPointerDown={onPanStart}
          onPointerMove={onPanMove}
          onPointerUp={onPanEnd}
          onPointerCancel={onPanEnd}
          onClickCapture={onClickCapture}
        >
          {laid && flat ? (
            <svg className="tree-svg" width={laid.width} height={laid.height} role="img">
              <g transform={`translate(${PAD},${PAD})`}>
                {flat.edges.map((e) => (
                  <path
                    key={e.id}
                    className={e.partner ? "tree-edge tree-edge-partner" : "tree-edge"}
                    d={e.d}
                  />
                ))}
                {flat.nodes.map((n) => {
                  const color = colorOf(n);
                  const modified = isModified(n);
                  return (
                    <g
                      key={n.key}
                      transform={`translate(${n.x},${n.y})`}
                      className={`tree-node${n.key === selectedKey ? " selected" : ""}`}
                      onClick={() => selectNode(n.key)}
                    >
                      <title>{n.name}{n.years ? ` · ${n.years}` : ""}</title>
                      <rect
                        width={NODE_W}
                        height={NODE_H}
                        rx={10}
                        ry={10}
                        fill={`color-mix(in srgb, ${color} 16%, var(--panel))`}
                        stroke={color}
                        strokeWidth={2.5}
                      />
                      <text
                        className="tree-node-name"
                        x={16}
                        y={19}
                        style={{ fill: sexColorVar(n.sex) ?? "#fff" }}
                      >
                        {truncate(n.name, 24)}
                      </text>
                      {(() => {
                        const k = homeId && n.master?.id ? kinshipLabel(masterDs, homeId, n.master.id, t) : undefined;
                        // Estimate pixel widths (years: ~6.5px/char at 11px; kinship: ~5.5px/char
                        // at 10px; modified badge: a fixed ~22px once it sits next to the years label).
                        const decW = modified ? 22 : 0;
                        const needsKinshipRow = !!(k && (n.years || modified) && (n.years?.length ?? 0) * 13 + decW + k.length * 11 > 300);
                        const yearsRowY = needsKinshipRow ? 32 : 36;
                        const decBadgeX = 16 + (n.years ? n.years.length * 6.5 + 8 : 0) + 7;
                        return (
                          <>
                            {n.years && (
                              <text className="tree-node-year gm-data" x={16} y={yearsRowY}>
                                {n.years}
                              </text>
                            )}
                            {k && (
                              <text className="tree-node-kinship gm-data" x={NODE_W - 8} y={needsKinshipRow ? 44 : 36} textAnchor="end">
                                {k}
                              </text>
                            )}
                            {modified && (
                              <g className="tree-node-decision" transform={`translate(${decBadgeX},${yearsRowY - 4})`}>
                                <circle r={7} fill={COLOR_MODIFIED} />
                                <text
                                  textAnchor="middle"
                                  dominantBaseline="central"
                                  x={0}
                                  y={0.5}
                                  fontSize={9}
                                  fontWeight={700}
                                  fill="var(--bg)"
                                >
                                  M
                                </text>
                              </g>
                            )}
                          </>
                        );
                      })()}
                    </g>
                  );
                })}
              </g>
            </svg>
          ) : (
            <p className="muted">{t("tree.empty")}</p>
          )}
        </div>

        {needsMinimap && laid && flat && (
          <EditMinimap
            nodes={flat.nodes}
            contentW={laid.width}
            contentH={laid.height}
            viewport={viewport}
            onScrollTo={scrollTo}
            colorOf={colorOf}
          />
        )}

        {selected && selected.master && (
          <EditNodePanel
            node={selected}
            isModified={isModified(selected)}
            onReroot={() => {
              setCurrentRootId(selected.master!.id);
              setSelectedKey(null);
            }}
            onClose={() => setSelectedKey(null)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Minimap ──────────────────────────────────────────────────────────────────

function EditMinimap({
  nodes,
  contentW,
  contentH,
  viewport,
  onScrollTo,
  colorOf,
}: {
  nodes: Placed[];
  contentW: number;
  contentH: number;
  viewport: Viewport;
  onScrollTo: (left: number, top: number) => void;
  colorOf: (n: Placed) => string;
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
          fill={colorOf(n)}
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

// ─── Node detail panel ────────────────────────────────────────────────────────

function EditNodePanel({
  node,
  isModified,
  onReroot,
  onClose,
}: {
  node: Placed;
  isModified: boolean;
  onReroot: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const color = isModified ? COLOR_MODIFIED : COLOR_NORMAL;
  return (
    <div className="tree-compare">
      <div className="tree-compare-head">
        <span className="tree-swatch" style={{ background: color }} />
        <span className={`tree-compare-title ${sexClass(node.sex)}`}>
          {node.name}
          {node.years && <span className="muted" style={{ fontWeight: 400 }}> · {node.years}</span>}
        </span>
        <button className="tree-compare-close" onClick={onClose} title={t("tree.close")}>×</button>
      </div>
      <div style={{ padding: "8px 12px", display: "flex", gap: "8px", alignItems: "center" }}>
        {isModified && (
          <span className="edit-tree-badge">{t("edit.tree.modified")}</span>
        )}
        <button
          className="nav-btn"
          style={{ marginLeft: isModified ? "auto" : 0 }}
          onClick={onReroot}
        >
          {t("edit.tree.reroot")}
        </button>
      </div>
    </div>
  );
}

// ─── Layout helpers (mirrors CompareTree's private layout functions) ───────────

function flatten(root: Placed): Flat {
  const nodes: Placed[] = [];
  const edges: Flat["edges"] = [];
  (function walk(n: Placed) {
    nodes.push(n);
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
    for (const c of n.children) {
      edges.push({ id: `${n.key}->${c.key}`, d: edgePath(n, c) });
      walk(c);
    }
  })(root);
  return { nodes, edges };
}

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

function maxDepth(node: TreeNode): number {
  const kids = [...node.children, ...node.partners.flatMap((p) => p.children)];
  return kids.length === 0 ? 0 : 1 + Math.max(...kids.map(maxDepth));
}

function edgePath(parent: Placed, child: Placed): string {
  const x1 = parent.x + NODE_W;
  const y1 = parent.y + NODE_H / 2;
  const x2 = child.x;
  const y2 = child.y + NODE_H / 2;
  const mx = (x1 + x2) / 2;
  return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
}

function partnerPath(person: Placed, partner: Placed): string {
  const x = person.x + 18;
  return `M${x},${person.y + NODE_H} L${x},${partner.y}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

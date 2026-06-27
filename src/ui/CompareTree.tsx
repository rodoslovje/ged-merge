import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GedNode } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { individualFieldRows } from "../review/fields";
import { decisionKey, importKey, type CandidateDecision, type ImportDirection, type MatchDecisionStatus } from "../review/types";
import { ReadOnlyCompare } from "./ReadOnlyCompare";
import { kinshipLabel } from "../match/kinship";
import { sexClass, sexColorVar } from "./sex";
import {
  buildCompareTree,
  buildMatchMaps,
  countImportable,
  countTreePeople,
  type MatchMaps,
  type NodeStatus,
  type TreeMode,
  type TreeNode,
} from "../tree/compareTree";
import { TreeNodePhoto } from "./PersonPhotos";
import type { PhotoRefContext } from "./PhotoViewer";
import { useMediaFolder } from "./MediaFolderContext";
import { MapIcon } from "./icons/MapIcon";

interface Props {
  masterDs: Dataset;
  compareDs: Dataset;
  matches: MatchResult;
  rootMasterId?: string;
  rootCompareId?: string;
  mode: TreeMode;
  onModeChange: (mode: TreeMode) => void;
  /** Re-root the tree on another person (clicked from a node's relative links). */
  onReroot: (masterId?: string, compareId?: string) => void;
  onBack: () => void;
  /** Leave the tree and open this match pair back in the Matches list. */
  onShowInMatches: (masterId: string, compareId: string) => void;
  /** Decisions by pair key, so matched nodes can show + set their status. */
  decisions: Map<string, CandidateDecision>;
  /** Toggle a matched node's decision status (confirm / reject / defer). */
  onDecide: (masterId: string, compareId: string, status: MatchDecisionStatus) => void;
  /** Keys (`importKey(direction, incomingId)`) of incoming branches marked to graft on save. */
  importBranches: Set<string>;
  /** Toggle "bring in this incoming person's ancestors/descendants on save". */
  onToggleImport: (direction: ImportDirection, incomingId: string) => void;
  /** Home person ID in the master dataset, used to show kinship labels on nodes. */
  homeId?: string;
}

/** The three actionable decisions, in button order. */
const DECISION_STATUSES: Exclude<MatchDecisionStatus, "undecided">[] = [
  "confirmed",
  "rejected",
  "deferred",
];

const NODE_W = 220;
// Box height matches the Edit-mode person card (a ~46px photo + padding).
const NODE_H = 56;
const PHOTO_SIZE = 46;
// Photo sits on the left, vertically centred.
const PHOTO_X = 5;
const PHOTO_Y = (NODE_H - PHOTO_SIZE) / 2;
// Text begins right of the photo column when a media folder is loaded (photos
// then occupy the reserved space); otherwise it starts at the left padding.
const TEXT_X_PHOTO = PHOTO_X + PHOTO_SIZE + 8;
const TEXT_X_PLAIN = 16;
const COL_GAP = 80;
const ROW_GAP = 18;
const COL_STEP = NODE_W + COL_GAP;
const ROW_STEP = NODE_H + ROW_GAP;
const PAD = 24;

/** Maximum minimap extent (px); the tree is scaled to fit within this box. */
const MINIMAP_MAX_W = 240;
const MINIMAP_MAX_H = 280;
/** How far each axis may stretch past the uniform scale. Pure uniform scaling
   collapses an extreme aspect-ratio tree (e.g. a deep descendants chart that is
   very tall but only a few generations wide) into a useless sliver; allowing a
   bounded per-axis stretch keeps the minimap usable while ordinary balanced
   trees stay close to proportional. */
const MINIMAP_MAX_STRETCH = 6;

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
  onReroot,
  onBack,
  onShowInMatches,
  decisions,
  onDecide,
  importBranches,
  onToggleImport,
  homeId,
}: Props) {
  const { t } = useTranslation();

  // A matched node (both sides present) carries a decision; resolve its status
  // and localized letter for the badge next to its lifespan. The badge's colour
  // comes from CSS (`.status-chip.<status>`), matching the same chip used in
  // Edit and Merge. Undecided → no badge.
  const decisionOf = useCallback(
    (n: Placed): { status: Exclude<MatchDecisionStatus, "undecided">; letter: string } | undefined => {
      if (!n.master || !n.incoming) return undefined;
      const d = decisions.get(decisionKey("individual", n.master.id, n.incoming.id));
      if (!d || d.status === "undecided") return undefined;
      return {
        status: d.status,
        letter: t(`status.${d.status}`).charAt(0).toUpperCase(),
      };
    },
    [decisions, t],
  );

  const kinshipOf = useCallback(
    (n: Placed): string | undefined => {
      if (!homeId || !n.master) return undefined;
      return kinshipLabel(masterDs, homeId, n.master.id, t) ?? undefined;
    },
    [homeId, masterDs, t],
  );

  // A photo's "referenced by" link re-roots the tree on that person, on the
  // side (master/compare) the photo came from.
  const masterRefCtx = useMemo(
    () => ({ dataset: masterDs, onNavigate: (id: string) => onReroot(id, undefined) }),
    [masterDs, onReroot],
  );
  const compareRefCtx = useMemo(
    () => ({ dataset: compareDs, onNavigate: (id: string) => onReroot(undefined, id) }),
    [compareDs, onReroot],
  );

  const rootMaster = rootMasterId ? masterDs.individuals.get(rootMasterId) : undefined;
  const rootIncoming = rootCompareId ? compareDs.individuals.get(rootCompareId) : undefined;

  const maps = useMemo(() => buildMatchMaps(matches), [matches]);

  // A rejected pairing prunes the incoming side from the tree (see
  // buildCompareTree): the two records are declared different people.
  const isRejected = useCallback(
    (masterId: string, compareId: string) =>
      decisions.get(decisionKey("individual", masterId, compareId))?.status === "rejected",
    [decisions],
  );

  const tree = useMemo(
    () => buildCompareTree(t, rootMaster, rootIncoming, masterDs, compareDs, maps, mode, isRejected),
    [t, rootMaster, rootIncoming, masterDs, compareDs, maps, mode, isRejected],
  );

  // Incoming-only people each direction could graft, shown on the mode buttons —
  // the same counts the Compare Tree button surfaces in Merge mode. Built for
  // both directions (independent of the current mode) so switching reflects them.
  const { importCounts, peopleCounts } = useMemo(() => {
    const ancestors = buildCompareTree(t, rootMaster, rootIncoming, masterDs, compareDs, maps, "ancestors", isRejected);
    const descendants = buildCompareTree(t, rootMaster, rootIncoming, masterDs, compareDs, maps, "descendants", isRejected);
    return {
      importCounts: {
        ancestors: ancestors ? countImportable(ancestors) : 0,
        descendants: descendants ? countImportable(descendants) : 0,
      },
      peopleCounts: {
        ancestors: countTreePeople(ancestors),
        descendants: countTreePeople(descendants),
      },
    };
  }, [t, rootMaster, rootIncoming, masterDs, compareDs, maps, isRejected]);

  const laid = useMemo(() => (tree ? layout(tree) : undefined), [tree]);
  const flat = useMemo(() => (laid ? flatten(laid.root) : undefined), [laid]);

  // Keys of incoming-only nodes that an active "import ancestors/descendants"
  // branch would bring in as new records: a node is covered once it, or any of
  // its render-tree ancestors, has its import toggled on for the current mode.
  // The rendered tree is exactly the graft direction, so coverage = subtree.
  const willImport = useMemo(() => {
    const set = new Set<string>();
    if (!laid) return set;
    const isAnchor = (n: Placed) => !!n.incoming && importBranches.has(importKey(mode, n.incoming.id));
    (function walk(n: Placed, covered: boolean) {
      const active = covered || isAnchor(n);
      if (active && n.status === "incoming-only") set.add(n.key);
      for (const p of n.partners) {
        const pActive = active || isAnchor(p);
        if (pActive && p.status === "incoming-only") set.add(p.key);
        for (const c of p.children) walk(c, pActive);
      }
      for (const c of n.children) walk(c, active);
    })(laid.root, false);
    return set;
  }, [laid, importBranches, mode]);

  // The badge a node shows next to its lifespan: a decided match's C/D/R, or "I"
  // (Incoming) for an incoming-only person an active graft will bring in.
  const badgeOf = useCallback(
    (n: Placed): { status: string; letter: string } | undefined => {
      const dec = decisionOf(n);
      if (dec) return dec;
      if (n.status === "incoming-only" && willImport.has(n.key)) {
        return { status: "incoming", letter: t("status.incoming").charAt(0).toUpperCase() };
      }
      return undefined;
    },
    [decisionOf, willImport, t],
  );

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
  const [mapOpen, setMapOpen] = useState(true);

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

  // On (re)layout — initial load and mode switches — scroll so the starting
  // person (the tree root) is in view: pinned to the left, vertically centred.
  // Then re-measure for the minimap.
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

  // Grab-to-pan with mouse / touchpad. Touch keeps the browser's native
  // one-finger scroll (with momentum), so we ignore touch pointers here.
  // We only capture the pointer *after* movement crosses a threshold — capturing
  // on pointerdown would retarget the click off the node and break selection.
  const pan = useRef<{ x: number; y: number; left: number; top: number; id: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const [panning, setPanning] = useState(false);

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
      if (Math.hypot(dx, dy) < 4) return; // ignore jitter, keep clicks clickable
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
      dragged.current = true; // swallow the click that the drag would emit
      if (el?.hasPointerCapture(p.id)) el.releasePointerCapture(p.id);
      setPanning(false);
    }
    pan.current = null;
  }, []);

  // After a pan, cancel the trailing click so dragging doesn't select a node.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (dragged.current) {
      e.stopPropagation();
      dragged.current = false;
    }
  }, []);

  const needsMinimap =
    !!laid &&
    viewport.width > 0 &&
    (laid.width > viewport.width + 1 || laid.height > viewport.height + 1);

  return (
    <div className="tree-page">
      <div className="tree-toolbar">
        <button className="tree-open-btn" onClick={onBack}>
          ← {t("tree.back")}
        </button>
        <h2 className="tree-title">
          {rootName ? (
            <>
              <span className={`tree-title-name ${sexClass(tree?.sex ?? "U")}`}>{rootName}</span>
              {rootYears && <span className="tree-title-years gm-data">{rootYears}</span>}
              <span className="tree-title-kind">{t("tree.title")}</span>
            </>
          ) : (
            t("tree.title")
          )}
        </h2>
      </div>

      <div className="tree-controls">
        <div className="tree-mode">
          <button
            className={mode === "ancestors" ? "active" : ""}
            onClick={() => onModeChange("ancestors")}
          >
            {t("tree.ancestors")}
            <span className="tree-mode-count">{peopleCounts.ancestors}</span>
            {importCounts.ancestors > 0 && (
              <span className="tree-import-count">▲{importCounts.ancestors}</span>
            )}
          </button>
          <button
            className={mode === "descendants" ? "active" : ""}
            onClick={() => onModeChange("descendants")}
          >
            {t("tree.descendants")}
            <span className="tree-mode-count">{peopleCounts.descendants}</span>
            {importCounts.descendants > 0 && (
              <span className="tree-import-count">▼{importCounts.descendants}</span>
            )}
          </button>
        </div>
        <TreeLegend nodes={flat?.nodes ?? []} selectedKey={selectedKey} onPick={selectNode} />
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
            <TreeSvg
              flat={flat}
              width={laid.width}
              height={laid.height}
              selectedKey={selectedKey}
              onSelect={setSelectedKey}
              decisionOf={badgeOf}
              kinshipOf={kinshipOf}
              masterRecords={masterDs.records}
              compareRecords={compareDs.records}
              masterRefCtx={masterRefCtx}
              compareRefCtx={compareRefCtx}
            />
          ) : (
            <p className="muted">{t("tree.empty")}</p>
          )}
        </div>
        {needsMinimap && laid && flat && (
          mapOpen ? (
            <div className="tree-minimap-box">
              <button
                className="tree-minimap-collapse"
                onClick={() => setMapOpen(false)}
                title={t("tree.minimap.hide")}
                aria-label={t("tree.minimap.hide")}
              >
                ×
              </button>
              <Minimap
                nodes={flat.nodes}
                contentW={laid.width}
                contentH={laid.height}
                viewport={viewport}
                onScrollTo={scrollTo}
              />
            </div>
          ) : (
            <button
              className="tree-minimap-show"
              onClick={() => setMapOpen(true)}
              title={t("tree.minimap.show")}
              aria-label={t("tree.minimap.show")}
            >
              <MapIcon />
            </button>
          )
        )}
        {selected && (
          <NodeCompare
            node={selected}
            masterDs={masterDs}
            compareDs={compareDs}
            maps={maps}
            mode={mode}
            importActive={!!selected.incoming && importBranches.has(importKey(mode, selected.incoming.id))}
            onToggleImport={onToggleImport}
            onReroot={onReroot}
            onClose={() => setSelectedKey(null)}
            onShowInMatches={onShowInMatches}
            decision={
              selected.master && selected.incoming
                ? decisions.get(decisionKey("individual", selected.master.id, selected.incoming.id))
                : undefined
            }
            onDecide={(status) => {
              if (selected.master && selected.incoming) {
                onDecide(selected.master.id, selected.incoming.id, status);
              }
            }}
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
  decisionOf,
  kinshipOf,
  masterRecords,
  compareRecords,
  masterRefCtx,
  compareRefCtx,
}: {
  flat: Flat;
  width: number;
  height: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  decisionOf: (n: Placed) => { status: string; letter: string } | undefined;
  kinshipOf: (n: Placed) => string | undefined;
  masterRecords: GedNode[];
  compareRecords: GedNode[];
  masterRefCtx: PhotoRefContext;
  compareRefCtx: PhotoRefContext;
}) {
  const { nodes, edges } = flat;
  const { folderName } = useMediaFolder();
  const textX = folderName ? TEXT_X_PHOTO : TEXT_X_PLAIN;
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
        {nodes.map((n) => {
          const dec = decisionOf(n);
          const kinship = kinshipOf(n);
          // Estimate pixel widths (years: ~6.5px/char at 11px; kinship: ~5.5px/char at 10px;
          // decision badge: a fixed ~22px once the years label has a badge next to it).
          // If they'd overflow the 160px gap, stack kinship on a separate third row.
          const decW = dec ? 22 : 0;
          const needsKinshipRow = !!(kinship && (n.years || dec) && (n.years?.length ?? 0) * 13 + decW + kinship.length * 11 > 300);
          const yearsRowY = needsKinshipRow ? 36 : 40;
          const decBadgeX = textX + (n.years ? n.years.length * 6.5 + 8 : 0) + 7;
          return (
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
                fill={`color-mix(in srgb, ${STATUS_COLOR[n.status]} 16%, var(--panel))`}
                stroke={STATUS_COLOR[n.status]}
                strokeWidth={2.5}
              />
              <text
                className="tree-node-name"
                x={textX}
                y={23}
                style={{ fill: sexColorVar(n.sex) ?? "#fff" }}
              >
                {truncate(n.name, 24)}
              </text>
              {n.years && (
                <text className="tree-node-year gm-data" x={textX} y={yearsRowY}>
                  {n.years}
                </text>
              )}
              {kinship && (
                <text className="tree-node-kinship gm-data" x={NODE_W - 8} y={needsKinshipRow ? 48 : 40} textAnchor="end">
                  {kinship}
                </text>
              )}
              {/* Decision badge next to the lifespan (matched, decided nodes) — same
                  colours as the status chip used in Edit and Merge. */}
              {dec && (
                <g className={`tree-node-decision ${dec.status}`} transform={`translate(${decBadgeX},${yearsRowY - 4})`}>
                  <circle r={7} />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    x={0}
                    y={0.5}
                    fontSize={9}
                    fontWeight={700}
                  >
                    {dec.letter}
                  </text>
                </g>
              )}
              <TreeNodePhoto
                node={n}
                masterRecords={masterRecords}
                compareRecords={compareRecords}
                masterRefCtx={masterRefCtx}
                compareRefCtx={compareRefCtx}
                x={PHOTO_X}
                y={PHOTO_Y}
                size={PHOTO_SIZE}
              />
            </g>
          );
        })}
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
  // Independent per-axis scale, each bounded to MINIMAP_MAX_STRETCH × the
  // uniform fit so an extreme aspect ratio can't collapse one axis to a sliver.
  const fitX = MINIMAP_MAX_W / contentW;
  const fitY = MINIMAP_MAX_H / contentH;
  const uniform = Math.min(fitX, fitY);
  const sx = Math.min(fitX, uniform * MINIMAP_MAX_STRETCH);
  const sy = Math.min(fitY, uniform * MINIMAP_MAX_STRETCH);
  const w = contentW * sx;
  const h = contentH * sy;

  const recentre = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / sx;
    const y = (e.clientY - rect.top) / sy;
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
          x={(n.x + PAD) * sx}
          y={(n.y + PAD) * sy}
          width={Math.max(1, NODE_W * sx)}
          height={Math.max(1, NODE_H * sy)}
          rx={1}
          fill={STATUS_COLOR[n.status]}
        />
      ))}
      <rect
        className="tree-minimap-viewport"
        x={viewport.left * sx}
        y={viewport.top * sy}
        width={viewport.width * sx}
        height={viewport.height * sy}
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
  maps,
  mode,
  importActive,
  onToggleImport,
  onReroot,
  onClose,
  onShowInMatches,
  decision,
  onDecide,
}: {
  node: Placed;
  masterDs: Dataset;
  compareDs: Dataset;
  maps: MatchMaps;
  mode: TreeMode;
  importActive: boolean;
  onToggleImport: (direction: ImportDirection, incomingId: string) => void;
  onReroot: (masterId?: string, compareId?: string) => void;
  onClose: () => void;
  onShowInMatches: (masterId: string, compareId: string) => void;
  decision: CandidateDecision | undefined;
  onDecide: (status: MatchDecisionStatus) => void;
}) {
  const { t } = useTranslation();
  // Both sides present → an actionable match the user can confirm/reject/defer.
  const decidable = !!node.master && !!node.incoming;
  const status = decision?.status ?? "undecided";
  // Anything with an incoming side has a subtree we can graft in the current
  // tree direction (ancestors or descendants of this person). The subtree shown
  // under this node *is* what the import would bring, so count its incoming-only
  // people up front — the number a "bring …" import would add as new records.
  const importableId = node.incoming?.id;
  const importCount = useMemo(() => countImportable(node), [node]);
  const rows = useMemo(
    () => individualFieldRows(t, node.master, node.incoming, masterDs, compareDs),
    [t, node, masterDs, compareDs],
  );

  // Any displayed relative can be re-rooted on; resolve the matched counterpart
  // so the new tree shows both sides where a match exists.
  const masterPerson = {
    linkable: () => true,
    onNavigate: (id: string) => onReroot(id, maps.masterToCompare.get(id)),
  };
  const incomingPerson = {
    linkable: () => true,
    onNavigate: (id: string) => onReroot(maps.compareToMaster.get(id), id),
  };

  // When both sides are present the pair is a real candidate in the match list,
  // so the title doubles as a link that opens it back in the Matches view.
  const matchLink = decidable && node.master && node.incoming
    ? () => onShowInMatches(node.master!.id, node.incoming!.id)
    : undefined;

  const titleContent = (
    <>
      <span className={`tree-compare-name ${sexClass(node.sex)}`}>{node.name}</span>
      {node.years && <span className="tree-compare-years gm-data">{node.years}</span>}
    </>
  );

  return (
    <div className="tree-compare">
      <div className="tree-compare-head">
        <span className="tree-swatch" style={{ background: STATUS_COLOR[node.status] }} />
        {matchLink ? (
          <button className="tree-compare-title tree-compare-title-link" onClick={matchLink} title={t("tree.openInMatches")}>
            {titleContent}
          </button>
        ) : (
          <span className="tree-compare-title">{titleContent}</span>
        )}
        <button className="tree-compare-close" onClick={onClose} title={t("tree.close")}>
          ×
        </button>
      </div>
      {decidable && (
        <div className="tree-compare-decisions decision-bar">
          {DECISION_STATUSES.map((s) => (
            <button
              key={s}
              className={status === s ? `decision ${s} active` : "decision"}
              onClick={() => onDecide(s)}
            >
              {t(`status.${s}`)}
            </button>
          ))}
        </div>
      )}
      {importableId && (importCount > 0 || importActive) && (
        <div className="tree-compare-import">
          <button
            className={`tree-import-btn${importActive ? " active" : ""}`}
            onClick={() => onToggleImport(mode, importableId)}
            title={t(`tree.import.${mode}.title`)}
          >
            {t(`tree.import.${mode}${importActive ? ".active" : ""}`)} ({importCount})
          </button>
        </div>
      )}
      <div className="tree-compare-body">
        <ReadOnlyCompare
          rows={rows}
          masterPerson={masterPerson}
          incomingPerson={incomingPerson}
          masterLabel={t("tree.master")}
          incomingLabel={t("tree.incoming")}
        />
      </div>
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

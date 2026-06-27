import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GedNode } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { individualFieldRows } from "../review/fields";
import { decisionKey, importKey, type CandidateDecision, type ImportDirection, type MatchDecisionStatus } from "../review/types";
import { TreeNodePanel } from "./TreeNodePanel";
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
} from "../tree/compareTree";
import {
  NODE_H,
  NODE_W,
  PAD,
  PHOTO_SIZE,
  PHOTO_X,
  PHOTO_Y,
  TEXT_X_PHOTO,
  TEXT_X_PLAIN,
  flatten,
  layout,
  truncate,
  type Flat,
  type Placed,
} from "../tree/treeLayout";
import { useTreeCanvas } from "../tree/useTreeCanvas";
import { TreeMinimap } from "./TreeMinimap";
import { TreeNodePhoto } from "./PersonPhotos";
import type { PhotoRefContext } from "./PhotoViewer";
import { useMediaFolder } from "./MediaFolderContext";
import { MapIcon } from "./icons/MapIcon";
import { diagramSlug, exportCanvasPdf, exportCanvasSvg } from "./exportSvg";
import { DownloadIcon } from "./icons/DownloadIcon";

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
  /** Master ids with unsaved edits — those nodes show an "M" badge. */
  changedPersonIds: Set<string>;
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
  changedPersonIds,
  onDecide,
  importBranches,
  onToggleImport,
  homeId,
}: Props) {
  const { t } = useTranslation();

  // A node whose master record has unsaved edits gets an "M" badge, matching the
  // Edit tree and relative cards.
  const isModified = useCallback(
    (n: Placed): boolean => !!n.master && changedPersonIds.has(n.master.id),
    [changedPersonIds],
  );

  // A matched node (both sides present) carries a decision; resolve its status
  // and localized letter for the badge next to its lifespan. The badge's colour
  // comes from CSS (`.status-chip.<status>`), matching the same chip used in
  // Edit and Merge. Undecided → no badge.
  const decisionOf = useCallback(
    (n: Placed): { status: Exclude<MatchDecisionStatus, "undecided">; letter: string } | undefined => {
      // A rejected pairing prunes the incoming side from the tree, so the root
      // node would lose its `incoming` — fall back to the root compare id (the
      // pair the tree was opened on) so the decided root still shows its badge.
      const compareId = n.incoming?.id ?? (n.master?.id === rootMasterId ? rootCompareId : undefined);
      if (!n.master || !compareId) return undefined;
      const d = decisions.get(decisionKey("individual", n.master.id, compareId));
      if (!d || d.status === "undecided") return undefined;
      return {
        status: d.status,
        letter: t(`status.${d.status}`).charAt(0).toUpperCase(),
      };
    },
    [decisions, t, rootMasterId, rootCompareId],
  );

  // The root pair's decision drives the C/D/R chip in the title — looked up from
  // the props ids directly so it survives the rejection pruning above.
  const rootStatus =
    rootMasterId && rootCompareId
      ? decisions.get(decisionKey("individual", rootMasterId, rootCompareId))?.status
      : undefined;

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
  // Root person's kinship to the home person, shown in the title.
  const rootKinship = homeId && rootMasterId ? kinshipLabel(masterDs, homeId, rootMasterId, t) : undefined;
  // Shared title for the SVG / PDF export header.
  const compareTreeTitle = [rootName, rootYears, "—", t("tree.title")].filter(Boolean).join(" ");

  const nodesByKey = useMemo(() => {
    const map = new Map<string, Placed>();
    for (const n of flat?.nodes ?? []) if (!map.has(n.key)) map.set(n.key, n);
    return map;
  }, [flat]);

  const [mapOpen, setMapOpen] = useState(true);

  // Viewport, grab-to-pan, root re-centring, and node selection.
  const { canvasRef, viewport, panning, scrollTo, canvasProps, selectedKey, setSelectedKey, selected, selectNode } =
    useTreeCanvas(laid, nodesByKey);

  const needsMinimap =
    !!laid &&
    viewport.width > 0 &&
    (laid.width > viewport.width + 1 || laid.height > viewport.height + 1);

  return (
    <div className="tree-page">
      <div className="tree-toolbar">
        <button className="tree-open-btn tree-back-btn" onClick={onBack} title={t("tree.back")} aria-label={t("tree.back")}>
          ← <span className="tree-back-label">{t("tree.back")}</span>
        </button>
        <h2 className="tree-title">
          {rootName ? (
            <>
              <span className={`tree-title-name ${sexClass(tree?.sex ?? "U")}`}>{rootName}</span>
              {rootYears && <span className="tree-title-years gm-data">{rootYears}</span>}
              <span className="tree-title-break" aria-hidden="true" />
              {rootKinship && <span className="tree-title-kinship">{rootKinship}</span>}
              {rootStatus && rootStatus !== "undecided" && (
                <span className={`status-chip ${rootStatus}`} title={t(`status.${rootStatus}`)}>
                  {t(`status.${rootStatus}`).charAt(0)}
                </span>
              )}
              <span className="tree-title-kind">{t("tree.title")}</span>
            </>
          ) : (
            t("tree.title")
          )}
        </h2>
        <button
          className="tree-open-btn tree-export-btn"
          onClick={() => exportCanvasSvg(canvasRef.current, diagramSlug(rootName, "compare-tree"), compareTreeTitle)}
          disabled={!laid}
          title={t("tree.export.tooltip")}
        >
          <DownloadIcon /> {t("tree.export")}
        </button>
        <button
          className="tree-open-btn tree-export-btn"
          onClick={() => exportCanvasPdf(canvasRef.current, compareTreeTitle)}
          disabled={!laid}
          title={t("tree.exportPdf.tooltip")}
        >
          <DownloadIcon /> {t("tree.exportPdf")}
        </button>
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
          {...canvasProps}
        >
          {laid && flat ? (
            <TreeSvg
              flat={flat}
              width={laid.width}
              height={laid.height}
              selectedKey={selectedKey}
              onSelect={selectNode}
              decisionOf={badgeOf}
              modifiedOf={isModified}
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
              <TreeMinimap
                nodes={flat.nodes}
                contentW={laid.width}
                contentH={laid.height}
                viewport={viewport}
                onScrollTo={scrollTo}
                fill={(n) => STATUS_COLOR[n.status]}
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
            kinship={kinshipOf(selected)}
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

function TreeSvg({
  flat,
  width,
  height,
  selectedKey,
  onSelect,
  decisionOf,
  modifiedOf,
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
  modifiedOf: (n: Placed) => boolean;
  kinshipOf: (n: Placed) => string | undefined;
  masterRecords: GedNode[];
  compareRecords: GedNode[];
  masterRefCtx: PhotoRefContext;
  compareRefCtx: PhotoRefContext;
}) {
  const { t } = useTranslation();
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
          const modified = modifiedOf(n);
          const kinship = kinshipOf(n);
          // Estimate pixel widths (years: ~6.5px/char at 11px; kinship: ~5.5px/char at 10px;
          // each badge: a fixed ~22px once the years label has a badge next to it).
          // If they'd overflow the 160px gap, stack kinship on a separate third row.
          const decW = (dec ? 22 : 0) + (modified ? 22 : 0);
          const needsKinshipRow = !!(kinship && (n.years || decW) && (n.years?.length ?? 0) * 13 + decW + kinship.length * 11 > 300);
          const yearsRowY = needsKinshipRow ? 36 : 40;
          const decBadgeX = textX + (n.years ? n.years.length * 6.5 + 8 : 0) + 7;
          // M badge sits after the decision badge when both are present.
          const modBadgeX = dec ? decBadgeX + 18 : decBadgeX;
          return (
            <g
              key={n.key}
              transform={`translate(${n.x},${n.y})`}
              className={`tree-node${n.key === selectedKey ? " selected" : ""}`}
              onClick={() => onSelect(n.key)}
            >
              <title>{t("tree.node.clickHint")}</title>
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
              {/* M badge for a master record with unsaved edits — solid fill, same
                  as the Edit tree. */}
              {modified && (
                <g className="tree-node-decision" transform={`translate(${modBadgeX},${yearsRowY - 4})`}>
                  <circle r={7} fill="var(--node-minor)" />
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    x={0}
                    y={0.5}
                    fontSize={9}
                    fontWeight={700}
                    fill="var(--bg)"
                  >
                    {t("edit.tree.modified").charAt(0)}
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
  const listRef = useRef<HTMLUListElement>(null);

  // The dropdown is anchored to its button (right-aligned), so for buttons near
  // a screen edge it can overflow off-screen. After it opens, nudge it back into
  // the viewport horizontally.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.style.transform = "";
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let dx = 0;
    if (rect.left < margin) dx = margin - rect.left;
    else if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right;
    if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
  }, [openStatus]);

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
              <ul className="tree-legend-list" ref={listRef}>
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
                      <span className="tree-person-text">
                        <span className={`tree-person-name ${sexClass(n.sex)}`}>{n.name}</span>
                        {n.years && <span className="tree-person-years gm-data">{n.years}</span>}
                      </span>
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
  kinship,
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
  kinship: string | undefined;
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

  // The confirm/reject/defer bar sits on the actions row (left), opposite the
  // Set-as-root button (right) — same row, left and right.
  const decisionBar = decidable ? (
    <div className="tree-compare-decisions decision-bar">
      {DECISION_STATUSES.map((s) => (
        <button
          key={s}
          className={status === s ? `decision ${s} active` : "decision"}
          onClick={() => onDecide(s)}
        >
          {t(status === s ? `status.${s}` : `status.action.${s}`)}
        </button>
      ))}
    </div>
  ) : undefined;

  const controls = (
    <>
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
    </>
  );

  return (
    <TreeNodePanel
      node={node}
      swatch={STATUS_COLOR[node.status]}
      rows={rows}
      masterPerson={masterPerson}
      incomingPerson={incomingPerson}
      masterLabel={t("tree.master")}
      incomingLabel={t("tree.incoming")}
      onClose={onClose}
      onSetRoot={() => onReroot(node.master?.id, node.incoming?.id)}
      onTitleClick={matchLink}
      titleHint={matchLink ? t("tree.openInMatches") : undefined}
      kinship={kinship}
      badges={decisionBar}
      controls={controls}
    />
  );
}

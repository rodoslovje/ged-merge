import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { individualFieldRows } from "../review/fields";
import { decisionKey, importKey, type CandidateDecision, type ImportDirection, type MatchDecisionStatus } from "../review/types";
import { TreeNodePanel } from "./TreeNodePanel";
import { createKinshipResolver, lineageClass } from "../match/kinship";
import type { Lineage } from "../match/relationshipPath";
import { sexClass } from "./sex";
import {
  buildPersonTree,
  buildMatchMaps,
  countImportable,
  countTreePeople,
  type MatchMaps,
  type NodeStatus,
  type TreeMode,
  type TreeNode,
} from "../tree/compareTree";
import { useFanChart } from "./useFanChart";
import { FanChartBody } from "./FanChartBody";
import {
  flatten,
  layout,
  layoutGrid,
  nodeHeight,
  type Placed,
} from "../tree/treeLayout";
import { formatMarriage } from "../tree/nodeDisplay";
import { useTreeCanvas } from "../tree/useTreeCanvas";
import { ChartMinimap } from "./ChartMinimap";
import { TreeSvg } from "./TreeSvg";
import { ZoomControls } from "./ZoomControls";
import { collectFirstFilePath } from "./PersonPhotos";
import { useMediaFolder } from "./MediaFolderContext";
import { ChartIcon } from "./icons/ChartIcon";
import { chartSlug } from "./exportSvg";
import { ChartExportMenu } from "./ChartExportMenu";
import { ChartPage } from "./ChartPage";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings, type PedigreeType } from "./ChartSettingsContext";
import { ChartKindTabs, PEDIGREE_KINDS } from "./ChartKindTabs";
import { useSettings } from "./SettingsContext";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";

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
  /** Start person ID in the master dataset, used to show kinship labels on nodes. */
  startId?: string;
  /** Open the Charts hub on a master-side person (from the node panel). */
  onOpenCharts?: (masterId: string) => void;
  /** Jump to a master-side person in Edit mode (closes the tree). */
  onOpenInEdit?: (masterId: string) => void;
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
  startId,
  onOpenCharts,
  onOpenInEdit,
}: Props) {
  const { t } = useTranslation();

  // A node whose master record has unsaved edits gets an "M" badge, matching the
  // Edit tree and relative cards.
  const isModified = useCallback(
    (n: TreeNode): boolean => !!n.master && changedPersonIds.has(n.master.id),
    [changedPersonIds],
  );

  // A matched node (both sides present) carries a decision; resolve its status
  // and localized letter for the badge next to its lifespan. The badge's colour
  // comes from CSS (`.status-chip.<status>`), matching the same chip used in
  // Edit and Merge. Undecided → no badge.
  const decisionOf = useCallback(
    (n: TreeNode): { status: Exclude<MatchDecisionStatus, "undecided">; letter: string } | undefined => {
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

  // Kinship-to-start resolver: one start-side pedigree walk, per-target caching —
  // labelling every node costs each person once, not two walks per node per render.
  const kinship = useMemo(
    () => (startId ? createKinshipResolver(masterDs, startId, t) : undefined),
    [startId, masterDs, t],
  );
  const kinshipOf = useCallback(
    (n: TreeNode): string | undefined => (n.master ? kinship?.label(n.master.id) : undefined),
    [kinship],
  );
  const lineageOf = useCallback(
    (n: TreeNode): Lineage | undefined => (n.master ? kinship?.lineage(n.master.id) : undefined),
    [kinship],
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
  // buildPersonTree): the two records are declared different people.
  const isRejected = useCallback(
    (masterId: string, compareId: string) =>
      decisions.get(decisionKey("individual", masterId, compareId))?.status === "rejected",
    [decisions],
  );

  const { settings, setType } = useChartSettings();
  // Grid is a layered chart (it reuses the tidy-tree SVG path); only fan/circle
  // are radial.
  const radial = settings.type === "fan" || settings.type === "circle";
  const isGrid = settings.type === "grid";
  // A radial chart only draws ancestors — an override on top of the user's
  // direction, never a change to it, so leaving Fan/Circle restores the choice.
  const effectiveMode = radial ? "ancestors" : mode;

  // Both directions build once per root/dataset/decisions: they feed the
  // mode-button counts, the current direction's layered chart, and (ancestors)
  // the radial chart — so switching direction or chart type never rebuilds a tree.
  const trees = useMemo(
    () => ({
      ancestors: buildPersonTree(t, rootMaster, rootIncoming, masterDs, compareDs, maps, "ancestors", isRejected),
      descendants: buildPersonTree(t, rootMaster, rootIncoming, masterDs, compareDs, maps, "descendants", isRejected),
    }),
    [t, rootMaster, rootIncoming, masterDs, compareDs, maps, isRejected],
  );
  const tree = trees[effectiveMode];

  // Incoming-only people each direction could graft, shown on the mode buttons —
  // the same counts the Compare Tree button surfaces in Merge mode.
  const { importCounts, peopleCounts } = useMemo(() => ({
    importCounts: {
      ancestors: trees.ancestors ? countImportable(trees.ancestors) : 0,
      descendants: trees.descendants ? countImportable(trees.descendants) : 0,
    },
    peopleCounts: {
      ancestors: countTreePeople(trees.ancestors),
      descendants: countTreePeople(trees.descendants),
    },
  }), [trees]);

  const { settings: appSettings } = useSettings();
  const { alignment } = settings;
  // Kinship can only show when there's a start person to measure against; gate it so
  // the box height doesn't reserve an always-empty kinship row.
  const display = useMemo(
    () => ({ ...settings, showKinship: settings.showKinship && appSettings.showKinship && !!startId }),
    [settings, appSettings.showKinship, startId],
  );
  // Box height grows per enabled detail row (lifespan / place / kinship); thread it
  // through the layout, connectors, canvas centring, minimap, and the node boxes.
  const nodeH = nodeHeight(display);
  const livingLabel = t("tree.node.living");
  const laid = useMemo(
    () => (tree ? (isGrid ? layoutGrid(tree, alignment, nodeH) : layout(tree, alignment, nodeH)) : undefined),
    [tree, alignment, isGrid, nodeH],
  );
  const marriageLabel = useMemo(() => {
    if (!display.showMarriageDate && !display.showMarriagePlace) return undefined;
    const fields = { date: display.showMarriageDate, place: display.showMarriagePlace };
    return (node: TreeNode) =>
      display.privacyLiving && node.living ? undefined : formatMarriage(node.marriage, fields);
  }, [display.showMarriageDate, display.showMarriagePlace, display.privacyLiving]);
  const flat = useMemo(
    () =>
      laid
        ? flatten(laid.root, alignment, isGrid ? "elbow" : "curve", nodeH, marriageLabel, effectiveMode === "ancestors")
        : undefined,
    [laid, alignment, isGrid, nodeH, marriageLabel, effectiveMode],
  );

  // Radial (fan / circle) ancestor chart — reuses the prebuilt ancestors tree,
  // so it's independent of the (overridden-to-ancestors) mode toggle.
  const { folderName } = useMediaFolder();
  const hasPhoto = useCallback(
    (n: TreeNode) =>
      !!folderName &&
      ((!!n.master && !!collectFirstFilePath(n.master.raw, masterDs.records)) ||
        (!!n.incoming && !!collectFirstFilePath(n.incoming.raw, compareDs.records))),
    [folderName, masterDs, compareDs],
  );
  // Kinship to the start person, shown in place of a redacted living person's name.
  const fanKinshipOf = useCallback(
    (n: TreeNode) => (n.master ? kinship?.label(n.master.id) : undefined),
    [kinship],
  );
  const { fan, nodes: fanNodes, laid: fanLaid } = useFanChart(
    radial ? trees.ancestors : undefined,
    settings.type === "circle" ? "circle" : "fan",
    { hasPhoto, display, livingLabel, kinshipOf: fanKinshipOf },
  );

  const colorOf = useCallback((n: TreeNode) => STATUS_COLOR[n.status], []);

  // Keys of incoming-only nodes that an active "import ancestors/descendants"
  // branch would bring in as new records: a node is covered once it, or any of
  // its render-tree ancestors, has its import toggled on for the current mode.
  // The rendered tree is exactly the graft direction, so coverage = subtree.
  const willImport = useMemo(() => {
    const set = new Set<string>();
    if (!laid) return set;
    const isAnchor = (n: Placed) => !!n.incoming && importBranches.has(importKey(effectiveMode, n.incoming.id));
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
  }, [laid, importBranches, effectiveMode]);

  // The badge a node shows next to its lifespan: a decided match's C/D/R, or "I"
  // (Incoming) for an incoming-only person an active graft will bring in.
  const badgeOf = useCallback(
    (n: TreeNode): { status: string; letter: string } | undefined => {
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
  // Root person's kinship to the start person, shown in the title.
  const rootKinship = rootMasterId ? kinship?.label(rootMasterId) : undefined;
  const rootLineage = rootMasterId ? kinship?.lineage(rootMasterId) : undefined;
  // Shared title for the SVG / PDF export header.
  const compareTreeTitle = [rootName, rootYears, "—", t("tree.title")].filter(Boolean).join(" ");

  // Per-segment badge for the radial chart: the decision / import "I" letter, or
  // an "M" for an edited master — same information as the tree node badges.
  const fanBadgeOf = useCallback(
    (n: TreeNode) => {
      const b = badgeOf(n);
      if (b) return { cls: `tree-node-decision ${b.status}`, letter: b.letter };
      if (isModified(n)) return { fill: "var(--node-minor)", textFill: "var(--bg)", letter: t("edit.tree.modified").charAt(0) };
      return undefined;
    },
    [badgeOf, isModified, t],
  );

  const nodesByKey = useMemo(() => {
    const map = new Map<string, Placed>();
    for (const n of flat?.nodes ?? []) if (!map.has(n.key)) map.set(n.key, n);
    return map;
  }, [flat]);

  const activeLaid = radial ? fanLaid : laid;
  const activeNodes = radial ? fanNodes : nodesByKey;

  // Viewport, grab-to-pan, zoom, root re-centring, and node selection.
  const { canvasRef, viewport, panning, scrollTo, canvasProps, selectedKey, setSelectedKey, selectNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(activeLaid, activeNodes, alignment, radial, nodeH);

  // +/− zoom, 0 reset, F fit, A/D direction, digits 1–4 for the chart kind.
  useChartShortcuts({
    zoomIn,
    zoomOut,
    resetZoom,
    fitToScreen,
    onMode: onModeChange,
    allowDescendants: !radial,
    kinds: PEDIGREE_KINDS,
    onKind: (k) => setType(k as PedigreeType),
    onLeave: onBack,
  });

  // The selected person — a laid tree node or a fan segment's ancestor node;
  // both are `TreeNode`s, read identically by the detail panel.
  const selected: TreeNode | undefined = radial
    ? fan?.segments.find((s) => s.key === selectedKey)?.node
    : selectedKey
      ? nodesByKey.get(selectedKey)
      : undefined;

  return (
    <ChartPage
      backLabel={t("tree.back")}
      onBack={onBack}
      title={
        rootName ? (
          <>
            <span className={`tree-title-name ${sexClass(tree?.sex ?? "U")}`}>{rootName}</span>
            {rootYears && <span className="tree-title-years gm-data">{rootYears}</span>}
            <span className="tree-title-break" aria-hidden="true" />
            {rootKinship && <span className={`tree-title-kinship ${lineageClass(rootLineage)}`}>{rootKinship}</span>}
            {rootStatus && rootStatus !== "undecided" && (
              <span className={`status-chip ${rootStatus}`} title={t(`status.${rootStatus}`)}>
                {t(`status.${rootStatus}`).charAt(0)}
              </span>
            )}
            <span className="tree-title-kind">{t("tree.title")}</span>
          </>
        ) : (
          t("tree.title")
        )
      }
      actions={
        <>
          <ChartSettings />
          <ChartExportMenu
            disabled={!activeLaid}
            slug={chartSlug(rootName, t(`tree.${effectiveMode}`))}
            title={compareTreeTitle}
            canvasRef={canvasRef}
          />
        </>
      }
      controlsLeft={
        <>
          <ChartKindTabs
            kinds={PEDIGREE_KINDS}
            value={settings.type}
            onChange={(k) => setType(k as PedigreeType)}
          />
          <div className="tree-mode">
            <button
              className={effectiveMode === "ancestors" ? "active" : ""}
              onClick={() => onModeChange("ancestors")}
            >
              {t("tree.ancestors")}
              <span className="tree-mode-count">{peopleCounts.ancestors}</span>
              {importCounts.ancestors > 0 && (
                <span className="tree-import-count">▲{importCounts.ancestors}</span>
              )}
            </button>
            {/* Radial charts are ancestor-only, so Descendants isn't offered
                there — the preserved choice reappears on the layered charts. */}
            {!radial && (
              <button
                className={effectiveMode === "descendants" ? "active" : ""}
                onClick={() => onModeChange("descendants")}
              >
                {t("tree.descendants")}
                <span className="tree-mode-count">{peopleCounts.descendants}</span>
                {importCounts.descendants > 0 && (
                  <span className="tree-import-count">▼{importCounts.descendants}</span>
                )}
              </button>
            )}
          </div>
        </>
      }
      controlsRight={<TreeLegend nodes={flat?.nodes ?? []} selectedKey={selectedKey} onPick={selectNode} />}
    >
      <div className="tree-canvas-wrap">
        <div
          className={`tree-canvas${panning ? " panning" : ""}`}
          ref={canvasRef}
          {...canvasProps}
        >
          {radial ? (
            fan ? (
              <FanChartBody
                chart={fan}
                zoom={zoom}
                colorOf={colorOf}
                selectedKey={selectedKey}
                onSelect={selectNode}
                masterRecords={masterDs.records}
                compareRecords={compareDs.records}
                masterRefCtx={masterRefCtx}
                compareRefCtx={compareRefCtx}
                badgeOf={fanBadgeOf}
              />
            ) : (
              <p className="muted">{t("tree.empty")}</p>
            )
          ) : laid && flat ? (
            <TreeSvg
              flat={flat}
              width={laid.width}
              height={laid.height}
              zoom={zoom}
              selectedKey={selectedKey}
              onSelect={selectNode}
              colorOf={colorOf}
              badgeOf={badgeOf}
              modifiedOf={isModified}
              kinshipOf={kinshipOf}
              lineageOf={lineageOf}
              masterRecords={masterDs.records}
              compareRecords={compareDs.records}
              masterRefCtx={masterRefCtx}
              compareRefCtx={compareRefCtx}
              display={display}
              nodeH={nodeH}
              livingLabel={livingLabel}
            />
          ) : (
            <p className="muted">{t("tree.empty")}</p>
          )}
        </div>
        {/* Radial charts fit the whole pedigree on screen; the minimap adds nothing. */}
        {!radial && laid && flat && (
          <ChartMinimap
            contentW={laid.width}
            contentH={laid.height}
            viewport={viewport}
            zoom={zoom}
            nodes={flat.nodes}
            fill={(n) => STATUS_COLOR[n.status]}
            nodeH={nodeH}
            onScrollTo={scrollTo}
          />
        )}
        {activeLaid && (
          <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fitToScreen} onReset={resetZoom} />
        )}
        {selected && (
          <NodeCompare
            node={selected}
            masterDs={masterDs}
            compareDs={compareDs}
            maps={maps}
            mode={effectiveMode}
            importActive={!!selected.incoming && importBranches.has(importKey(effectiveMode, selected.incoming.id))}
            onToggleImport={onToggleImport}
            onReroot={onReroot}
            onClose={() => setSelectedKey(null)}
            onShowInMatches={onShowInMatches}
            kinship={kinshipOf(selected)}
            kinshipLineage={lineageClass(lineageOf(selected))}
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
            onOpenCharts={onOpenCharts}
            onOpenInEdit={onOpenInEdit}
          />
        )}
      </div>
    </ChartPage>
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
  kinshipLineage,
  decision,
  onDecide,
  onOpenCharts,
  onOpenInEdit,
}: {
  /** The selected node — a laid tree node or a fan segment's person node. */
  node: TreeNode;
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
  kinshipLineage: string | undefined;
  decision: CandidateDecision | undefined;
  onDecide: (status: MatchDecisionStatus) => void;
  onOpenCharts?: (masterId: string) => void;
  onOpenInEdit?: (masterId: string) => void;
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
      kinshipLineage={kinshipLineage}
      badges={decisionBar}
      extraActions={
        node.master ? (
          <>
            {onOpenCharts && (
              <button
                className="nav-btn tree-compare-root charts-open-btn"
                onClick={() => onOpenCharts(node.master!.id)}
                title={t("edit.charts.tooltip")}
              >
                <ChartIcon size={13} /> {t("edit.charts.button")}
              </button>
            )}
            {onOpenInEdit && (
              <button className="nav-btn tree-compare-root" onClick={() => onOpenInEdit(node.master!.id)}>
                {t("relpath.openInEdit")}
              </button>
            )}
          </>
        ) : undefined
      }
      controls={controls}
    />
  );
}

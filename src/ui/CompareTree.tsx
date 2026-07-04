import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset, GedNode } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { individualFieldRows } from "../review/fields";
import { decisionKey, importKey, type CandidateDecision, type ImportDirection, type MatchDecisionStatus } from "../review/types";
import { TreeNodePanel } from "./TreeNodePanel";
import { kinshipLabel, lineageClass } from "../match/kinship";
import { bloodLineage, type Lineage } from "../match/relationshipPath";
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
import { buildFanChart, type FanSegment } from "../tree/fanLayout";
import { FanChartBody } from "./FanChartBody";
import {
  DETAIL_ROW_H,
  DETAIL_ROW_TOP,
  NODE_W,
  PAD,
  PHOTO_SIZE,
  PHOTO_X,
  TEXT_X_PHOTO,
  TEXT_X_PLAIN,
  flatten,
  layout,
  layoutGrid,
  minimapDefaultOpen,
  nodeHeight,
  truncate,
  type Flat,
  type Placed,
} from "../tree/treeLayout";
import { formatMarriage, nodeDisplay, type NodeDisplayOptions } from "../tree/nodeDisplay";
import { useTreeCanvas } from "../tree/useTreeCanvas";
import { TreeMinimap } from "./TreeMinimap";
import { ZoomControls } from "./ZoomControls";
import { TreeNodePhoto, collectFirstFilePath } from "./PersonPhotos";
import type { PhotoRefContext } from "./PhotoViewer";
import { useMediaFolder } from "./MediaFolderContext";
import { MapIcon } from "./icons/MapIcon";
import { diagramSlug, exportCanvasPdf, exportCanvasSvg } from "./exportSvg";
import { ExportMenu } from "./ExportMenu";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings, type ChartType } from "./ChartSettingsContext";
import { ChartKindTabs, PEDIGREE_KINDS } from "./ChartKindTabs";
import { useSettings } from "./SettingsContext";

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

  const kinshipOf = useCallback(
    (n: TreeNode): string | undefined => {
      if (!startId || !n.master) return undefined;
      return kinshipLabel(masterDs, startId, n.master.id, t) ?? undefined;
    },
    [startId, masterDs, t],
  );
  const lineageOf = useCallback(
    (n: TreeNode): Lineage | undefined =>
      startId && n.master ? bloodLineage(masterDs, startId, n.master.id) : undefined,
    [startId, masterDs],
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

  const { settings, setType } = useChartSettings();
  const { settings: appSettings } = useSettings();
  const { alignment } = settings;
  // Grid is a layered chart (it reuses the tidy-tree SVG path); only fan/circle
  // are radial.
  const radial = settings.type === "fan" || settings.type === "circle";
  const isGrid = settings.type === "grid";
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
        ? flatten(laid.root, alignment, isGrid ? "elbow" : "curve", nodeH, marriageLabel, mode === "ancestors")
        : undefined,
    [laid, alignment, isGrid, nodeH, marriageLabel, mode],
  );

  // A radial chart only draws ancestors; force the mode so the toggle reflects it.
  useEffect(() => {
    if (radial) onModeChange("ancestors");
  }, [radial, onModeChange]);

  // Radial (fan / circle) ancestor chart, built from a dedicated ancestors tree
  // so it's independent of the (forced-ancestors) mode toggle.
  const { folderName } = useMediaFolder();
  const fan = useMemo(() => {
    if (!radial) return undefined;
    const at = buildCompareTree(t, rootMaster, rootIncoming, masterDs, compareDs, maps, "ancestors", isRejected);
    if (!at) return undefined;
    const hasPhoto = (n: TreeNode) =>
      !!folderName &&
      ((!!n.master && !!collectFirstFilePath(n.master.raw, masterDs.records)) ||
        (!!n.incoming && !!collectFirstFilePath(n.incoming.raw, compareDs.records)));
    // Kinship to the start person, shown in place of a redacted living person's name.
    const kinshipOf = (n: TreeNode) =>
      startId && n.master?.id ? kinshipLabel(masterDs, startId, n.master.id, t) : undefined;
    return buildFanChart(at, settings.type === "circle" ? "circle" : "fan", { hasPhoto, display, livingLabel, kinshipOf });
  }, [radial, rootMaster, rootIncoming, masterDs, compareDs, maps, isRejected, settings.type, display, t, folderName, livingLabel, startId]);

  const colorOf = useCallback((n: TreeNode) => STATUS_COLOR[n.status], []);

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
  const rootKinship = startId && rootMasterId ? kinshipLabel(masterDs, startId, rootMasterId, t) : undefined;
  const rootLineage = startId && rootMasterId ? bloodLineage(masterDs, startId, rootMasterId) : undefined;
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

  const fanNodes = useMemo(() => {
    const m = new Map<string, Placed>();
    for (const s of fan?.segments ?? []) m.set(s.key, s as unknown as Placed);
    return m;
  }, [fan]);
  const fanLaid = useMemo(
    () => (fan ? { root: (fanNodes.get(fan.rootKey) ?? fan.segments[0]) as unknown as Placed, width: fan.width, height: fan.height } : undefined),
    [fan, fanNodes],
  );
  const activeLaid = radial ? fanLaid : laid;
  const activeNodes = radial ? fanNodes : nodesByKey;

  // null = follow the automatic default (collapsed unless the chart dwarfs the
  // screen); true/false once the user has toggled it by hand.
  const [mapOpen, setMapOpen] = useState<boolean | null>(null);

  // Viewport, grab-to-pan, zoom, root re-centring, and node selection.
  const { canvasRef, viewport, panning, scrollTo, canvasProps, selectedKey, setSelectedKey, selectNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(activeLaid, activeNodes, alignment, radial, nodeH);

  // The selected person — a laid tree node or a fan segment's ancestor node;
  // both are `TreeNode`s, read identically by the detail panel.
  const selected: TreeNode | undefined = radial
    ? fan?.segments.find((s) => s.key === selectedKey)?.node
    : selectedKey
      ? nodesByKey.get(selectedKey)
      : undefined;

  // Radial charts fit the whole pedigree on screen; the minimap adds nothing.
  const needsMinimap =
    !radial &&
    !!activeLaid &&
    viewport.width > 0 &&
    (activeLaid.width * zoom > viewport.width + 1 || activeLaid.height * zoom > viewport.height + 1);
  const minimapOpen = mapOpen ?? (!!activeLaid && minimapDefaultOpen(activeLaid.width, activeLaid.height, viewport));

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
          )}
        </h2>
        <ChartSettings />
        <ExportMenu
          disabled={!activeLaid}
          items={[
            {
              key: "svg",
              label: t("export.svg"),
              title: t("tree.export.tooltip"),
              onSelect: () => exportCanvasSvg(canvasRef.current, diagramSlug(rootName, t(`tree.${mode}`)), compareTreeTitle),
            },
            {
              key: "pdf",
              label: t("export.pdf"),
              title: t("tree.exportPdf.tooltip"),
              onSelect: () => exportCanvasPdf(canvasRef.current, diagramSlug(rootName, t(`tree.${mode}`)), compareTreeTitle),
            },
          ]}
        />
      </div>

      <div className="tree-controls">
        <div className="tree-controls-left">
          <ChartKindTabs
            kinds={PEDIGREE_KINDS}
            value={settings.type}
            onChange={(k) => setType(k as ChartType)}
          />
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
              onClick={() => {
                // Radial charts are ancestor-only; switching to descendants reverts
                // to the layered tree.
                if (radial) setType("tree");
                onModeChange("descendants");
              }}
            >
              {t("tree.descendants")}
              <span className="tree-mode-count">{peopleCounts.descendants}</span>
              {importCounts.descendants > 0 && (
                <span className="tree-import-count">▼{importCounts.descendants}</span>
              )}
            </button>
          </div>
        </div>
        <TreeLegend nodes={flat?.nodes ?? []} selectedKey={selectedKey} onPick={selectNode} />
      </div>

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
              decisionOf={badgeOf}
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
        {needsMinimap && activeLaid && (
          minimapOpen ? (
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
                nodes={radial ? (fan!.segments as unknown as Placed[]) : flat!.nodes}
                contentW={activeLaid.width}
                contentH={activeLaid.height}
                viewport={viewport}
                onScrollTo={scrollTo}
                fill={radial ? (n) => STATUS_COLOR[(n as unknown as FanSegment).node.status] : (n) => STATUS_COLOR[n.status]}
                nodeH={radial ? undefined : nodeH}
                zoom={zoom}
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
        {activeLaid && (
          <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fitToScreen} onReset={resetZoom} />
        )}
        {selected && (
          <NodeCompare
            node={selected as unknown as Placed}
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
  zoom,
  selectedKey,
  onSelect,
  decisionOf,
  modifiedOf,
  kinshipOf,
  lineageOf,
  masterRecords,
  compareRecords,
  masterRefCtx,
  compareRefCtx,
  display,
  nodeH,
  livingLabel,
}: {
  flat: Flat;
  width: number;
  height: number;
  zoom: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  decisionOf: (n: Placed) => { status: string; letter: string } | undefined;
  modifiedOf: (n: Placed) => boolean;
  kinshipOf: (n: Placed) => string | undefined;
  lineageOf: (n: Placed) => Lineage | undefined;
  masterRecords: GedNode[];
  compareRecords: GedNode[];
  masterRefCtx: PhotoRefContext;
  compareRefCtx: PhotoRefContext;
  display: NodeDisplayOptions;
  nodeH: number;
  livingLabel: string;
}) {
  const { t } = useTranslation();
  const { nodes, edges } = flat;
  const { folderName } = useMediaFolder();
  const photoY = (nodeH - PHOTO_SIZE) / 2;
  return (
    <svg className="tree-svg" width={width * zoom} height={height * zoom} viewBox={`0 0 ${width} ${height}`} role="img">
      <g transform={`translate(${PAD},${PAD})`}>
        {edges.map((e) => (
          <path
            key={e.id}
            className={e.partner ? "tree-edge tree-edge-partner" : "tree-edge"}
            d={e.d}
          />
        ))}
        {edges.map(
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
        {nodes.map((n) => {
          const dec = decisionOf(n);
          const modified = modifiedOf(n);
          const disp = nodeDisplay(display, {
            name: n.name,
            years: n.years,
            place: n.place,
            kinship: kinshipOf(n),
            kinshipLineage: lineageOf(n),
            living: n.living,
            livingLabel,
          });
          const { years } = disp;
          // Text shifts right of the photo column whenever a media folder is loaded
          // and photos are shown (privacy hides them).
          const showPhoto = disp.showPhoto && !!folderName;
          const textX = showPhoto ? TEXT_X_PHOTO : TEXT_X_PLAIN;
          // Lifespan, then place, then kinship — each on its own stacked row.
          const rows: { text: string; cls: string }[] = [];
          if (disp.years) rows.push({ text: disp.years, cls: "tree-node-year" });
          if (disp.place) rows.push({ text: truncate(disp.place, 26), cls: "tree-node-place" });
          if (disp.kinship) rows.push({ text: disp.kinship, cls: `tree-node-kinship ${lineageClass(disp.kinshipLineage)}` });
          // Badges sit on the lifespan row, just past the years label.
          const yearsRowY = DETAIL_ROW_TOP;
          const decBadgeX = textX + (years ? years.length * 6.5 + 8 : 0) + 7;
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
                height={nodeH}
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
                {truncate(disp.name, 24)}
              </text>
              {rows.map((r, i) => (
                <text key={r.cls} className={`${r.cls} gm-data`} x={textX} y={DETAIL_ROW_TOP + i * DETAIL_ROW_H}>
                  {r.text}
                </text>
              ))}
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
              {disp.showPhoto && (
                <TreeNodePhoto
                  node={n}
                  masterRecords={masterRecords}
                  compareRecords={compareRecords}
                  masterRefCtx={masterRefCtx}
                  compareRefCtx={compareRefCtx}
                  x={PHOTO_X}
                  y={photoY}
                  size={PHOTO_SIZE}
                />
              )}
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
  kinshipLineage,
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
  kinshipLineage: string | undefined;
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
      kinshipLineage={kinshipLineage}
      badges={decisionBar}
      controls={controls}
    />
  );
}

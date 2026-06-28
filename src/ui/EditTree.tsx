import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { buildCompareTree, countTreePeople, type TreeMode, type TreeNode } from "../tree/compareTree";
import {
  PAD,
  flatten,
  layout,
  layoutGrid,
  minimapDefaultOpen,
  nodeHeight,
  type Placed,
} from "../tree/treeLayout";
import { buildFanChart, type FanSegment } from "../tree/fanLayout";
import { useTreeCanvas } from "../tree/useTreeCanvas";
import { FanChartBody } from "./FanChartBody";
import { collectFirstFilePath } from "./PersonPhotos";
import { useMediaFolder } from "./MediaFolderContext";
import { TreeMinimap } from "./TreeMinimap";
import { ZoomControls } from "./ZoomControls";
import { kinshipLabel } from "../match/kinship";
import { individualFieldRows } from "../review/fields";
import { decisionStatusByMasterId, type CandidateDecision, type MatchDecisionStatus } from "../review/types";
import { sexClass } from "./sex";
import { TreeNodeBox } from "./TreeNodeBox";
import { TreeNodePanel } from "./TreeNodePanel";
import { MapIcon } from "./icons/MapIcon";
import { DownloadIcon } from "./icons/DownloadIcon";
import { diagramSlug, exportCanvasPdf, exportCanvasSvg } from "./exportSvg";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings } from "./ChartSettingsContext";

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
  chanCreaUsage: { recordChan: false, recordCrea: false, eventChan: false, eventCrea: false },
} as Dataset;

const EMPTY_MAPS = {
  masterToCompare: new Map<string, string>(),
  compareToMaster: new Map<string, string>(),
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  masterDs: Dataset;
  rootId: string;
  homeId?: string;
  changedPersonIds: Set<string>;
  /** Merge decisions, so confirmed/rejected/deferred matches show the same badge here as in the Compare Tree. */
  decisions?: Map<string, CandidateDecision>;
  onBack: () => void;
}

export function EditTree({ masterDs, rootId, homeId, changedPersonIds, decisions, onBack }: Props) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<TreeMode>("ancestors");
  const [currentRootId, setCurrentRootId] = useState(rootId);
  // null = follow the automatic default (collapsed unless the chart dwarfs the
  // screen); true/false once the user has toggled it by hand.
  const [mapOpen, setMapOpen] = useState<boolean | null>(null);

  const { settings, setType } = useChartSettings();
  const { alignment } = settings;
  // Grid is a layered chart (it reuses the tidy-tree SVG path); only fan/circle
  // are radial.
  const radial = settings.type === "fan" || settings.type === "circle";
  const isGrid = settings.type === "grid";
  // Kinship can only show when there's a home person to measure against; gate it so
  // the box height doesn't reserve an always-empty kinship row.
  const display = useMemo(
    () => ({ ...settings, showKinship: settings.showKinship && !!homeId }),
    [settings, homeId],
  );
  // Box height grows per enabled detail row (lifespan / place / kinship); thread it
  // through the layout, connectors, canvas centring, minimap, and the node boxes.
  const nodeH = nodeHeight(display);
  const livingLabel = t("tree.node.living");

  // A radial chart only draws ancestors; force the mode so the toggle reflects it.
  useEffect(() => {
    if (radial) setMode("ancestors");
  }, [radial]);

  const rootPerson = masterDs.individuals.get(currentRootId);

  const tree = useMemo(
    () => rootPerson
      ? buildCompareTree(t, rootPerson, undefined, masterDs, EMPTY_DS, EMPTY_MAPS, mode)
      : undefined,
    [t, rootPerson, masterDs, mode],
  );

  const laid = useMemo(
    () => (tree ? (isGrid ? layoutGrid(tree, alignment, nodeH) : layout(tree, alignment, nodeH)) : undefined),
    [tree, alignment, isGrid, nodeH],
  );
  const flat = useMemo(
    () => (laid ? flatten(laid.root, alignment, isGrid ? "elbow" : "curve", nodeH) : undefined),
    [laid, alignment, isGrid, nodeH],
  );

  // Ancestor / descendant head-counts for both directions, shown on the mode
  // buttons so the user can tell at a glance whether either way is worth
  // opening. Built independently of the current mode (memoized on the root), so
  // switching modes doesn't recompute them.
  const peopleCounts = useMemo(() => ({
    ancestors: countTreePeople(rootPerson ? buildCompareTree(t, rootPerson, undefined, masterDs, EMPTY_DS, EMPTY_MAPS, "ancestors") : undefined),
    descendants: countTreePeople(rootPerson ? buildCompareTree(t, rootPerson, undefined, masterDs, EMPTY_DS, EMPTY_MAPS, "descendants") : undefined),
  }), [t, rootPerson, masterDs]);

  const nodesByKey = useMemo(() => {
    const m = new Map<string, Placed>();
    for (const n of flat?.nodes ?? []) if (!m.has(n.key)) m.set(n.key, n);
    return m;
  }, [flat]);

  const isModified = useCallback(
    (n: TreeNode) => !!n.master && changedPersonIds.has(n.master.id),
    [changedPersonIds],
  );
  const colorOf = useCallback(
    (n: TreeNode) => isModified(n) ? COLOR_MODIFIED : COLOR_NORMAL,
    [isModified],
  );

  const decisionStatusById = useMemo(() => decisionStatusByMasterId(decisions), [decisions]);
  const decisionOf = useCallback(
    (n: TreeNode): { status: Exclude<MatchDecisionStatus, "undecided">; letter: string } | undefined => {
      const status = n.master ? decisionStatusById.get(n.master.id) : undefined;
      return status ? { status, letter: t(`status.${status}`).charAt(0) } : undefined;
    },
    [decisionStatusById, t],
  );

  // Radial (fan / circle) ancestor chart, built from a dedicated ancestors tree
  // so it's independent of the (forced-ancestors) mode toggle.
  const { folderName } = useMediaFolder();
  const fan = useMemo(() => {
    if (!radial || !rootPerson) return undefined;
    const at = buildCompareTree(t, rootPerson, undefined, masterDs, EMPTY_DS, EMPTY_MAPS, "ancestors");
    if (!at) return undefined;
    const hasPhoto = (n: TreeNode) => !!folderName && !!n.master && !!collectFirstFilePath(n.master.raw, masterDs.records);
    // Kinship to the home person, shown in place of a redacted living person's name.
    const kinshipOf = (n: TreeNode) =>
      homeId && n.master?.id ? kinshipLabel(masterDs, homeId, n.master.id, t) : undefined;
    return buildFanChart(at, settings.type === "circle" ? "circle" : "fan", { hasPhoto, display, livingLabel, kinshipOf });
  }, [radial, rootPerson, masterDs, settings.type, display, t, folderName, livingLabel, homeId]);

  const fanNodes = useMemo(() => {
    const m = new Map<string, Placed>();
    for (const s of fan?.segments ?? []) m.set(s.key, s as unknown as Placed);
    return m;
  }, [fan]);
  const fanLaid = useMemo(
    () => (fan ? { root: (fanNodes.get(fan.rootKey) ?? fan.segments[0]) as unknown as Placed, width: fan.width, height: fan.height } : undefined),
    [fan, fanNodes],
  );

  const fanBadgeOf = useCallback(
    (n: TreeNode) => {
      const dec = decisionOf(n);
      if (dec) return { cls: `tree-node-decision ${dec.status}`, letter: dec.letter };
      if (isModified(n)) return { fill: COLOR_MODIFIED, textFill: "var(--bg)", letter: t("edit.tree.modified").charAt(0) };
      return undefined;
    },
    [decisionOf, isModified, t],
  );

  const activeLaid = radial ? fanLaid : laid;
  const activeNodes = radial ? fanNodes : nodesByKey;

  // Viewport, grab-to-pan, zoom, root re-centring, and node selection.
  const { canvasRef, viewport, panning, scrollTo, canvasProps, selectedKey, setSelectedKey, selectNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(activeLaid, activeNodes, alignment, radial, nodeH);

  // The selected person — a laid tree node, or a fan segment's ancestor node.
  // Both are `TreeNode`s (Placed extends TreeNode), so the panel reads them alike.
  const selected: TreeNode | undefined = radial
    ? fan?.segments.find((s) => s.key === selectedKey)?.node
    : selectedKey
      ? nodesByKey.get(selectedKey)
      : undefined;

  // Master-only field rows for the selected person's detail panel; clicking a
  // relative re-roots the tree on them.
  const selectedRows = useMemo(
    () => (selected?.master ? individualFieldRows(t, selected.master, undefined, masterDs) : []),
    [t, selected, masterDs],
  );
  const masterNav = useMemo(
    () => ({
      linkable: (id: string) => masterDs.individuals.has(id),
      onNavigate: (id: string) => { setCurrentRootId(id); setSelectedKey(null); },
    }),
    [masterDs, setSelectedKey],
  );
  const selectedDecision = selected ? decisionOf(selected) : undefined;
  const selectedModified = selected ? isModified(selected) : false;

  // ── Derived counts for legend ─────────────────────────────────────────────

  // "Modified" and "Merged" are independent, overlapping dimensions — a node can
  // carry both an edit and a confirmed merge — so the counts mirror the badges
  // rather than partitioning the total. "Unmodified" is the clean complement:
  // people the save leaves untouched (no edit, no confirmed merge).
  const allNodes = flat?.nodes ?? [];
  const modifiedCount = allNodes.filter((n) => isModified(n)).length;
  const mergedCount = allNodes.filter((n) => decisionOf(n)?.status === "confirmed").length;
  const unmodifiedCount = allNodes.filter(
    (n) => !isModified(n) && decisionOf(n)?.status !== "confirmed",
  ).length;

  // Root person's kinship to the home person, shown in the title.
  const rootKinship = homeId && rootPerson ? kinshipLabel(masterDs, homeId, rootPerson.id, t) : undefined;

  // Radial charts fit the whole pedigree on screen; the minimap adds nothing.
  const needsMinimap =
    !radial && !!activeLaid && viewport.width > 0 &&
    (activeLaid.width * zoom > viewport.width + 1 || activeLaid.height * zoom > viewport.height + 1);
  const minimapOpen = mapOpen ?? (!!activeLaid && minimapDefaultOpen(activeLaid.width, activeLaid.height, viewport));

  // Shared title for the SVG / PDF export header.
  const editTreeTitle = [tree?.name, tree?.years, "—", t("edit.tree.title")].filter(Boolean).join(" ");

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="tree-page">
      <div className="tree-toolbar">
        <button className="tree-open-btn tree-back-btn" onClick={onBack} title={t("edit.tree.back")} aria-label={t("edit.tree.back")}>
          ← <span className="tree-back-label">{t("edit.tree.back")}</span>
        </button>
        <h2 className="tree-title">
          {tree ? (
            <>
              <span className={`tree-title-name ${rootPerson ? sexClass(rootPerson.sex) : ""}`}>
                {tree.name}
              </span>
              {tree.years && <span className="tree-title-years gm-data">{tree.years}</span>}
              <span className="tree-title-break" aria-hidden="true" />
              {rootKinship && <span className="tree-title-kinship">{rootKinship}</span>}
              <span className="tree-title-kind">{t("edit.tree.title")}</span>
            </>
          ) : (
            t("edit.tree.title")
          )}
        </h2>
        <ChartSettings />
        <button
          className="tree-open-btn tree-export-btn"
          onClick={() => exportCanvasSvg(
            canvasRef.current,
            diagramSlug(tree?.name, t(`tree.${mode}`)),
            editTreeTitle,
          )}
          disabled={!activeLaid}
          title={t("tree.export.tooltip")}
        >
          <DownloadIcon /> {t("tree.export")}
        </button>
        <button
          className="tree-open-btn tree-export-btn"
          onClick={() => exportCanvasPdf(
            canvasRef.current,
            diagramSlug(tree?.name, t(`tree.${mode}`)),
            editTreeTitle,
          )}
          disabled={!activeLaid}
          title={t("tree.exportPdf.tooltip")}
        >
          <DownloadIcon /> {t("tree.exportPdf")}
        </button>
      </div>

      {/* Mode toggle (left) + legend (right) — same layout as the Compare Tree. */}
      <div className="tree-controls">
        <div className="tree-mode">
          <button className={mode === "ancestors" ? "active" : ""} onClick={() => setMode("ancestors")}>
            {t("tree.ancestors")}
            <span className="tree-mode-count">{peopleCounts.ancestors}</span>
          </button>
          <button
            className={mode === "descendants" ? "active" : ""}
            onClick={() => {
              // Radial charts are ancestor-only; switching to descendants reverts
              // to the layered tree.
              if (radial) setType("tree");
              setMode("descendants");
            }}
          >
            {t("tree.descendants")}
            <span className="tree-mode-count">{peopleCounts.descendants}</span>
          </button>
        </div>
        {/* Legend: confirmed-merge badge + modified / unmodified swatches.
            Merged and Modified overlap, so they don't sum to the total.
            Empty groups are hidden. */}
        <div className="tree-legend">
          {mergedCount > 0 && (
            <div className="tree-legend-item">
              <span className="tree-legend-btn">
                <span className="tree-swatch confirmed" />
                {t("edit.tree.merged")} ({mergedCount})
              </span>
            </div>
          )}
          {modifiedCount > 0 && (
            <div className="tree-legend-item">
              <span className="tree-legend-btn">
                <span className="tree-swatch" style={{ background: COLOR_MODIFIED }} />
                {t("edit.tree.modified")} ({modifiedCount})
              </span>
            </div>
          )}
          {unmodifiedCount > 0 && (
            <div className="tree-legend-item">
              <span className="tree-legend-btn">
                <span className="tree-swatch" style={{ background: COLOR_NORMAL }} />
                {t("edit.tree.unmodified")} ({unmodifiedCount})
              </span>
            </div>
          )}
        </div>
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
                masterRefCtx={{ dataset: masterDs, onNavigate: setCurrentRootId }}
                badgeOf={fanBadgeOf}
              />
            ) : (
              <p className="muted">{t("tree.empty")}</p>
            )
          ) : laid && flat ? (
            <svg className="tree-svg" width={laid.width * zoom} height={laid.height * zoom} viewBox={`0 0 ${laid.width} ${laid.height}`} role="img">
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
                  const dec = decisionOf(n);
                  return (
                    <g
                      key={n.key}
                      transform={`translate(${n.x},${n.y})`}
                      className={`tree-node${n.key === selectedKey ? " selected" : ""}`}
                      onClick={() => selectNode(n.key)}
                    >
                      <title>{t("tree.node.clickHint")}</title>
                      <TreeNodeBox
                        name={n.name}
                        years={n.years}
                        place={n.place}
                        sex={n.sex}
                        color={color}
                        kinship={homeId && n.master?.id ? kinshipLabel(masterDs, homeId, n.master.id, t) : undefined}
                        photo={n.master ? { raw: n.master.raw, records: masterDs.records, refCtx: { dataset: masterDs, onNavigate: setCurrentRootId } } : undefined}
                        display={display}
                        living={n.living}
                        livingLabel={livingLabel}
                        nodeH={nodeH}
                        badges={({ yearsY, textX: tx }) => {
                          // Estimate the years label width (~6.5px/char) so badges sit just past it.
                          const badge1X = tx + (n.years ? n.years.length * 6.5 + 8 : 0) + 7;
                          const modifiedBadgeX = dec ? badge1X + 18 : badge1X;
                          return (
                            <>
                              {dec && (
                                <g className={`tree-node-decision ${dec.status}`} transform={`translate(${badge1X},${yearsY - 4})`}>
                                  <circle r={7} />
                                  <text textAnchor="middle" dominantBaseline="central" x={0} y={0.5} fontSize={9} fontWeight={700}>
                                    {dec.letter}
                                  </text>
                                </g>
                              )}
                              {modified && (
                                <g className="tree-node-decision" transform={`translate(${modifiedBadgeX},${yearsY - 4})`}>
                                  <circle r={7} fill={COLOR_MODIFIED} />
                                  <text textAnchor="middle" dominantBaseline="central" x={0} y={0.5} fontSize={9} fontWeight={700} fill="var(--bg)">
                                    {t("edit.tree.modified").charAt(0)}
                                  </text>
                                </g>
                              )}
                            </>
                          );
                        }}
                      />
                    </g>
                  );
                })}
              </g>
            </svg>
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
                fill={radial ? (n) => colorOf((n as unknown as FanSegment).node) : colorOf}
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

        {selected && selected.master && (
          <TreeNodePanel
            node={selected as unknown as Placed}
            swatch={colorOf(selected)}
            rows={selectedRows}
            masterPerson={masterNav}
            masterLabel={t("tree.master")}
            singleColumn
            onClose={() => setSelectedKey(null)}
            onSetRoot={() => {
              setCurrentRootId(selected.master!.id);
              setSelectedKey(null);
            }}
            badges={
              selectedDecision || selectedModified ? (
                <>
                  {selectedDecision && (
                    <span className={`status-chip ${selectedDecision.status}`} title={t(`status.${selectedDecision.status}`)}>
                      {t(`status.${selectedDecision.status}`)}
                    </span>
                  )}
                  {selectedModified && <span className="edit-tree-badge">{t("edit.tree.modified")}</span>}
                </>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}

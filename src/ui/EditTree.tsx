import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { emptyDataset } from "../gedcom/builder";
import { buildCompareTree, countTreePeople, type TreeMode, type TreeNode } from "../tree/compareTree";
import {
  flatten,
  layout,
  layoutGrid,
  nodeHeight,
  type Placed,
} from "../tree/treeLayout";
import { buildFanChart } from "../tree/fanLayout";
import { formatMarriage } from "../tree/nodeDisplay";
import { useTreeCanvas } from "../tree/useTreeCanvas";
import { FanChartBody } from "./FanChartBody";
import { collectFirstFilePath } from "./PersonPhotos";
import { useMediaFolder } from "./MediaFolderContext";
import { ChartMinimap } from "./ChartMinimap";
import { ZoomControls } from "./ZoomControls";
import { createKinshipResolver, lineageClass } from "../match/kinship";
import { individualFieldRows } from "../review/fields";
import { decisionStatusByMasterId, type CandidateDecision, type MatchDecisionStatus } from "../review/types";
import { sexClass } from "./sex";
import { TreeSvg } from "./TreeSvg";
import { TreeNodePanel } from "./TreeNodePanel";
import { diagramSlug } from "./exportSvg";
import { ChartExportMenu } from "./ChartExportMenu";
import { ChartPage } from "./ChartPage";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings } from "./ChartSettingsContext";
import { useSettings } from "./SettingsContext";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";

// Color for unmodified nodes (master pine green) and modified (amber/minor).
const COLOR_NORMAL = "var(--node-master)";
const COLOR_MODIFIED = "var(--node-minor)";

// Empty compare-side dataset — the tree builder needs a valid Dataset object
// but won't find any incoming individuals since all Maps are empty. Module-level
// so its identity is stable across renders (it sits in memo dep arrays).
const EMPTY_DS = emptyDataset();

const EMPTY_MAPS = {
  masterToCompare: new Map<string, string>(),
  compareToMaster: new Map<string, string>(),
};

// ─── Component ────────────────────────────────────────────────────────────────

interface Props {
  masterDs: Dataset;
  rootId: string;
  startId?: string;
  changedPersonIds: Set<string>;
  /** Merge decisions, so confirmed/rejected/deferred matches show the same badge here as in the Compare Tree. */
  decisions?: Map<string, CandidateDecision>;
  /** Translated label for where Back lands (from the hub / App). */
  backLabel: string;
  onBack: () => void;
  /** Jump to a person in Edit mode (closes the hub). */
  onNavigate?: (id: string) => void;
  /** The user's chosen direction — owned by the Charts hub so it survives kind
   *  switches (including a round-trip through the relationship diagram). */
  mode: TreeMode;
  onModeChange: (mode: TreeMode) => void;
  /** The Charts-hub kind switcher, rendered in the controls row. */
  kindSwitcher?: React.ReactNode;
  /** Reports re-roots up to the Charts hub, so switching to the relationship
   *  diagram keeps the person the user navigated to (not the original root). */
  onRootChange?: (id: string) => void;
}

export function EditTree({ masterDs, rootId, startId, changedPersonIds, decisions, backLabel, onBack, onNavigate, mode, onModeChange, kindSwitcher, onRootChange }: Props) {
  const { t } = useTranslation();
  const [currentRootId, setCurrentRootId] = useState(rootId);
  const changeRoot = useCallback((id: string) => {
    setCurrentRootId(id);
    onRootChange?.(id);
  }, [onRootChange]);

  const { settings } = useChartSettings();
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

  // A radial chart only draws ancestors — an override on top of the user's
  // direction, never a change to it, so leaving Fan/Circle restores the choice.
  const effectiveMode = radial ? "ancestors" : mode;

  const rootPerson = masterDs.individuals.get(currentRootId);

  // Kinship-to-start resolver: one start-side pedigree walk, per-target caching —
  // labelling every node costs each person once, not two walks per node per render.
  const kinship = useMemo(
    () => (startId ? createKinshipResolver(masterDs, startId, t) : undefined),
    [masterDs, startId, t],
  );

  const tree = useMemo(
    () => rootPerson
      ? buildCompareTree(t, rootPerson, undefined, masterDs, EMPTY_DS, EMPTY_MAPS, effectiveMode)
      : undefined,
    [t, rootPerson, masterDs, effectiveMode],
  );

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

  // A photo's "referenced by" link re-roots the tree on that person.
  const masterRefCtx = useMemo(
    () => ({ dataset: masterDs, onNavigate: changeRoot }),
    [masterDs, changeRoot],
  );

  // Radial (fan / circle) ancestor chart, built from a dedicated ancestors tree
  // so it's independent of the (forced-ancestors) mode toggle.
  const { folderName } = useMediaFolder();
  const fan = useMemo(() => {
    if (!radial || !rootPerson) return undefined;
    const at = buildCompareTree(t, rootPerson, undefined, masterDs, EMPTY_DS, EMPTY_MAPS, "ancestors");
    if (!at) return undefined;
    const hasPhoto = (n: TreeNode) => !!folderName && !!n.master && !!collectFirstFilePath(n.master.raw, masterDs.records);
    // Kinship to the start person, shown in place of a redacted living person's name.
    const kinshipOf = (n: TreeNode) => (n.master ? kinship?.label(n.master.id) : undefined);
    return buildFanChart(at, settings.type === "circle" ? "circle" : "fan", { hasPhoto, display, livingLabel, kinshipOf });
  }, [radial, rootPerson, masterDs, settings.type, display, t, folderName, livingLabel, kinship]);

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

  // +/− zoom, 0 reset, F fit, A/D direction (D unavailable on radial charts),
  // Esc leaves the page.
  useChartShortcuts({ zoomIn, zoomOut, resetZoom, fitToScreen, onMode: onModeChange, allowDescendants: !radial, onLeave: onBack });

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
      onNavigate: (id: string) => { changeRoot(id); setSelectedKey(null); },
    }),
    [masterDs, setSelectedKey, changeRoot],
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

  // Root person's kinship to the start person, shown in the title.
  const rootKinship = rootPerson ? kinship?.label(rootPerson.id) : undefined;
  const rootLineage = rootPerson ? kinship?.lineage(rootPerson.id) : undefined;

  // Chart "kind" label = direction + diagram type, e.g. "Ancestors Fan Chart".
  const chartKind = `${t(effectiveMode === "ancestors" ? "tree.ancestors" : "tree.descendants")} ${t(`tree.kind.${settings.type}`)}`;
  // Shared title for the SVG / PDF export header.
  const editTreeTitle = [tree?.name, tree?.years, "—", chartKind].filter(Boolean).join(" ");
  // Everyone drawn on the current chart (incl. spouses in descendant mode) —
  // the person set the GEDCOM export cuts out of the master file. Deduped:
  // pedigree collapse draws a person in several positions but exports them once,
  // so the menu's count matches the file.
  const chartPersonIds = useMemo(() => {
    const ids = new Set<string>();
    const nodes = radial ? (fan?.segments ?? []).map((s) => s.node) : (flat?.nodes ?? []);
    for (const n of nodes) if (n.master) ids.add(n.master.id);
    return [...ids];
  }, [radial, fan, flat]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <ChartPage
      backLabel={backLabel}
      onBack={onBack}
      title={
        tree ? (
          <>
            <span className={`tree-title-name ${rootPerson ? sexClass(rootPerson.sex) : ""}`}>
              {tree.name}
            </span>
            {tree.years && <span className="tree-title-years gm-data">{tree.years}</span>}
            <span className="tree-title-break" aria-hidden="true" />
            {rootKinship && <span className={`tree-title-kinship ${lineageClass(rootLineage)}`}>{rootKinship}</span>}
            <span className="tree-title-kind">{chartKind}</span>
          </>
        ) : (
          chartKind
        )
      }
      actions={
        <>
          <ChartSettings />
          <ChartExportMenu
            disabled={!activeLaid}
            slug={diagramSlug(tree?.name, t(`tree.${effectiveMode}`))}
            title={editTreeTitle}
            gedcom={{ ds: masterDs, personIds: chartPersonIds }}
            canvasRef={canvasRef}
          />
        </>
      }
      controlsLeft={
        <>
          {kindSwitcher}
          <div className="tree-mode">
            <button className={effectiveMode === "ancestors" ? "active" : ""} onClick={() => onModeChange("ancestors")}>
              {t("tree.ancestors")}
              <span className="tree-mode-count">{peopleCounts.ancestors}</span>
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
              </button>
            )}
          </div>
        </>
      }
      controlsRight={
        /* Legend: confirmed-merge badge + modified / unmodified swatches.
           Merged and Modified overlap, so they don't sum to the total.
           Empty groups are hidden. */
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
      }
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
                masterRefCtx={masterRefCtx}
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
              badgeOf={decisionOf}
              modifiedOf={isModified}
              kinshipOf={(n) => (n.master ? kinship?.label(n.master.id) : undefined)}
              lineageOf={(n) => (n.master ? kinship?.lineage(n.master.id) : undefined)}
              masterRecords={masterDs.records}
              masterRefCtx={masterRefCtx}
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
            fill={colorOf}
            nodeH={nodeH}
            onScrollTo={scrollTo}
          />
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
              changeRoot(selected.master!.id);
              setSelectedKey(null);
            }}
            extraActions={
              onNavigate ? (
                <button className="nav-btn tree-compare-root" onClick={() => onNavigate(selected.master!.id)}>
                  {t("relpath.openInEdit")}
                </button>
              ) : undefined
            }
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
    </ChartPage>
  );
}

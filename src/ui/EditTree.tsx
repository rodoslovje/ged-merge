import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { emptyDataset } from "../gedcom/builder";
import { buildPersonTree, countTreePeople, pruneTree, treeDepth, type TreeMode, type TreeNode } from "../chart/personTree";
import {
  flatten,
  layout,
  layoutGrid,
  nodeHeight,
  type Placed,
} from "../chart/treeLayout";
import { useFanChart } from "./useFanChart";
import { formatMarriage, lifespanLine, modeSummary } from "../chart/nodeDisplay";
import { useTreeCanvas } from "./useTreeCanvas";
import { FanChartBody } from "./FanChartBody";
import { collectFirstFilePath } from "./PersonMedia";
import { useMediaFolder } from "./MediaFolderContext";
import { ChartMinimap } from "./ChartMinimap";
import { ZoomControls } from "./ZoomControls";
import { createKinshipResolver } from "../match/kinship";
import { ChartRootTitle } from "./ChartRootTitle";
import { useStableHandler } from "./edit/useStableHandler";
import { individualFieldRows } from "../review/fields";
import { decisionStatusByMainId, type CandidateDecision, type MatchDecisionStatus } from "../review/types";
import { sexClass } from "./sex";
import { TreeSvg } from "./TreeSvg";
import { TreeNodePanel } from "./TreeNodePanel";
import { chartSlug } from "./exportSvg";
import { ChartExportMenu } from "./ChartExportMenu";
import { ChartPage } from "./ChartPage";
import { ChartSettings } from "./ChartSettings";
import { ChartFindBox } from "./ChartFindBox";
import { useChartFind } from "./useChartFind";
import { useChartSettings } from "./ChartSettingsContext";
import { useNameOf, useSettingsSlice } from "./SettingsContext";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";

// Color for unmodified nodes (main pine green) and modified (amber/minor).
/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["showKinship"] as const;

const COLOR_NORMAL = "var(--node-main)";
const COLOR_MODIFIED = "var(--node-minor)";

// Empty compare-side dataset — the tree builder needs a valid Dataset object
// but won't find any incoming individuals since all Maps are empty. Module-level
// so its identity is stable across renders (it sits in memo dep arrays).
const EMPTY_DS = emptyDataset();

const EMPTY_MAPS = {
  mainToCompare: new Map<string, string>(),
  compareToMain: new Map<string, string>(),
};

// ─── Component ────────────────────────────────────────────────────────────────

/** Chart override for the name formatter when the chart's own Married-name
 *  toggle is off; a module-level constant so useNameOf's formatter keeps a
 *  stable identity across renders. */
const NO_MARRIED_NAME = { marriedSurname: false } as const;

interface Props {
  mainDs: Dataset;
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
  /** Re-root on another person. The hub owns the root (and records it in browser
   *  history), so a re-root here comes back down as a new `rootId`. */
  onRootChange: (id: string) => void;
}

export function EditTree({ mainDs, rootId: currentRootId, startId, changedPersonIds, decisions, backLabel, onBack, onNavigate, mode, onModeChange, kindSwitcher, onRootChange }: Props) {
  const { t } = useTranslation();
  // Identity-stable, so the memoized card contexts and the find box below don't
  // rebuild every render just because App passes a fresh callback.
  const changeRoot = useStableHandler(onRootChange);

  const { settings } = useChartSettings();
  const appSettings = useSettingsSlice(SETTINGS_KEYS);
  // Names read as the Name-display settings say (married surname, order, …) —
  // the same formatter the lists, the timeline and the reports use.
  const nameOf = useNameOf(settings.showMarriedName ? undefined : NO_MARRIED_NAME);
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

  // A radial chart only draws ancestors — an override on top of the user's
  // direction, never a change to it, so leaving Fan/Circle restores the choice.
  const effectiveMode = radial ? "ancestors" : mode;

  const rootPerson = mainDs.individuals.get(currentRootId);

  // Kinship-to-start resolver: one start-side pedigree walk, per-target caching —
  // labelling every node costs each person once, not two walks per node per render.
  const kinship = useMemo(
    () => (startId ? createKinshipResolver(mainDs, startId, t) : undefined),
    [mainDs, startId, t],
  );

  // Both directions build once per root/dataset: they feed the mode-button
  // head-counts, the current direction's layered chart, and (ancestors) the
  // radial chart — so switching direction or chart type never rebuilds a tree.
  const trees = useMemo(
    () => ({
      ancestors: rootPerson ? buildPersonTree(t, rootPerson, undefined, mainDs, EMPTY_DS, EMPTY_MAPS, "ancestors", undefined, nameOf) : undefined,
      descendants: rootPerson ? buildPersonTree(t, rootPerson, undefined, mainDs, EMPTY_DS, EMPTY_MAPS, "descendants", undefined, nameOf) : undefined,
    }),
    [t, rootPerson, mainDs, nameOf],
  );
  // How deep each direction goes, and the trees as the generation limit leaves
  // them. The full trees stay behind them for the head-counts and the "of N"
  // readout, so raising the limit never rebuilds anything.
  const depths = useMemo(
    () => ({ ancestors: treeDepth(trees.ancestors), descendants: treeDepth(trees.descendants) }),
    [trees],
  );
  const limit = settings.maxGenerations;
  const shown = useMemo(
    () => ({
      ancestors: limit === null ? trees.ancestors : pruneTree(trees.ancestors, limit),
      descendants: limit === null ? trees.descendants : pruneTree(trees.descendants, limit),
    }),
    [trees, limit],
  );
  const tree = shown[effectiveMode];
  // Whether the limit actually cuts the direction on screen (a limit deeper than
  // the tree changes nothing, and shouldn't claim to).
  const limited = limit !== null && limit < depths[effectiveMode];
  // What the "+N" marker says: the direction decides who is missing, and the
  // tooltip names the limit that hid them.
  const hiddenTitle = useCallback(
    // `atLimit` lets a chart that ran out of room of its own (the radial rings)
    // name its own cap instead of the generation setting's.
    (count: number, atLimit?: number) =>
      t(effectiveMode === "ancestors" ? "tree.node.hiddenAncestors" : "tree.node.hiddenDescendants", {
        count,
        limit: atLimit ?? limit ?? 0,
      }),
    [t, effectiveMode, limit],
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

  // What "print in sheets" splits: the layered charts only — a fan has no
  // rectangular branches to cut. It re-lays the very same tree the canvas draws.
  const sheetSource = useMemo(
    () =>
      !radial && tree
        ? { tree, alignment, grid: isGrid, nodeH, marriageLabel, ancestors: effectiveMode === "ancestors" }
        : undefined,
    [radial, tree, alignment, isGrid, nodeH, marriageLabel, effectiveMode],
  );

  // Ancestor / descendant head-counts for both directions, shown on the mode
  // buttons so the user can tell at a glance whether either way is worth opening.
  const peopleCounts = useMemo(() => ({
    ancestors: countTreePeople(trees.ancestors),
    descendants: countTreePeople(trees.descendants),
  }), [trees]);

  const nodesByKey = useMemo(() => {
    const m = new Map<string, Placed>();
    for (const n of flat?.nodes ?? []) if (!m.has(n.key)) m.set(n.key, n);
    return m;
  }, [flat]);

  const isModified = useCallback(
    (n: TreeNode) => !!n.main && changedPersonIds.has(n.main.id),
    [changedPersonIds],
  );
  const colorOf = useCallback(
    (n: TreeNode) => isModified(n) ? COLOR_MODIFIED : COLOR_NORMAL,
    [isModified],
  );

  const decisionStatusById = useMemo(() => decisionStatusByMainId(decisions), [decisions]);
  const decisionOf = useCallback(
    (n: TreeNode): { status: Exclude<MatchDecisionStatus, "undecided">; letter: string } | undefined => {
      const status = n.main ? decisionStatusById.get(n.main.id) : undefined;
      return status ? { status, letter: t(`status.${status}`).charAt(0) } : undefined;
    },
    [decisionStatusById, t],
  );

  // A photo's "referenced by" link re-roots the tree on that person.
  const mainRefCtx = useMemo(
    () => ({ dataset: mainDs, onNavigate: changeRoot }),
    [mainDs, changeRoot],
  );

  // Radial (fan / circle) ancestor chart — reuses the prebuilt ancestors tree,
  // so it's independent of the (forced-ancestors) mode toggle.
  const { folderName } = useMediaFolder();
  const hasPhoto = useCallback(
    (n: TreeNode) => !!folderName && !!n.main && !!collectFirstFilePath(n.main.raw, mainDs.records),
    [folderName, mainDs],
  );
  // Kinship to the start person, shown in place of a redacted living person's name.
  const fanKinshipOf = useCallback(
    (n: TreeNode) => (n.main ? kinship?.label(n.main.id) : undefined),
    [kinship],
  );
  const { fan, nodes: fanNodes, laid: fanLaid } = useFanChart(
    radial ? shown.ancestors : undefined,
    settings.type === "circle" ? "circle" : "fan",
    { hasPhoto, display, kinshipOf: fanKinshipOf },
  );

  const activeLaid = radial ? fanLaid : laid;
  const activeNodes = radial ? fanNodes : nodesByKey;

  // Viewport, grab-to-pan, zoom, root re-centring, and node selection.
  const { canvasRef, viewport, panning, scrollTo, canvasProps, selectedKey, setSelectedKey, selectNode, revealNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(activeLaid, activeNodes, alignment, radial, nodeH, `${currentRootId}:${effectiveMode}:${settings.type}:${alignment}`);

  // Find-in-chart: every drawn position, in layout order (a shared ancestor is
  // drawn once per line of descent, so the same person yields several).
  const findSources = useMemo(
    () =>
      radial
        ? (fan?.segments ?? []).map((s) => ({ key: s.key, people: [s.node.main] }))
        : (flat?.nodes ?? []).map((n) => ({ key: n.key, people: [n.main] })),
    [radial, fan, flat],
  );
  const find = useChartFind(findSources, mainDs.individuals, revealNode, changeRoot);

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

  // Main-only field rows for the selected person's detail panel; clicking a
  // relative re-roots the tree on them.
  const selectedRows = useMemo(
    () => (selected?.main ? individualFieldRows(t, selected.main, undefined, mainDs) : []),
    [t, selected, mainDs],
  );
  const mainNav = useMemo(
    () => ({
      linkable: (id: string) => mainDs.individuals.has(id),
      onNavigate: (id: string) => { changeRoot(id); setSelectedKey(null); },
    }),
    [mainDs, setSelectedKey, changeRoot],
  );
  const selectedDecision = selected ? decisionOf(selected) : undefined;
  const selectedModified = selected ? isModified(selected) : false;

  // Root person's kinship to the start person, shown in the title.
  const rootKinship = rootPerson ? kinship?.label(rootPerson.id) : undefined;
  const rootLineage = rootPerson ? kinship?.lineage(rootPerson.id) : undefined;

  // Chart "kind" label = direction + diagram type, e.g. "Ancestors Fan Chart",
  // plus "4 of 9 generations" while the limit is cutting — on the page and in
  // every export header, so a partial chart never passes for a whole one.
  const chartKind =
    `${t(effectiveMode === "ancestors" ? "tree.ancestors" : "tree.descendants")} ${t(`tree.kind.${settings.type}`)}` +
    (limited ? ` · ${t("tree.gen.shown", { n: limit, of: depths[effectiveMode] })}` : "");
  // The root's lifespan for the title, with the age appended when Age is on
  // (the title always shows the lifespan, so force it on here).
  const rootYears = tree
    ? lifespanLine({ showLifespan: true, showAge: display.showAge }, { years: tree.years, age: tree.age })
    : undefined;
  // Shared title for the SVG / PDF export header.
  const editTreeTitle = [tree?.name, rootYears, "—", chartKind].filter(Boolean).join(" ");
  // Everyone drawn on the current chart (incl. spouses in descendant mode) —
  // the person set the GEDCOM export cuts out of the main file. Deduped:
  // pedigree collapse draws a person in several positions but exports them once,
  // so the menu's count matches the file.
  const chartPersonIds = useMemo(() => {
    const ids = new Set<string>();
    const nodes = radial ? (fan?.segments ?? []).map((s) => s.node) : (flat?.nodes ?? []);
    for (const n of nodes) if (n.main) ids.add(n.main.id);
    return [...ids];
  }, [radial, fan, flat]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <ChartPage
      backLabel={backLabel}
      onBack={onBack}
      title={
        tree ? (
          <ChartRootTitle
            name={tree.name}
            sexCls={rootPerson ? sexClass(rootPerson.sex) : ""}
            years={rootYears}
            kinship={rootKinship}
            lineage={rootLineage}
            kind={chartKind}
          />
        ) : (
          chartKind
        )
      }
      actions={
        <>
          <ChartSettings availableGenerations={depths[effectiveMode]} />
          <ChartExportMenu
            disabled={!activeLaid}
            slug={chartSlug(tree?.name, t(`tree.${effectiveMode}`))}
            title={editTreeTitle}
            gedcom={{ ds: mainDs, personIds: chartPersonIds }}
            canvasRef={canvasRef}
            sheets={sheetSource}
          />
        </>
      }
      controlsLeft={
        <>
          {kindSwitcher}
          <div className="tree-mode">
            <button
              className={effectiveMode === "ancestors" ? "active" : ""}
              onClick={() => onModeChange("ancestors")}
              title={modeSummary(t, peopleCounts.ancestors, depths.ancestors)}
            >
              {t("tree.ancestors")}
              <span className="tree-mode-count">{peopleCounts.ancestors}</span>
            </button>
            {/* Radial charts are ancestor-only, so Descendants isn't offered
                there — the preserved choice reappears on the layered charts. */}
            {!radial && (
              <button
                className={effectiveMode === "descendants" ? "active" : ""}
                onClick={() => onModeChange("descendants")}
                title={modeSummary(t, peopleCounts.descendants, depths.descendants)}
              >
                {t("tree.descendants")}
                <span className="tree-mode-count">{peopleCounts.descendants}</span>
              </button>
            )}
          </div>
        </>
      }
      controlsRight={<ChartFindBox find={find} />}
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
                flashKey={find.hitKey}
                onSelect={selectNode}
                mainRecords={mainDs.records}
                mainRefCtx={mainRefCtx}
                showRepeat
                onRepeatJump={find.jumpTo}
                hiddenTitle={hiddenTitle}
                onHiddenJump={(n) => n.main && changeRoot(n.main.id)}
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
              flashKey={find.hitKey}
              onSelect={selectNode}
              colorOf={colorOf}
              showRepeat
              onRepeatJump={find.jumpTo}
              hiddenTitle={hiddenTitle}
              onHiddenJump={(n) => n.main && changeRoot(n.main.id)}
              kinshipOf={(n) => (n.main ? kinship?.label(n.main.id) : undefined)}
              lineageOf={(n) => (n.main ? kinship?.lineage(n.main.id) : undefined)}
              mainRecords={mainDs.records}
              mainRefCtx={mainRefCtx}
              display={display}
              nodeH={nodeH}
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

        {selected && selected.main && (
          <TreeNodePanel
            node={selected}
            swatch={colorOf(selected)}
            rows={selectedRows}
            mainPerson={mainNav}
            mainLabel={t("tree.main")}
            singleColumn
            onClose={() => setSelectedKey(null)}
            onSetRoot={() => {
              changeRoot(selected.main!.id);
              setSelectedKey(null);
            }}
            extraActions={
              onNavigate ? (
                <button className="nav-btn tree-compare-root" onClick={() => onNavigate(selected.main!.id)}>
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

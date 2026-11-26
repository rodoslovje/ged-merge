import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { emptyDataset } from "../gedcom/builder";
import { buildPersonTree, countTreePeople, pruneTree, someTreeNode, treeDepth, type TreeMode, type TreeNode } from "../chart/personTree";
import { buildCompleteTree, connectedCount, flattenComplete, layoutComplete, type CompleteLaid } from "../chart/completeTree";
import { buildFamilyGraph, graphBranches } from "../chart/familyGraph";
import {
  bowtieHalf,
  flatten,
  flattenBowtie,
  isBowtie,
  layout,
  layoutBowtie,
  layoutGrid,
  nodeHeight,
  type BowtieLaid,
  type ChartDirection,
  type Placed,
} from "../chart/treeLayout";
import { Segmented, type SegmentedItem } from "./Segmented";
import { AXIS_TINT, CHART_AXES, fanPosition, indexPositions, type NodePosition } from "../chart/nodeColor";
import { useNodeColorer } from "./useNodeColorer";
import { ChartLegend } from "./ChartLegend";
import { hoverInfoFrom, type HoverInfo } from "./useChartHover";
import { useAssocHover } from "./useAssocHover";
import { hiddenName, useLivingNameOf } from "./useLivingName";
import { ChartHoverCard } from "./ChartHoverCard";
import { useFanChart } from "./useFanChart";
import type { FanSegment } from "../chart/fanLayout";
import { ageStandalone, formatMarriage, lifespanLine, livingLabelFor, modeSummary } from "../chart/nodeDisplay";
import { useTreeCanvas } from "./useTreeCanvas";
import { ChartZoom } from "./ChartZoom";
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
import { lifespanTooltipOf } from "../gedcom/age";
import { ChartSettings } from "./ChartSettings";
import { ChartFindBox } from "./ChartFindBox";
import { useChartFind } from "./useChartFind";
import { marriedNameOverride, pedigreeVariant, useChartSettings } from "./ChartSettingsContext";
import { FanSiblingsToggle, PedigreeVariantTabs } from "./ChartKindTabs";
import { buildSiblingRow } from "../chart/siblingRow";
import { useNameOf, useSettingsSlice } from "./SettingsContext";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";
import { familyStepFor, isEditableTarget, isModalOpen } from "../keyboard/shortcuts";
import { familyStepTarget } from "../gedcom/familyNav";

// Colors on the plain Color axis: the ancestors' side (main pine green), the
// descendants' side (a step away from it, so a bowtie's two halves read
// apart), and modified (amber/minor). Any other axis colours by the shared
// colorer, and an edit shows as the "modified" badge alone.
/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["showKinship"] as const;

const COLOR_NORMAL = "var(--node-main)";
const COLOR_DESCENDANT = "var(--node-desc)";
const COLOR_MODIFIED = "var(--node-minor)";
/** A spouse's band on the descendant fan: neutral, like the ancestors'
 *  marriage collars — the spouse is not of the line, so the line's colour
 *  is not theirs. */
const COLOR_SPOUSE_BAND = "var(--muted)";

// Empty compare-side dataset — the tree builder needs a valid Dataset object
// but won't find any incoming individuals since all Maps are empty. Module-level
// so its identity is stable across renders (it sits in memo dep arrays).
const EMPTY_DS = emptyDataset();

const EMPTY_MAPS = {
  mainToCompare: new Map<string, string>(),
  compareToMain: new Map<string, string>(),
};

/** The direction row's choices: a direction, or the Complete Tree. */
type DirectionChoice = ChartDirection | "complete";

// ─── Component ────────────────────────────────────────────────────────────────

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
  /** The user's chosen direction — ancestors, descendants, or both at once
   *  (the bowtie) — owned by the Charts hub so it survives kind switches
   *  (including a round-trip through the relationship diagram). */
  direction: ChartDirection;
  onDirectionChange: (direction: ChartDirection) => void;
  /** Draw the Complete Tree (everyone connected, see `completeTree.ts`) in place
   *  of the direction — the layered chart only. Offered when the host can keep
   *  the choice (`onCompleteChange`). */
  complete?: boolean;
  onCompleteChange?: (complete: boolean) => void;
  /** The Charts-hub kind switcher, rendered in the controls row. */
  kindSwitcher?: React.ReactNode;
  /** Re-root on another person. The hub owns the root (and records it in browser
   *  history), so a re-root here comes back down as a new `rootId`. */
  onRootChange: (id: string) => void;
}

export function EditTree({ mainDs, rootId: currentRootId, startId, changedPersonIds, decisions, backLabel, onBack, onNavigate, direction, onDirectionChange, complete: completeChosen = false, onCompleteChange, kindSwitcher, onRootChange }: Props) {
  const { t } = useTranslation();
  // Identity-stable, so the memoized card contexts and the find box below don't
  // rebuild every render just because App passes a fresh callback.
  const changeRoot = useStableHandler(onRootChange);
  // A direction (button or A/D key) leaves the Complete Tree.
  const chooseDirection = useStableHandler((d: ChartDirection) => {
    onCompleteChange?.(false);
    onDirectionChange(d);
  });

  const { settings } = useChartSettings();
  const appSettings = useSettingsSlice(SETTINGS_KEYS);
  // Names read as the Name-display settings say (married surname, order, …) —
  // the same formatter the lists, the timeline and the reports use.
  const nameOf = useNameOf(marriedNameOverride(settings.showMarriedName));
  const livingNameOf = useLivingNameOf();
  const assocHover = useAssocHover(mainDs);
  const { alignment } = settings;
  // Grid is a layered chart (it reuses the tidy-tree SVG path); only the fan
  // kind (fan / circle) is radial.
  const radial = settings.type === "fan";
  const isGrid = !radial && settings.treeLayout === "grid";
  // "Both" is the bowtie: the layered chart draws the ancestors before the
  // root and the descendants after it; the radial chart shares one circle
  // between the two, ancestors up and descendants down. `mode` is the one
  // direction the single-direction code paths still read.
  // The Complete Tree replaces the direction while chosen; the fan has none.
  const complete = completeChosen && !radial;
  const bowtie = direction === "both" && !complete;
  const mode: TreeMode = complete ? "descendants" : direction === "both" ? "ancestors" : direction;
  // The radial bowtie is a full circle whatever the shape setting says.
  const variant = bowtie && radial ? "circle" : pedigreeVariant(settings);
  const rootPerson = mainDs.individuals.get(currentRootId);

  // Kinship-to-start resolver: one start-side pedigree walk, per-target caching —
  // labelling every node costs each person once, not two walks per node per render.
  const startKinship = useMemo(
    () => (startId ? createKinshipResolver(mainDs, startId, t) : undefined),
    [mainDs, startId, t],
  );
  // The labels on the chart are measured from the start person, or — the
  // user's choice — from the person the chart is rooted on, who then carries
  // none: "start person" is not what the root is. The title's kinship and the
  // bold direct line stay the start person's.
  const kinship = useMemo(() => {
    if (settings.kinshipFrom !== "root" || currentRootId === startId) return startKinship;
    if (!mainDs.individuals.has(currentRootId)) return undefined;
    const fromRoot = createKinshipResolver(mainDs, currentRootId, t);
    return { ...fromRoot, label: (id: string) => (id === currentRootId ? undefined : fromRoot.label(id)) };
  }, [settings.kinshipFrom, currentRootId, startId, startKinship, mainDs, t]);

  // Both directions build once per root/dataset: they feed the mode-button
  // head-counts and the current direction's chart, layered or radial — so
  // switching direction or chart type never rebuilds a tree.
  const trees = useMemo(
    () => ({
      ancestors: rootPerson ? buildPersonTree(t, rootPerson, undefined, mainDs, EMPTY_DS, EMPTY_MAPS, "ancestors", undefined, nameOf) : undefined,
      descendants: rootPerson ? buildPersonTree(t, rootPerson, undefined, mainDs, EMPTY_DS, EMPTY_MAPS, "descendants", undefined, nameOf) : undefined,
    }),
    [t, rootPerson, mainDs, nameOf],
  );
  // The root's brothers and sisters, for the radial bowtie's notches.
  const siblingsOn = bowtie && radial && settings.fanSiblings;
  const siblings = useMemo(
    () => (siblingsOn && rootPerson ? buildSiblingRow(t, rootPerson, mainDs, nameOf) : undefined),
    [siblingsOn, t, rootPerson, mainDs, nameOf],
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
  const tree = shown[mode];
  // How deep what is on screen goes: the bowtie's deeper half, else the
  // direction's tree.
  const shownDepth = bowtie ? Math.max(depths.ancestors, depths.descendants) : depths[mode];
  // Whether the limit actually cuts the chart on screen (a limit deeper than
  // the tree changes nothing, and shouldn't claim to).
  const limited = !complete && limit !== null && limit < shownDepth;
  // Everyone connected, built only while it is on screen: on a large file it is
  // the one pedigree view whose cost grows with the whole family, not one line.
  // It stops at COMPLETE_MAX_PEOPLE unless asked for everyone: past that a
  // large file opens in seconds rather than at once and pans unevenly
  // (measured: 20k boxes take ~9 s and ~24 fps, 7.8k ~3 s and 60 fps). The
  // choice holds per person, so a re-root starts capped again.
  const [completeAllFor, setCompleteAllFor] = useState<string | null>(null);
  const completeAll = completeAllFor === currentRootId;
  const completeTree = useMemo(
    () => (complete && rootPerson ? buildCompleteTree(t, rootPerson, mainDs, nameOf, completeAll ? Infinity : undefined) : undefined),
    [complete, completeAll, t, rootPerson, mainDs, nameOf],
  );
  // Kinship can only show when there's a start person to measure against, and
  // only for a chart with someone related to them on it; gate it so the box
  // height doesn't reserve an always-empty kinship row.
  const kinshipOn = settings.showKinship && appSettings.showKinship && !!kinship;
  const kinshipDrawn = useMemo(() => {
    if (!kinshipOn || !kinship) return false;
    const related = (n: TreeNode) => !!n.main && !!kinship.label(n.main.id);
    const roots = complete
      ? completeTree?.panels.map((p) => p.tree) ?? []
      : bowtie ? [shown.ancestors, shown.descendants] : [tree];
    return roots.some((root) => someTreeNode(root, related));
  }, [kinshipOn, kinship, complete, completeTree, bowtie, shown, tree]);
  const display = useMemo(() => ({ ...settings, showKinship: kinshipDrawn }), [settings, kinshipDrawn]);
  // Box height grows per enabled detail row (lifespan / place / kinship); thread it
  // through the layout, connectors, canvas centring, minimap, and the node boxes.
  const nodeH = nodeHeight(display);
  // What the "+N" marker says: the half decides who is missing, and the
  // tooltip names the limit that hid them.
  const hiddenTitleFor = useCallback(
    // `atLimit` lets a chart that ran out of room of its own (the radial rings)
    // name its own cap instead of the generation setting's.
    (half: TreeMode, count: number, atLimit?: number) =>
      t(half === "ancestors" ? "tree.node.hiddenAncestors" : "tree.node.hiddenDescendants", {
        count,
        limit: atLimit ?? limit ?? 0,
      }),
    [t, limit],
  );
  // The radial body hands the segment's key along, which says which half of
  // a bowtie the marker is on.
  const hiddenTitle = useCallback(
    (count: number, atLimit?: number, key?: string) =>
      hiddenTitleFor(bowtie && key ? bowtieHalf(key) : mode, count, atLimit),
    [hiddenTitleFor, bowtie, mode],
  );
  // The layered chart's marker knows its node, and so which half of a bowtie
  // it is on.
  const treeHiddenTitle = useCallback(
    (count: number, node: Placed) => hiddenTitleFor(bowtie ? bowtieHalf(node.key) : mode, count),
    [hiddenTitleFor, bowtie, mode],
  );

  const laid = useMemo<CompleteLaid | BowtieLaid | ReturnType<typeof layout> | undefined>(
    () =>
      complete
        ? completeTree && layoutComplete(completeTree, alignment, nodeH, isGrid)
        : bowtie && shown.ancestors && shown.descendants
          ? layoutBowtie(shown.ancestors, shown.descendants, alignment, nodeH, isGrid)
          : tree
            ? isGrid ? layoutGrid(tree, alignment, nodeH) : layout(tree, alignment, nodeH)
            : undefined,
    [complete, completeTree, bowtie, shown, tree, alignment, isGrid, nodeH],
  );
  const panels = laid && "panels" in laid ? laid.panels : undefined;
  const marriageLabel = useMemo(() => {
    if (!display.showMarriageDate && !display.showMarriagePlace) return undefined;
    const fields = { date: display.showMarriageDate, place: display.showMarriagePlace };
    // formatMarriage redacts a couple with a living partner itself; the node
    // being living says nothing about its parents' wedding.
    return (node: TreeNode) => formatMarriage(node.marriage, fields, display.privacyLiving);
  }, [display.showMarriageDate, display.showMarriagePlace, display.privacyLiving]);
  const flat = useMemo(
    () =>
      !laid
        ? undefined
        : "panels" in laid
          ? flattenComplete(laid, alignment, isGrid ? "elbow" : "curve", nodeH, marriageLabel)
          : isBowtie(laid)
          ? flattenBowtie(laid, alignment, isGrid ? "elbow" : "curve", nodeH, marriageLabel)
          : flatten(laid.root, alignment, isGrid ? "elbow" : "curve", nodeH, marriageLabel, mode === "ancestors"),
    [laid, alignment, isGrid, nodeH, marriageLabel, mode],
  );

  // What "print in sheets" splits: the layered charts only — a fan has no
  // rectangular branches to cut. It re-lays the very same tree the canvas
  // draws; a bowtie hands over both its halves.
  const sheetSource = useMemo(
    () =>
      complete
        ? completeTree?.panels.length
          ? { tree: completeTree.panels[0].tree, complete: completeTree, alignment, grid: isGrid, nodeH, marriageLabel, ancestors: false }
          : undefined
        : !radial && tree && (!bowtie || shown.descendants)
          ? { tree, bowtie: bowtie ? shown.descendants : undefined, alignment, grid: isGrid, nodeH, marriageLabel, ancestors: mode === "ancestors" }
          : undefined,
    [radial, bowtie, complete, completeTree, tree, shown, alignment, isGrid, nodeH, marriageLabel, mode],
  );

  // Everyone the Complete Tree covers, for its button — a walk over ids, not
  // the chart itself, so offering the button costs next to nothing.
  const completeCount = useMemo(
    () => (onCompleteChange ? connectedCount(mainDs, currentRootId) : 0),
    [onCompleteChange, mainDs, currentRootId],
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

  // Radial (fan / circle) chart of the current direction — reuses the prebuilt
  // tree, so switching direction is a re-layout, not a rebuild.
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
  const lineageOf = useCallback(
    (n: TreeNode) => (n.main ? kinship?.lineage(n.main.id) : undefined),
    [kinship],
  );
  const directOf = useCallback(
    (n: TreeNode) => (n.main ? startKinship?.direct(n.main.id) ?? false : false),
    [startKinship],
  );
  // Identity-stable across renders — the chart bodies are memoized, and an
  // inline arrow here would void that on every zoom/scroll tick.
  const hiddenJump = useCallback(
    (n: TreeNode) => { if (n.main) changeRoot(n.main.id); },
    [changeRoot],
  );
  const { fan, nodes: fanNodes, laid: fanLaid } = useFanChart(
    radial ? tree : undefined,
    settings.fanShape,
    { mode: bowtie ? "both" : mode, other: bowtie ? shown.descendants : undefined, siblings, hasPhoto, display, kinshipOf: fanKinshipOf },
  );

  // Where every drawn person sits (generation, family line), for the Color
  // axes that read the chart rather than the record. The layered bowtie's
  // ancestor half carries prefixed keys; the fan's segments resolve through
  // their tree node.
  const { positions, branchInfo } = useMemo(() => {
    // The Complete Tree's panels each start from their own top person, so the
    // generation and line come from the 3D network's walk out from the root
    // instead: generations counted from the root, the grandparent line (or
    // the partner's family) the walk reached each person through.
    if (complete) {
      const graph = buildFamilyGraph(mainDs, currentRootId, "connected", Infinity);
      const byId = new Map(graph.nodes.map((n) => [n.indi.id, n.pos]));
      const positions = new Map<string, NodePosition>();
      for (const n of flat?.nodes ?? []) {
        const pos = n.main && byId.get(n.main.id);
        if (pos) positions.set(n.key, pos);
      }
      return { positions, branchInfo: graphBranches(graph, mainDs, t, nameOf) };
    }
    const anc = !complete && (bowtie || mode === "ancestors") ? shown.ancestors : undefined;
    const desc = !complete && (bowtie || mode === "descendants") ? shown.descendants : undefined;
    const a = indexPositions(anc, "ancestors", bowtie && !radial ? "a:" : "");
    const d = indexPositions(desc, "descendants", "", a.positions, a.branches);
    return { positions: d.positions, branchInfo: d.branches };
  }, [complete, flat, mainDs, currentRootId, t, nameOf, bowtie, mode, radial, shown]);
  const positionOf = useCallback(
    (n: TreeNode, seg?: FanSegment): NodePosition | undefined => {
      if (!seg) return positions.get(n.key);
      const pos = fanPosition(seg, bowtie ? bowtieHalf(seg.key) : mode, positions);
      // A spouse's band rides beside the line, not on it: the chart-reading
      // axes leave them out, counts and all (see NodePosition.offLine).
      return seg.band ? { ...pos, offLine: true } : pos;
    },
    [positions, bowtie, mode],
  );
  const subjects = useMemo(
    () =>
      radial
        ? (fan?.segments ?? []).map((s) => ({ indi: s.node.main, pos: positionOf(s.node, s) }))
        : (flat?.nodes ?? []).map((n) => ({ indi: n.main, pos: positionOf(n) })),
    [radial, fan, flat, positionOf],
  );
  const colorer = useNodeColorer(mainDs, subjects, branchInfo);
  // On the plain axis everyone below the root takes the descendants' colour,
  // everyone else the main one, and an edited person shows the modified amber
  // wherever they are drawn. On any other axis the colorer decides and an
  // edit is the badge alone.
  const tint = colorer.axis === "plain" ? undefined : AXIS_TINT;
  const colorOf = useCallback(
    (n: TreeNode, seg?: FanSegment) => {
      if (seg?.band && CHART_AXES.has(colorer.axis) && !isModified(n)) return COLOR_SPOUSE_BAND;
      const pos = positionOf(n, seg);
      if (colorer.axis !== "plain") return colorer.colorFor(n.main, pos) ?? COLOR_NORMAL;
      return isModified(n) ? COLOR_MODIFIED : (pos?.gen ?? 0) < 0 ? COLOR_DESCENDANT : COLOR_NORMAL;
    },
    [colorer, positionOf, isModified],
  );

  const activeLaid = radial ? fanLaid : laid;
  const activeNodes = radial ? fanNodes : nodesByKey;

  // Viewport, grab-to-pan, zoom, root re-centring, and node selection.
  const { canvasRef, zoomLayerRef, viewport, panning, scrollTo, scrollBy, canvasProps, selectedKey, setSelectedKey, selectNode, revealNode, zoom, zoomIn, zoomOut, resetZoom, setZoomTo, fitToScreen } =
    useTreeCanvas(activeLaid, activeNodes, alignment, radial, nodeH, `${currentRootId}:${complete ? "complete" : bowtie ? "both" : mode}:${variant}:${alignment}`, bowtie || complete);

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

  // The selected person — a laid tree node, or a fan segment's ancestor node.
  // Both are `TreeNode`s (Placed extends TreeNode), so the panel reads them alike.
  const selected: TreeNode | undefined = radial
    ? fan?.segments.find((s) => s.key === selectedKey)?.node
    : selectedKey
      ? nodesByKey.get(selectedKey)
      : undefined;

  // The hover card: the person under the pointer, in full, plus the fields
  // the options show — the same lines the native tooltip carried, in the sex
  // colour and without the browser's delay and truncation.
  const hoverInfoFor = useCallback(
    (key: string): HoverInfo | undefined => {
      const n: TreeNode | undefined = radial ? fanNodes.get(key)?.node : nodesByKey.get(key);
      if (!n) return undefined;
      return hoverInfoFrom(
        display,
        {
          name: n.name,
          years: n.years,
          yearsApprox: n.yearsApprox,
          age: n.age,
          ageText: n.age !== undefined ? ageStandalone(t, n.sex, n.age) : undefined,
          place: n.place,
          address: n.address,
          kinship: fanKinshipOf(n),
          kinshipLineage: lineageOf(n),
          kinshipDirect: directOf(n),
          living: n.living,
          livingLabel: livingLabelFor(t, n.sex),
          livingName: n.living ? livingNameOf(n.main) : undefined,
        },
        n.sex,
        t("tree.node.clickHint"),
        () => assocHover(n.main),
      );
    },
    [radial, fanNodes, nodesByKey, display, t, fanKinshipOf, lineageOf, directOf, livingNameOf, assocHover],
  );

  // +/− zoom, 0 reset, F fit, A/D direction, E the selected person in Edit,
  // Esc leaves the page.
  const selectedMainId = selected?.main?.id;
  useChartShortcuts({
    zoomIn, zoomOut, resetZoom, fitToScreen, scrollBy,
    onMode: chooseDirection,
    onEdit: selectedMainId && onNavigate ? () => onNavigate(selectedMainId) : undefined,
    onLeave: onBack,
  });

  // ⌥ + arrows walk the family on the chart as they do in Edit — a parent up,
  // a child down, a sibling sideways, Shift for the other one on that axis —
  // from the person focused or selected, to the first position that draws
  // the relative. The step is a reveal (selected and centred) and the focus
  // moves with it, so the next step starts from there.
  const keyByPerson = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of findSources) {
      const id = s.people[0]?.id;
      if (id && !m.has(id)) m.set(id, s.key);
    }
    return m;
  }, [findSources]);
  const walkRef = useRef({ selectedKey, activeNodes, keyByPerson, revealNode, mainDs });
  walkRef.current = { selectedKey, activeNodes, keyByPerson, revealNode, mainDs };
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.defaultPrevented || isModalOpen() || isEditableTarget(e.target)) return;
      const step = familyStepFor(e.key, e.shiftKey);
      if (!step) return;
      const { selectedKey: sel, activeNodes: nodes, keyByPerson: keys, revealNode: reveal, mainDs: ds } = walkRef.current;
      const focusedKey = (document.activeElement as HTMLElement | null)?.closest?.("[data-key]")?.getAttribute("data-key");
      const fromKey = focusedKey ?? sel;
      const from = fromKey ? nodes.get(fromKey) : undefined;
      // A fan segment wraps its TreeNode; a laid node is one.
      const fromId = from ? ("node" in from ? from.node.main?.id : from.main?.id) : undefined;
      if (!fromId) return;
      const target = familyStepTarget(ds, fromId, step);
      const key = target ? keys.get(target) : undefined;
      if (!key) return;
      e.preventDefault();
      reveal(key);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const rootKinship = rootPerson ? startKinship?.label(rootPerson.id) : undefined;
  const rootLineage = rootPerson ? startKinship?.lineage(rootPerson.id) : undefined;
  const rootDirect = rootPerson ? startKinship?.direct(rootPerson.id) : undefined;

  // Chart "kind" label = direction — diagram type, e.g. "Ancestors — Fan Chart"
  // or "Bowtie — Tree", plus "4 of 9 generations" while the limit is cutting —
  // on the page and in every export header, so a partial chart never passes
  // for a whole one.
  const directionLabel = t(complete ? "tree.complete" : bowtie ? "tree.bowtie" : `tree.${mode}`);
  const chartKind =
    `${directionLabel} — ${t(`tree.kind.${variant}`)}` +
    (limited ? ` · ${t("tree.gen.shown", { n: limit, of: shownDepth })}` : "") +
    (completeTree?.truncated ? ` · ${t("tree.complete.truncated", { n: completeTree.people })}` : "");
  // The direction row: the two directions with their head-counts, and both at
  // once.
  const directions: SegmentedItem<DirectionChoice>[] = [
    {
      key: "ancestors",
      label: <>{t("tree.ancestors")}<span className="tree-mode-count">{peopleCounts.ancestors}</span></>,
      title: modeSummary(t, peopleCounts.ancestors, depths.ancestors),
    },
    {
      key: "descendants",
      label: <>{t("tree.descendants")}<span className="tree-mode-count">{peopleCounts.descendants}</span></>,
      title: modeSummary(t, peopleCounts.descendants, depths.descendants),
    },
    {
      key: "both",
      label: <>{t("tree.both")}<span className="tree-mode-count">{peopleCounts.ancestors + peopleCounts.descendants}</span></>,
      title: t("tree.both.tooltip"),
    },
    // Layered only: the fan has no panels to lay the families out in.
    ...(onCompleteChange && !radial
      ? [{
          key: "complete" as const,
          label: <>{t("tree.complete")}<span className="tree-mode-count">{completeCount}</span></>,
          title: t("tree.complete.tooltip"),
        }]
      : []),
  ];
  // The root's lifespan for the title, with the age appended when Age is on
  // (the title always shows the lifespan, so force it on here).
  const rootYears = tree
    ? lifespanLine({ showLifespan: true, showAge: display.showAge }, { years: tree.years, age: tree.age })
    : undefined;
  // Shared title for the SVG / PDF export header.
  // A root the privacy setting hides is named in the file as on the chart.
  const rootHidden = tree && hiddenName(t, display.privacyLiving, livingNameOf, tree.main ?? tree.incoming, tree.living, tree.sex);
  const exportName = rootHidden ?? tree?.name;
  const editTreeTitle = [exportName, rootHidden ? undefined : rootYears, "—", chartKind].filter(Boolean).join(" ");
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
            yearsApprox={tree.yearsApprox}
            yearsTitle={lifespanTooltipOf(rootPerson, display.showAge, t)}
            kinship={rootKinship}
            lineage={rootLineage}
            direct={rootDirect}
            kind={chartKind}
          />
        ) : (
          chartKind
        )
      }
      actions={
        <>
          <ChartSettings availableGenerations={shownDepth} kinshipFrom />
          <ChartExportMenu
            disabled={!activeLaid}
            slug={chartSlug(exportName, directionLabel)}
            title={editTreeTitle}
            legend={colorer.legend}
            gedcom={{ ds: mainDs, personIds: chartPersonIds }}
            canvasRef={canvasRef}
            sheets={sheetSource}
          />
        </>
      }
      controlsLeft={
        <>
          {kindSwitcher}
          <PedigreeVariantTabs hideShape={bowtie} />
          <Segmented
            label={t("tree.direction")}
            value={complete ? "complete" : bowtie ? "both" : mode}
            onChange={(k) => (k === "complete" ? onCompleteChange?.(true) : chooseDirection(k))}
            items={directions}
          />
          {bowtie && radial && <FanSiblingsToggle />}
        </>
      }
      controlsRight={
        <>
          {completeTree?.truncated && (
            <button
              className="nav-btn"
              onClick={() => setCompleteAllFor(currentRootId)}
              title={t("tree.complete.showAll.tooltip")}
            >
              {t("tree.complete.showAll", { n: completeCount })}
            </button>
          )}
          <ChartFindBox find={find} />
        </>
      }
    >
      <div className="tree-canvas-wrap">
        <ChartLegend entries={colorer.legend} tint={tint} />
        <div
          className={`tree-canvas${panning ? " panning" : ""}`}
          ref={canvasRef}
          {...canvasProps}
        >
          {radial ? (
            fan ? (
              <ChartZoom width={fan.width} height={fan.height} zoom={zoom} layerRef={zoomLayerRef}>
                <FanChartBody
                  chart={fan}
                  colorOf={colorOf}
                  tint={tint}
                  selectedKey={selectedKey}
                  flashKey={find.hitKey}
                  onSelect={selectNode}
                  mainRecords={mainDs.records}
                  mainRefCtx={mainRefCtx}
                  showRepeat
                  onRepeatJump={find.jumpTo}
                  hiddenTitle={hiddenTitle}
                  onHiddenJump={hiddenJump}
                  nativeTooltip={false}
                />
              </ChartZoom>
            ) : (
              <p className="muted">{t("tree.empty")}</p>
            )
          ) : laid && flat ? (
            <ChartZoom width={laid.width} height={laid.height} zoom={zoom} layerRef={zoomLayerRef}>
              <TreeSvg
                flat={flat}
                width={laid.width}
                height={laid.height}
                selectedKey={selectedKey}
                flashKey={find.hitKey}
                onSelect={selectNode}
                colorOf={colorOf}
                tint={tint}
                showRepeat
                onRepeatJump={find.jumpTo}
                hiddenTitle={treeHiddenTitle}
                onHiddenJump={hiddenJump}
                kinshipOf={fanKinshipOf}
                lineageOf={lineageOf}
                directOf={directOf}
                mainRecords={mainDs.records}
                mainRefCtx={mainRefCtx}
                display={display}
                nodeH={nodeH}
                nativeTooltip={false}
                panels={panels}
              />
            </ChartZoom>
          ) : (
            <p className="muted">{t("tree.empty")}</p>
          )}
        </div>

        <ChartHoverCard canvasRef={canvasRef} infoFor={hoverInfoFor} />

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
            frames={panels}
          />
        )}

        {activeLaid && (
          <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fitToScreen} onSetZoom={setZoomTo} />
        )}

        {selected && selected.main && (
          <TreeNodePanel
            node={selected}
            personId={selected.main?.id}
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

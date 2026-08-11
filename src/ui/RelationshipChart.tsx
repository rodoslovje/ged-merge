import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { isPresumedLiving, lifespanOf } from "../gedcom/lifespan";
import { lifespanAge } from "../gedcom/age";
import { PAD, nodeHeight } from "../chart/treeLayout";
import { formatMarriage, lifespanLine, placeLabel } from "../chart/nodeDisplay";
import { useTreeCanvas } from "./useTreeCanvas";
import { SelectMenu } from "./DropdownMenu";
import { ChartFindBox } from "./ChartFindBox";
import { useChartFind } from "./useChartFind";
import { createKinshipResolver, lineageClass } from "../match/kinship";
import { bloodPaths, shortestPath, type RelationshipPath } from "../match/relationshipPath";
import { buildRelationshipChart, type ChartBox } from "../chart/relationshipLayout";
import { individualFieldRows } from "../review/fields";
import { useNameOf } from "./SettingsContext";
import { sexClass } from "./sex";
import { StartPersonSelector } from "./StartPersonSelector";
import { TreeNodeBox } from "./TreeNodeBox";
import { TreeNodePanel } from "./TreeNodePanel";
import { ChartMinimap } from "./ChartMinimap";
import { ZoomControls } from "./ZoomControls";
import { chartSlug } from "./exportSvg";
import { ChartExportMenu } from "./ChartExportMenu";
import { ChartPage } from "./ChartPage";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings } from "./ChartSettingsContext";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";

const COLOR_SPINE = "var(--node-main)";
const COLOR_CONTEXT = "var(--faint)";

interface Props {
  mainDs: Dataset;
  startId: string;
  targetId: string;
  /** Main ids with unsaved edits — those boxes show the "M" badge. */
  /** Translated label for where Back lands (from the hub / App). */
  backLabel: string;
  onBack: () => void;
  /** Jump to a person in Edit mode (closes the chart). */
  onNavigate: (id: string) => void;
  /** The Charts-hub kind switcher, rendered under the toolbar. */
  kindSwitcher?: React.ReactNode;
  /** Reports target swaps up to the Charts hub, so switching to a pedigree
   *  chart roots on the person this diagram currently points at. */
  onTargetChange?: (id: string) => void;
}

interface PathOption {
  path: RelationshipPath;
  label: string;
}

/**
 * Full-page top-down "relationship to the start person" diagram: the chain of
 * people connecting the start person to the target, drawn as two vertical rails
 * (start's line and the target's line) joined at the common-ancestor couple, with
 * parent couples beside each rail. A selector offers the shortest route plus
 * every distinct bloodline; clicking a person opens the shared detail panel.
 */
export function RelationshipChart({ mainDs, startId, targetId, backLabel, onBack, onNavigate, kindSwitcher, onTargetChange }: Props) {
  const { t } = useTranslation();
  const formatName = useNameOf();
  const [optionIdx, setOptionIdx] = useState(0);
  // Either endpoint can be swapped on this page without touching the app's start
  // person; the local picks reset whenever the page is (re)opened for a new pair.
  const [startSel, setStartSel] = useState(startId);
  const [targetSel, setTargetSel] = useState(targetId);
  const [picking, setPicking] = useState<"start" | "target" | null>(null);
  useEffect(() => setStartSel(startId), [startId]);
  useEffect(() => setTargetSel(targetId), [targetId]);

  const replace = useCallback(
    (side: "start" | "target", id: string) => {
      (side === "start" ? setStartSel : setTargetSel)(id);
      if (side === "target") onTargetChange?.(id);
      setOptionIdx(0);
      setPicking(null);
    },
    [onTargetChange],
  );

  const nameOf = useCallback(
    (id: string) => {
      const indi = mainDs.individuals.get(id);
      return indi ? formatName(indi) : id;
    },
    [mainDs, formatName],
  );
  const yearsOf = (id: string) => {
    const indi = mainDs.individuals.get(id);
    if (!indi) return undefined;
    // The endpoint always shows the lifespan; Age appends "(N)" when it's on.
    return lifespanLine(
      { showLifespan: true, showAge: settings.showAge },
      { years: lifespanOf(indi), age: lifespanAge(indi) },
    );
  };

  // Shortest path + every distinct bloodline, deduped (a shortest path that is
  // already a pure bloodline isn't listed twice).
  const options = useMemo<PathOption[]>(() => {
    const blood = bloodPaths(mainDs, startSel, targetSel);
    const opts: PathOption[] = blood.map((path) => ({
      path,
      label: t("relpath.optBlood", { name: nameOf(path.steps[path.lcaIndex!].id), count: path.hops }),
    }));
    const shortest = shortestPath(mainDs, startSel, targetSel);
    if (shortest && !blood.some((b) => sameSteps(b, shortest))) {
      // A bloodline can never be shorter than the general shortest path, only
      // equal or longer. Insert before the first bloodline that's strictly
      // longer, so equal-length bloodlines stay ahead of it — a tie in step
      // count still defaults to the blood relationship (index 0).
      const insertAt = blood.findIndex((b) => b.hops > shortest.hops);
      opts.splice(insertAt === -1 ? opts.length : insertAt, 0, {
        path: shortest,
        label: t("relpath.optShortest", { count: shortest.hops }),
      });
    }
    return opts;
  }, [mainDs, startSel, targetSel, t, nameOf]);

  const settings = useChartSettings().settings;
  const { alignment } = settings;
  const nodeH = nodeHeight(settings);
  // Marriage label fields, when either toggle is on (else no labels are drawn).
  const marriageFields =
    settings.showMarriageDate || settings.showMarriagePlace
      ? { date: settings.showMarriageDate, place: settings.showMarriagePlace }
      : undefined;
  const current = options[Math.min(optionIdx, options.length - 1)]?.path;
  const chart = useMemo(
    () => (current ? buildRelationshipChart(mainDs, current, alignment, nodeH, formatName) : undefined),
    [mainDs, current, alignment, nodeH, formatName],
  );

  // The chart boxes keyed for `useTreeCanvas` (they satisfy ChartNode
  // structurally). The start box pins the initial scroll.
  const nodesByKey = useMemo(() => {
    const m = new Map<string, ChartBox>();
    for (const b of chart?.boxes ?? []) m.set(b.key, b);
    return m;
  }, [chart]);
  const laid = useMemo(
    () =>
      chart
        ? { root: nodesByKey.get(chart.rootKey) ?? chart.boxes[0], width: chart.width, height: chart.height }
        : undefined,
    [chart, nodesByKey],
  );

  const { canvasRef, viewport, panning, scrollTo, canvasProps, selectedKey, setSelectedKey, selectNode, revealNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(laid, nodesByKey, alignment, false, nodeH);

  // Find-in-chart. This diagram only draws one route, so somebody off it is the
  // usual case — finding them makes them the new target, redrawing the route.
  const findSources = useMemo(
    () => (chart?.boxes ?? []).map((b) => ({ key: b.key, people: [mainDs.individuals.get(b.id)] })),
    [chart, mainDs],
  );
  const retarget = useCallback((id: string) => replace("target", id), [replace]);
  const find = useChartFind(findSources, mainDs.individuals, revealNode, retarget);

  // +/− zoom, 0 reset, F fit, Esc leaves (kind digits are the Charts hub's).
  useChartShortcuts({ zoomIn, zoomOut, resetZoom, fitToScreen, onLeave: onBack });

  const selectedBox = chart?.boxes.find((b) => b.key === selectedKey);
  const selectedIndi = selectedBox ? mainDs.individuals.get(selectedBox.id) : undefined;
  const selectedRows = useMemo(
    () => (selectedIndi ? individualFieldRows(t, selectedIndi, undefined, mainDs) : []),
    [t, selectedIndi, mainDs],
  );

  // Kinship-to-start resolver: one start-side pedigree walk, per-target caching
  // (every box on the chart carries a kinship label).
  const kinshipOf = useMemo(() => createKinshipResolver(mainDs, startSel, t), [mainDs, startSel, t]);
  const kinship = kinshipOf.label(targetSel);
  const kinshipLineage = kinshipOf.lineage(targetSel);
  // Shared title for the SVG / PDF export header, and the download slug.
  const relchartTitle = `${nameOf(startSel)} → ${nameOf(targetSel)} — ${t("relpath.pageTitle")}`;
  const relchartSlug = chartSlug(nameOf(startSel), nameOf(targetSel), t("relpath.pageTitle"));

  // A title endpoint: the person's name + lifespan, clickable to swap that side.
  const renderEndpoint = (side: "start" | "target", id: string) => {
    const indi = mainDs.individuals.get(id);
    return (
      <button
        type="button"
        className={`relchart-endpoint${picking === side ? " active" : ""}`}
        onClick={() => setPicking(picking === side ? null : side)}
        title={t("relpath.replace")}
      >
        <span className={`tree-title-name ${sexClass(indi?.sex)}`}>{nameOf(id)}</span>
        {yearsOf(id) && <span className="tree-title-years gm-data">{yearsOf(id)}</span>}
        <span className="relchart-endpoint-edit" aria-hidden="true">✎</span>
      </button>
    );
  };

  return (
    <ChartPage
      backLabel={backLabel}
      onBack={onBack}
      title={
        <>
          {renderEndpoint("start", startSel)}
          <span className="tree-title-arrow" aria-hidden="true">→</span>
          {renderEndpoint("target", targetSel)}
          {kinship && <span className={`tree-title-kinship ${lineageClass(kinshipLineage)}`}>{kinship}</span>}
          <span className="tree-title-kind">{t("relpath.pageTitle")}</span>
        </>
      }
      actions={
        <>
          <ChartSettings lockedType="tree" />
          <ChartExportMenu
            disabled={!chart}
            slug={relchartSlug}
            title={relchartTitle}
            gedcom={{ ds: mainDs, personIds: chart?.boxes.map((b) => b.id) ?? [] }}
            canvasRef={canvasRef}
          />
        </>
      }
      controlsLeft={kindSwitcher}
      controlsRight={<ChartFindBox find={find} />}
    >
      {picking && (
        <div className="tree-controls relchart-picker-bar">
          <span className="relchart-picker-label">
            {picking === "start" ? t("relpath.replaceStart") : t("relpath.replaceTarget")}
          </span>
          <StartPersonSelector
            key={picking}
            individuals={mainDs.individuals}
            startId={picking === "start" ? startSel : targetSel}
            onChange={(newId) => replace(picking, newId)}
            icon="search"
            autoFocus
            selectedAsPlaceholder={false}
            placeholder={t("relpath.searchPerson")}
            tooltip={t("relpath.searchPerson")}
          />
          <button
            className="relchart-picker-cancel"
            onClick={() => setPicking(null)}
            title={t("tree.close")}
            aria-label={t("tree.close")}
          >
            ×
          </button>
        </div>
      )}

      {options.length > 1 && (
        <div className="tree-controls">
          <label className="relchart-paths">
            {t("relpath.availablePaths")}
            <SelectMenu
              value={String(optionIdx)}
              onChange={(v) => setOptionIdx(Number(v))}
              options={options.map((o, i) => ({ value: String(i), label: o.label }))}
            />
          </label>
        </div>
      )}

      <div className="tree-canvas-wrap">
        <div className={`tree-canvas${panning ? " panning" : ""}`} ref={canvasRef} {...canvasProps}>
          {chart ? (
            <svg className="tree-svg" width={chart.width * zoom} height={chart.height * zoom} viewBox={`0 0 ${chart.width} ${chart.height}`} role="img">
              <g transform={`translate(${PAD},${PAD})`}>
                {chart.links.map((e) => (
                  <path key={e.id} className={`relchart-edge relchart-edge-${e.kind}`} d={e.d} />
                ))}
                {marriageFields &&
                  chart.links.map((e) => {
                    const text = e.mid && formatMarriage(e.marriage, marriageFields);
                    return text && e.mid ? (
                      <text
                        key={`${e.id}-m`}
                        className="tree-edge-label gm-data"
                        x={e.mid.x}
                        y={e.mid.y}
                        textAnchor="middle"
                        dominantBaseline="central"
                      >
                        {text}
                      </text>
                    ) : null;
                  })}
                {chart.boxes.map((b) => {
                  const color = b.onSpine ? COLOR_SPINE : COLOR_CONTEXT;
                  const indi = mainDs.individuals.get(b.id);
                  return (
                    <g
                      key={b.key}
                      transform={`translate(${b.x},${b.y})`}
                      className={`tree-node relchart-node${b.key === selectedKey ? " selected" : ""}${b.key === find.hitKey ? " find-hit" : ""}${b.role ? ` is-${b.role}` : ""}`}
                      onClick={() => selectNode(b.key)}
                    >
                      <title>{t("tree.node.clickHint")}</title>
                      <TreeNodeBox
                        name={b.name}
                        years={b.years}
                        age={lifespanAge(indi)}
                        place={placeLabel(indi)}
                        sex={b.sex}
                        color={color}
                        strokeWidth={b.onSpine ? 2.5 : 1.5}
                        kinship={kinshipOf.label(b.id)}
                        kinshipLineage={kinshipOf.lineage(b.id)}
                        photo={indi ? { node: { main: { raw: indi.raw } }, mainRecords: mainDs.records, mainRefCtx: { dataset: mainDs, onNavigate } } : undefined}
                        display={settings}
                        living={isPresumedLiving(indi, mainDs) || !!indi?.private}
                        nodeH={nodeH}
                      />
                    </g>
                  );
                })}
              </g>
            </svg>
          ) : (
            <p className="muted">{t("relpath.none")}</p>
          )}
        </div>

        {chart && (
          <ChartMinimap
            contentW={chart.width}
            contentH={chart.height}
            viewport={viewport}
            zoom={zoom}
            nodes={chart.boxes}
            fill={(b) => (b.onSpine ? COLOR_SPINE : COLOR_CONTEXT)}
            nodeH={nodeH}
            onScrollTo={scrollTo}
          />
        )}

        {chart && (
          <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fitToScreen} onReset={resetZoom} />
        )}

        {selectedBox && selectedIndi && (
          <TreeNodePanel
            node={selectedBox}
            swatch={selectedBox.onSpine ? COLOR_SPINE : COLOR_CONTEXT}
            rows={selectedRows}
            mainPerson={{ linkable: (id) => mainDs.individuals.has(id), onNavigate }}
            mainLabel={t("tree.main")}
            singleColumn
            kinship={kinshipOf.label(selectedBox.id)}
            kinshipLineage={lineageClass(kinshipOf.lineage(selectedBox.id))}
            onClose={() => setSelectedKey(null)}
            onSetRoot={() => onNavigate(selectedBox.id)}
            rootLabel={t("relpath.openInEdit")}
          />
        )}
      </div>
    </ChartPage>
  );
}

function sameSteps(a: RelationshipPath, b: RelationshipPath): boolean {
  return a.steps.length === b.steps.length && a.steps.every((s, i) => s.id === b.steps[i].id);
}

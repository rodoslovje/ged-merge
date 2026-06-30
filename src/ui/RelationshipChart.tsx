import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { isPresumedLiving, lifespanOf } from "../gedcom/lifespan";
import { PAD, minimapDefaultOpen, nodeHeight, type Placed } from "../tree/treeLayout";
import { formatMarriage, placeLabel } from "../tree/nodeDisplay";
import { useTreeCanvas } from "../tree/useTreeCanvas";
import { kinshipLabel, lineageClass } from "../match/kinship";
import { bloodLineage, bloodPaths, shortestPath, type RelationshipPath } from "../match/relationshipPath";
import { buildRelationshipChart, type ChartBox } from "../match/relationshipChartLayout";
import { individualFieldRows } from "../review/fields";
import { useNameOf } from "./SettingsContext";
import { sexClass } from "./sex";
import { HomePersonSelector } from "./HomePersonSelector";
import { TreeNodeBox } from "./TreeNodeBox";
import { TreeNodePanel } from "./TreeNodePanel";
import { TreeMinimap } from "./TreeMinimap";
import { ZoomControls } from "./ZoomControls";
import { MapIcon } from "./icons/MapIcon";
import { diagramSlug, exportCanvasPdf, exportCanvasSvg } from "./exportSvg";
import { DownloadIcon } from "./icons/DownloadIcon";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings } from "./ChartSettingsContext";

const COLOR_SPINE = "var(--node-master)";
const COLOR_CONTEXT = "var(--faint)";

interface Props {
  masterDs: Dataset;
  homeId: string;
  targetId: string;
  onBack: () => void;
  /** Jump to a person in Edit mode (closes the chart). */
  onNavigate: (id: string) => void;
}

interface PathOption {
  path: RelationshipPath;
  label: string;
}

/**
 * Full-page top-down "relationship to the home person" diagram: the chain of
 * people connecting the home person to the target, drawn as two vertical rails
 * (home's line and the target's line) joined at the common-ancestor couple, with
 * parent couples beside each rail. A selector offers the shortest route plus
 * every distinct bloodline; clicking a person opens the shared detail panel.
 */
export function RelationshipChart({ masterDs, homeId, targetId, onBack, onNavigate }: Props) {
  const { t } = useTranslation();
  const formatName = useNameOf();
  const [optionIdx, setOptionIdx] = useState(0);
  // Either endpoint can be swapped on this page without touching the app's home
  // person; the local picks reset whenever the page is (re)opened for a new pair.
  const [homeSel, setHomeSel] = useState(homeId);
  const [targetSel, setTargetSel] = useState(targetId);
  const [picking, setPicking] = useState<"home" | "target" | null>(null);
  useEffect(() => setHomeSel(homeId), [homeId]);
  useEffect(() => setTargetSel(targetId), [targetId]);

  const replace = (side: "home" | "target", id: string) => {
    (side === "home" ? setHomeSel : setTargetSel)(id);
    setOptionIdx(0);
    setPicking(null);
  };

  const nameOf = (id: string) => {
    const indi = masterDs.individuals.get(id);
    return indi ? formatName(indi) : id;
  };
  const yearsOf = (id: string) => {
    const indi = masterDs.individuals.get(id);
    return (indi && lifespanOf(indi)) || undefined;
  };

  // Shortest path + every distinct bloodline, deduped (a shortest path that is
  // already a pure bloodline isn't listed twice).
  const options = useMemo<PathOption[]>(() => {
    const blood = bloodPaths(masterDs, homeSel, targetSel);
    const opts: PathOption[] = blood.map((path) => ({
      path,
      label: t("relpath.optBlood", { name: nameOf(path.steps[path.lcaIndex!].id), count: path.hops }),
    }));
    const shortest = shortestPath(masterDs, homeSel, targetSel);
    if (shortest && !blood.some((b) => sameSteps(b, shortest))) {
      opts.unshift({ path: shortest, label: t("relpath.optShortest", { count: shortest.hops }) });
    }
    return opts;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterDs, homeSel, targetSel, t]);

  const settings = useChartSettings().settings;
  const { alignment } = settings;
  const nodeH = nodeHeight(settings);
  // Marriage label fields, when either toggle is on (else no labels are drawn).
  const marriageFields =
    settings.showMarriageDate || settings.showMarriagePlace
      ? { date: settings.showMarriageDate, place: settings.showMarriagePlace }
      : undefined;
  const livingLabel = t("tree.node.living");
  const current = options[Math.min(optionIdx, options.length - 1)]?.path;
  const chart = useMemo(
    () => (current ? buildRelationshipChart(masterDs, current, alignment, nodeH) : undefined),
    [masterDs, current, alignment, nodeH],
  );

  // Adapt the chart boxes to the shapes `useTreeCanvas` / `TreeMinimap` expect
  // (they only read key/x/y). The home box pins the initial scroll.
  const nodesByKey = useMemo(() => {
    const m = new Map<string, Placed>();
    for (const b of chart?.boxes ?? []) m.set(b.key, b as unknown as Placed);
    return m;
  }, [chart]);
  const laid = useMemo(
    () =>
      chart
        ? { root: (nodesByKey.get(chart.rootKey) ?? chart.boxes[0]) as unknown as Placed, width: chart.width, height: chart.height }
        : undefined,
    [chart, nodesByKey],
  );

  const { canvasRef, viewport, panning, scrollTo, canvasProps, selectedKey, setSelectedKey, selectNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(laid, nodesByKey, alignment, false, nodeH);
  // null = follow the automatic default (collapsed unless the chart dwarfs the
  // screen); true/false once the user has toggled it by hand.
  const [mapOpen, setMapOpen] = useState<boolean | null>(null);

  const selectedBox = chart?.boxes.find((b) => b.key === selectedKey);
  const selectedIndi = selectedBox ? masterDs.individuals.get(selectedBox.id) : undefined;
  const selectedRows = useMemo(
    () => (selectedIndi ? individualFieldRows(t, selectedIndi, undefined, masterDs) : []),
    [t, selectedIndi, masterDs],
  );

  const kinship = kinshipLabel(masterDs, homeSel, targetSel, t);
  const kinshipLineage = bloodLineage(masterDs, homeSel, targetSel);
  // Shared title for the SVG / PDF export header.
  const relchartTitle = `${nameOf(homeSel)} → ${nameOf(targetSel)} — ${t("relpath.pageTitle")}`;
  const needsMinimap =
    !!chart && viewport.width > 0 &&
    (chart.width * zoom > viewport.width + 1 || chart.height * zoom > viewport.height + 1);
  const minimapOpen = mapOpen ?? (!!chart && minimapDefaultOpen(chart.width, chart.height, viewport));

  // A title endpoint: the person's name + lifespan, clickable to swap that side.
  const renderEndpoint = (side: "home" | "target", id: string) => {
    const indi = masterDs.individuals.get(id);
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
    <div className="tree-page">
      <div className="tree-toolbar">
        <button className="tree-open-btn tree-back-btn" onClick={onBack} title={t("edit.tree.back")} aria-label={t("edit.tree.back")}>
          ← <span className="tree-back-label">{t("edit.tree.back")}</span>
        </button>
        <h2 className="tree-title">
          {renderEndpoint("home", homeSel)}
          <span className="tree-title-arrow" aria-hidden="true">→</span>
          {renderEndpoint("target", targetSel)}
          {kinship && <span className={`tree-title-kinship ${lineageClass(kinshipLineage)}`}>{kinship}</span>}
          <span className="tree-title-kind">{t("relpath.pageTitle")}</span>
        </h2>
        <ChartSettings lockedType="tree" />
        <button
          className="tree-open-btn tree-export-btn"
          onClick={() => exportCanvasSvg(
            canvasRef.current,
            diagramSlug(nameOf(homeSel), nameOf(targetSel), t("relpath.pageTitle")),
            relchartTitle,
          )}
          disabled={!chart}
          title={t("tree.export.tooltip")}
        >
          <DownloadIcon /> {t("tree.export")}
        </button>
        <button
          className="tree-open-btn tree-export-btn"
          onClick={() => exportCanvasPdf(
            canvasRef.current,
            diagramSlug(nameOf(homeSel), nameOf(targetSel), t("relpath.pageTitle")),
            relchartTitle,
          )}
          disabled={!chart}
          title={t("tree.exportPdf.tooltip")}
        >
          <DownloadIcon /> {t("tree.exportPdf")}
        </button>
      </div>

      {picking && (
        <div className="tree-controls relchart-picker-bar">
          <span className="relchart-picker-label">
            {picking === "home" ? t("relpath.replaceHome") : t("relpath.replaceTarget")}
          </span>
          <HomePersonSelector
            key={picking}
            individuals={masterDs.individuals}
            homeId={picking === "home" ? homeSel : targetSel}
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
            <select value={optionIdx} onChange={(e) => setOptionIdx(Number(e.target.value))}>
              {options.map((o, i) => (
                <option key={i} value={i}>{o.label}</option>
              ))}
            </select>
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
                  const indi = masterDs.individuals.get(b.id);
                  return (
                    <g
                      key={b.key}
                      transform={`translate(${b.x},${b.y})`}
                      className={`tree-node relchart-node${b.key === selectedKey ? " selected" : ""}${b.role ? ` is-${b.role}` : ""}`}
                      onClick={() => selectNode(b.key)}
                    >
                      <title>{t("tree.node.clickHint")}</title>
                      <TreeNodeBox
                        name={b.name}
                        years={b.years}
                        place={placeLabel(indi)}
                        sex={b.sex}
                        color={color}
                        strokeWidth={b.onSpine ? 2.5 : 1.5}
                        kinship={kinshipLabel(masterDs, homeSel, b.id, t)}
                        kinshipLineage={bloodLineage(masterDs, homeSel, b.id)}
                        photo={indi ? { raw: indi.raw, records: masterDs.records, refCtx: { dataset: masterDs, onNavigate } } : undefined}
                        display={settings}
                        living={isPresumedLiving(indi)}
                        livingLabel={livingLabel}
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

        {needsMinimap && chart && (
          minimapOpen ? (
            <div className="tree-minimap-box">
              <button className="tree-minimap-collapse" onClick={() => setMapOpen(false)} title={t("tree.minimap.hide")} aria-label={t("tree.minimap.hide")}>
                ×
              </button>
              <TreeMinimap
                nodes={chart.boxes as unknown as Placed[]}
                contentW={chart.width}
                contentH={chart.height}
                viewport={viewport}
                onScrollTo={scrollTo}
                fill={(n) => ((n as unknown as ChartBox).onSpine ? COLOR_SPINE : COLOR_CONTEXT)}
                nodeH={nodeH}
                zoom={zoom}
              />
            </div>
          ) : (
            <button className="tree-minimap-show" onClick={() => setMapOpen(true)} title={t("tree.minimap.show")} aria-label={t("tree.minimap.show")}>
              <MapIcon />
            </button>
          )
        )}

        {chart && (
          <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fitToScreen} onReset={resetZoom} />
        )}

        {selectedBox && selectedIndi && (
          <TreeNodePanel
            node={selectedBox as unknown as Placed}
            swatch={selectedBox.onSpine ? COLOR_SPINE : COLOR_CONTEXT}
            rows={selectedRows}
            masterPerson={{ linkable: (id) => masterDs.individuals.has(id), onNavigate }}
            masterLabel={t("tree.master")}
            singleColumn
            kinship={kinshipLabel(masterDs, homeSel, selectedBox.id, t)}
            kinshipLineage={lineageClass(bloodLineage(masterDs, homeSel, selectedBox.id))}
            onClose={() => setSelectedKey(null)}
            onSetRoot={() => onNavigate(selectedBox.id)}
            rootLabel={t("relpath.openInEdit")}
          />
        )}
      </div>
    </div>
  );
}

function sameSteps(a: RelationshipPath, b: RelationshipPath): boolean {
  return a.steps.length === b.steps.length && a.steps.every((s, i) => s.id === b.steps[i].id);
}

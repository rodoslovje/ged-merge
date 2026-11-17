import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { birthYear, deathYear, lifespanApproxOf } from "../gedcom/lifespan";
import { lifespanTooltipOf } from "../gedcom/age";
import type { TreeNode } from "../chart/personTree";
import { familyDepth } from "../chart/timeline";
import { bandYear, blurYear, layoutLineage, type LineagePoint } from "../chart/lineageYears";
import { livingLabelFor } from "../chart/nodeDisplay";
import { PAD, type ChartNode } from "../chart/treeLayout";
import { createKinshipResolver, lineageClass } from "../match/kinship";
import { individualFieldRows } from "../review/fields";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";
import { useTreeCanvas } from "./useTreeCanvas";
import { ChartZoom } from "./ChartZoom";
import { ChartFindBox } from "./ChartFindBox";
import { useChartFind } from "./useChartFind";
import { ChartPage } from "./ChartPage";
import { ChartRootTitle } from "./ChartRootTitle";
import { TreeNodePanel } from "./TreeNodePanel";
import { ZoomControls } from "./ZoomControls";
import { chartSlug } from "./exportSvg";
import { ChartExportMenu } from "./ChartExportMenu";
import { ChartSettings } from "./ChartSettings";
import { TimelineLayoutTabs } from "./ChartKindTabs";
import { useChartSettings } from "./ChartSettingsContext";
import { useBloodTrees } from "./useBloodTrees";
import { useNodeColorer } from "./useNodeColorer";
import { ChartLegend } from "./ChartLegend";
import { useStableHandler } from "./edit/useStableHandler";
import { usePublishedSettings } from "./PublishedView";
import { sexClass, sexColorVar } from "./sex";
import { useHistoryEvents } from "./useHistoryEvents";

// The Timeline's "Lines" layout: the root person's blood line on a vertical
// year axis — ancestors at their birth year converging down onto the root,
// descendants branching out below — each parent joined to their child by a
// curve. The data and slots come from chart/lineageYears; this file turns them
// into pixels and wires the shared chart page (settings, find, export, the
// person panel) around them.

// ── Geometry (native, pre-zoom pixels) ───────────────────────────────────────
/** Width of one leaf slot. */
const SLOT_W = 58;
/** Height of a year — the least, and the most the historical-event labels may
 *  stretch it to so they fit one column (a year apart takes 12). */
const PX_PER_YEAR = 6;
const PX_PER_YEAR_MAX = 14;
/** The year column on the left. */
const AXIS_W = 46;
const TOP = 16;
/** Room right of the last slot for its name. */
const LABEL_ROOM = 150;
/** The band under the year scale for people with no year to stand at. */
const UNDATED_GAP = 46;
const DOT_R = 4.5;
const ROOT_R = 7;
const TICK_STEP = 10;
/** Estimated width per character of an 11px label, for collision checks. */
const CHAR_W = 6.4;
const LABEL_H = 12;

const COLOR_ANCESTOR = "var(--node-main)";
const COLOR_DESCENDANT = "var(--node-desc)";


interface Props {
  mainDs: Dataset;
  rootId: string;
  startId?: string;
  backLabel: string;
  onBack: () => void;
  onNavigate?: (id: string) => void;
  kindSwitcher?: React.ReactNode;
  onRootChange: (id: string) => void;
}

/** A point with its pixel position and whether its label fits. */
interface Placed extends LineagePoint, ChartNode {
  label: boolean;
}

export function TimelineLines({ mainDs, rootId, startId, backLabel, onBack, onNavigate, kindSwitcher, onRootChange }: Props) {
  const { t } = useTranslation();
  const { settings } = useChartSettings();
  const changeRoot = useStableHandler(onRootChange);
  const limit = settings.maxGenerations;
  const reduced = usePublishedSettings()?.reduced;

  // The blood line both ways, and the family lines the Color axes read: a
  // grandparent's line above the root, a child's below.
  const trees = useBloodTrees(mainDs, rootId);
  const { positions, branches } = trees;
  const depth = useMemo(() => familyDepth(mainDs, rootId), [mainDs, rootId]);

  // A living person shown without details keeps their year off the chart too:
  // on a year axis the dot's height *is* the birth year.
  // The family website's people shown without details: none of their own
  // dates is read — they stand where their generation puts them.
  const withheld = useCallback((n: TreeNode) => !!n.main && !!reduced?.has(n.main.id), [reduced]);
  const redacted = useCallback(
    (n: TreeNode) => (settings.privacyLiving && n.living) || withheld(n),
    [settings.privacyLiving, withheld],
  );
  const layout = useMemo(() => {
    // A living person under the privacy setting stands at the middle of their
    // birth decade — near enough to read the generations, ±5 years from the
    // truth. The blurred year is also what their undated relatives are
    // estimated from, so no estimate leads back to the real one.
    const l = layoutLineage(trees.ancestors, trees.descendants, (n) => {
      if (withheld(n)) return undefined;
      const year = birthYear(n.main);
      return year !== undefined && redacted(n) ? blurYear(year) : year;
    });
    const points = l.points.map((p) =>
      // Nothing of their own was read (yearOf gave none): any year they have
      // is stepped in from dated relatives, a generation at a time, and is
      // shown only as the 25-year band it falls in.
      withheld(p.node)
        ? { ...p, year: p.year === undefined ? undefined : bandYear(p.year), estimated: false }
        : redacted(p.node) && p.year !== undefined
          ? { ...p, year: blurYear(p.year), estimated: false }
          : p,
    );
    // Hidden siblings on the same blurred year: each younger one (the trees
    // list children oldest first) moves on two years, as on the bars.
    const taken = new Map<string, number>();
    for (const p of points) {
      if (p.year === undefined || !redacted(p.node)) continue;
      const key = `${p.node.main?.childOf[0] ?? p.key}:${p.year}`;
      const n = taken.get(key) ?? 0;
      taken.set(key, n + 1);
      p.year += 2 * n;
    }
    const years = points.flatMap((p) => (p.year === undefined ? [] : [p.year]));
    return {
      ...l,
      points,
      minYear: years.length ? Math.min(...years) : undefined,
      maxYear: years.length ? Math.max(...years) : undefined,
    };
  }, [trees, redacted, withheld]);

  // The year scale, whole decades either side of the dated people — down to
  // the last death, or today, while the lifelines hang below the births.
  const nowYear = new Date().getFullYear();
  const lifelines = settings.timelineLifelines;
  const lastYear = useMemo(() => {
    if (layout.maxYear === undefined || !lifelines) return layout.maxYear;
    let last = layout.maxYear;
    for (const p of layout.points) {
      if (p.year === undefined) continue;
      const end = deathYear(p.node.main) ?? (p.node.living ? nowYear : undefined);
      if (end !== undefined && end > last) last = end;
    }
    return last;
  }, [layout, lifelines, nowYear]);
  const y0 = layout.minYear === undefined ? undefined : Math.floor(layout.minYear / TICK_STEP) * TICK_STEP;
  const y1 = lastYear === undefined ? undefined : Math.ceil(lastYear / TICK_STEP) * TICK_STEP;

  // Historical events over those years, by where the chart's people lived.
  const people = useMemo(
    () =>
      layout.points.flatMap((p) =>
        p.node.main && p.year !== undefined
          ? [{ id: p.node.main.id, from: p.year, to: deathYear(p.node.main) ?? (p.node.living ? nowYear : p.year + 70) }]
          : [],
      ),
    [layout, nowYear],
  );
  const history = useHistoryEvents(mainDs, people, y0, y1);
  // Their labels get a space of their own between the year scale and the
  // people — over the drawing they would sit on the first ancestors' names —
  // in one column. Where two events stand closer than a label's height, the
  // decades grow taller until they don't (up to a limit). Events of the very
  // same year — or closer than the limit allows — step down one under the
  // other.
  const { historyLabels, historyW, pxPerYear } = useMemo(() => {
    if (y0 === undefined || !history.length) return { historyLabels: [], historyW: 0, pxPerYear: PX_PER_YEAR };
    let px = PX_PER_YEAR;
    for (let i = 1; i < history.length; i++) {
      const gap = history[i].from - history[i - 1].from;
      if (gap > 0) px = Math.max(px, LABEL_H / gap);
    }
    px = Math.min(Math.ceil(px), PX_PER_YEAR_MAX);
    let last = -Infinity;
    const labels = history.map((e) => {
      const y = Math.max(TOP + (e.from - y0) * px - 3, last + LABEL_H);
      last = y;
      return { ...e, x: AXIS_W + 4, y };
    });
    return {
      historyLabels: labels,
      historyW: Math.max(...labels.map((l) => l.text.length * CHAR_W)) + 12,
      pxPerYear: px,
    };
  }, [history, y0]);

  const geom = useMemo(() => {
    if (y0 === undefined || y1 === undefined) return undefined;
    const yOf = (year: number) => TOP + (year - y0) * pxPerYear;
    const xOf = (slot: number) => AXIS_W + historyW + 16 + slot * SLOT_W;
    const scaleBottom = yOf(y1);
    const undatedY = scaleBottom + UNDATED_GAP;
    const anyUndated = layout.points.some((p) => p.year === undefined);
    const ticks: number[] = [];
    for (let y = y0; y <= y1; y += TICK_STEP) ticks.push(y);
    return {
      y0, y1, yOf, xOf, ticks, scaleBottom, undatedY, anyUndated,
      width: xOf(layout.slots - 1) + LABEL_ROOM,
      height: (anyUndated ? undatedY : scaleBottom) + 24,
    };
  }, [layout, y0, y1, historyW, pxPerYear]);

  // What a dot is labelled: the name, or for a hidden living person their
  // kinship to the start person (else "Living").
  const kinship = useMemo(() => (startId ? createKinshipResolver(mainDs, startId, t) : undefined), [mainDs, startId, t]);
  const nameFor = useCallback(
    (p: LineagePoint) =>
      redacted(p.node) ? (p.node.main && kinship?.label(p.node.main.id)) || livingLabelFor(t, p.node.sex) : p.node.name,
    [redacted, kinship, t],
  );

  // Every point in pixels; labels greedily, nearest generations first, each
  // dropped when it would overlap one already placed (the dot keeps its tooltip).
  const placed = useMemo(() => {
    const m = new Map<string, Placed>();
    if (!geom) return m;
    const all = layout.points.map((p) => ({
      ...p,
      x: geom.xOf(p.slot),
      y: p.year === undefined ? geom.undatedY : geom.yOf(p.year),
      label: false,
    }));
    // Every dot is an obstacle too: a name run over its neighbour's dot reads
    // as that neighbour's name.
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = all.map((p) => ({
      x0: p.x - DOT_R,
      x1: p.x + DOT_R,
      y0: p.y - DOT_R,
      y1: p.y + DOT_R,
    }));
    for (const p of [...all].sort((a, b) => Math.abs(a.gen) - Math.abs(b.gen))) {
      const w = nameFor(p).length * CHAR_W + 4;
      const box = { x0: p.x + 7, x1: p.x + 7 + w, y0: p.y - LABEL_H / 2, y1: p.y + LABEL_H / 2 };
      if (boxes.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
      boxes.push(box);
      p.label = true;
    }
    for (const p of all) m.set(p.key, p);
    return m;
  }, [layout, geom, nameFor]);

  const points = useMemo(() => [...placed.values()], [placed]);
  const subjects = useMemo(
    () => points.map((p) => ({ indi: p.node.main, pos: positions.get(p.key) })),
    [points, positions],
  );
  const colorer = useNodeColorer(mainDs, subjects, branches);
  const colorOf = useCallback(
    (p: LineagePoint) =>
      colorer.colorFor(p.node.main, positions.get(p.key)) ?? (p.gen < 0 ? COLOR_DESCENDANT : COLOR_ANCESTOR),
    [colorer, positions],
  );


  const rootPoint = points.find((p) => p.gen === 0);
  const laid = useMemo(
    () => (geom && rootPoint ? { root: rootPoint, width: geom.width + 2 * PAD, height: geom.height + 2 * PAD } : undefined),
    [geom, rootPoint],
  );
  const { canvasRef, zoomLayerRef, viewport, panning, scrollBy, canvasProps, selectedKey, setSelectedKey, selectNode, revealNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(laid, placed, "tb", false, LABEL_H, `lines:${rootId}:${limit ?? "all"}`, true);

  const findSources = useMemo(() => points.map((p) => ({ key: p.key, people: [p.node.main] })), [points]);
  const find = useChartFind(findSources, mainDs.individuals, revealNode, changeRoot);

  const selected = selectedKey ? placed.get(selectedKey) : undefined;
  const selectedIndi = selected?.node.main;
  useChartShortcuts({
    zoomIn, zoomOut, resetZoom, fitToScreen, scrollBy,
    onEdit: selectedIndi && onNavigate ? () => onNavigate(selectedIndi.id) : undefined,
    onLeave: onBack,
  });
  const selectedRows = useMemo(
    () => (selectedIndi ? individualFieldRows(t, selectedIndi, undefined, mainDs) : []),
    [t, selectedIndi, mainDs],
  );
  const mainNav = useMemo(
    () => ({
      linkable: (id: string) => mainDs.individuals.has(id),
      onNavigate: (id: string) => { changeRoot(id); setSelectedKey(null); },
    }),
    [mainDs, setSelectedKey, changeRoot],
  );

  const pageKind = t("timeline.pageTitle");
  const root = rootPoint?.node;
  const rootYears = root && !redacted(root) ? root.years : undefined;
  const exportTitle = [root && rootPoint && nameFor(rootPoint), rootYears, "—", pageKind].filter(Boolean).join(" ");

  /** The year scale, the decade grid and the historical events, drawn across
   *  to `right` — the whole chart, or just the left column that the sticky
   *  copy repeats while the chart scrolls sideways. Spans are one flat tint
   *  however many overlap (solid fills under one group opacity); a single
   *  year is a dotted rule. */
  const yearColumn = (g: NonNullable<typeof geom>, right: number) => (
    <>
      {g.ticks.map((year) => (
        <g key={year}>
          <line className="timeline-grid" x1={AXIS_W} y1={g.yOf(year)} x2={right} y2={g.yOf(year)} />
          <text className="timeline-axis gm-data" x={AXIS_W - 8} y={g.yOf(year) + 4} textAnchor="end">
            {year}
          </text>
        </g>
      ))}
      <g className="timeline-history-bands">
        {history.map((e) =>
          e.to !== undefined ? (
            <rect key={e.key} x={AXIS_W} y={g.yOf(e.from)} width={right - AXIS_W} height={(e.to - e.from) * pxPerYear}>
              <title>{e.text}</title>
            </rect>
          ) : null,
        )}
      </g>
      {history.map((e) =>
        e.to === undefined ? (
          <line key={e.key} className="timeline-history-line" x1={AXIS_W} y1={g.yOf(e.from)} x2={right} y2={g.yOf(e.from)}>
            <title>{e.text}</title>
          </line>
        ) : null,
      )}
      {historyLabels.map((e) => (
        <text key={e.key} className="timeline-history-label timeline-lines-history" x={e.x} y={e.y}>
          {e.text}
        </text>
      ))}
    </>
  );

  return (
    <ChartPage
      backLabel={backLabel}
      onBack={onBack}
      title={
        root && rootPoint ? (
          <ChartRootTitle
            name={nameFor(rootPoint)}
            sexCls={sexClass(root.sex)}
            years={rootYears}
            yearsApprox={lifespanApproxOf(root.main)}
            yearsTitle={lifespanTooltipOf(root.main, settings.showAge, t)}
            kind={pageKind}
          />
        ) : (
          pageKind
        )
      }
      actions={
        <>
          <ChartSettings lockedType="timeline" availableGenerations={depth} />
          <ChartExportMenu
            disabled={!laid}
            slug={chartSlug(root?.name, pageKind)}
            title={exportTitle}
            legend={colorer.legend}
            gedcom={{ ds: mainDs, personIds: points.flatMap((p) => (p.node.main ? [p.node.main.id] : [])) }}
            canvasRef={canvasRef}
          />
        </>
      }
      controlsLeft={
        <>
          {kindSwitcher}
          <TimelineLayoutTabs />
        </>
      }
      controlsRight={<ChartFindBox find={find} />}
    >
      <div className="tree-canvas-wrap">
        <ChartLegend entries={colorer.legend} />
        <div className={`tree-canvas${panning ? " panning" : ""}`} ref={canvasRef} {...canvasProps}>
          {laid && geom ? (
            <ChartZoom width={laid.width} height={laid.height} zoom={zoom} layerRef={zoomLayerRef}>
              <svg className="tree-svg" width={laid.width} height={laid.height} viewBox={`0 0 ${laid.width} ${laid.height}`} role="img">
                <g transform={`translate(${PAD},${PAD})`}>
                  {yearColumn(geom, geom.width)}
                  {geom.anyUndated && (
                    <text className="timeline-lines-undated" x={AXIS_W + 4} y={geom.undatedY - 22}>
                      {t("timeline.lines.undated")}
                    </text>
                  )}

                  {/* Lifelines: each life hangs from the birth dot down to the
                      death year — to today, fading, for the living. Dashed
                      where the start is not the recorded year: estimated from
                      a relative, or a hidden living person's blurred decade.
                      Behind the curves, so the family links stay on top. */}
                  {lifelines &&
                    points.map((p) => {
                      if (p.year === undefined) return null;
                      const hidden = redacted(p.node);
                      const died = hidden ? undefined : deathYear(p.node.main);
                      const end = died ?? (p.node.living ? nowYear : undefined);
                      if (end === undefined || end <= p.year) return null;
                      return (
                        <line
                          key={`life:${p.key}`}
                          className={`timeline-lines-life${p.estimated || hidden ? " estimated" : ""}${died === undefined ? " open" : ""}`}
                          x1={p.x}
                          y1={p.y}
                          x2={p.x}
                          y2={geom.yOf(end)}
                          stroke={colorOf(p)}
                        />
                      );
                    })}
                  {/* Parent → child curves, in the older person's colour. */}
                  {layout.links.map((l) => {
                    const a = placed.get(l.from);
                    const b = placed.get(l.to);
                    if (!a || !b) return null;
                    const my = (a.y + b.y) / 2;
                    return (
                      <path
                        key={`${l.from}>${l.to}`}
                        className="timeline-lines-link"
                        d={`M ${a.x} ${a.y} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`}
                        stroke={colorOf(b.gen >= 0 ? a : b)}
                      />
                    );
                  })}

                  {points.map((p) => {
                    const color = colorOf(p);
                    const hidden = redacted(p.node);
                    const isRoot = p.gen === 0;
                    const tip = hidden ? nameFor(p) : [p.node.name, p.node.years].filter(Boolean).join(", ");
                    return (
                      <g
                        key={p.key}
                        className={`timeline-lines-person${p.key === selectedKey ? " selected" : ""}${p.key === find.hitKey ? " find-hit" : ""}`}
                        data-key={p.key}
                        tabIndex={0}
                        role="button"
                        aria-label={tip}
                        aria-pressed={p.key === selectedKey}
                        onClick={() => selectNode(p.key)}
                        onKeyDown={(ev) => {
                          if (ev.key !== "Enter" && ev.key !== " ") return;
                          ev.preventDefault();
                          selectNode(p.key);
                        }}
                      >
                        <title>
                          {hidden && p.year !== undefined
                            ? `${tip} (${t(withheld(p.node) ? "timeline.lines.byGeneration" : "timeline.lines.blurred")})`
                            : p.estimated
                              ? `${tip} (${t("timeline.lines.estimated")})`
                              : tip}
                        </title>
                        <circle
                          className={`timeline-lines-dot${p.estimated ? " estimated" : ""}${isRoot ? " root" : ""}`}
                          cx={p.x}
                          cy={p.y}
                          r={isRoot ? ROOT_R : DOT_R}
                          fill={hidden ? "var(--muted)" : p.estimated ? "var(--panel)" : color}
                          stroke={hidden ? "var(--muted)" : color}
                        />
                        {(p.label || isRoot || p.key === selectedKey) && (
                          <text
                            className={`timeline-lines-name${hidden ? " hidden" : ""} ${lineageClass(kinship?.lineage(p.node.main?.id ?? ""), kinship?.direct(p.node.main?.id ?? ""))}`}
                            x={p.x + (isRoot ? ROOT_R + 4 : DOT_R + 3)}
                            y={p.y + 4}
                            style={hidden ? undefined : { fill: sexColorVar(p.node.sex) }}
                          >
                            {nameFor(p)}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              </svg>
            </ChartZoom>
          ) : (
            <p className="muted">{t("timeline.empty")}</p>
          )}
        </div>

        {laid && <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fitToScreen} onReset={resetZoom} />}
        {/* Scrolled sideways, the year scale and the event labels ride along at
            the left edge — without them a dot's height says nothing. */}
        {laid && geom && viewport.left > 1 && (
          <div className="timeline-lines-sticky" aria-hidden>
            <svg
              width={(PAD + AXIS_W + historyW) * zoom}
              height={laid.height * zoom}
              viewBox={`0 0 ${PAD + AXIS_W + historyW} ${laid.height}`}
              style={{ transform: `translateY(${-viewport.top}px)` }}
            >
              <rect className="timeline-lines-sticky-bg" x={0} y={0} width={PAD + AXIS_W + historyW} height={laid.height} />
              <g transform={`translate(${PAD},${PAD})`}>
                {yearColumn(geom, AXIS_W + historyW)}
              </g>
            </svg>
          </div>
        )}

        {selected && selectedIndi && (
          <TreeNodePanel
            node={{ name: nameFor(selected), years: redacted(selected.node) ? "" : selected.node.years, sex: selected.node.sex }}
            personId={selectedIndi.id}
            swatch={colorOf(selected)}
            rows={selectedRows}
            mainPerson={mainNav}
            mainLabel={t("tree.main")}
            singleColumn
            onClose={() => setSelectedKey(null)}
            onSetRoot={() => {
              changeRoot(selectedIndi.id);
              setSelectedKey(null);
            }}
            extraActions={
              onNavigate ? (
                <button className="nav-btn tree-compare-root" onClick={() => onNavigate(selectedIndi.id)}>
                  {t("relpath.openInEdit")}
                </button>
              ) : undefined
            }
          />
        )}
      </div>
    </ChartPage>
  );
}

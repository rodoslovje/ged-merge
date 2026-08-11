import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { buildTimeline, familyDepth, type TimelineRow } from "../chart/timeline";
import { ageStandalone, formatMarriage, lifespanLine, livingLabelFor } from "../chart/nodeDisplay";
import { lifespanAge } from "../gedcom/age";
import { PAD, type ChartNode } from "../chart/treeLayout";
import { useTreeCanvas } from "./useTreeCanvas";
import { ChartFindBox } from "./ChartFindBox";
import { useChartFind } from "./useChartFind";
import { createKinshipResolver, lineageClass } from "../match/kinship";
import { individualFieldRows } from "../review/fields";
import { ChartPage } from "./ChartPage";
import { ChartRootTitle } from "./ChartRootTitle";
import { useStableHandler } from "./edit/useStableHandler";
import { collectFirstFilePath, TreeNodePhoto } from "./PersonMedia";
import { useMediaFolder } from "./MediaFolderContext";
import { sexClass, sexColorVar } from "./sex";
import { TreeNodePanel } from "./TreeNodePanel";
import { ZoomControls } from "./ZoomControls";
import { chartSlug } from "./exportSvg";
import { ChartExportMenu } from "./ChartExportMenu";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings } from "./ChartSettingsContext";
import { useNameOf, useSettingsSlice } from "./SettingsContext";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";

// Full-page family Timeline: the root person and their immediate family
// (parents, siblings, spouses, children) as horizontal lifespan bars on a
// shared year axis — a "family through time" strip. Dated life events show as
// dots on the root's bar and marriages as ⚭ markers; clicking a bar opens the
// shared detail panel, from which the timeline can be re-rooted.

// The root person's bar keeps the full-strength accent; family bars are the
// same pine faded toward the panel, so the root stands out by intensity in
// both themes (in light mode --accent and --node-main are nearly the same
// green, so a hue difference alone wouldn't read).
/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["showKinship"] as const;

const COLOR_PERSON = "var(--accent)";
const COLOR_FAMILY = "color-mix(in srgb, var(--node-main) 45%, var(--panel))";

// ── Geometry (native, pre-zoom pixels) ───────────────────────────────────────
const PX_PER_YEAR = 14;
// How much of the years before the root person the chart opens on (see `laid`) —
// about a generation, so their parents are already on the bar when it opens.
const OPEN_LEAD_YEARS = 30;
/** Top ruler band holding the year labels. */
const AXIS_H = 26;
const ROW_H = 46;
/** Bar band inside a row: the name line sits above it. */
const BAR_Y = 24;
/** Photo thumbnail, drawn above the bar with its left edge on the birth year.
 *  While photos show, rows grow by {@link PHOTO_SHIFT} and the bar band moves
 *  down the same amount, so the thumbnail never covers the bar. */
const PHOTO_SIZE = 34;
const PHOTO_Y = 4;
const PHOTO_SHIFT = 18;
const BAR_H = 12;
/** Residence strip: a thin band just under the bar; rows grow by its height
 *  (plus a gap) when it's on, pushing the under-bar label lane down. */
const STRIP_H = 4;
const STRIP_GAP = 2;
/** Estimated half-width per character of a 10.5px lane label, for greedy
 *  collision-skipping (labels that would overlap are dropped; tooltips remain). */
const LANE_CHAR_HW = 2.75;
/** Minimum spacing between on-bar event marks; closer ones merge into one
 *  mark with a combined tooltip (a glyph half over a dot reads as clutter). */
const MARK_MIN_GAP = 10;
/** Baseline shift that puts a glyph's *ink* centre on a target line, measured
 *  once per glyph by drawing it on a canvas and scanning the painted rows.
 *  Font-metric guessing (dominant-baseline) can't do this: the ink of * and ~
 *  sits high in the em box, and ⌂ often comes from a fallback font whose
 *  metrics differ from the app face entirely. */
const glyphShiftCache = new Map<string, number>();
function glyphDy(glyph: string): number {
  let v = glyphShiftCache.get(glyph);
  if (v === undefined) {
    v = 4; // fallback ≈ half a cap height, if canvas is unavailable
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (ctx) {
      const baseline = 24;
      ctx.font = `600 11px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textAlign = "center";
      ctx.fillText(glyph, 16, baseline);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      let minY = -1;
      let maxY = -1;
      for (let yy = 0; yy < 32; yy++) {
        for (let xx = 0; xx < 32; xx++) {
          if (data[(yy * 32 + xx) * 4 + 3] > 0) {
            if (minY < 0) minY = yy;
            maxY = yy;
            break;
          }
        }
      }
      if (maxY >= 0) v = baseline - (minY + maxY) / 2;
    }
    glyphShiftCache.set(glyph, v);
  }
  return v;
}
/** Length of the open-end taper (unknown death / still living). */
const TAPER_W = 12;

/** Axis ticks come every decade — at the fixed year scale they're always
 *  140px apart, so density never needs to adapt to the span. */
const TICK_STEP = 10;

interface Props {
  mainDs: Dataset;
  rootId: string;
  startId?: string;
  /** Main ids with unsaved edits — those rows show the "M" chip. */
  /** Translated label for where Back lands (App knows the hub's origin). */
  backLabel: string;
  onBack: () => void;
  /** Jump to a person in Edit mode (closes the hub). */
  onNavigate?: (id: string) => void;
  /** The Charts-hub kind switcher, rendered in the controls row. */
  kindSwitcher?: React.ReactNode;
  /** Re-root on another person. The hub owns the root (and records it in browser
   *  history), so a re-root here comes back down as a new `rootId`. */
  onRootChange: (id: string) => void;
}

export function TimelineChart({ mainDs, rootId: currentRootId, startId, backLabel, onBack, onNavigate, kindSwitcher, onRootChange }: Props) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const { settings } = useChartSettings();
  const appSettings = useSettingsSlice(SETTINGS_KEYS);
  // Identity-stable, so the memoized row handlers below don't rebuild every
  // render just because App passes a fresh callback.
  const changeRoot = useStableHandler(onRootChange);

  // Kinship-to-start adds nothing while the timeline is rooted on the start
  // person themselves — every row's role already says the same thing.
  const showKinship = settings.showKinship && appSettings.showKinship && !!startId && startId !== currentRootId;

  // How far the chart reaches: the shared Generations choice, which for the
  // timeline counts both ways at once — ancestors above, descendants below.
  const limit = settings.maxGenerations;
  const data = useMemo(
    () => buildTimeline(t, mainDs, currentRootId, nameOf, undefined, limit),
    [t, mainDs, currentRootId, nameOf, limit],
  );
  // What the stepper's "of N" counts: the deeper of the two directions, always
  // the full family, so raising the limit never has to rebuild anything first.
  const depth = useMemo(() => familyDepth(mainDs, currentRootId), [mainDs, currentRootId]);

  // Photos need a loaded media folder.
  const { folderName } = useMediaFolder();
  const photosOn = settings.showPhoto && !!folderName;

  // Timeline-only options: whose bars carry event dots, the under-bar event
  // labels, and the residence strip (which shifts the label lane down).
  const eventsScope = settings.timelineEvents;
  const labelsOn = settings.timelineEventLabels;
  const stripOn = settings.showResidence;
  const barY = BAR_Y + (photosOn ? PHOTO_SHIFT : 0);
  const rowH = ROW_H + (photosOn ? PHOTO_SHIFT : 0) + (stripOn ? STRIP_H + STRIP_GAP : 0);
  const laneY = barY + BAR_H + 10 + (stripOn ? STRIP_H + STRIP_GAP : 0);

  // Axis domain: the data range rounded outward to whole decades, so the chart
  // always opens and closes on a labelled gridline (e.g. 1930 … 2030).
  const geom = useMemo(() => {
    if (!data || data.minYear === undefined || data.maxYear === undefined) return undefined;
    const x0 = Math.floor(data.minYear / TICK_STEP) * TICK_STEP;
    const x1 = Math.ceil(data.maxYear / TICK_STEP) * TICK_STEP;
    const contentW = (x1 - x0) * PX_PER_YEAR;
    const contentH = AXIS_H + data.rows.length * rowH;
    const xOf = (year: number) => (year - x0) * PX_PER_YEAR;
    const ticks: number[] = [];
    for (let y = x0; y <= x1; y += TICK_STEP) ticks.push(y);
    return { x0, x1, contentW, contentH, xOf, ticks };
  }, [data, rowH]);

  // Kinship-to-start resolver: one start-side pedigree walk, per-target caching.
  const kinship = useMemo(
    () => (startId ? createKinshipResolver(mainDs, startId, t) : undefined),
    [mainDs, startId, t],
  );

  // Kinship from the chart's own root, which is what a row's role means; the
  // resolver above answers the other question (kinship to the start person).
  const rootKinship = useMemo(
    () => createKinshipResolver(mainDs, currentRootId, t),
    [mainDs, currentRootId, t],
  );

  // Redact people inferred to be living: label only (a bar would betray the
  // dates), name replaced by their kinship to the start person or "Living".
  const redacted = useCallback(
    (row: TimelineRow) => settings.privacyLiving && (row.living || !!row.private),
    [settings.privacyLiving],
  );
  const rowName = useCallback(
    (row: TimelineRow) => {
      if (!redacted(row)) return row.name;
      return kinship?.label(row.id) || livingLabelFor(t, row.sex);
    },
    [redacted, kinship, t],
  );

  // Position each row for useTreeCanvas (rows satisfy ChartNode once they get
  // an x/y); the root person's row pins the initial scroll.
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const nodesByKey = useMemo(() => {
    const m = new Map<string, TimelineRow & ChartNode>();
    rows.forEach((r, i) => {
      const x = geom && r.from !== undefined ? geom.xOf(r.from) : 0;
      m.set(r.key, { ...r, x, y: AXIS_H + i * rowH });
    });
    return m;
  }, [rows, geom, rowH]);
  const laid = useMemo(() => {
    if (!geom) return undefined;
    const rootRow = rows.find((r) => r.role === "person");
    const placed = (rootRow && nodesByKey.get(rootRow.key)) ?? [...nodesByKey.values()][0];
    if (!placed) return undefined;
    // Open on the person's own bar, one generation of years to its left — far
    // enough back that the parents' bars are already running, near enough that
    // the person is on screen. The left edge won't do: with ancestors on the
    // chart the axis can start two centuries before them, and the chart then
    // opens on an empty stretch of gridlines. A person with no dated event has
    // no bar to aim at (x is 0), and keeps the left edge.
    const root = { ...placed, x: Math.max(0, placed.x - OPEN_LEAD_YEARS * PX_PER_YEAR) };
    return { root, width: geom.contentW + 2 * PAD, height: geom.contentH + 2 * PAD };
  }, [geom, rows, nodesByKey]);

  const { canvasRef, panning, canvasProps, selectedKey, setSelectedKey, selectNode, revealNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(laid, nodesByKey, "lr", false, rowH);

  // Find-in-chart. The timeline only draws the root's immediate family, so a
  // name that isn't here is common — the box then offers to re-root on them.
  const findSources = useMemo(
    () => rows.map((r) => ({ key: r.key, people: [mainDs.individuals.get(r.id)] })),
    [rows, mainDs],
  );
  const find = useChartFind(findSources, mainDs.individuals, revealNode, changeRoot);

  // +/− zoom, 0 reset, F fit, Esc leaves (kind digits are the Charts hub's).
  useChartShortcuts({ zoomIn, zoomOut, resetZoom, fitToScreen, onLeave: onBack });

  const selectedRow = rows.find((r) => r.key === selectedKey);
  const selectedIndi = selectedRow ? mainDs.individuals.get(selectedRow.id) : undefined;
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

  const rootRow = rows.find((r) => r.role === "person");
  const nowYear = new Date().getFullYear();

  // Shared title for the page heading and the SVG / PDF export header. The title
  // always shows the lifespan, so force it on and let Age append "(N)".
  const pageKind = t("timeline.pageTitle");
  const rootYears =
    rootRow && !redacted(rootRow)
      ? lifespanLine(
          { showLifespan: true, showAge: settings.showAge },
          { years: rootRow.years, age: lifespanAge(mainDs.individuals.get(rootRow.id)) },
        )
      : undefined;
  const exportTitle = [rootRow && rowName(rootRow), rootYears, "—", pageKind].filter(Boolean).join(" ");

  // Marriage ⚭ marks always draw; the two Marriage toggles add the visible
  // `⚭ 1925 Kranj` label text beside them (the tooltip carries it regardless).
  const marriageFields =
    settings.showMarriageDate || settings.showMarriagePlace
      ? { date: settings.showMarriageDate, place: settings.showMarriagePlace }
      : undefined;

  /** One row's second (muted) label line: lifespan · place · role. The root
   *  person carries no role chip — the highlight already marks them. The
   *  kinship-to-start renders as its own lineage-coloured tspan after this. */
  const rowMeta = (row: TimelineRow): string => {
    // "Great-grandmother" says what "Ancestor" cannot, and the kinship resolver
    // already speaks both languages; the plain role stays as the fallback for a
    // line it can't name (an adoptive step it doesn't follow, say).
    const role =
      row.role === "person"
        ? undefined
        : row.role === "ancestor" || row.role === "descendant"
          ? rootKinship.label(row.id) || t(`timeline.role.${row.role}`)
          : t(`timeline.role.${roleKey(row)}`);
    if (redacted(row)) return role ?? "";
    const age = lifespanAge(mainDs.individuals.get(row.id));
    const lifespan = lifespanLine(settings, {
      years: row.years,
      age,
      ageText: age !== undefined ? ageStandalone(t, row.sex, age) : undefined,
    });
    const parts = [
      lifespan,
      settings.showPlace ? row.place : undefined,
      role,
    ].filter(Boolean);
    return parts.join(" · ");
  };

  return (
    <ChartPage
      backLabel={backLabel}
      onBack={onBack}
      title={
        rootRow ? (
          <ChartRootTitle
            name={rowName(rootRow)}
            sexCls={sexClass(rootRow.sex)}
            years={rootYears}
            kinship={showKinship ? kinship?.label(currentRootId) : undefined}
            lineage={kinship?.lineage(currentRootId)}
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
            slug={chartSlug(rootRow?.name, pageKind)}
            title={exportTitle}
            gedcom={{ ds: mainDs, personIds: rows.map((r) => r.id) }}
            canvasRef={canvasRef}
          />
        </>
      }
      controlsLeft={kindSwitcher}
      controlsRight={<ChartFindBox find={find} />}
    >
      <div className="tree-canvas-wrap">
        <div className={`tree-canvas${panning ? " panning" : ""}`} ref={canvasRef} {...canvasProps}>
          {laid && geom ? (
            <svg className="tree-svg" width={laid.width * zoom} height={laid.height * zoom} viewBox={`0 0 ${laid.width} ${laid.height}`} role="img">
              <g transform={`translate(${PAD},${PAD})`}>
                {/* Year ruler + vertical decade grid. */}
                {geom.ticks.map((year) => (
                  <g key={year}>
                    <line className="timeline-grid" x1={geom.xOf(year)} y1={AXIS_H - 8} x2={geom.xOf(year)} y2={geom.contentH} />
                    <text className="timeline-axis gm-data" x={geom.xOf(year)} y={AXIS_H - 14} textAnchor="middle">
                      {year}
                    </text>
                  </g>
                ))}
                {/* Today, when it falls inside the axis. */}
                {nowYear >= geom.x0 && nowYear <= geom.x1 && (
                  <line className="timeline-now" x1={geom.xOf(nowYear)} y1={AXIS_H - 8} x2={geom.xOf(nowYear)} y2={geom.contentH} />
                )}

                {rows.map((row, i) => {
                  const y = AXIS_H + i * rowH;
                  const hidden = redacted(row);
                  const color = row.role === "person" ? COLOR_PERSON : COLOR_FAMILY;
                  const barX = row.from !== undefined ? geom.xOf(row.from) : 0;
                  const barW = row.from !== undefined && row.to !== undefined
                    ? Math.max(3, (row.to - row.from) * PX_PER_YEAR)
                    : 0;
                  // Keep the label on-canvas even when the bar starts far right.
                  const labelX = Math.max(4, Math.min(barX, geom.contentW - 220));
                  const indi = mainDs.individuals.get(row.id);
                  const photoPath = photosOn && !hidden && indi ? collectFirstFilePath(indi.raw, mainDs.records) : null;
                  // The avatar's left edge sits on the birth year; text clears its right edge.
                  const photoX = row.from !== undefined ? barX : labelX;
                  const nameX = photoPath ? photoX + PHOTO_SIZE + 8 : labelX;
                  const showEvents = !hidden && (eventsScope === "all" || (eventsScope === "person" && row.role === "person"));
                  // The under-bar text lane: marriage labels plus (when enabled)
                  // the events' compact labels, greedily skipping any label that
                  // would overlap its left neighbour — the dots and tooltips
                  // still carry everything a skipped label would have said.
                  const lane: { x: number; text: string; title: string; marriage: boolean }[] = [];
                  if (!hidden) {
                    for (const m of row.marks) {
                      if (m.kind === "marriage") {
                        lane.push({
                          x: geom.xOf(m.year),
                          text: (marriageFields && m.marriage && formatMarriage(m.marriage, marriageFields)) || "⚭",
                          title: m.label,
                          marriage: true,
                        });
                      } else if (labelsOn && showEvents && m.short) {
                        lane.push({ x: geom.xOf(m.year), text: m.short, title: m.label, marriage: false });
                      }
                    }
                    lane.sort((a, b) => a.x - b.x);
                    let lastEnd = -Infinity;
                    for (let k = 0; k < lane.length; ) {
                      const hw = lane[k].text.length * LANE_CHAR_HW;
                      if (lane[k].x - hw < lastEnd + 6) {
                        lane.splice(k, 1);
                      } else {
                        lastEnd = lane[k].x + hw;
                        k++;
                      }
                    }
                  }
                  // On-bar event marks, clustered: same-year (or near-same-year)
                  // events would draw a glyph half over a dot, so marks within a
                  // glyph's width collapse into one mark whose tooltip lists all
                  // of them (first recorded glyph wins over the generic dot).
                  const dots: { x: number; glyph?: string; labels: string[] }[] = [];
                  if (showEvents) {
                    for (const m of row.marks) {
                      if (m.kind !== "event") continue;
                      const x = geom.xOf(m.year);
                      const last = dots[dots.length - 1];
                      if (last && x - last.x < MARK_MIN_GAP) {
                        last.labels.push(m.label);
                        last.glyph ??= m.glyph;
                      } else {
                        dots.push({ x, glyph: m.glyph, labels: [m.label] });
                      }
                    }
                  }
                  return (
                    <g
                      key={row.key}
                      transform={`translate(0,${y})`}
                      className={`timeline-row${row.key === selectedKey ? " selected" : ""}${row.key === find.hitKey ? " find-hit" : ""}${row.role === "person" ? " is-person" : ""}`}
                      onClick={() => selectNode(row.key)}
                    >
                      <title>{t("tree.node.clickHint")}</title>
                      {/* Full-width hit/selection strip. */}
                      <rect className="timeline-row-bg" x={0} y={0} width={geom.contentW} height={rowH} />
                      {!hidden && row.from !== undefined && row.to !== undefined && (
                        <>
                          <rect
                            className="timeline-bar"
                            x={barX}
                            y={barY}
                            width={barW}
                            height={BAR_H}
                            rx={3}
                            fill={color}
                          />
                          {/* Open ends taper off: unknown birth fades in, an
                              unrecorded death / living person fades out. */}
                          {row.openStart && (
                            <path className="timeline-bar-open" d={`M ${barX} ${barY} L ${barX - TAPER_W} ${barY + BAR_H / 2} L ${barX} ${barY + BAR_H} Z`} fill={color} />
                          )}
                          {row.openEnd && (
                            <path className="timeline-bar-open" d={`M ${barX + barW} ${barY} L ${barX + barW + TAPER_W} ${barY + BAR_H / 2} L ${barX + barW} ${barY + BAR_H} Z`} fill={color} />
                          )}
                        </>
                      )}
                      {/* Residence periods: a thin strip just under the bar;
                          adjacent segments alternate opacity to show breaks. */}
                      {stripOn && !hidden &&
                        row.residences.map((p, j) => (
                          <rect
                            key={`r${j}`}
                            className={`timeline-residence${j % 2 ? " alt" : ""}`}
                            x={geom.xOf(p.from)}
                            y={barY + BAR_H + STRIP_GAP}
                            width={Math.max(2, (p.to - p.from) * PX_PER_YEAR)}
                            height={STRIP_H}
                          >
                            <title>{p.label}</title>
                          </rect>
                        ))}
                      {dots.map((d, j) =>
                        // Known event types draw their genealogy glyph
                        // (* ~ † ▭ ⌂ …); the rest keep the generic dot.
                        d.glyph ? (
                          <text
                            key={j}
                            className="timeline-mark-glyph"
                            x={d.x}
                            y={barY + BAR_H / 2 + glyphDy(d.glyph)}
                            textAnchor="middle"
                          >
                            {d.glyph}
                            <title>{d.labels.join("\n")}</title>
                          </text>
                        ) : (
                          <circle key={j} className="timeline-mark" cx={d.x} cy={barY + BAR_H / 2} r={3.5}>
                            <title>{d.labels.join("\n")}</title>
                          </circle>
                        ),
                      )}
                      {lane.map((l, j) => (
                        <text
                          key={`l${j}`}
                          className={l.marriage ? "timeline-mark-marriage" : "timeline-mark-label"}
                          x={l.x}
                          y={laneY}
                          textAnchor="middle"
                        >
                          {l.text}
                          <title>{l.title}</title>
                        </text>
                      ))}
                      {photoPath && indi && (
                        <TreeNodePhoto
                          node={{ main: { raw: indi.raw } }}
                          mainRecords={mainDs.records}
                          mainRefCtx={{ dataset: mainDs, onNavigate: changeRoot }}
                          x={photoX}
                          y={PHOTO_Y}
                          size={PHOTO_SIZE}
                        />
                      )}
                      {/* With photos on, the name drops to the photo's bottom
                          edge — just above the bar — so both read as one block. */}
                      <text className="timeline-row-name" x={nameX} y={photosOn ? PHOTO_Y + PHOTO_SIZE : 16} style={{ fill: sexColorVar(row.sex) }}>
                        {rowName(row)}
                        <tspan className="timeline-row-meta" dx={8}>{rowMeta(row)}</tspan>
                        {/* Kinship-to-start in its own tspan, coloured by blood
                            lineage (paternal blue / maternal purple) like the
                            tree charts, so it reads apart from the role chip. */}
                        {showKinship && !hidden && (
                          <tspan
                            className={`timeline-row-meta timeline-row-kinship ${lineageClass(kinship?.lineage(row.id))}`}
                            dx={8}
                          >
                            {kinship?.label(row.id)}
                          </tspan>
                        )}
                        {!hidden && row.from === undefined && (
                          <tspan className="timeline-row-meta" dx={8}>{t("timeline.undated")}</tspan>
                        )}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          ) : (
            <p className="muted">{t("timeline.empty")}</p>
          )}
        </div>

        {laid && (
          <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onFit={fitToScreen} onReset={resetZoom} />
        )}

        {selectedRow && selectedIndi && (
          <TreeNodePanel
            node={selectedRow}
            swatch={selectedRow.role === "person" ? COLOR_PERSON : COLOR_FAMILY}
            rows={selectedRows}
            mainPerson={mainNav}
            mainLabel={t("tree.main")}
            singleColumn
            onClose={() => setSelectedKey(null)}
            onSetRoot={() => {
              changeRoot(selectedRow.id);
              setSelectedKey(null);
            }}
            extraActions={
              onNavigate ? (
                <button className="nav-btn tree-compare-root" onClick={() => onNavigate(selectedRow.id)}>
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

/** The i18n suffix for a row's relation-to-root label — sex-exact where the
 *  sex is recorded (Brother/Sister, Son/Daughter, Stepmother, Half-brother…),
 *  the neutral word otherwise. */
function roleKey(row: TimelineRow): string {
  if (row.role === "parent") return row.sex === "F" ? "mother" : "father";
  if (row.role === "stepparent" && row.sex !== "U") return row.sex === "F" ? "stepmother" : "stepfather";
  if (row.role === "sibling" && row.sex !== "U") return row.sex === "F" ? "sister" : "brother";
  if (row.role === "halfsibling" && row.sex !== "U") return row.sex === "F" ? "halfsister" : "halfbrother";
  if (row.role === "child" && row.sex !== "U") return row.sex === "F" ? "daughter" : "son";
  if (row.role === "stepchild" && row.sex !== "U") return row.sex === "F" ? "stepdaughter" : "stepson";
  return row.role;
}

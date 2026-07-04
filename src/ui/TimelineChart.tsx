import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { buildTimeline, type TimelineRow } from "../tree/timeline";
import { formatMarriage } from "../tree/nodeDisplay";
import { PAD, type Placed } from "../tree/treeLayout";
import { useTreeCanvas } from "../tree/useTreeCanvas";
import { createKinshipResolver, lineageClass } from "../match/kinship";
import { individualFieldRows } from "../review/fields";
import { BackButton } from "./BackButton";
import { collectFirstFilePath, TreeNodePhoto } from "./PersonPhotos";
import { useMediaFolder } from "./MediaFolderContext";
import { sexClass, sexColorVar } from "./sex";
import { TreeNodePanel } from "./TreeNodePanel";
import { ZoomControls } from "./ZoomControls";
import { diagramSlug, exportCanvasPdf, exportCanvasSvg } from "./exportSvg";
import { exportChartGedcom } from "./exportGedcom";
import { ExportMenu } from "./ExportMenu";
import { GedIcon, ImageIcon, PrinterIcon } from "./icons/FormatIcons";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings } from "./ChartSettingsContext";
import { useNameOf, useSettings } from "./SettingsContext";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";

// Full-page family Timeline: the root person and their immediate family
// (parents, siblings, spouses, children) as horizontal lifespan bars on a
// shared year axis — a "family through time" strip. Dated life events show as
// dots on the root's bar and marriages as ⚭ markers; clicking a bar opens the
// shared detail panel, from which the timeline can be re-rooted.

// The root person's bar keeps the full-strength accent; family bars are the
// same pine faded toward the panel, so the root stands out by intensity in
// both themes (in light mode --accent and --node-master are nearly the same
// green, so a hue difference alone wouldn't read).
const COLOR_PERSON = "var(--accent)";
const COLOR_FAMILY = "color-mix(in srgb, var(--node-master) 45%, var(--panel))";

// ── Geometry (native, pre-zoom pixels) ───────────────────────────────────────
const PX_PER_YEAR = 14;
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
  masterDs: Dataset;
  rootId: string;
  startId?: string;
  /** Translated label for where Back lands (App knows the hub's origin). */
  backLabel: string;
  onBack: () => void;
  /** Jump to a person in Edit mode (closes the hub). */
  onNavigate?: (id: string) => void;
  /** The Charts-hub kind switcher, rendered in the controls row. */
  kindSwitcher?: React.ReactNode;
  /** Reports re-roots up to the Charts hub, so switching kinds stays on the
   *  person the user is looking at. */
  onRootChange?: (id: string) => void;
}

export function TimelineChart({ masterDs, rootId, startId, backLabel, onBack, onNavigate, kindSwitcher, onRootChange }: Props) {
  const { t } = useTranslation();
  const nameOf = useNameOf();
  const { settings } = useChartSettings();
  const { settings: appSettings } = useSettings();
  const [currentRootId, setCurrentRootId] = useState(rootId);
  const changeRoot = useCallback((id: string) => {
    setCurrentRootId(id);
    onRootChange?.(id);
  }, [onRootChange]);

  // Kinship-to-start adds nothing while the timeline is rooted on the start
  // person themselves — every row's role already says the same thing.
  const showKinship = settings.showKinship && appSettings.showKinship && !!startId && startId !== currentRootId;
  const livingLabel = t("tree.node.living");

  const data = useMemo(
    () => buildTimeline(t, masterDs, currentRootId, nameOf),
    [t, masterDs, currentRootId, nameOf],
  );

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
    () => (startId ? createKinshipResolver(masterDs, startId, t) : undefined),
    [masterDs, startId, t],
  );

  // Redact people inferred to be living: label only (a bar would betray the
  // dates), name replaced by their kinship to the start person or "Living".
  const redacted = useCallback(
    (row: TimelineRow) => settings.privacyLiving && row.living,
    [settings.privacyLiving],
  );
  const rowName = useCallback(
    (row: TimelineRow) => {
      if (!redacted(row)) return row.name;
      return kinship?.label(row.id) || livingLabel;
    },
    [redacted, kinship, livingLabel],
  );

  // Adapt the rows to the shapes useTreeCanvas expects (it only reads key/x/y);
  // the root person's row pins the initial scroll.
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const nodesByKey = useMemo(() => {
    const m = new Map<string, Placed>();
    rows.forEach((r, i) => {
      const x = geom && r.from !== undefined ? geom.xOf(r.from) : 0;
      m.set(r.key, { ...r, x, y: AXIS_H + i * rowH } as unknown as Placed);
    });
    return m;
  }, [rows, geom, rowH]);
  const laid = useMemo(() => {
    if (!geom) return undefined;
    const rootRow = rows.find((r) => r.role === "person");
    const placed = (rootRow && nodesByKey.get(rootRow.key)) ?? [...nodesByKey.values()][0];
    if (!placed) return undefined;
    // Pin the initial scroll to the chart's left edge, not the root's bar —
    // the parents' bars (and labels) usually start earlier than the root.
    const root = { ...placed, x: 0 } as Placed;
    return { root, width: geom.contentW + 2 * PAD, height: geom.contentH + 2 * PAD };
  }, [geom, rows, nodesByKey]);

  const { canvasRef, panning, canvasProps, selectedKey, setSelectedKey, selectNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(laid, nodesByKey, "lr", false, rowH);

  // +/− zoom, 0 reset, F fit, Esc leaves (kind digits are the Charts hub's).
  useChartShortcuts({ zoomIn, zoomOut, resetZoom, fitToScreen, onLeave: onBack });

  const selectedRow = rows.find((r) => r.key === selectedKey);
  const selectedIndi = selectedRow ? masterDs.individuals.get(selectedRow.id) : undefined;
  const selectedRows = useMemo(
    () => (selectedIndi ? individualFieldRows(t, selectedIndi, undefined, masterDs) : []),
    [t, selectedIndi, masterDs],
  );
  const masterNav = useMemo(
    () => ({
      linkable: (id: string) => masterDs.individuals.has(id),
      onNavigate: (id: string) => { changeRoot(id); setSelectedKey(null); },
    }),
    [masterDs, setSelectedKey, changeRoot],
  );

  const rootRow = rows.find((r) => r.role === "person");
  const nowYear = new Date().getFullYear();

  // Shared title for the page heading and the SVG / PDF export header.
  const pageKind = t("timeline.pageTitle");
  const exportTitle = [rootRow && rowName(rootRow), rootRow && !redacted(rootRow) ? rootRow.years : undefined, "—", pageKind]
    .filter(Boolean)
    .join(" ");

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
    const role = row.role !== "person" ? t(`timeline.role.${roleKey(row)}`) : undefined;
    if (redacted(row)) return role ?? "";
    const parts = [
      settings.showLifespan ? row.years : undefined,
      settings.showPlace ? row.place : undefined,
      role,
    ].filter(Boolean);
    return parts.join(" · ");
  };

  return (
    <div className="tree-page">
      <div className="tree-toolbar">
        <BackButton label={backLabel} shortcutHint="Esc" onClick={onBack} />
        <h2 className="tree-title">
          {rootRow ? (
            <>
              <span className={`tree-title-name ${sexClass(rootRow.sex)}`}>{rowName(rootRow)}</span>
              {!redacted(rootRow) && rootRow.years && <span className="tree-title-years gm-data">{rootRow.years}</span>}
              <span className="tree-title-break" aria-hidden="true" />
              <span className="tree-title-kind">{pageKind}</span>
            </>
          ) : (
            pageKind
          )}
        </h2>
        <ChartSettings lockedType="timeline" />
        <ExportMenu
          disabled={!laid}
          items={[
            {
              key: "ged",
              icon: <GedIcon />,
              label: t("export.gedcom", { count: rows.length }),
              title: t("tree.exportGedcom.tooltip"),
              onSelect: () => exportChartGedcom(masterDs, rows.map((r) => r.id), diagramSlug(rootRow?.name, pageKind)),
            },
            {
              key: "svg",
              icon: <ImageIcon />,
              label: t("export.svg"),
              title: t("tree.export.tooltip"),
              onSelect: () => exportCanvasSvg(canvasRef.current, diagramSlug(rootRow?.name, pageKind), exportTitle),
            },
            {
              key: "pdf",
              icon: <PrinterIcon />,
              label: t("export.pdf"),
              title: t("tree.exportPdf.tooltip"),
              onSelect: () => exportCanvasPdf(canvasRef.current, diagramSlug(rootRow?.name, pageKind), exportTitle),
            },
          ]}
        />
      </div>

      <div className="tree-controls">
        <div className="tree-controls-left">{kindSwitcher}</div>
      </div>

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
                  const indi = masterDs.individuals.get(row.id);
                  const photoPath = photosOn && !hidden && indi ? collectFirstFilePath(indi.raw, masterDs.records) : null;
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
                      className={`timeline-row${row.key === selectedKey ? " selected" : ""}${row.role === "person" ? " is-person" : ""}`}
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
                          node={{ master: { raw: indi.raw } }}
                          masterRecords={masterDs.records}
                          masterRefCtx={{ dataset: masterDs, onNavigate: changeRoot }}
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
            node={selectedRow as unknown as Placed}
            swatch={selectedRow.role === "person" ? COLOR_PERSON : COLOR_FAMILY}
            rows={selectedRows}
            masterPerson={masterNav}
            masterLabel={t("tree.master")}
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
    </div>
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

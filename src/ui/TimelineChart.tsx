import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { buildTimeline, type TimelineRow } from "../tree/timeline";
import { formatMarriage } from "../tree/nodeDisplay";
import { PAD, type Placed } from "../tree/treeLayout";
import { useTreeCanvas } from "../tree/useTreeCanvas";
import { kinshipLabel } from "../match/kinship";
import { individualFieldRows } from "../review/fields";
import { BackButton } from "./BackButton";
import { collectFirstFilePath, TreeNodePhoto } from "./PersonPhotos";
import { useMediaFolder } from "./MediaFolderContext";
import { sexClass, sexColorVar } from "./sex";
import { TreeNodePanel } from "./TreeNodePanel";
import { ZoomControls } from "./ZoomControls";
import { diagramSlug, exportCanvasPdf, exportCanvasSvg } from "./exportSvg";
import { ExportMenu } from "./ExportMenu";
import { FileTextIcon, ImageIcon } from "./icons/FormatIcons";
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
/** Photo thumbnail, drawn as an avatar over the start of the bar (vertically
 *  centred in the row) so photos don't cost any extra row height. */
const PHOTO_SIZE = 34;
const BAR_H = 12;
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

  // Axis domain: the data range rounded outward to whole decades, so the chart
  // always opens and closes on a labelled gridline (e.g. 1930 … 2030).
  const geom = useMemo(() => {
    if (!data || data.minYear === undefined || data.maxYear === undefined) return undefined;
    const x0 = Math.floor(data.minYear / TICK_STEP) * TICK_STEP;
    const x1 = Math.ceil(data.maxYear / TICK_STEP) * TICK_STEP;
    const contentW = (x1 - x0) * PX_PER_YEAR;
    const contentH = AXIS_H + data.rows.length * ROW_H;
    const xOf = (year: number) => (year - x0) * PX_PER_YEAR;
    const ticks: number[] = [];
    for (let y = x0; y <= x1; y += TICK_STEP) ticks.push(y);
    return { x0, x1, contentW, contentH, xOf, ticks };
  }, [data]);

  // Redact people inferred to be living: label only (a bar would betray the
  // dates), name replaced by their kinship to the start person or "Living".
  const redacted = useCallback(
    (row: TimelineRow) => settings.privacyLiving && row.living,
    [settings.privacyLiving],
  );
  const rowName = useCallback(
    (row: TimelineRow) => {
      if (!redacted(row)) return row.name;
      return (startId && kinshipLabel(masterDs, startId, row.id, t)) || livingLabel;
    },
    [redacted, startId, masterDs, t, livingLabel],
  );

  // Adapt the rows to the shapes useTreeCanvas expects (it only reads key/x/y);
  // the root person's row pins the initial scroll.
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const nodesByKey = useMemo(() => {
    const m = new Map<string, Placed>();
    rows.forEach((r, i) => {
      const x = geom && r.from !== undefined ? geom.xOf(r.from) : 0;
      m.set(r.key, { ...r, x, y: AXIS_H + i * ROW_H } as unknown as Placed);
    });
    return m;
  }, [rows, geom]);
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
    useTreeCanvas(laid, nodesByKey, "lr", false, ROW_H);

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

  /** One row's second (muted) label line: lifespan · place · role · kinship.
   *  The root person carries no role chip — the highlight already marks them. */
  const rowMeta = (row: TimelineRow): string => {
    const role = row.role !== "person" ? t(`timeline.role.${roleKey(row)}`) : undefined;
    if (redacted(row)) return role ?? "";
    const parts = [
      settings.showLifespan ? row.years : undefined,
      settings.showPlace ? row.place : undefined,
      role,
      showKinship ? kinshipLabel(masterDs, startId!, row.id, t) : undefined,
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
              key: "svg",
              icon: <ImageIcon />,
              label: t("export.svg"),
              title: t("tree.export.tooltip"),
              onSelect: () => exportCanvasSvg(canvasRef.current, diagramSlug(rootRow?.name, pageKind), exportTitle),
            },
            {
              key: "pdf",
              icon: <FileTextIcon />,
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
                  const y = AXIS_H + i * ROW_H;
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
                  return (
                    <g
                      key={row.key}
                      transform={`translate(0,${y})`}
                      className={`timeline-row${row.key === selectedKey ? " selected" : ""}${row.role === "person" ? " is-person" : ""}`}
                      onClick={() => selectNode(row.key)}
                    >
                      <title>{t("tree.node.clickHint")}</title>
                      {/* Full-width hit/selection strip. */}
                      <rect className="timeline-row-bg" x={0} y={0} width={geom.contentW} height={ROW_H} />
                      {!hidden && row.from !== undefined && row.to !== undefined && (
                        <>
                          <rect
                            className="timeline-bar"
                            x={barX}
                            y={BAR_Y}
                            width={barW}
                            height={BAR_H}
                            rx={3}
                            fill={color}
                          />
                          {/* Open ends taper off: unknown birth fades in, an
                              unrecorded death / living person fades out. */}
                          {row.openStart && (
                            <path className="timeline-bar-open" d={`M ${barX} ${BAR_Y} L ${barX - TAPER_W} ${BAR_Y + BAR_H / 2} L ${barX} ${BAR_Y + BAR_H} Z`} fill={color} />
                          )}
                          {row.openEnd && (
                            <path className="timeline-bar-open" d={`M ${barX + barW} ${BAR_Y} L ${barX + barW + TAPER_W} ${BAR_Y + BAR_H / 2} L ${barX + barW} ${BAR_Y + BAR_H} Z`} fill={color} />
                          )}
                        </>
                      )}
                      {!hidden &&
                        row.marks.map((m, j) =>
                          m.kind === "marriage" ? (
                            <text key={j} className="timeline-mark-marriage" x={geom.xOf(m.year)} y={BAR_Y + BAR_H + 10} textAnchor="middle">
                              {(marriageFields && m.marriage && formatMarriage(m.marriage, marriageFields)) || "⚭"}
                              <title>{m.label}</title>
                            </text>
                          ) : (
                            <circle key={j} className="timeline-mark" cx={geom.xOf(m.year)} cy={BAR_Y + BAR_H / 2} r={3.5}>
                              <title>{m.label}</title>
                            </circle>
                          ),
                        )}
                      {photoPath && indi && (
                        <TreeNodePhoto
                          node={{ master: { raw: indi.raw } }}
                          masterRecords={masterDs.records}
                          masterRefCtx={{ dataset: masterDs, onNavigate: changeRoot }}
                          x={photoX}
                          y={(ROW_H - PHOTO_SIZE) / 2}
                          size={PHOTO_SIZE}
                        />
                      )}
                      <text className="timeline-row-name" x={nameX} y={16} style={{ fill: sexColorVar(row.sex) }}>
                        {rowName(row)}
                        <tspan className="timeline-row-meta" dx={8}>{rowMeta(row)}</tspan>
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
 *  sex is recorded (Brother/Sister, Son/Daughter), the neutral word otherwise. */
function roleKey(row: TimelineRow): string {
  if (row.role === "parent") return row.sex === "F" ? "mother" : "father";
  if (row.role === "sibling" && row.sex !== "U") return row.sex === "F" ? "sister" : "brother";
  if (row.role === "child" && row.sex !== "U") return row.sex === "F" ? "daughter" : "son";
  return row.role;
}

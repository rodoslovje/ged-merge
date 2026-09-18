import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { placeKin } from "../chart/kinMap";
import { PersonLink } from "./PersonLink";
import {
  WHEEL_LABEL_PX,
  barNameFont,
  barNameText,
  buildKinBars,
  buildKinshipWheel,
  buildSurnameRings,
  collectKin,
  kinDepth,
  kinDirection,
  OWN_BRANCH,
  type KinDirection,
  type KinPerson,
} from "../chart/kinshipWheel";
import { birthYear, isPresumedLiving } from "../gedcom/lifespan";
import { lifespanLine, livingLabelFor } from "../chart/nodeDisplay";
import { lifespanAge } from "../gedcom/age";
import type { ChartNode } from "../chart/treeLayout";
import { PAD } from "../chart/treeLayout";
import { useTreeCanvas } from "./useTreeCanvas";
import { ChartZoom } from "./ChartZoom";
import { ChartFindBox } from "./ChartFindBox";
import { useChartFind } from "./useChartFind";
import { createKinshipResolver, kinshipLabelFor, lineageClass } from "../match/kinship";
import { individualFieldRows } from "../review/fields";
import { ChartPage } from "./ChartPage";
import { ChartRootTitle } from "./ChartRootTitle";
import { TreeNodePanel } from "./TreeNodePanel";
import { ZoomControls } from "./ZoomControls";
import { chartSlug } from "./exportSvg";
import { ChartExportMenu } from "./ChartExportMenu";
import { ChartSettings } from "./ChartSettings";
import { useChartSettings } from "./ChartSettingsContext";
import { useNodeColorer } from "./useNodeColorer";
import { ChartLegend } from "./ChartLegend";
import { AXIS_TINT, lineColor, type BranchInfo } from "../chart/nodeColor";
import { useNameOf } from "./SettingsContext";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";
import { sexClass } from "./sex";

// Leaflet comes with the layout that needs it, as the Places map's does.
const KinMapBody = lazy(() => import("./KinMapBody"));

// Full-page **Contemporaries** chart: every blood relative of one person, placed
// by how closely they are related rather than by pedigree position — and, by
// default, filtered to those whose life overlapped the root's.
//
// Four layouts over one data pass (see `src/chart/kinshipWheel.ts`): the
// wheel, where the distance from the centre is the blood distance and each
// wedge is a grandparent line; the surname rings, the same rings shared out
// among continuous surname bands; the bars, the same people on a year axis
// banded by blood distance; and the map, the same people each at one place (see
// `src/chart/kinMap.ts`). The wheel answers "who are they and how close", the
// surnames "which names is this family made of, and how far out", the bars "who
// was here at the same time", the map "where did they come from".

/** The unplaced list shows at most this many names per group. */
const UNPLACED_MAX_ROWS = 150;

/** What a surname slice is filled with while the shared Color axis is Plain.
 *  The wheel can leave every dot the accent, because ground separates them; a
 *  ring of slices touching edge to edge would read as one flat disc, so the
 *  plain fill says which way the band lies — the elders, the root's own
 *  generation, the issue — from the same three tokens the Generation axis ramps
 *  between. That axis still says more: a generation each, and a colour key. */
const DIRECTION_FILL: Record<KinDirection, string> = {
  up: "var(--kin-anc-near)",
  same: "var(--kin-gen-0)",
  down: "var(--kin-desc-near)",
};

interface Props {
  mainDs: Dataset;
  rootId: string;
  startId?: string;
  backLabel: string;
  onBack: () => void;
  onNavigate?: (id: string) => void;
  onRootChange: (id: string) => void;
  kindSwitcher?: React.ReactNode;
  /** Open Tools → Places → Geocode places, from the map layout's list of
   *  relatives whose place has no coordinates. */
  onOpenGeocode?: () => void;
}

export function KinshipChart({ mainDs, rootId, startId, backLabel, onBack, onNavigate, onRootChange, kindSwitcher, onOpenGeocode }: Props) {
  const { t } = useTranslation();
  const { settings, set } = useChartSettings();
  const nameOf = useNameOf();
  const now = new Date().getFullYear();

  const currentRootId = mainDs.individuals.has(rootId) ? rootId : [...mainDs.individuals.keys()][0];
  const changeRoot = useCallback((id: string) => onRootChange(id), [onRootChange]);

  const root = mainDs.individuals.get(currentRootId);
  const rootBirth = root ? birthYear(root) : undefined;
  // The window every "contemporary" is measured against: the root's own life,
  // running to today while they are presumed living.
  const window = useMemo(() => {
    if (!root || rootBirth === undefined) return undefined;
    const living = isPresumedLiving(root, mainDs, now);
    const to = living ? now : (lifespanAge(root) !== undefined ? rootBirth + lifespanAge(root)! : now);
    return { from: rootBirth, to };
  }, [root, rootBirth, mainDs, now]);

  // Scope falls back to "all" for a root with no datable life: there is no
  // window to compare anyone against, and an empty chart would say nothing.
  const scope = window ? settings.kinScope : "all";
  const layout = settings.kinLayout;

  // "Alive in <year>": dims everyone whose life did not reach that year, rather
  // than dropping them, so the dots hold still while the year is dragged.
  const [yearOn, setYearOn] = useState(false);
  const [year, setYear] = useState(now);

  const baseInput = useMemo(
    () => ({
      ds: mainDs,
      rootId: currentRootId,
      nameOf,
      now,
      window: scope === "contemporaries" ? window : undefined,
    }),
    [mainDs, currentRootId, nameOf, now, scope, window],
  );
  const input = useMemo(
    () => ({ ...baseInput, maxDistance: settings.maxGenerations ?? undefined }),
    [baseInput, settings.maxGenerations],
  );
  // How far the chart *could* reach, measured without the cap — the stepper's
  // "of N". Taking it from the capped chart would let a step down to 1 remove
  // the stepper itself, with no way back up.
  const depth = useMemo(() => kinDepth(baseInput), [baseInput]);

  // One pass, shared by both layouts and by the colour key.
  const people = useMemo(() => collectKin(input), [input]);
  const wheel = useMemo(() => buildKinshipWheel({ ...input, people }), [input, people]);
  // Built only while it is showing: the other layouts never ask, and the rings
  // are a second full pass over everyone.
  const surnames = useMemo(
    () => (layout === "surnames" ? buildSurnameRings({ ...input, people }) : undefined),
    [layout, input, people],
  );

  const wedgeLabel = useCallback(
    (key: string, ancestorId?: string) => {
      if (key === OWN_BRANCH) return t("kin.wedge.own");
      const indi = ancestorId ? mainDs.individuals.get(ancestorId) : undefined;
      return indi ? nameOf(indi) : t("kin.wedge.unknown");
    },
    [t, mainDs, nameOf],
  );
  // The wedges' colours and names, in the order the wedges themselves run:
  // the grandfather's line first, the grandmother's second — keyed by side,
  // so the father's lines take the first half of the ancestor ramp and the
  // mother's the second, as on the pedigree charts.
  const branches = useMemo(() => {
    const map = new Map<string, BranchInfo>();
    const seen = { father: 0, mother: 0 };
    for (const w of wheel.wedges) {
      if (w.key === OWN_BRANCH || w.side === "own") continue;
      const i = (w.side === "father" ? 0 : 2) + Math.min(seen[w.side]++, 1);
      map.set(w.key, { label: wedgeLabel(w.key, w.ancestorId), color: lineColor(i, 4, "ancestors") });
    }
    return map;
  }, [wheel.wedges, wedgeLabel]);
  // The shared Color axis, over everyone but the root (whose dot is the centre).
  const subjects = useMemo(
    () => people.filter((p) => p.distance > 0).map((p) => ({ indi: p.indi, pos: { gen: p.generation, branch: p.branch } })),
    [people],
  );
  const colorer = useNodeColorer(mainDs, subjects, branches);

  const alive = useCallback(
    (p: KinPerson) => (p.span.to ?? p.span.from ?? -Infinity) >= year && (p.span.from ?? Infinity) <= year,
    [year],
  );
  const lit = useCallback((p: KinPerson) => !yearOn || alive(p), [yearOn, alive]);

  const categoryOf = useCallback(
    (p: KinPerson) => colorer.categoryOf(p.indi, { gen: p.generation, branch: p.branch }),
    [colorer],
  );
  const colorOf = useCallback((p: KinPerson) => colorer.colorOf(categoryOf(p)) ?? "var(--accent)", [colorer, categoryOf]);
  /** Surname slices are tinted rather than filled flat, as the pedigree boxes
   *  and fan wedges are: the surname is set on top of its own band, and has to
   *  stay readable whatever the Color axis hands back. */
  const sliceFill = useCallback(
    (p: KinPerson) => {
      const c = colorer.axis === "plain" ? DIRECTION_FILL[kinDirection(p.generation)] : colorOf(p);
      return `color-mix(in srgb, ${c} ${AXIS_TINT}%, var(--panel))`;
    },
    [colorer.axis, colorOf],
  );

  // The colour key doubles as a filter, like the Map's event-kind chips: each
  // entry hides its own group. The layout is built from everyone regardless, so
  // hiding a family line never reshuffles the wedges around it.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setHidden(new Set()), [colorer.axis]);
  const shown = useCallback((p: KinPerson) => !hidden.has(categoryOf(p)), [hidden, categoryOf]);

  // The bars are a list: hiding a group has to close the gap it leaves, or the
  // bands keep their old height around holes. The wheel is a map, and holds
  // still on purpose — see buildKinshipWheel. The bars want a width up front;
  // the canvas scrolls, so a generous fixed native width beats measuring the
  // viewport and relaying out on every resize.
  const bars = useMemo(
    () => buildKinBars({ ...input, width: 1400, people: people.filter(shown) }),
    [input, people, shown],
  );
  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const legend = colorer.legend;

  // Redact people inferred to be living, as the other charts do: the name goes,
  // the dot stays — its ring and wedge are the point, and they give nothing away.
  const redacted = useCallback((p: KinPerson) => settings.privacyLiving && p.span.living, [settings.privacyLiving]);
  const kinship = useMemo(
    () => (startId ? createKinshipResolver(mainDs, startId, t) : undefined),
    [mainDs, startId, t],
  );
  const nameFor = useCallback(
    (p: KinPerson) => (redacted(p) ? livingLabelFor(t, p.sex) : p.name),
    [redacted, t],
  );
  /** Hover text: who they are, how they are related *to this chart's root*, and
   *  their years. The relationship belongs here rather than on the detail panel,
   *  whose kinship line means something else everywhere in the app — the
   *  relationship to your start person. Named from the positions the layout
   *  already knows, so no pedigree is walked per person. */
  const kinshipOf = useCallback((p: KinPerson) => kinshipLabelFor(p.up, p.down, p.sex, t), [t]);
  const tooltipFor = useCallback(
    (p: KinPerson) => {
      const rel = kinshipOf(p);
      return redacted(p)
        ? [nameFor(p), rel].filter(Boolean).join(" · ")
        : [p.name, rel, p.years].filter(Boolean).join(" · ");
    },
    [redacted, nameFor, kinshipOf],
  );

  const drawn = useCallback((p: KinPerson) => p.distance > 0 && shown(p), [shown]);

  // The map layout: each relative at their anchor place, the rest listed. Only
  // built while it is showing — the other two layouts never ask.
  const mapData = useMemo(() => (layout === "map" ? placeKin(mainDs, people) : undefined), [layout, mainDs, people]);
  const placedShown = useMemo(() => (mapData ? mapData.placed.filter((x) => drawn(x.person)) : []), [mapData, drawn]);
  const rootPoint = mapData?.placed.find((x) => x.person.id === currentRootId)?.point;
  // The unplaced follow the colour key too, and keep the root: a root with no
  // place is the one absence worth pointing out.
  const unplacedNoCoords = useMemo(() => (mapData ? mapData.noCoords.filter(shown) : []), [mapData, shown]);
  const unplacedNoPlace = useMemo(() => (mapData ? mapData.noPlace.filter(shown) : []), [mapData, shown]);
  const unplacedCount = unplacedNoCoords.length + unplacedNoPlace.length;
  const [unplacedOpen, setUnplacedOpen] = useState(false);
  useEffect(() => setUnplacedOpen(false), [layout, currentRootId]);
  /** The map body's fly-to, for the find box. */
  const revealRef = useRef<((id: string) => void) | null>(null);

  // Position for useTreeCanvas: one node per person so Find can reveal them.
  const nodesByKey = useMemo(() => {
    const m = new Map<string, ChartNode>();
    if (surnames) {
      m.set(currentRootId, { key: currentRootId, x: surnames.cx, y: surnames.cy });
      for (const s of surnames.slices) m.set(s.person.id, { key: s.person.id, x: s.x, y: s.y });
    } else if (layout !== "bars") {
      m.set(currentRootId, { key: currentRootId, x: wheel.cx, y: wheel.cy });
      for (const d of wheel.dots) m.set(d.person.id, { key: d.person.id, x: d.x, y: d.y });
    } else {
      for (const band of bars.bands) {
        for (const r of band.rows) m.set(r.person.id, { key: r.person.id, x: r.x0, y: r.y });
      }
    }
    return m;
  }, [layout, wheel, bars, surnames, currentRootId]);

  const laid = useMemo(() => {
    const rootNode = nodesByKey.get(currentRootId) ?? [...nodesByKey.values()][0];
    if (!rootNode) return undefined;
    if (surnames) return { root: rootNode, width: surnames.width + 2 * PAD, height: surnames.height + 2 * PAD };
    return layout !== "bars"
      ? { root: rootNode, width: wheel.width + 2 * PAD, height: wheel.height + 2 * PAD }
      : { root: { ...rootNode, x: 0 }, width: bars.width + 2 * PAD, height: bars.height + 2 * PAD };
  }, [layout, nodesByKey, currentRootId, wheel, bars, surnames]);

  const { canvasRef, zoomLayerRef, viewport, panning, scrollBy, canvasProps, selectedKey, setSelectedKey, selectNode, revealNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(laid, nodesByKey, "lr", layout === "wheel" || layout === "surnames", 24, `${currentRootId}:${layout}:${scope}:${settings.maxGenerations ?? "all"}`);

  // On the map only the placed can be found; a hit elsewhere is a miss with
  // the usual re-root offer.
  const findSources = useMemo(
    () =>
      layout === "map"
        ? placedShown.map((x) => ({ key: x.person.id, people: [x.person.indi] }))
        : people.map((p) => ({ key: p.id, people: [p.indi] })),
    [layout, placedShown, people],
  );
  const reveal = useCallback(
    (key: string) => (layout === "map" ? revealRef.current?.(key) : revealNode(key)),
    [layout, revealNode],
  );
  const find = useChartFind(findSources, mainDs.individuals, reveal, changeRoot);


  const selected = people.find((p) => p.id === selectedKey);
  // Leaflet owns +/− on the map; the chart-canvas zoom keys stay off there.
  const onMap = layout === "map";
  useChartShortcuts({
    zoomIn: onMap ? undefined : zoomIn,
    zoomOut: onMap ? undefined : zoomOut,
    resetZoom: onMap ? undefined : resetZoom,
    fitToScreen: onMap ? undefined : fitToScreen,
    scrollBy: onMap ? undefined : scrollBy,
    onEdit: selected && onNavigate ? () => onNavigate(selected.id) : undefined,
    onLeave: onBack,
  });
  const selectedRows = useMemo(
    () => (selected ? individualFieldRows(t, selected.indi, undefined, mainDs) : []),
    [t, selected, mainDs],
  );
  const mainNav = useMemo(
    () => ({
      linkable: (id: string) => mainDs.individuals.has(id),
      onNavigate: (id: string) => { changeRoot(id); setSelectedKey(null); },
    }),
    [mainDs, setSelectedKey, changeRoot],
  );

  const pageKind = t("kin.pageTitle");
  const rootYears = root ? lifespanLine({ showLifespan: true, showAge: settings.showAge }, { years: people[0]?.years, age: lifespanAge(root) }) : undefined;
  const rootName = root ? nameOf(root) : "";
  const drawnCount = useMemo(() => people.filter(drawn).length, [people, drawn]);
  const litCount = yearOn ? people.filter((p) => drawn(p) && lit(p)).length : drawnCount;

  /** A ring's caption, named only where the gutter can actually hold the words:
   *  the arc left of the 6 o'clock axis is all it has, and a longer name would
   *  run into the family wedge beside it. The number always shows, and the exact
   *  kinship is on every tooltip regardless. */
  const ringName = (d: number): string => {
    if (d <= 3) return t(`kin.ring.${d}`, { defaultValue: "" });
    // Every even ring is a cousin degree — 4 birth links is a first cousin, 6 a
    // second, and so on without end. Generated from the app's own cousin
    // vocabulary so a ring and a person's tooltip never word it differently.
    // The odd rings mix a removed cousin with a great-uncle's line and have no
    // one settled name; they stay numbers.
    if (d % 2) return "";
    const degree = d / 2 - 1;
    return degree <= 3 ? t(`kin.ring.cousin${degree}`) : t("kin.ring.cousinN", { n: degree });
  };
  /** What a ring's number means, for its tooltip. */
  const ringTitle = (d: number) => {
    const named = ringName(d);
    return named ? `${d} · ${named}` : String(d);
  };

  /** The bars' year ruler and the root's own lifetime band, drawn to a given
   *  height so the sticky header can repeat them over the scrolling body. */
  const barsBackdrop = (height: number) => (
    <>
      {bars.ticks.map((y) => (
        <g key={y}>
          <line className="timeline-grid" x1={bars.xOf(y)} y1={34} x2={bars.xOf(y)} y2={height} />
          <text className="timeline-axis gm-data" x={bars.xOf(y)} y={26} textAnchor="middle">
            {y}
          </text>
        </g>
      ))}
      {window && (
        <rect
          className="kin-window"
          x={bars.xOf(window.from)}
          y={34}
          width={Math.max(1, bars.xOf(window.to) - bars.xOf(window.from))}
          height={Math.max(0, height - 34)}
        />
      )}
    </>
  );

  const barsBand = (band: (typeof bars.bands)[number]) => (
    <g key={band.distance}>
      <line className="kin-band-rule" x1={0} y1={band.y - 13} x2={bars.width} y2={band.y - 13} />
      <text className="kin-band-label" x={10} y={band.y - 10}>
        {ringTitle(band.distance)} <tspan className="kin-wedge-count">{band.count}</tspan>
      </text>
      {band.rows.map((r) => {
        const font = barNameFont(band.rowH);
        const label = barNameText({ ...r.person, name: nameFor(r.person) }, font);
        const showName = settings.kinNames && r.named && lit(r.person);
        return (
          <g
            key={r.person.id}
            data-key={r.person.id}
            tabIndex={0}
            role="button"
            aria-pressed={r.person.id === selectedKey}
            onClick={() => selectNode(r.person.id)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              selectNode(r.person.id);
            }}
          >
            <rect
              className={`kin-bar${lit(r.person) ? "" : " dim"}${r.person.id === selectedKey ? " selected" : ""}${r.person.id === find.hitKey ? " find-hit" : ""}`}
              x={r.x0}
              y={r.y}
              width={r.x1 - r.x0}
              height={band.rowH * 0.72}
              rx={Math.min(2.5, band.rowH / 3)}
              fill={colorOf(r.person)}
              fillOpacity={r.person.span.openEnd ? 0.65 : 1}
            >
              <title>{tooltipFor(r.person)}</title>
            </rect>
            {showName && (
              <text
                className="kin-name kin-bar-name"
                x={r.x0 - 7}
                y={r.y + band.rowH * 0.66}
                textAnchor="end"
                fontSize={font}
                fillOpacity={font < 8 ? 0.72 : 1}
              >
                {label}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );

  return (
    <ChartPage
      backLabel={backLabel}
      onBack={onBack}
      title={
        root ? (
          <ChartRootTitle
            name={rootName}
            sexCls={sexClass(root.sex)}
            years={rootYears}
            kinship={settings.showKinship && startId && startId !== currentRootId ? kinship?.label(currentRootId) : undefined}
            lineage={kinship?.lineage(currentRootId)}
            kind={pageKind}
          />
        ) : (
          pageKind
        )
      }
      actions={
        <>
          <ChartSettings lockedType="kin" availableGenerations={depth} />
          <ChartExportMenu
            disabled={!laid}
            slug={chartSlug(rootName, pageKind)}
            title={[rootName, rootYears, "—", pageKind].filter(Boolean).join(" ")}
            legend={legend}
            gedcom={{ ds: mainDs, personIds: people.map((p) => p.id) }}
            // The map is tiles, not an SVG: no image export from it.
            canvasRef={onMap ? undefined : canvasRef}
          />
        </>
      }
      controlsLeft={
        <>
          {kindSwitcher}
          <div className="tree-mode" role="tablist" aria-label={t("kin.layout")}>
          {(["wheel", "surnames", "bars", "map"] as const).map((l) => (
            <button
              key={l}
              role="tab"
              aria-selected={layout === l}
              className={layout === l ? "active" : ""}
              onClick={() => set({ kinLayout: l })}
            >
              {t(`kin.layout.${l}`)}
            </button>
          ))}
        </div>
        {window && (
          <div className="tree-mode" role="tablist" aria-label={t("kin.scope")}>
            {(["contemporaries", "all"] as const).map((sc) => (
              <button
                key={sc}
                role="tab"
                aria-selected={scope === sc}
                className={scope === sc ? "active" : ""}
                onClick={() => set({ kinScope: sc })}
              >
                {t(`kin.scope.${sc}`)}
              </button>
            ))}
          </div>
        )}
        <label className="kin-year">
          <input type="checkbox" checked={yearOn} onChange={(e) => setYearOn(e.target.checked)} />
          <span>{t("kin.aliveIn")}</span>
          <output className="kin-year-value">{year}</output>
          <input
            type="range"
            min={bars.minYear.toFixed(0)}
            max={now}
            value={year}
            disabled={!yearOn}
            onChange={(e) => setYear(Number(e.target.value))}
            aria-label={t("kin.aliveIn")}
          />
        </label>
        </>
      }
      controlsRight={
        <div className="tree-controls-right">
          <span className="kin-count">
            {onMap ? (
              <>
                {yearOn
                  ? t("kin.countInYear", { n: placedShown.filter((x) => lit(x.person)).length, year })
                  : t("kin.map.onMap", { count: placedShown.length })}
                {unplacedCount > 0 && (
                  <>
                    {" · "}
                    <button
                      type="button"
                      className={`kin-unplaced-btn${unplacedOpen ? " active" : ""}`}
                      aria-pressed={unplacedOpen}
                      title={t("kin.map.unplaced.tooltip")}
                      onClick={() => setUnplacedOpen((v) => !v)}
                    >
                      {t("kin.map.unplaced", { count: unplacedCount })}
                    </button>
                  </>
                )}
              </>
            ) : yearOn ? (
              t("kin.countInYear", { n: litCount, year })
            ) : (
              t("kin.count", { count: drawnCount })
            )}
          </span>
          <ChartFindBox find={find} />
        </div>
      }
    >
      <div className={`tree-canvas-wrap${onMap ? " map-canvas-wrap kin-map-wrap" : ""}`}>
        <ChartLegend entries={legend} hidden={hidden} onToggle={toggle} />
        {onMap && (
          <Suspense fallback={null}>
            <KinMapBody
              placed={placedShown}
              rootPoint={rootPoint}
              rootLabel={people[0] ? tooltipFor(people[0]) : rootName}
              rootInitials={initials(rootName)}
              colorOf={colorOf}
              categoryOf={categoryOf}
              lit={lit}
              nameFor={nameFor}
              kinshipOf={kinshipOf}
              redacted={redacted}
              tooltipFor={tooltipFor}
              selectedId={selectedKey}
              findHitId={find.hitKey}
              onSelect={selectNode}
              fitKey={`${currentRootId}:${scope}:${settings.maxGenerations ?? "all"}`}
              revealRef={revealRef}
            />
          </Suspense>
        )}
        {onMap && mapData && !mapData.placed.length && (
          <div className="map-empty">
            <div className="map-empty-card">
              <p className="map-empty-title">{t("kin.map.empty")}</p>
              <p className="map-empty-hint">{t("kin.map.emptyHint")}</p>
            </div>
          </div>
        )}
        {onMap && unplacedOpen && unplacedCount > 0 && (
          <div className="map-panel kin-unplaced-panel">
            <div className="map-panel-header">
              <span className="map-panel-title">{t("kin.map.unplaced.title")}</span>
              <button className="modal-close" onClick={() => setUnplacedOpen(false)} title={t("help.close")} aria-label={t("help.close")}>
                ×
              </button>
            </div>
            <div className="kin-unplaced-body">
              <p className="kin-unplaced-hint">{t("kin.map.unplaced.hint")}</p>
              {(
                [
                  ["noCoords", unplacedNoCoords],
                  ["noPlace", unplacedNoPlace],
                ] as const
              )
                .filter(([, list]) => list.length)
                .map(([group, list]) => (
                  <section key={group}>
                    <div className="kin-unplaced-group">
                      <span>{t(`kin.map.unplaced.${group}`, { count: list.length })}</span>
                      {/* The geocoding tool is the fix for this group — and only this one. */}
                      {group === "noCoords" && onOpenGeocode && (
                        <button type="button" className="nav-btn" onClick={onOpenGeocode}>
                          {t("tools.places.geocodeToggle")}
                        </button>
                      )}
                    </div>
                    <ul className="map-panel-list kin-map-list">
                      {list.slice(0, UNPLACED_MAX_ROWS).map((p) => (
                        <li key={p.id}>
                          <span className="map-panel-person">
                            {/* A redacted name is plain text: the link would
                                name the person its label withholds. */}
                            {redacted(p) || !onNavigate ? (
                              <span>{nameFor(p)}</span>
                            ) : (
                              <PersonLink dataset={mainDs} id={p.id} fallback={p.id} onNavigate={onNavigate} />
                            )}
                            <span className="person-kinship">{kinshipLabelFor(p.up, p.down, p.sex, t)}</span>
                          </span>
                        </li>
                      ))}
                      {list.length > UNPLACED_MAX_ROWS && (
                        <li className="map-panel-more">{t("kin.map.more", { count: list.length - UNPLACED_MAX_ROWS })}</li>
                      )}
                    </ul>
                  </section>
                ))}
            </div>
          </div>
        )}
        <div className={`tree-canvas${panning ? " panning" : ""}`} ref={canvasRef} {...canvasProps} hidden={onMap}>
          {laid && !onMap && (
            <ChartZoom width={laid.width} height={laid.height} zoom={zoom} layerRef={zoomLayerRef}>
              <svg className="tree-svg kin-svg" width={laid.width} height={laid.height} viewBox={`0 0 ${laid.width} ${laid.height}`} role="img">
                <g transform={`translate(${PAD},${PAD})`}>
                  {surnames ? (
                    <>
                      {/* One slice per relative, filled by the shared Color axis
                          exactly as the wheel's dots are, so the two layouts
                          answer the colour key the same way. They tile edge to
                          edge: the surname bands are drawn over them. */}
                      {surnames.slices
                        .filter((s) => shown(s.person))
                        .map((s) => (
                          <path
                            key={s.person.id}
                            className={`kin-slice${lit(s.person) ? "" : " dim"}${s.person.id === selectedKey ? " selected" : ""}${s.person.id === find.hitKey ? " find-hit" : ""}`}
                            d={s.pathD}
                            fill={sliceFill(s.person)}
                            onClick={() => selectNode(s.person.id)}
                          >
                            <title>{tooltipFor(s.person)}</title>
                          </path>
                        ))}
                      {/* A hairline where one surname gives way to the next… */}
                      {surnames.bands.map((b) => (
                        <line
                          key={`e${b.distance}:${b.a0.toFixed(2)}`}
                          className="kin-band-edge"
                          x1={surnames.cx + b.rInner * Math.cos((b.a0 * Math.PI) / 180)}
                          y1={surnames.cy + b.rInner * Math.sin((b.a0 * Math.PI) / 180)}
                          x2={surnames.cx + b.rOuter * Math.cos((b.a0 * Math.PI) / 180)}
                          y2={surnames.cy + b.rOuter * Math.sin((b.a0 * Math.PI) / 180)}
                        />
                      ))}
                      {/* …and a firmer one where the elders' run meets the
                          issue's, which is the one boundary in a ring that is
                          about kinship rather than about names. */}
                      {surnames.splits.map((s) => (
                        <line
                          key={`s${s.distance}:${s.angle.toFixed(2)}`}
                          className="kin-gen-split"
                          x1={surnames.cx + s.rInner * Math.cos((s.angle * Math.PI) / 180)}
                          y1={surnames.cy + s.rInner * Math.sin((s.angle * Math.PI) / 180)}
                          x2={surnames.cx + s.rOuter * Math.cos((s.angle * Math.PI) / 180)}
                          y2={surnames.cy + s.rOuter * Math.sin((s.angle * Math.PI) / 180)}
                        />
                      ))}
                      {settings.kinNames &&
                        surnames.bands.map((b) =>
                          !b.label ? null : b.label.pathD ? (
                            <g key={`l${b.distance}:${b.a0.toFixed(2)}`}>
                              <path id={`kin-sur-${b.distance}-${b.a0.toFixed(2)}`} d={b.label.pathD} fill="none" />
                              <text className="kin-surname" fontSize={b.label.fontPx} dominantBaseline="central">
                                <textPath href={`#kin-sur-${b.distance}-${b.a0.toFixed(2)}`} startOffset="50%" textAnchor="middle">
                                  {b.surname || t("kin.surname.none")}
                                  {b.label.count !== undefined && <tspan className="kin-wedge-count"> {b.label.count}</tspan>}
                                </textPath>
                              </text>
                            </g>
                          ) : (
                            <text
                              key={`l${b.distance}:${b.a0.toFixed(2)}`}
                              className="kin-surname"
                              fontSize={b.label.fontPx}
                              textAnchor="middle"
                              dominantBaseline="central"
                              transform={`translate(${b.label.x!.toFixed(1)},${b.label.y!.toFixed(1)}) rotate(${b.label.rotate!.toFixed(1)})`}
                            >
                              {b.surname || t("kin.surname.none")}
                              {b.label.count !== undefined && <tspan className="kin-wedge-count"> {b.label.count}</tspan>}
                            </text>
                          ),
                        )}
                      {/* The ring scale, on the 9 o'clock axis: a continuous ring
                          leaves no gutter to set it in, so it rides over the
                          bands on the halo the wheel's numbers already use. */}
                      {surnames.rings.filter((r) => r.numbered).map((ring) => (
                        <text
                          key={`r${ring.distance}`}
                          className="kin-ring-label"
                          x={surnames.cx - ring.labelR}
                          y={surnames.cy + 3.5}
                          textAnchor="middle"
                        >
                          <title>{ringTitle(ring.distance)}</title>
                          {ring.distance}
                        </text>
                      ))}
                      <circle className="kin-hub" cx={surnames.cx} cy={surnames.cy} r={19} />
                      <text className="kin-hub-label" x={surnames.cx} y={surnames.cy + 5} textAnchor="middle">
                        {initials(rootName)}
                      </text>
                    </>
                  ) : layout === "wheel" ? (
                    <>
                      {wheel.rings.map((ring) => (
                        <circle key={ring.distance} className="kin-ring" cx={wheel.cx} cy={wheel.cy} r={ring.rOuter} />
                      ))}
                      {wheel.wedges.map((w) => (
                        <g key={w.key}>
                          {[w.a0, w.a1].map((a) => {
                            const r = (a * Math.PI) / 180;
                            return (
                              <line
                                key={a}
                                className="kin-spoke"
                                x1={wheel.cx + 42 * Math.cos(r)}
                                y1={wheel.cy + 42 * Math.sin(r)}
                                x2={wheel.cx + wheel.radius * Math.cos(r)}
                                y2={wheel.cy + wheel.radius * Math.sin(r)}
                              />
                            );
                          })}
                          <text className="kin-wedge-label" x={w.labelX} y={w.labelY} textAnchor={w.labelAnchor} fill={branches.get(w.key)?.color ?? "var(--accent)"}>
                            {wedgeLabel(w.key, w.ancestorId)} <tspan className="kin-wedge-count">{w.count}</tspan>
                          </text>
                        </g>
                      ))}
                      {wheel.dots.filter((d) => shown(d.person)).map((d) => (
                        <circle
                          key={d.person.id}
                          className={`kin-dot${lit(d.person) ? "" : " dim"}${d.person.id === selectedKey ? " selected" : ""}${d.person.id === find.hitKey ? " find-hit" : ""}`}
                          cx={d.x}
                          cy={d.y}
                          r={d.r}
                          fill={colorOf(d.person)}
                          stroke={d.person.span.living && lit(d.person) ? "var(--text)" : "none"}
                          onClick={() => selectNode(d.person.id)}
                        >
                          <title>{tooltipFor(d.person)}</title>
                        </circle>
                      ))}
                      {/* The ring scale, set on the ring itself and right-aligned
                          to the 6 o'clock gutter, so the captions form one column
                          instead of running into the wedge beside them. */}
                      {wheel.rings.map((ring) => (
                        <g key={`s${ring.distance}`}>
                          <path id={`kin-ring-${ring.distance}`} d={ring.pathD} fill="none" />
                          {/* Just the number: the gutter is sized for it and
                              nothing more, and the kinship it stands for is on
                              its tooltip. */}
                          <text className="kin-ring-label">
                            <title>{ringTitle(ring.distance)}</title>
                            <textPath href={`#kin-ring-${ring.distance}`} startOffset={ring.textOffset} textAnchor="middle">
                              {ring.distance}
                            </textPath>
                          </text>
                        </g>
                      ))}
                      {settings.kinNames &&
                        wheel.labels
                          .filter((l) => lit(l.person) && shown(l.person))
                          .map((l) => (
                            <text
                              key={l.person.id}
                              className="kin-name"
                              x={l.x}
                              y={l.y}
                              textAnchor={l.anchor}
                              fontSize={WHEEL_LABEL_PX}
                            >
                              {redacted(l.person) ? nameFor(l.person) : l.text}
                            </text>
                          ))}
                      <circle className="kin-hub" cx={wheel.cx} cy={wheel.cy} r={19} />
                      <text className="kin-hub-label" x={wheel.cx} y={wheel.cy + 5} textAnchor="middle">
                        {initials(rootName)}
                      </text>
                    </>
                  ) : (
                    <>
                      {barsBackdrop(bars.height)}
                      {bars.bands.map(barsBand)}
                    </>
                  )}
                </g>
              </svg>
            </ChartZoom>
          )}
        </div>

        {/* Outside the canvas: an absolute child of a scroller scrolls away with
            the content, and the zoom toolbar has to stay put. */}
        {laid && !onMap && (
          <ZoomControls zoom={zoom} onZoomIn={zoomIn} onZoomOut={zoomOut} onReset={resetZoom} onFit={fitToScreen} />
        )}
        {/* The year ruler and the root's own row ride above the scrolling body:
            every other bar is read against that life, and losing it two thousand
            rows down makes the rest meaningless. Only once it is actually needed
            — unscrolled, or on a chart short enough never to scroll, it would
            just be a second copy of the row already on screen. It sits outside
            the canvas (an absolute child of a scroller scrolls away with the
            content) and carries the canvas's own PAD and scroll offset, so its
            axis lines up with the gridlines below it. */}
        {layout === "bars" && laid && viewport.top > 1 && (
          <div className="kin-sticky" style={{ height: (bars.headerHeight + PAD) * zoom }} aria-hidden>
            {/* Same width and the same flex + auto-margin centring the canvas
                gives the chart itself, so the two round identically — computing
                the offset by hand left the header a pixel off the gridlines. */}
            <svg
              width={laid.width * zoom}
              height={(bars.headerHeight + PAD) * zoom}
              viewBox={`0 0 ${laid.width} ${bars.headerHeight + PAD}`}
              style={{ transform: `translateX(${-viewport.left}px)` }}
            >
              <g transform={`translate(${PAD},${PAD})`}>
                {barsBackdrop(bars.headerHeight)}
                {bars.bands.filter((b) => b.distance === 0).map(barsBand)}
              </g>
            </svg>
          </div>
        )}
        {selected && (
          <TreeNodePanel
            node={{ name: nameFor(selected), years: selected.years, sex: selected.sex }}
            swatch={colorOf(selected)}
            rows={selectedRows}
            mainPerson={mainNav}
            mainLabel={t("tree.main")}
            singleColumn
            kinship={settings.showKinship && startId && startId !== selected.id ? kinship?.label(selected.id) : undefined}
            kinshipLineage={lineageClass(kinship?.lineage(selected.id))}
            onClose={() => setSelectedKey(null)}
            onSetRoot={() => { changeRoot(selected.id); setSelectedKey(null); }}
            extraActions={
              onNavigate ? (
                <button className="nav-btn tree-compare-root" onClick={() => onNavigate(selected.id)}>
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

/** Initials for the hub marker at the wheel's centre. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => [...w][0]?.toUpperCase() ?? "")
    .join("");
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import {
  WHEEL_LABEL_PX,
  barNameFont,
  barNameText,
  buildKinBars,
  buildKinshipWheel,
  collectKin,
  kinDepth,
  OWN_BRANCH,
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
import { useNameOf } from "./SettingsContext";
import { useChartShortcuts } from "../keyboard/useChartShortcuts";
import { sexClass } from "./sex";

// Full-page **Contemporaries** chart: every blood relative of one person, placed
// by how closely they are related rather than by pedigree position — and, by
// default, filtered to those whose life overlapped the root's.
//
// Two layouts over one data pass (see `src/chart/kinshipWheel.ts`): the wheel,
// where the distance from the centre is the blood distance and each wedge is a
// grandparent line; and the bars, the same people on a year axis banded by
// blood distance. The wheel answers "who are they and how close", the bars
// "who was here at the same time".

/** Wedge colours per side, in the order the wedges themselves run: the
 *  grandfather's line first, the grandmother's second. Keyed by side rather than
 *  by position in the list — indexing the flat list handed the father's lines
 *  the maternal purple. */
const BRANCH_COLORS: Record<"father" | "mother", string[]> = {
  father: ["var(--kin-line-f1)", "var(--kin-line-f2)"],
  mother: ["var(--kin-line-m1)", "var(--kin-line-m2)"],
};

/** Generation colour, mixed between the theme's two ramp ends so it reads on
 *  paper as well as on the dark. Each direction is scaled to the range actually
 *  on screen — a tree can reach twelve generations up and three down, and one
 *  shared span squeezes every descendant step into a few degrees of hue. Eased,
 *  so the crowded first steps still separate. */
function generationColor(g: number, up: number, down: number): string {
  if (g === 0) return "var(--kin-gen-0)";
  const n = g > 0 ? up : down;
  const t = n <= 1 ? 0 : Math.pow(Math.min(1, (Math.abs(g) - 1) / (n - 1)), 0.7);
  const [near, far] = g > 0 ? ["--kin-anc-near", "--kin-anc-far"] : ["--kin-desc-near", "--kin-desc-far"];
  return `color-mix(in oklch, var(${far}) ${(t * 100).toFixed(1)}%, var(${near}))`;
}

interface Props {
  mainDs: Dataset;
  rootId: string;
  startId?: string;
  backLabel: string;
  onBack: () => void;
  onNavigate?: (id: string) => void;
  onRootChange: (id: string) => void;
  kindSwitcher?: React.ReactNode;
}

export function KinshipChart({ mainDs, rootId, startId, backLabel, onBack, onNavigate, onRootChange, kindSwitcher }: Props) {
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

  // Colour needs the range on screen, not the tree's full depth.
  const [genUp, genDown] = useMemo(() => {
    let up = 1;
    let down = 1;
    for (const p of people) {
      if (p.generation > up) up = p.generation;
      if (-p.generation > down) down = -p.generation;
    }
    return [up, down];
  }, [people]);

  const branchColor = useMemo(() => {
    const map = new Map<string, string>([[OWN_BRANCH, "var(--accent)"]]);
    const seen = { father: 0, mother: 0 };
    for (const w of wheel.wedges) {
      if (w.key === OWN_BRANCH || w.side === "own") continue;
      const palette = BRANCH_COLORS[w.side];
      map.set(w.key, palette[seen[w.side]++] ?? "var(--faint)");
    }
    return map;
  }, [wheel.wedges]);

  const alive = useCallback(
    (p: KinPerson) => (p.span.to ?? p.span.from ?? -Infinity) >= year && (p.span.from ?? Infinity) <= year,
    [year],
  );
  const lit = useCallback((p: KinPerson) => !yearOn || alive(p), [yearOn, alive]);

  const colorOf = useCallback(
    (p: KinPerson) => {
      if (settings.kinColour === "branch") return branchColor.get(p.branch) ?? "var(--faint)";
      if (settings.kinColour === "living") return p.span.living ? "var(--accent)" : "var(--kin-deceased)";
      return generationColor(p.generation, genUp, genDown);
    },
    [settings.kinColour, branchColor, genUp, genDown],
  );

  const wedgeLabel = useCallback(
    (key: string, ancestorId?: string) => {
      if (key === OWN_BRANCH) return t("kin.wedge.own");
      const indi = ancestorId ? mainDs.individuals.get(ancestorId) : undefined;
      return indi ? nameOf(indi) : t("kin.wedge.unknown");
    },
    [t, mainDs, nameOf],
  );

  // The colour key doubles as a filter, like the Map's event-kind chips: each
  // entry hides its own group. The layout is built from everyone regardless, so
  // hiding a family line never reshuffles the wedges around it.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => setHidden(new Set()), [settings.kinColour]);
  const categoryOf = useCallback(
    (p: KinPerson) =>
      settings.kinColour === "branch" ? p.branch
        : settings.kinColour === "living" ? (p.span.living ? "living" : "deceased")
          : String(p.generation),
    [settings.kinColour],
  );
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

  /** The key's entries for the colour axis in force, each with its own count. */
  const legend = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of people) {
      if (p.distance === 0) continue;
      const k = categoryOf(p);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const label = (key: string): string => {
      if (settings.kinColour === "branch") {
        const w = wheel.wedges.find((x) => x.key === key);
        return wedgeLabel(key, w?.ancestorId);
      }
      if (settings.kinColour === "living") return t(`kin.living.${key}`);
      const g = Number(key);
      if (g === 0) return t("kin.gen.0");
      const n = Math.abs(g);
      const dir = g > 0 ? "up" : "down";
      return n <= 3 ? t(`kin.gen.${dir}.${n}`) : t(`kin.gen.${dir}.n`, { n });
    };
    const keys = [...counts.keys()].sort((a, b) =>
      settings.kinColour === "generation" ? Number(b) - Number(a) : (counts.get(b)! - counts.get(a)!),
    );
    return keys.map((key) => {
      const sample = people.find((p) => p.distance > 0 && categoryOf(p) === key)!;
      return { key, label: label(key), colour: colorOf(sample), count: counts.get(key)! };
    });
  }, [people, categoryOf, settings.kinColour, colorOf, wheel.wedges, wedgeLabel, t]);

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
  const tooltipFor = useCallback(
    (p: KinPerson) => {
      const rel = kinshipLabelFor(p.up, p.down, p.sex, t);
      return redacted(p)
        ? [nameFor(p), rel].filter(Boolean).join(" · ")
        : [p.name, rel, p.years].filter(Boolean).join(" · ");
    },
    [redacted, nameFor, t],
  );

  // Position for useTreeCanvas: one node per person so Find can reveal them.
  const nodesByKey = useMemo(() => {
    const m = new Map<string, ChartNode>();
    if (layout === "wheel") {
      m.set(currentRootId, { key: currentRootId, x: wheel.cx, y: wheel.cy });
      for (const d of wheel.dots) m.set(d.person.id, { key: d.person.id, x: d.x, y: d.y });
    } else {
      for (const band of bars.bands) {
        for (const r of band.rows) m.set(r.person.id, { key: r.person.id, x: r.x0, y: r.y });
      }
    }
    return m;
  }, [layout, wheel, bars, currentRootId]);

  const laid = useMemo(() => {
    const rootNode = nodesByKey.get(currentRootId) ?? [...nodesByKey.values()][0];
    if (!rootNode) return undefined;
    return layout === "wheel"
      ? { root: rootNode, width: wheel.width + 2 * PAD, height: wheel.height + 2 * PAD }
      : { root: { ...rootNode, x: 0 }, width: bars.width + 2 * PAD, height: bars.height + 2 * PAD };
  }, [layout, nodesByKey, currentRootId, wheel, bars]);

  const { canvasRef, zoomLayerRef, viewport, panning, scrollBy, canvasProps, selectedKey, setSelectedKey, selectNode, revealNode, zoom, zoomIn, zoomOut, resetZoom, fitToScreen } =
    useTreeCanvas(laid, nodesByKey, "lr", layout === "wheel", 24, `${currentRootId}:${layout}:${scope}:${settings.maxGenerations ?? "all"}`);

  const findSources = useMemo(
    () => people.map((p) => ({ key: p.id, people: [p.indi] })),
    [people],
  );
  const find = useChartFind(findSources, mainDs.individuals, revealNode, changeRoot);

  useChartShortcuts({ zoomIn, zoomOut, resetZoom, fitToScreen, scrollBy, onLeave: onBack });

  const selected = people.find((p) => p.id === selectedKey);
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
  const drawn = useCallback((p: KinPerson) => p.distance > 0 && shown(p), [shown]);
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
          <g key={r.person.id} onClick={() => selectNode(r.person.id)}>
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
            gedcom={{ ds: mainDs, personIds: people.map((p) => p.id) }}
            canvasRef={canvasRef}
          />
        </>
      }
      controlsLeft={
        <>
          {kindSwitcher}
          <div className="tree-mode" role="tablist" aria-label={t("kin.layout")}>
          {(["wheel", "bars"] as const).map((l) => (
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
            {yearOn
              ? t("kin.countInYear", { n: litCount, year })
              : t("kin.count", { count: drawnCount })}
          </span>
          <ChartFindBox find={find} />
        </div>
      }
    >
      {legend.length > 1 && (
        <div className="kin-legend" role="group" aria-label={t("kin.legend")}>
          {legend.map((e) => (
            <button
              key={e.key}
              type="button"
              className={`map-kind-chip${hidden.has(e.key) ? "" : " active"}`}
              aria-pressed={!hidden.has(e.key)}
              title={t("kin.legend.toggle")}
              onClick={() => toggle(e.key)}
            >
              <span className="map-kind-dot" style={{ background: e.colour }} />
              {e.label} <span className="kin-legend-count">{e.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="tree-canvas-wrap">
        <div className={`tree-canvas${panning ? " panning" : ""}`} ref={canvasRef} {...canvasProps}>
          {laid && (
            <ChartZoom width={laid.width} height={laid.height} zoom={zoom} layerRef={zoomLayerRef}>
              <svg className="tree-svg kin-svg" width={laid.width} height={laid.height} viewBox={`0 0 ${laid.width} ${laid.height}`} role="img">
                <g transform={`translate(${PAD},${PAD})`}>
                  {layout === "wheel" ? (
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
                          <text className="kin-wedge-label" x={w.labelX} y={w.labelY} textAnchor={w.labelAnchor} fill={branchColor.get(w.key)}>
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
        {laid && (
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

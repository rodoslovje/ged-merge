import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ChartAlignment } from "../chart/treeLayout";
import type { FanShape } from "../chart/fanLayout";
import { sanitizeColorAxis, type ColorAxis } from "../chart/nodeColor";
import { useSettingsSlice } from "./SettingsContext";

// Shared, persisted configuration for the full-page diagram views (Edit Tree,
// Compare Tree, Relationship chart). One instance drives all three so a change
// applies live everywhere; the choice is saved to localStorage so it sticks
// across sessions.

/** The two pedigree diagrams: "tree" (layered — the tidy tree or the grid of
 *  aligned columns, per `treeLayout`) and "fan" (radial — a fan or a full
 *  circle, per `fanShape`). */
export type PedigreeType = "tree" | "fan";

/** How the layered chart places its boxes: the tidy tree, or the grid of
 *  aligned columns (a pedigree grid for ancestors, an indented outline for
 *  descendants). */
export type TreeLayout = "tidy" | "grid";

export type { FanShape };

/** The look a pedigree page is actually drawing — the four the user can tell
 *  apart; keys the chart-kind title strings (`tree.kind.*`). */
export type PedigreeVariant = "tree" | "grid" | "fan" | "circle";

/** The name-display override for a chart's own Married-surname toggle. The
 *  toggle is seeded from the global Name-display setting and independent after,
 *  so the chart must pin the value both ways — passing nothing when the toggle
 *  is on would follow the global setting, and a chart could never turn the
 *  married surname on while that setting was off. Module-level constants, so
 *  the formatter useNameOf returns keeps a stable identity. */
const MARRIED_NAME_ON = { marriedSurname: true } as const;
const MARRIED_NAME_OFF = { marriedSurname: false } as const;
export function marriedNameOverride(show: boolean): { readonly marriedSurname: boolean } {
  return show ? MARRIED_NAME_ON : MARRIED_NAME_OFF;
}

/** The variant these settings draw. */
export function pedigreeVariant(s: Pick<ChartSettings, "type" | "treeLayout" | "fanShape">): PedigreeVariant {
  return s.type === "fan" ? s.fanShape : s.treeLayout === "grid" ? "grid" : "tree";
}

/** What the Charts hub is showing: one of the pedigree chart types, the
 *  relationship-to-start diagram, the family timeline, the places map, or the
 *  report page (currently the Ahnentafel; the descendant register will share
 *  the kind). The hub's kind switcher drives this; `type` keeps tracking the
 *  last pedigree chart so display logic (radial vs layered) stays valid while
 *  a non-pedigree view is open. */
export type ChartKind = PedigreeType | "relationship" | "timeline" | "kin" | "map" | "report";

/** The hub kinds that are not pedigree charts: choosing them leaves `type`
 *  untouched, so leaving them restores the last pedigree chart. */
const NON_PEDIGREE_KINDS = ["relationship", "timeline", "kin", "map", "report"] as const;

/** The preferences this file reads — subscribed field by field, so an
 *  unrelated one changing leaves it alone (see useSettingsSlice). */
const SETTINGS_KEYS = ["showAge", "marriedSurname"] as const;

export type { ChartAlignment };

/** Whose lifespan bars carry event dots on the Timeline. */
export type TimelineEventScope = "person" | "all" | "off";

/** Contemporaries: the wheel of blood distance, the same people as bars on a
 *  year axis or as dots on a map, or their surnames banded on continuous rings. */
export type KinLayout = "wheel" | "surnames" | "bars" | "map";

/** Contemporaries: which blood relatives are drawn — the ones whose life
 *  overlapped the root's, or every one of them. */
export type KinScope = "contemporaries" | "all";

export interface ChartSettings {
  type: PedigreeType;
  /** Tree kind: the tidy tree or the grid. */
  treeLayout: TreeLayout;
  /** Fan kind: the 230° fan or the full circle. */
  fanShape: FanShape;
  /** Last-used hub view; also decides what the Edit "Charts" button reopens. */
  kind: ChartKind;
  alignment: ChartAlignment;
  /** Show the kinship-to-start label on each node. */
  showKinship: boolean;
  /** Show the person's photo (when a media folder is loaded). */
  showPhoto: boolean;
  /** Show the birth–death lifespan years. */
  showLifespan: boolean;
  /** Show the person's age: appended to the lifespan in parentheses, or — when
   *  the lifespan is hidden — as its own "age N" line. */
  showAge: boolean;
  /** Show a place line (first available of birth / residence / death). */
  showPlace: boolean;
  /** Append a woman's married surname to her name, as the global Name-display
   *  setting does elsewhere. Seeded from that setting and independent after. */
  showMarriedName: boolean;
  /** Show the marriage year on the couple's connector / fan collar. */
  showMarriageDate: boolean;
  /** Show the marriage place on the couple's connector / fan collar. */
  showMarriagePlace: boolean;
  /** How many generations away from the root a chart/report draws — one shared
   *  choice for every view that fans out from a person. `null` = all of them. */
  maxGenerations: number | null;
  /** Redact people inferred to be living: show only their relationship / "Living". */
  privacyLiving: boolean;
  /** Timeline: whose bars carry event dots (root only / everyone / none). */
  timelineEvents: TimelineEventScope;
  /** Timeline: label the event dots with small text under the bar. */
  timelineEventLabels: boolean;
  /** Show residence information — the Timeline draws it as a thin strip under
   *  the lifespan bar, the Report as ⌂ fact lines. One shared choice. */
  showResidence: boolean;
  /** Report: add ⚒ occupation fact lines. */
  showOccupation: boolean;
  /** Report: add ✎ education fact lines. */
  showEducation: boolean;
  /** Report: show person notes under the name and event notes under the fact. */
  showNotes: boolean;
  /** Report: show source citations under the person and their fact lines. */
  showSources: boolean;
  /** Report: prose narrative style instead of the glyph fact-line list. */
  reportNarrative: boolean;
  /** Report: a table of contents up top — one line per generation with its
   *  entry-number range, linked to the section in every rendering. */
  reportToc: boolean;
  /** Contemporaries: wheel or bars. */
  kinLayout: KinLayout;
  /** Contemporaries: the root's contemporaries, or every blood relative. */
  kinScope: KinScope;
  /** What a person's fill says, on every chart that draws people — see
   *  {@link ColorAxis}. */
  colorAxis: ColorAxis;
  /** Contemporaries: write names beside the closest kin. */
  kinNames: boolean;
}

const DEFAULTS: ChartSettings = {
  type: "tree",
  treeLayout: "tidy",
  fanShape: "fan",
  kind: "tree",
  alignment: "lr",
  showKinship: true,
  showPhoto: true,
  showLifespan: true,
  showAge: false,
  showPlace: false,
  showMarriedName: true,
  showMarriageDate: false,
  showMarriagePlace: false,
  maxGenerations: null,
  privacyLiving: false,
  timelineEvents: "person",
  timelineEventLabels: false,
  showResidence: false,
  showOccupation: false,
  showEducation: false,
  showNotes: false,
  showSources: false,
  reportNarrative: false,
  reportToc: false,
  kinLayout: "wheel",
  kinScope: "contemporaries",
  colorAxis: "plain",
  kinNames: true,
};

const STORAGE_KEY = "gedmerge.chartSettings";

/** Upper end of the generation stepper — past this a chart is unreadable long
 *  before the data runs out, and "all" says it better anyway. */
export const MAX_GENERATIONS = 20;

/** A stored/handed-in generation limit reduced to a whole 1…{@link MAX_GENERATIONS}
 *  (anything else, `null` included, means "all generations"). */
export function clampGenerations(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(MAX_GENERATIONS, Math.max(1, Math.round(v)));
}

interface ChartSettingsCtx {
  settings: ChartSettings;
  setType: (type: PedigreeType) => void;
  /** Switch the hub view. A pedigree kind also becomes the chart `type`;
   *  "relationship" / "timeline" leave `type` untouched so leaving them
   *  restores the chart. */
  setKind: (kind: ChartKind) => void;
  setAlignment: (alignment: ChartAlignment) => void;
  /** Patch any subset of the settings (used by the display/privacy toggles). */
  set: (patch: Partial<ChartSettings>) => void;
}

export const ChartSettingsContext = createContext<ChartSettingsCtx>({
  settings: DEFAULTS,
  setType: () => {},
  setKind: () => {},
  setAlignment: () => {},
  set: () => {},
});

/**
 * Load the persisted chart settings. `defaults` seeds the two toggles that have
 * a global counterpart — Age and Married name — when the stored blob doesn't pin
 * them (a fresh user, or one from before the toggle existed). So a chart follows
 * the global preference by default, and becomes independent of it the moment the
 * user flips the chart's own toggle.
 */
function load(defaults: { showAge: boolean; showMarriedName: boolean }): ChartSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, ...defaults };
    const parsed = JSON.parse(raw) as Partial<ChartSettings>;
    // Each field falls back to its default, so older saved blobs (which lack the
    // newer display/privacy flags) load cleanly.
    const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
    // Grid and Circle were kinds of their own once: a blob from then carries
    // them in `type` (and `kind`), and they land on the kind that hosts them
    // now, with the layout / shape they meant.
    const legacy = parsed as { type?: string; kind?: string };
    const stored = legacy.kind === "grid" || legacy.kind === "circle" ? legacy.kind : legacy.type;
    const type: PedigreeType = stored === "fan" || stored === "circle" ? "fan" : DEFAULTS.type;
    const treeLayout: TreeLayout =
      parsed.treeLayout === "grid" || (parsed.treeLayout === undefined && stored === "grid") ? "grid" : "tidy";
    const fanShape: FanShape =
      parsed.fanShape === "circle" || (parsed.fanShape === undefined && stored === "circle") ? "circle" : "fan";
    return {
      type,
      treeLayout,
      fanShape,
      // Older saved blobs lack `kind`; fall back to the chart type they saved.
      kind: (NON_PEDIGREE_KINDS as readonly string[]).includes(parsed.kind as string) ? parsed.kind! : type,
      alignment: parsed.alignment === "tb" ? "tb" : DEFAULTS.alignment,
      showKinship: bool(parsed.showKinship, DEFAULTS.showKinship),
      showPhoto: bool(parsed.showPhoto, DEFAULTS.showPhoto),
      showLifespan: bool(parsed.showLifespan, DEFAULTS.showLifespan),
      showAge: bool(parsed.showAge, defaults.showAge),
      showMarriedName: bool(parsed.showMarriedName, defaults.showMarriedName),
      showPlace: bool(parsed.showPlace, DEFAULTS.showPlace),
      showMarriageDate: bool(parsed.showMarriageDate, DEFAULTS.showMarriageDate),
      showMarriagePlace: bool(parsed.showMarriagePlace, DEFAULTS.showMarriagePlace),
      maxGenerations: clampGenerations(parsed.maxGenerations),
      privacyLiving: bool(parsed.privacyLiving, DEFAULTS.privacyLiving),
      timelineEvents:
        parsed.timelineEvents === "all" || parsed.timelineEvents === "off"
          ? parsed.timelineEvents
          : DEFAULTS.timelineEvents,
      timelineEventLabels: bool(parsed.timelineEventLabels, DEFAULTS.timelineEventLabels),
      // showResidence replaced the timeline-only `timelineResidence` when the
      // Report gained residence lines; older blobs carry the old name.
      showResidence: bool(
        parsed.showResidence ?? (parsed as { timelineResidence?: unknown }).timelineResidence,
        DEFAULTS.showResidence,
      ),
      showOccupation: bool(parsed.showOccupation, DEFAULTS.showOccupation),
      showEducation: bool(parsed.showEducation, DEFAULTS.showEducation),
      showNotes: bool(parsed.showNotes, DEFAULTS.showNotes),
      showSources: bool(parsed.showSources, DEFAULTS.showSources),
      kinLayout:
        parsed.kinLayout === "bars" || parsed.kinLayout === "map" || parsed.kinLayout === "surnames"
          ? parsed.kinLayout
          : DEFAULTS.kinLayout,
      kinScope: parsed.kinScope === "all" ? "all" : DEFAULTS.kinScope,
      // The Contemporaries' own colour axis became the shared one; a blob from
      // then carries it as `kinColour`.
      colorAxis: sanitizeColorAxis(parsed.colorAxis ?? (parsed as { kinColour?: unknown }).kinColour),
      kinNames: bool(parsed.kinNames, DEFAULTS.kinNames),
      reportNarrative: bool(parsed.reportNarrative, DEFAULTS.reportNarrative),
      reportToc: bool(parsed.reportToc, DEFAULTS.reportToc),
    };
  } catch {
    return { ...DEFAULTS, ...defaults };
  }
}

function save(settings: ChartSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable / quota — settings stay in-memory for this session
  }
}

export function ChartSettingsProvider({ children }: { children: React.ReactNode }) {
  // Seed the Age and Married-name toggles from their global preferences on first
  // load, so charts honour them by default (SettingsProvider wraps this one, so
  // the global values are already resolved synchronously here).
  const appSettings = useSettingsSlice(SETTINGS_KEYS);
  const [settings, setSettings] = useState<ChartSettings>(
    () => load({ showAge: appSettings.showAge, showMarriedName: appSettings.marriedSurname }),
  );

  const update = useCallback((patch: Partial<ChartSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      save(next);
      return next;
    });
  }, []);

  const value = useMemo<ChartSettingsCtx>(
    () => ({
      settings,
      // Changing the chart type is also a hub-view choice, so both move together.
      setType: (type) => update({ type, kind: type }),
      setKind: (kind) =>
        update((NON_PEDIGREE_KINDS as readonly string[]).includes(kind) ? { kind } : { kind, type: kind as PedigreeType }),
      setAlignment: (alignment) => update({ alignment }),
      set: update,
    }),
    [settings, update],
  );

  return <ChartSettingsContext.Provider value={value}>{children}</ChartSettingsContext.Provider>;
}

export function useChartSettings() {
  return useContext(ChartSettingsContext);
}

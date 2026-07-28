import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ChartAlignment } from "../chart/treeLayout";
import { useSettings } from "./SettingsContext";

// Shared, persisted configuration for the full-page diagram views (Edit Tree,
// Compare Tree, Relationship chart). One instance drives all three so a change
// applies live everywhere; the choice is saved to localStorage so it sticks
// across sessions.

/** Diagram rendering style. "tree" (tidy layered), "grid" (aligned columns —
 *  a pedigree grid for ancestors, an indented outline for descendants), and
 *  "fan"/"circle" (radial, curved-text ancestor charts) are all implemented. */
export type PedigreeType = "tree" | "grid" | "fan" | "circle";

/** What the Charts hub is showing: one of the pedigree chart types, the
 *  relationship-to-start diagram, the family timeline, the places map, or the
 *  report page (currently the Ahnentafel; the descendant register will share
 *  the kind). The hub's kind switcher drives this; `type` keeps tracking the
 *  last pedigree chart so display logic (radial vs layered) stays valid while
 *  a non-pedigree view is open. */
export type ChartKind = PedigreeType | "relationship" | "timeline" | "map" | "report";

/** The hub kinds that are not pedigree charts: choosing them leaves `type`
 *  untouched, so leaving them restores the last pedigree chart. */
const NON_PEDIGREE_KINDS = ["relationship", "timeline", "map", "report"] as const;

export type { ChartAlignment };

/** Whose lifespan bars carry event dots on the Timeline. */
export type TimelineEventScope = "person" | "all" | "off";

export interface ChartSettings {
  type: PedigreeType;
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
  /** Show the status badges on nodes — the merge-decision C/R/D letters, the
   *  unsaved-edit "M" and the import "I" (Edit and Compare trees). */
  showBadges: boolean;
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
}

const DEFAULTS: ChartSettings = {
  type: "tree",
  kind: "tree",
  alignment: "lr",
  showKinship: true,
  showPhoto: true,
  showLifespan: true,
  showAge: false,
  showPlace: false,
  showBadges: true,
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
 * Load the persisted chart settings. `defaultShowAge` seeds the Age toggle when
 * the stored blob doesn't pin it (a fresh user, or one from before the toggle
 * existed) — so charts follow the global "Show ages" preference by default, then
 * become independent the moment the user flips the per-chart toggle.
 */
function load(defaultShowAge: boolean): ChartSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, showAge: defaultShowAge };
    const parsed = JSON.parse(raw) as Partial<ChartSettings>;
    // Each field falls back to its default, so older saved blobs (which lack the
    // newer display/privacy flags) load cleanly.
    const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
    const type =
      parsed.type === "grid" || parsed.type === "fan" || parsed.type === "circle"
        ? parsed.type
        : DEFAULTS.type;
    return {
      type,
      // Older saved blobs lack `kind`; fall back to the chart type they saved.
      kind: (NON_PEDIGREE_KINDS as readonly string[]).includes(parsed.kind as string) ? parsed.kind! : type,
      alignment: parsed.alignment === "tb" ? "tb" : DEFAULTS.alignment,
      showKinship: bool(parsed.showKinship, DEFAULTS.showKinship),
      showPhoto: bool(parsed.showPhoto, DEFAULTS.showPhoto),
      showLifespan: bool(parsed.showLifespan, DEFAULTS.showLifespan),
      showAge: bool(parsed.showAge, defaultShowAge),
      showPlace: bool(parsed.showPlace, DEFAULTS.showPlace),
      showBadges: bool(parsed.showBadges, DEFAULTS.showBadges),
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
      reportNarrative: bool(parsed.reportNarrative, DEFAULTS.reportNarrative),
      reportToc: bool(parsed.reportToc, DEFAULTS.reportToc),
    };
  } catch {
    return { ...DEFAULTS, showAge: defaultShowAge };
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
  // Seed the Age toggle from the global "Show ages" preference on first load, so
  // charts honour it by default (SettingsProvider wraps this one, so the global
  // value is already resolved synchronously here).
  const { settings: appSettings } = useSettings();
  const [settings, setSettings] = useState<ChartSettings>(() => load(appSettings.showAge));

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

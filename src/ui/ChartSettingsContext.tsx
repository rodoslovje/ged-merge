import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ChartAlignment } from "../tree/treeLayout";

// Shared, persisted configuration for the full-page diagram views (Edit Tree,
// Compare Tree, Relationship chart). One instance drives all three so a change
// applies live everywhere; the choice is saved to localStorage so it sticks
// across sessions.

/** Diagram rendering style. "tree" (tidy layered), "grid" (aligned columns —
 *  a pedigree grid for ancestors, an indented outline for descendants), and
 *  "fan"/"circle" (radial, curved-text ancestor charts) are all implemented. */
export type ChartType = "tree" | "grid" | "fan" | "circle";

/** What the Charts hub is showing: one of the pedigree chart types, or the
 *  relationship-to-start diagram. The hub's kind switcher drives this; `type`
 *  keeps tracking the last pedigree chart so display logic (radial vs layered)
 *  stays valid while the relationship diagram is open. */
export type ChartKind = ChartType | "relationship";

export type { ChartAlignment };

export interface ChartSettings {
  type: ChartType;
  /** Last-used hub view; also decides what the Edit "Charts" button reopens. */
  kind: ChartKind;
  alignment: ChartAlignment;
  /** Show the kinship-to-start label on each node. */
  showKinship: boolean;
  /** Show the person's photo (when a media folder is loaded). */
  showPhoto: boolean;
  /** Show the birth–death lifespan years. */
  showLifespan: boolean;
  /** Show a place line (first available of birth / residence / death). */
  showPlace: boolean;
  /** Show the marriage year on the couple's connector / fan collar. */
  showMarriageDate: boolean;
  /** Show the marriage place on the couple's connector / fan collar. */
  showMarriagePlace: boolean;
  /** Redact people inferred to be living: show only their relationship / "Living". */
  privacyLiving: boolean;
}

const DEFAULTS: ChartSettings = {
  type: "tree",
  kind: "tree",
  alignment: "lr",
  showKinship: true,
  showPhoto: true,
  showLifespan: true,
  showPlace: false,
  showMarriageDate: false,
  showMarriagePlace: false,
  privacyLiving: false,
};

const STORAGE_KEY = "gedmerge.chartSettings";

interface ChartSettingsCtx {
  settings: ChartSettings;
  setType: (type: ChartType) => void;
  /** Switch the hub view. A pedigree kind also becomes the chart `type`;
   *  "relationship" leaves `type` untouched so leaving it restores the chart. */
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

function load(): ChartSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
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
      kind: parsed.kind === "relationship" ? "relationship" : type,
      alignment: parsed.alignment === "tb" ? "tb" : DEFAULTS.alignment,
      showKinship: bool(parsed.showKinship, DEFAULTS.showKinship),
      showPhoto: bool(parsed.showPhoto, DEFAULTS.showPhoto),
      showLifespan: bool(parsed.showLifespan, DEFAULTS.showLifespan),
      showPlace: bool(parsed.showPlace, DEFAULTS.showPlace),
      showMarriageDate: bool(parsed.showMarriageDate, DEFAULTS.showMarriageDate),
      showMarriagePlace: bool(parsed.showMarriagePlace, DEFAULTS.showMarriagePlace),
      privacyLiving: bool(parsed.privacyLiving, DEFAULTS.privacyLiving),
    };
  } catch {
    return DEFAULTS;
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
  const [settings, setSettings] = useState<ChartSettings>(load);

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
      setKind: (kind) => update(kind === "relationship" ? { kind } : { kind, type: kind }),
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

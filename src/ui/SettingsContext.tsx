import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Individual, PersonName } from "../gedcom/types";
import { marriedSurnameOf, primaryName } from "../match/relatives";
import {
  DEFAULT_NAME_DISPLAY,
  formatPersonName,
  type NameDisplayOptions,
  type NameOrder,
} from "../gedcom/nameDisplay";
import { sanitizeFormatOverrides, type FormatOverrides } from "../normalize/formatOverrides";

// App-wide user preferences, persisted to localStorage so they stick across
// sessions. Follows the same shape as ChartSettingsContext: one provider near
// the root, a `set(patch)` updater, and a tolerant `load()` so older saved
// blobs (missing newer keys) fall back to defaults field by field.

export interface AppSettings extends NameDisplayOptions {
  /** Show each person's record id (xref) alongside their name. */
  showXref: boolean;
  /** Show the kinship-to-start-person label/badge throughout the app (person
   *  headers, relative cards, match candidates, tree nodes). When off, no
   *  kinship is shown anywhere even if a start person is set. */
  showKinship: boolean;
  /** Show ages: at death after the lifespan (current age for the living), the
   *  person's age next to each event date, and the parents'/spouses' ages on
   *  birth and family events. */
  showAge: boolean;
  /** Allow looking up link metadata through the public CORS relay (opt-in:
   *  this is the one feature that sends a URL off the user's machine). */
  allowLinkFetch: boolean;
  /** Allow the Map chart to load base-map tiles from the tile provider
   *  (opt-in: tile requests reveal the viewed region). Until enabled the map
   *  draws on the bundled offline world outline. */
  allowMapTiles: boolean;
  /** Show the small per-person places map under the Edit view's events. */
  showEditMap: boolean;
  /** Custom XYZ tile URL template ({z}/{x}/{y}); empty = the default CARTO
   *  basemap matching the current theme. */
  mapTileUrl: string;
  /** User overrides for the detected file-format conventions (dates, places,
   *  names, sources, links…). Absent fields mean "Detected" — the tools
   *  follow the file's own habit. See {@link FormatOverrides}. */
  formatOverrides: FormatOverrides;
  /** Cache the loaded files + progress to IndexedDB so a reload restores the
   *  workspace. Opt-in: off by default, and only when on may the browser be
   *  asked for persistent storage. */
  persistWorkspace: boolean;
}

const DEFAULTS: AppSettings = {
  ...DEFAULT_NAME_DISPLAY,
  showXref: false,
  showKinship: true,
  showAge: false,
  allowLinkFetch: false,
  allowMapTiles: false,
  showEditMap: true,
  mapTileUrl: "",
  formatOverrides: {},
  persistWorkspace: false,
};

const STORAGE_KEY = "gedmerge.settings";

interface SettingsCtx {
  settings: AppSettings;
  set: (patch: Partial<AppSettings>) => void;
}

export const SettingsContext = createContext<SettingsCtx>({
  settings: DEFAULTS,
  set: () => {},
});

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
    const order: NameOrder = parsed.order === "surname-given" ? "surname-given" : "given-surname";
    return {
      order,
      uppercaseSurname: bool(parsed.uppercaseSurname, DEFAULTS.uppercaseSurname),
      marriedSurname: bool(parsed.marriedSurname, DEFAULTS.marriedSurname),
      showXref: bool(parsed.showXref, DEFAULTS.showXref),
      showKinship: bool(parsed.showKinship, DEFAULTS.showKinship),
      showAge: bool(parsed.showAge, DEFAULTS.showAge),
      allowLinkFetch: bool(parsed.allowLinkFetch, DEFAULTS.allowLinkFetch),
      allowMapTiles: bool(parsed.allowMapTiles, DEFAULTS.allowMapTiles),
      // Legacy home of this preference (before it moved into Settings).
      showEditMap: bool(parsed.showEditMap, localStorage.getItem("gedmerge-edit-map-hidden") !== "true"),
      mapTileUrl: typeof parsed.mapTileUrl === "string" ? parsed.mapTileUrl : DEFAULTS.mapTileUrl,
      formatOverrides: {
        // Legacy key from the first page-media release, folded into overrides.
        ...((parsed as { sourcePageMedia?: string }).sourcePageMedia === "event" ||
        (parsed as { sourcePageMedia?: string }).sourcePageMedia === "source"
          ? { pageMedia: (parsed as { sourcePageMedia?: "event" | "source" }).sourcePageMedia }
          : {}),
        ...sanitizeFormatOverrides(parsed.formatOverrides),
      },
      persistWorkspace: bool(parsed.persistWorkspace, DEFAULTS.persistWorkspace),
    };
  } catch {
    return DEFAULTS;
  }
}

function save(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // storage unavailable / quota — settings stay in-memory for this session
  }
}

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<AppSettings>(load);

  const set = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      save(next);
      return next;
    });
  }, []);

  const value = useMemo<SettingsCtx>(() => ({ settings, set }), [settings, set]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  return useContext(SettingsContext);
}

/**
 * A name formatter bound to the current Name-display settings. Returns a stable
 * function for either a structured `PersonName` or an `Individual` (its primary
 * name), so the existing `displayName(primaryName(indi))` call sites become
 * `nameOf(indi)`.
 */
export function useNameOf(overrides?: Partial<NameDisplayOptions>) {
  const { settings } = useSettings();
  return useCallback(
    (subject: Individual | PersonName | undefined): string => {
      // Callers may pin individual display options (e.g. the reports drop the
      // married-surname parenthetical); pass a module-level constant so the
      // returned formatter keeps a stable identity.
      const opts = overrides ? { ...settings, ...overrides } : settings;
      // For an Individual, resolve the married surname from the whole record
      // (inline `_MARNM` *or* a separate `TYPE married` NAME) so both styles work.
      if (subject && "names" in subject) {
        const primary = primaryName(subject);
        const married = marriedSurnameOf(subject);
        return formatPersonName(primary ? { ...primary, married } : undefined, opts);
      }
      return formatPersonName(subject, opts);
    },
    [settings, overrides],
  );
}

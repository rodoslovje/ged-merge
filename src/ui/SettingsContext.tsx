import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { Individual, PersonName } from "../gedcom/types";
import { marriedSurnameOf, primaryName } from "../match/relatives";
import {
  DEFAULT_NAME_DISPLAY,
  formatPersonName,
  type NameDisplayOptions,
  type NameOrder,
} from "../gedcom/nameDisplay";

// App-wide user preferences, persisted to localStorage so they stick across
// sessions. Follows the same shape as ChartSettingsContext: one provider near
// the root, a `set(patch)` updater, and a tolerant `load()` so older saved
// blobs (missing newer keys) fall back to defaults field by field.

export interface AppSettings extends NameDisplayOptions {
  /** Show each person's record id (xref) alongside their name. */
  showXref: boolean;
  /** Allow looking up link metadata through the public CORS relay (opt-in:
   *  this is the one feature that sends a URL off the user's machine). */
  allowLinkFetch: boolean;
}

const DEFAULTS: AppSettings = {
  ...DEFAULT_NAME_DISPLAY,
  showXref: false,
  allowLinkFetch: false,
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
      allowLinkFetch: bool(parsed.allowLinkFetch, DEFAULTS.allowLinkFetch),
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
export function useNameOf() {
  const { settings } = useSettings();
  return useCallback(
    (subject: Individual | PersonName | undefined): string => {
      // For an Individual, resolve the married surname from the whole record
      // (inline `_MARNM` *or* a separate `TYPE married` NAME) so both styles work.
      if (subject && "names" in subject) {
        const primary = primaryName(subject);
        const married = marriedSurnameOf(subject);
        return formatPersonName(primary ? { ...primary, married } : undefined, settings);
      }
      return formatPersonName(subject, settings);
    },
    [settings],
  );
}

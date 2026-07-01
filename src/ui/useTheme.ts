import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemeMode = "auto" | "light" | "dark";

const THEME_KEY = "gedmerge.theme";

/** The OS's current colour-scheme preference. */
function osTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The persisted theme *mode*; absent/invalid means "follow the OS" (auto). */
function detectThemeMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_KEY);
  return saved === "light" || saved === "dark" ? saved : "auto";
}

/**
 * Light/dark theme. The mode is "auto" (follow the OS), "light" or "dark"; the
 * applied theme resolves "auto" against the live OS preference. Persisted in
 * localStorage and kept in sync with the inline boot script in index.html, and
 * mirrored onto the document's `data-theme` attribute.
 */
export function useTheme(): { themeMode: ThemeMode; changeThemeMode: (mode: ThemeMode) => void } {
  const [themeMode, setThemeMode] = useState<ThemeMode>(detectThemeMode);
  const [osPref, setOsPref] = useState<Theme>(osTheme);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = (e: MediaQueryListEvent) => setOsPref(e.matches ? "light" : "dark");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const theme: Theme = themeMode === "auto" ? osPref : themeMode;
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  function changeThemeMode(mode: ThemeMode) {
    setThemeMode(mode);
    try {
      if (mode === "auto") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, mode);
    } catch {
      // ignore storage failures (private mode); the in-memory choice still applies
    }
  }

  return { themeMode, changeThemeMode };
}

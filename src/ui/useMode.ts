import { useEffect, useState } from "react";

export type Mode = "merge" | "edit" | "tools";

const MODE_KEY = "gedmerge.mode";

/**
 * Active view mode (Merge / Edit / Tools), persisted to localStorage. Defaults
 * to "edit"; only "merge"/"edit" are restored on startup — "tools" is transient
 * and never becomes the boot mode.
 */
export function useMode(): [Mode, (m: Mode) => void] {
  const [mode, setMode] = useState<Mode>(() => {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === "merge" || saved === "edit" ? saved : "edit";
  });
  useEffect(() => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // ignore storage failures (private mode); the in-memory choice still applies
    }
  }, [mode]);
  return [mode, setMode];
}

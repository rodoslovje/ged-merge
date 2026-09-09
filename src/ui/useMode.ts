import { useEffect, useState } from "react";

export type Mode = "merge" | "edit" | "tools";

/** The key an earlier build remembered the mode under; cleared on boot. */
const LEGACY_MODE_KEY = "gedmerge.mode";

/**
 * Active view mode (Merge / Edit / Tools). Every session starts in Edit: the
 * mode is where the last session's work happened, not a preference, and a
 * file reopened in Merge or Tools with nothing to merge or scan opened on
 * an empty page. The mode is not persisted; the key an earlier build wrote
 * is removed so it stops lingering in storage.
 */
export function useMode(): [Mode, (m: Mode) => void] {
  const [mode, setMode] = useState<Mode>("edit");
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_MODE_KEY);
    } catch {
      // ignore storage failures (private mode)
    }
  }, []);
  return [mode, setMode];
}

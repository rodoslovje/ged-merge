import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Resolves once the browser has painted the frame the caller just committed. */
function afterPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/**
 * Run a slow main-thread action under a progress cursor. The cursor is put up
 * and painted *before* the work starts — a synchronous build would otherwise
 * hold the very frame that shows it — and taken down in the same commit as
 * whatever state the work sets, so it stays until the result is on screen.
 * A call while one is already running is ignored.
 */
export function useBusyCursor() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  useLayoutEffect(() => {
    if (!busy) return;
    const root = document.documentElement;
    root.classList.add("app-busy");
    return () => root.classList.remove("app-busy");
  }, [busy]);
  return useCallback(async (work: () => unknown) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await afterPaint();
      await work();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
}

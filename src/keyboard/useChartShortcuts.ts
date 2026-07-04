import { useEffect, useRef } from "react";
import { CHART_KEY, isEditableTarget, isModalOpen } from "./shortcuts";
import type { ChartKind } from "../ui/ChartSettingsContext";
import type { TreeMode } from "../tree/compareTree";

// Bare-key shortcuts for the full-page chart overlays: +/− zoom, 0 reset,
// F fit-to-screen, A/D ancestors/descendants, and digits 1–n for the kind
// switcher. Each chart page passes only the handlers it supports; the hidden
// Edit/Merge views gate their own key handlers while an overlay is open, so
// these keys never collide with the decision shortcuts (C/R/D) underneath.

interface Handlers {
  zoomIn?: () => void;
  zoomOut?: () => void;
  resetZoom?: () => void;
  fitToScreen?: () => void;
  /** Digit keys 1..n pick from this list (in tab order). */
  kinds?: readonly ChartKind[];
  onKind?: (kind: ChartKind) => void;
  /** A / D switch the direction; D is ignored when descendants are unavailable. */
  onMode?: (mode: TreeMode) => void;
  allowDescendants?: boolean;
}

export function useChartShortcuts(handlers: Handlers) {
  // Ref-fed closure so the listener registers once and always sees fresh handlers.
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isModalOpen()) return;
      // Shift stays allowed: "+" is Shift+"=" on most layouts.
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const h = ref.current;
      const key = e.key;
      if ((CHART_KEY.zoomIn as readonly string[]).includes(key)) {
        if (h.zoomIn) { e.preventDefault(); h.zoomIn(); }
        return;
      }
      if ((CHART_KEY.zoomOut as readonly string[]).includes(key)) {
        if (h.zoomOut) { e.preventDefault(); h.zoomOut(); }
        return;
      }
      if (key === CHART_KEY.zoomReset) {
        if (h.resetZoom) { e.preventDefault(); h.resetZoom(); }
        return;
      }
      const lower = key.toLowerCase();
      if (lower === CHART_KEY.fit) {
        if (h.fitToScreen) { e.preventDefault(); h.fitToScreen(); }
        return;
      }
      if (lower === CHART_KEY.ancestors) {
        if (h.onMode) { e.preventDefault(); h.onMode("ancestors"); }
        return;
      }
      if (lower === CHART_KEY.descendants) {
        if (h.onMode && h.allowDescendants !== false) { e.preventDefault(); h.onMode("descendants"); }
        return;
      }
      if (h.kinds && h.onKind && key >= "1" && key <= "9") {
        const kind = h.kinds[Number(key) - 1];
        if (kind) { e.preventDefault(); h.onKind(kind); }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

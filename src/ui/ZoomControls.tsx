import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CHART_KEY, keyHint } from "../keyboard/shortcuts";

interface Props {
  /** Current zoom factor (1 = native). */
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Scale the whole chart to fit the viewport. */
  onFit: () => void;
  /** Zoom to a typed factor (the percentage field). */
  onSetZoom: (zoom: number) => void;
}

/** A typed percentage as a zoom factor: "85", "85%" or "85,5" — nothing else. */
export function parseZoomPercent(text: string): number | undefined {
  const m = text.trim().replace(",", ".").match(/^(\d+(?:\.\d+)?)\s*%?$/);
  const pct = m ? Number(m[1]) : NaN;
  return pct > 0 ? pct / 100 : undefined;
}

/** Floating zoom toolbar pinned to the bottom-right of a `.tree-canvas-wrap`.
 *  Shared by the Edit Tree, Compare Tree, and Relationship charts; the keyboard /
 *  touchpad zoom (ctrl/⌘ + wheel) lives in `useTreeCanvas`. The percentage is a
 *  field: type a value and press Enter for a zoom the buttons' steps miss. */
export function ZoomControls({ zoom, onZoomIn, onZoomOut, onFit, onSetZoom }: Props) {
  const { t } = useTranslation();
  const shown = `${Math.round(zoom * 100)}%`;
  // The text being typed; undefined while the field just shows the zoom.
  const [draft, setDraft] = useState<string | undefined>();
  // Escape blurs the field too; the blur must then not apply what was typed.
  const cancelled = useRef(false);
  const justFocused = useRef(false);
  const commit = () => {
    const z = draft === undefined || cancelled.current ? undefined : parseZoomPercent(draft);
    cancelled.current = false;
    if (z !== undefined) onSetZoom(z);
    setDraft(undefined);
  };
  return (
    <div className="tree-zoom" role="group" aria-label={t("tree.zoom.label")}>
      <button className="tree-zoom-btn" onClick={onZoomIn} title={keyHint(t("tree.zoom.in"), "+")} aria-label={t("tree.zoom.in")}>
        +
      </button>
      <input
        className="tree-zoom-pct gm-data"
        type="text"
        inputMode="decimal"
        value={draft ?? shown}
        title={t("tree.zoom.pct")}
        aria-label={t("tree.zoom.pct")}
        onFocus={(e) => {
          e.currentTarget.select();
          justFocused.current = true;
        }}
        // A click's mouseup would put the caret down and drop the selection
        // the focus just made — the value is there to be typed over.
        onMouseUp={(e) => {
          if (justFocused.current) e.preventDefault();
          justFocused.current = false;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            e.stopPropagation();
            cancelled.current = true;
            e.currentTarget.blur();
          }
        }}
      />
      <button className="tree-zoom-btn" onClick={onZoomOut} title={keyHint(t("tree.zoom.out"), "−")} aria-label={t("tree.zoom.out")}>
        −
      </button>
      <button className="tree-zoom-btn tree-zoom-fit" onClick={onFit} title={keyHint(t("tree.zoom.fit"), CHART_KEY.fit.toUpperCase())} aria-label={t("tree.zoom.fit")}>
        {/* corner-arrows "fit" glyph */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
        </svg>
      </button>
    </div>
  );
}

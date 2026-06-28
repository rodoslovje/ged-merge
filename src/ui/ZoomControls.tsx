import { useTranslation } from "react-i18next";

interface Props {
  /** Current zoom factor (1 = native). */
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Scale the whole chart to fit the viewport. */
  onFit: () => void;
  /** Reset to 1× (native size) — also the action behind clicking the percentage. */
  onReset: () => void;
}

/** Floating zoom toolbar pinned to the bottom-right of a `.tree-canvas-wrap`.
 *  Shared by the Edit Tree, Compare Tree, and Relationship charts; the keyboard /
 *  touchpad zoom (ctrl/⌘ + wheel) lives in `useTreeCanvas`. */
export function ZoomControls({ zoom, onZoomIn, onZoomOut, onFit, onReset }: Props) {
  const { t } = useTranslation();
  return (
    <div className="tree-zoom" role="group" aria-label={t("tree.zoom.label")}>
      <button className="tree-zoom-btn" onClick={onZoomIn} title={t("tree.zoom.in")} aria-label={t("tree.zoom.in")}>
        +
      </button>
      <button
        className="tree-zoom-pct gm-data"
        onClick={onReset}
        title={t("tree.zoom.reset")}
        aria-label={t("tree.zoom.reset")}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button className="tree-zoom-btn" onClick={onZoomOut} title={t("tree.zoom.out")} aria-label={t("tree.zoom.out")}>
        −
      </button>
      <button className="tree-zoom-btn tree-zoom-fit" onClick={onFit} title={t("tree.zoom.fit")} aria-label={t("tree.zoom.fit")}>
        {/* corner-arrows "fit" glyph */}
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4" />
        </svg>
      </button>
    </div>
  );
}

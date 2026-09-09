import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CHART_KEY, isEditableTarget, isModalOpen, keyHint } from "../keyboard/shortcuts";
import { minimapDefaultOpen, type ChartNode, type Viewport } from "../chart/treeLayout";
import { TreeMinimap } from "./TreeMinimap";
import { MapIcon } from "./icons/MapIcon";

// The collapsible minimap corner shared by the layered chart pages: the
// TreeMinimap in a box with a hide button, or the small "show" toggle — and
// nothing at all while the whole chart fits the viewport. It starts expanded
// only when the chart dwarfs the screen (minimapDefaultOpen); once the user
// toggles it by hand, their choice wins for the rest of the page's life.

interface Props<T extends ChartNode> {
  /** Full chart extent in native px (the layout's width/height, PAD included). */
  contentW: number;
  contentH: number;
  viewport: Viewport;
  /** Canvas zoom — the visibility test compares scaled extent to the viewport. */
  zoom: number;
  nodes: T[];
  /** Fill colour for a node dot — each view colours by its own scheme. */
  fill: (n: T) => string;
  /** Box height for the current display settings. */
  nodeH?: number;
  onScrollTo: (left: number, top: number) => void;
}

export function ChartMinimap<T extends ChartNode>({ contentW, contentH, viewport, zoom, nodes, fill, nodeH, onScrollTo }: Props<T>) {
  const { t } = useTranslation();
  // null = follow the automatic default (collapsed unless the chart dwarfs the
  // screen); true/false once the user has toggled it by hand.
  const [mapOpen, setMapOpen] = useState<boolean | null>(null);

  // O flips the map, from anywhere on the page: the corner it lives in is a
  // long Tab away from the chart's people.
  const defaultOpen = minimapDefaultOpen(contentW, contentH, viewport);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== CHART_KEY.minimap || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (isEditableTarget(e.target) || isModalOpen() || e.defaultPrevented) return;
      e.preventDefault();
      setMapOpen((open) => !(open ?? defaultOpen));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [defaultOpen]);

  // The minimap only earns its corner when the chart overflows the viewport.
  const needed =
    viewport.width > 0 &&
    (contentW * zoom > viewport.width + 1 || contentH * zoom > viewport.height + 1);
  if (!needed) return null;

  const open = mapOpen ?? defaultOpen;
  const key = CHART_KEY.minimap.toUpperCase();
  return open ? (
    <div className="tree-minimap-box">
      <button
        className="tree-minimap-collapse"
        onClick={() => setMapOpen(false)}
        title={keyHint(t("tree.minimap.hide"), key)}
        aria-label={t("tree.minimap.hide")}
      >
        ×
      </button>
      <TreeMinimap
        nodes={nodes}
        contentW={contentW}
        contentH={contentH}
        viewport={viewport}
        onScrollTo={onScrollTo}
        fill={fill}
        nodeH={nodeH}
        zoom={zoom}
      />
    </div>
  ) : (
    <button
      className="tree-minimap-show"
      onClick={() => setMapOpen(true)}
      title={keyHint(t("tree.minimap.show"), key)}
      aria-label={t("tree.minimap.show")}
    >
      <MapIcon />
    </button>
  );
}

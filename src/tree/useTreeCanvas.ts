import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NODE_H, NODE_W, PAD, type ChartAlignment, type Placed, type Viewport } from "./treeLayout";

/** Zoom range and the per-click button step. Wheel zoom is continuous within this
 *  range; "fit" never magnifies past 1× so a small chart keeps its natural size. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Props to spread on the scrollable `.tree-canvas` div. */
export interface TreeCanvasProps {
  onScroll: () => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: React.MouseEvent) => void;
}

export interface TreeCanvas {
  canvasRef: React.RefObject<HTMLDivElement | null>;
  viewport: Viewport;
  /** True while a grab-pan is in progress (drives the `panning` cursor class). */
  panning: boolean;
  /** Imperatively scroll the canvas (used by node selection and the minimap). */
  scrollTo: (left: number, top: number) => void;
  canvasProps: TreeCanvasProps;
  /** Key of the currently selected node, or null. */
  selectedKey: string | null;
  setSelectedKey: (key: string | null) => void;
  /** The selected node, resolved against the current layout. */
  selected: Placed | undefined;
  /** Select a node (clicking the selected one again deselects) and centre it. */
  selectNode: (key: string) => void;
  /** Current zoom factor (1 = native); multiply the SVG's width/height by it
   *  while keeping the `viewBox` at native size for crisp vector scaling. */
  zoom: number;
  /** Step zoom in / out around the viewport centre. */
  zoomIn: () => void;
  zoomOut: () => void;
  /** Reset to 1× (native size), centred on the viewport's current centre. */
  resetZoom: () => void;
  /** Scale so the whole chart fits the viewport (never past 1×) and centre it. */
  fitToScreen: () => void;
}

/**
 * Shared canvas behaviour for the full-page tree views: viewport tracking,
 * grab-to-pan with the mouse/touchpad, re-centring on the root whenever the
 * layout changes, and node selection (centre-on-select, toggle-off, and
 * deselect when the tree itself changes). Both the Edit Tree and Compare Tree
 * use it identically.
 *
 * @param laid the current layout result (or undefined); when it changes the
 *   canvas scrolls so the root is pinned left and vertically centred, and any
 *   stale selection is cleared.
 * @param nodesByKey the laid-out nodes indexed by key, for selection lookup.
 */
export function useTreeCanvas(
  laid: { root: Placed; width?: number; height?: number } | undefined,
  nodesByKey: Map<string, Placed>,
  alignment: ChartAlignment = "lr",
  /** Radial charts (fan/circle) centre the whole diagram on the root instead of
   *  pinning it to the leading edge — the root sits at the chart's centre. */
  radial = false,
  /** Box height for the current display settings (grows when the place line shows). */
  nodeH: number = NODE_H,
): TreeCanvas {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ left: 0, top: 0, width: 0, height: 0 });
  const [panning, setPanning] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number; id: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  // Zoom lives here so all the viewport↔content conversions (root re-centring,
  // centre-on-select, the minimap) share one scale. `zoomRef` mirrors the state
  // so the wheel handler reads the latest value synchronously between renders.
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  // A zoom changes the SVG's rendered size, which only takes effect after the
  // consumer re-renders. So we stash the target scroll here and apply it in a
  // layout effect — after the bigger/smaller SVG has been committed — otherwise
  // the browser clamps the scroll to the *old* (stale) scrollable extent.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);

  const syncViewport = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    setViewport({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight });
  }, []);

  // On (re)layout — initial load, mode switches, alignment flips — scroll so the
  // starting person (the tree root) is in view. The root sits at the leading edge
  // of the depth axis, so pin it there (left in LR, top in TB) and centre it on
  // the breadth axis. Then re-measure for the minimap.
  useEffect(() => {
    const el = canvasRef.current;
    if (el && laid) {
      // Layout coordinates are in native (1×) space; the SVG is rendered scaled,
      // so on-screen scroll positions are layout px × zoom.
      const z = zoomRef.current;
      if (radial) {
        // Root centroid is the chart's centre; centre it both ways.
        el.scrollLeft = Math.max(0, (laid.root.x + PAD) * z - el.clientWidth / 2);
        el.scrollTop = Math.max(0, (laid.root.y + PAD) * z - el.clientHeight / 2);
      } else if (alignment === "tb") {
        el.scrollTop = Math.max(0, laid.root.y * z);
        el.scrollLeft = Math.max(0, (laid.root.x + PAD + NODE_W / 2) * z - el.clientWidth / 2);
      } else {
        el.scrollLeft = Math.max(0, laid.root.x * z);
        el.scrollTop = Math.max(0, (laid.root.y + PAD + nodeH / 2) * z - el.clientHeight / 2);
      }
    }
    syncViewport();
  }, [laid, syncViewport, alignment, radial, nodeH]);

  // Apply a pending zoom-driven scroll once the resized SVG has been committed,
  // then re-measure so the minimap's viewport box tracks the new scale.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (el && pendingScroll.current) {
      el.scrollLeft = pendingScroll.current.left;
      el.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    }
    syncViewport();
  }, [zoom, syncViewport]);

  // Re-scale around a focus point (cx, cy) given in canvas-client pixels, keeping
  // the layout point under that focus fixed on screen.
  const zoomAround = useCallback((next: number, cx: number, cy: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const clamped = clampZoom(next);
    const prev = zoomRef.current;
    if (clamped === prev) return;
    const ratio = clamped / prev;
    pendingScroll.current = {
      left: (el.scrollLeft + cx) * ratio - cx,
      top: (el.scrollTop + cy) * ratio - cy,
    };
    zoomRef.current = clamped;
    setZoom(clamped);
  }, []);

  const zoomCentre = useCallback((next: number) => {
    const el = canvasRef.current;
    if (!el) return;
    zoomAround(next, el.clientWidth / 2, el.clientHeight / 2);
  }, [zoomAround]);

  const zoomIn = useCallback(() => zoomCentre(zoomRef.current * ZOOM_STEP), [zoomCentre]);
  const zoomOut = useCallback(() => zoomCentre(zoomRef.current / ZOOM_STEP), [zoomCentre]);
  const resetZoom = useCallback(() => zoomCentre(1), [zoomCentre]);

  const fitToScreen = useCallback(() => {
    const el = canvasRef.current;
    if (!el || !laid?.width || !laid?.height) return;
    // Fit the whole chart, but never magnify a small one past its native size.
    const z = clampZoom(Math.min(1, el.clientWidth / laid.width, el.clientHeight / laid.height));
    pendingScroll.current = {
      left: Math.max(0, (laid.width * z - el.clientWidth) / 2),
      top: Math.max(0, (laid.height * z - el.clientHeight) / 2),
    };
    zoomRef.current = z;
    setZoom(z);
  }, [laid]);

  // Ctrl/⌘ + wheel (and touchpad pinch, which the browser delivers as ctrl+wheel)
  // zooms toward the cursor; a plain wheel keeps the canvas's native scrolling.
  // Attached natively with { passive: false } so preventDefault actually blocks
  // the browser's page zoom — React's synthetic onWheel can't guarantee that.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAround(zoomRef.current * factor, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAround]);

  useEffect(() => {
    window.addEventListener("resize", syncViewport);
    return () => window.removeEventListener("resize", syncViewport);
  }, [syncViewport]);

  const scrollTo = useCallback((left: number, top: number) => {
    const el = canvasRef.current;
    if (!el) return;
    el.scrollLeft = left; // browser clamps to range; onScroll re-syncs the rect
    el.scrollTop = top;
  }, []);

  // A new tree (mode switch / different root) invalidates the old selection.
  useEffect(() => setSelectedKey(null), [laid]);

  const selectNode = useCallback(
    (key: string) => {
      // Clicking the already-selected node deselects it (and skips re-centring).
      if (key === selectedKey) {
        setSelectedKey(null);
        return;
      }
      setSelectedKey(key);
      const n = nodesByKey.get(key);
      const el = canvasRef.current;
      if (!n || !el) return;
      // The detail panel covers the right half of the canvas, so centre the node
      // in the left (visible) area — at a quarter of the width — not the middle.
      // Node coordinates are native; scroll is in scaled (zoomed) pixels.
      const z = zoomRef.current;
      scrollTo(
        (n.x + PAD + NODE_W / 2) * z - el.clientWidth / 4,
        (n.y + PAD + nodeH / 2) * z - el.clientHeight / 2,
      );
    },
    [selectedKey, nodesByKey, scrollTo, nodeH],
  );

  const selected = selectedKey ? nodesByKey.get(selectedKey) : undefined;

  // Grab-to-pan with mouse / touchpad. Touch keeps the browser's native
  // one-finger scroll (with momentum), so we ignore touch pointers here.
  // We only capture the pointer *after* movement crosses a threshold — capturing
  // on pointerdown would retarget the click off the node and break selection.
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "touch" || e.button !== 0) return;
    const el = canvasRef.current;
    if (!el) return;
    pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, id: e.pointerId, moved: false };
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    const el = canvasRef.current;
    if (!p || !el) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!p.moved) {
      if (Math.hypot(dx, dy) < 4) return; // ignore jitter, keep clicks clickable
      p.moved = true;
      el.setPointerCapture(p.id);
      setPanning(true);
    }
    el.scrollLeft = p.left - dx;
    el.scrollTop = p.top - dy;
  }, []);

  const onPointerUp = useCallback(() => {
    const p = pan.current;
    const el = canvasRef.current;
    if (!p) return;
    if (p.moved) {
      dragged.current = true; // swallow the click that the drag would emit
      if (el?.hasPointerCapture(p.id)) el.releasePointerCapture(p.id);
      setPanning(false);
    }
    pan.current = null;
  }, []);

  // After a pan, cancel the trailing click so dragging doesn't select a node.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (dragged.current) {
      e.stopPropagation();
      dragged.current = false;
    }
  }, []);

  return {
    canvasRef,
    viewport,
    panning,
    scrollTo,
    canvasProps: {
      onScroll: syncViewport,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onClickCapture,
    },
    selectedKey,
    setSelectedKey,
    selected,
    selectNode,
    zoom,
    zoomIn,
    zoomOut,
    resetZoom,
    fitToScreen,
  };
}

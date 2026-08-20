import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NODE_H, NODE_W, PAD, type ChartAlignment, type ChartNode, type Viewport } from "../chart/treeLayout";
import { PHONE_QUERY } from "./usePhone";

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
  /** Attach to the ChartZoom wrapper: pinch/wheel gestures paint on it directly
   *  (CSS transform) and only commit to React state when the gesture ends. */
  zoomLayerRef: React.RefObject<HTMLDivElement | null>;
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
  selected: ChartNode | undefined;
  /** Select a node (clicking the selected one again deselects) and centre it. */
  selectNode: (key: string) => void;
  /** Select and centre a node unconditionally — what find-in-chart jumps with:
   *  landing on the person you searched for must never toggle them off. */
  revealNode: (key: string) => void;
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
 * @param laid the current layout result (or undefined); a stale selection is
 *   cleared whenever it changes, and the canvas scrolls to the root whenever
 *   `viewKey` says this is a different chart.
 * @param nodesByKey the laid-out nodes indexed by key, for selection lookup.
 */
export function useTreeCanvas(
  laid: { root: ChartNode; width?: number; height?: number } | undefined,
  nodesByKey: Map<string, ChartNode>,
  alignment: ChartAlignment = "lr",
  /** Radial charts (fan/circle) centre the whole diagram on the root instead of
   *  pinning it to the leading edge — the root sits at the chart's centre. */
  radial = false,
  /** Box height for the current display settings (grows when the place line shows). */
  nodeH: number = NODE_H,
  /** What makes this a *different* chart — the root person, the direction, the
   *  chart type. The view scrolls home when this changes, and holds still when
   *  it doesn't: every display toggle rebuilds `laid` too (a place line changes
   *  the node height), and being thrown back to the root for ticking "Place" is
   *  no way to compare two settings. Omit to scroll home on every relayout. */
  viewKey?: string,
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

  // ── Gesture fast path ──────────────────────────────────────────────────────
  // While a pinch (or a ctrl+wheel run) is in progress, the accumulated pan and
  // zoom are painted as a plain CSS transform on the ChartZoom layer — no React
  // state, no scroll writes, no SVG re-layout per event, so the browser only
  // re-composites. The gesture commits once, when the fingers lift or the wheel
  // goes idle: the transform is folded into the real zoom + scroll, and the
  // layer transform is cleared in the same layout-effect frame so nothing jumps.
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  // `k` is the factor on top of the committed zoom; (dx, dy) the translation;
  // (x0, y0) the layer's client origin when the gesture started (identity).
  const gesture = useRef<{ k: number; dx: number; dy: number; x0: number; y0: number } | null>(null);
  const gestureRaf = useRef(0);
  const wheelIdle = useRef(0);
  const pendingLayerReset = useRef(false);

  const syncViewport = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    setViewport({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight });
  }, []);

  // Apply a pending zoom-driven scroll once the resized SVG has been committed,
  // then re-measure so the minimap's viewport box tracks the new scale. A
  // gesture commit also clears its layer transform here — before paint, in the
  // same frame the resized SVG lands — so the swap is invisible.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (el && pendingScroll.current) {
      el.scrollLeft = pendingScroll.current.left;
      el.scrollTop = pendingScroll.current.top;
      pendingScroll.current = null;
    }
    if (pendingLayerReset.current) {
      pendingLayerReset.current = false;
      const layer = zoomLayerRef.current;
      if (layer) {
        layer.style.transform = "";
        layer.style.willChange = "";
      }
    }
    syncViewport();
  }, [zoom, syncViewport]);

  // Open (or continue) the in-progress gesture; null when the host renders no
  // ChartZoom layer — the caller then falls back to committing per event.
  const ensureGesture = useCallback(() => {
    const layer = zoomLayerRef.current;
    if (!layer) return null;
    if (!gesture.current) {
      const r = layer.getBoundingClientRect();
      gesture.current = { k: 1, dx: 0, dy: 0, x0: r.left, y0: r.top };
      // Promote the layer for the duration of the gesture so the per-event
      // transform stays on the compositor; cleared again on commit.
      layer.style.willChange = "transform";
    }
    return gesture.current;
  }, []);

  // Paint the gesture transform once per animation frame, however many wheel /
  // touch events arrived in between.
  const paintGesture = useCallback(() => {
    if (gestureRaf.current) return;
    gestureRaf.current = requestAnimationFrame(() => {
      gestureRaf.current = 0;
      const g = gesture.current;
      const layer = zoomLayerRef.current;
      if (g && layer) layer.style.transform = `translate(${g.dx}px, ${g.dy}px) scale(${g.k})`;
    });
  }, []);

  /** Scale the gesture by `factor` about the client point (cx, cy), keeping the
   *  content under that point fixed on screen. False = no layer to paint on. */
  const gestureZoom = useCallback((factor: number, cx: number, cy: number) => {
    const g = ensureGesture();
    if (!g) return false;
    // Clamp so the zoom the commit will land on stays inside the range.
    const k = clampZoom(zoomRef.current * g.k * factor) / zoomRef.current;
    // The layer-local point currently under the focus…
    const px = (cx - g.x0 - g.dx) / g.k;
    const py = (cy - g.y0 - g.dy) / g.k;
    // …stays put: solve translate for the new scale.
    g.dx = cx - g.x0 - px * k;
    g.dy = cy - g.y0 - py * k;
    g.k = k;
    paintGesture();
    return true;
  }, [ensureGesture, paintGesture]);

  /** Pan the gesture by the fingers' midpoint travel. False = no layer. */
  const gesturePan = useCallback((mx: number, my: number) => {
    const g = ensureGesture();
    if (!g) return false;
    g.dx += mx;
    g.dy += my;
    paintGesture();
    return true;
  }, [ensureGesture, paintGesture]);

  /** Fold the gesture transform into the committed zoom + scroll (one render). */
  const commitGesture = useCallback(() => {
    const g = gesture.current;
    gesture.current = null;
    if (gestureRaf.current) {
      cancelAnimationFrame(gestureRaf.current);
      gestureRaf.current = 0;
    }
    if (wheelIdle.current) {
      clearTimeout(wheelIdle.current);
      wheelIdle.current = 0;
    }
    const el = canvasRef.current;
    const layer = zoomLayerRef.current;
    if (!g || !el || !layer) return;
    const z0 = zoomRef.current;
    const z1 = clampZoom(z0 * g.k);
    // Where the layer's content origin visually sits now (client coords) —
    // computed from the gesture state, so an unpainted last event still counts.
    const ox = g.x0 + g.dx;
    const oy = g.y0 + g.dy;
    // Scroll that reproduces that position at the committed scale. The layer's
    // layout offset inside the canvas is the flex auto-margin centring, which
    // only bites while the scaled chart is smaller than the canvas.
    const rect = el.getBoundingClientRect();
    const centreX = Math.max(0, (el.clientWidth - (laid?.width ?? 0) * z1) / 2);
    const centreY = Math.max(0, (el.clientHeight - (laid?.height ?? 0) * z1) / 2);
    const left = Math.max(0, centreX + rect.left + el.clientLeft - ox);
    const top = Math.max(0, centreY + rect.top + el.clientTop - oy);
    if (z1 === z0) {
      // Pure pan (or a pinch that cancelled itself out): no re-render is
      // coming, so clear the transform and set the scroll directly.
      layer.style.transform = "";
      layer.style.willChange = "";
      el.scrollLeft = left;
      el.scrollTop = top;
      syncViewport();
      return;
    }
    pendingLayerReset.current = true;
    pendingScroll.current = { left, top };
    zoomRef.current = z1;
    setZoom(z1);
  }, [laid, syncViewport]);

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
    commitGesture(); // a wheel gesture may still be in its idle window
    zoomAround(next, el.clientWidth / 2, el.clientHeight / 2);
  }, [zoomAround, commitGesture]);

  const zoomIn = useCallback(() => zoomCentre(zoomRef.current * ZOOM_STEP), [zoomCentre]);
  const zoomOut = useCallback(() => zoomCentre(zoomRef.current / ZOOM_STEP), [zoomCentre]);
  const resetZoom = useCallback(() => zoomCentre(1), [zoomCentre]);

  const fitToScreen = useCallback(() => {
    const el = canvasRef.current;
    if (!el || !laid?.width || !laid?.height) return;
    commitGesture(); // a wheel gesture may still be in its idle window
    // Fit the whole chart, but never magnify a small one past its native size.
    const z = clampZoom(Math.min(1, el.clientWidth / laid.width, el.clientHeight / laid.height));
    const left = Math.max(0, (laid.width * z - el.clientWidth) / 2);
    const top = Math.max(0, (laid.height * z - el.clientHeight) / 2);
    if (z === zoomRef.current) {
      // Already at the fit scale: no re-render is coming to flush a pending
      // scroll, so centre directly (the scrollable extent is already right).
      el.scrollLeft = left;
      el.scrollTop = top;
      return;
    }
    pendingScroll.current = { left, top };
    zoomRef.current = z;
    setZoom(z);
  }, [laid, commitGesture]);

  // On a new chart — initial load, a re-root, mode switches, alignment flips —
  // scroll so the starting person (the tree root) is in view. The root sits at
  // the leading edge of the depth axis, so pin it there (left in LR, top in TB)
  // and centre it on the breadth axis. Then re-measure for the minimap.
  // (Defined after fitToScreen: the dependency array reads it during render.)
  const homedFor = useRef<string | null>(null);
  useEffect(() => {
    const el = canvasRef.current;
    // Same chart, re-laid out (a display toggle): keep the reader where they are.
    const home = viewKey === undefined || homedFor.current !== viewKey;
    if (el && laid && home) {
      homedFor.current = viewKey ?? null;
      // Layout coordinates are in native (1×) space; the SVG is rendered scaled,
      // so on-screen scroll positions are layout px × zoom.
      const z = zoomRef.current;
      if (radial) {
        // A radial chart is one compact disc: open it whole — fitted (never past
        // 1×) and centred — rather than showing just the middle rings at the
        // zoom left over from the previous chart.
        fitToScreen();
      } else if (alignment === "tb") {
        el.scrollTop = Math.max(0, laid.root.y * z);
        el.scrollLeft = Math.max(0, (laid.root.x + PAD + NODE_W / 2) * z - el.clientWidth / 2);
      } else {
        el.scrollLeft = Math.max(0, laid.root.x * z);
        el.scrollTop = Math.max(0, (laid.root.y + PAD + nodeH / 2) * z - el.clientHeight / 2);
      }
    }
    syncViewport();
  }, [laid, syncViewport, alignment, radial, nodeH, viewKey, fitToScreen]);

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
      const factor = Math.exp(-e.deltaY * 0.0015);
      // Fast path: paint the run of wheel events as one gesture and commit
      // when it goes idle. Without a ChartZoom layer, commit per event.
      if (gestureZoom(factor, e.clientX, e.clientY)) {
        if (wheelIdle.current) clearTimeout(wheelIdle.current);
        wheelIdle.current = window.setTimeout(commitGesture, 140);
        return;
      }
      const rect = el.getBoundingClientRect();
      zoomAround(zoomRef.current * factor, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAround, gestureZoom, commitGesture]);

  // Two-finger pinch zooms toward the fingers' midpoint; moving the midpoint
  // pans. Attached natively with { passive: false } so preventDefault blocks
  // the browser's own pinch (page zoom) and scroll while two fingers are down —
  // one-finger touch keeps the native momentum scroll. The `.tree-canvas`
  // touch-action CSS (pan-x pan-y) makes the browser hand the pinch to us.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    let lastDist = 0;
    let lastMid = { x: 0, y: 0 };
    const measure = (e: TouchEvent) => {
      const [a, b] = [e.touches[0], e.touches[1]];
      return {
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        mid: { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 },
      };
    };
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      ({ dist: lastDist, mid: lastMid } = measure(e));
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2 || lastDist === 0) return;
      e.preventDefault();
      const { dist, mid } = measure(e);
      // Fast path: fold the midpoint's travel and the pinch into the gesture
      // transform. Without a ChartZoom layer, commit per event as before.
      if (gesturePan(mid.x - lastMid.x, mid.y - lastMid.y)) {
        gestureZoom(dist / lastDist, mid.x, mid.y);
      } else {
        // Pan by the midpoint's travel first: zoomAround reads the scroll
        // position synchronously, so the pan is folded into its target.
        el.scrollLeft -= mid.x - lastMid.x;
        el.scrollTop -= mid.y - lastMid.y;
        const rect = el.getBoundingClientRect();
        zoomAround(zoomRef.current * (dist / lastDist), mid.x - rect.left, mid.y - rect.top);
      }
      lastDist = dist;
      lastMid = mid;
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        lastDist = 0;
        commitGesture();
      }
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [zoomAround, gesturePan, gestureZoom, commitGesture]);

  // Unmount mid-gesture: stop the pending paint / idle-commit timers.
  useEffect(() => () => {
    if (gestureRaf.current) cancelAnimationFrame(gestureRaf.current);
    if (wheelIdle.current) clearTimeout(wheelIdle.current);
  }, []);

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

  // Bring a node into view, centred in the part of the canvas the detail panel
  // leaves showing — not in the middle of the canvas, which the panel covers.
  // The panel takes the right half on a desktop (so: a quarter of the width) and
  // the bottom half on a phone (so: a quarter of the height).
  // Node coordinates are native; scroll is in scaled (zoomed) px.
  const centreOn = useCallback(
    (key: string) => {
      const n = nodesByKey.get(key);
      const el = canvasRef.current;
      if (!n || !el) return;
      const z = zoomRef.current;
      const phone = window.matchMedia(PHONE_QUERY).matches;
      scrollTo(
        (n.x + PAD + NODE_W / 2) * z - el.clientWidth / (phone ? 2 : 4),
        (n.y + PAD + nodeH / 2) * z - el.clientHeight / (phone ? 4 : 2),
      );
    },
    [nodesByKey, scrollTo, nodeH],
  );

  const selectNode = useCallback(
    (key: string) => {
      // Clicking the already-selected node deselects it (and skips re-centring).
      if (key === selectedKey) {
        setSelectedKey(null);
        return;
      }
      setSelectedKey(key);
      centreOn(key);
    },
    [selectedKey, centreOn],
  );

  const revealNode = useCallback(
    (key: string) => {
      setSelectedKey(key);
      centreOn(key);
    },
    [centreOn],
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
    zoomLayerRef,
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
    revealNode,
    zoom,
    zoomIn,
    zoomOut,
    resetZoom,
    fitToScreen,
  };
}

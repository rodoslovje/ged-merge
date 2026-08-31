import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  centreOffset,
  clampScroll,
  NODE_H,
  NODE_W,
  PAD,
  scrollForZoom,
  type ChartAlignment,
  type ChartNode,
  type Viewport,
} from "../chart/treeLayout";
import { PHONE_QUERY } from "./usePhone";

/** Zoom range and the per-click button step. Wheel zoom is continuous within this
 *  range; "fit" never magnifies past 1× so a small chart keeps its natural size. */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** A wheel speaks one of three units; normalize lines to pixels. */
const WHEEL_LINE_PX = 16;
/** Cap on one event's scroll delta: a mouse notch (±120) must feel like a step,
 *  not a leap, and no single event may cross the whole zoom range. */
const WHEEL_MAX_PX = 120;

/** An in-flight pinch / wheel-zoom run, tracked in the canvas's own terms. */
interface Gesture {
  /** Committed zoom and scroll when it opened — what the DOM still shows. */
  z0: number;
  left0: number;
  top0: number;
  /** Canvas client box: the size the clamps use, the origin focus points use. */
  cw: number;
  ch: number;
  ox: number;
  oy: number;
  /** Chart extent in native (1×) px. */
  contentW: number;
  contentH: number;
  /** Live target, already clamped: where the gesture lands if it ends now. */
  z: number;
  left: number;
  top: number;
}

/** Props to spread on the scrollable `.tree-canvas` div. */
export interface TreeCanvasProps {
  onScroll: () => void;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: React.MouseEvent) => void;
  onDoubleClick: (e: React.MouseEvent) => void;
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
  const pan = useRef<
    { x: number; y: number; left: number; top: number; id: number; moved: boolean; dx: number; dy: number } | null
  >(null);
  const panRaf = useRef(0);
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
  // The gesture is tracked in the canvas's own terms — a target zoom and a
  // target scroll, both clamped to what the canvas can reach — and the layer
  // transform is *derived* from that pair. So what the fingers see is exactly
  // what the commit lands on: there is nothing left to snap back from.
  const gesture = useRef<Gesture | null>(null);
  const gestureRaf = useRef(0);
  const wheelIdle = useRef(0);
  const pendingLayerReset = useRef(false);

  const syncViewport = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    const next = { left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight };
    // A pan fires scroll events faster than the page around the canvas can
    // usefully re-render, and the last events of a run usually say nothing new —
    // an unchanged rect must not cost a render at all.
    setViewport((v) =>
      v.left === next.left && v.top === next.top && v.width === next.width && v.height === next.height
        ? v
        : next,
    );
  }, []);

  // Scroll and resize sync through a frame, so however many events the trackpad
  // delivers between two paints, React sees one viewport update per frame.
  const viewportRaf = useRef(0);
  const queueViewport = useCallback(() => {
    if (viewportRaf.current) return;
    viewportRaf.current = requestAnimationFrame(() => {
      viewportRaf.current = 0;
      syncViewport();
    });
  }, [syncViewport]);

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
    const el = canvasRef.current;
    const layer = zoomLayerRef.current;
    if (!el || !layer) return null;
    if (!gesture.current) {
      // One geometry read for the whole gesture: the canvas does not move while
      // the fingers are down, and mixing two reads is what makes a pinch drift.
      const r = el.getBoundingClientRect();
      const z0 = zoomRef.current;
      gesture.current = {
        z0,
        left0: el.scrollLeft,
        top0: el.scrollTop,
        cw: el.clientWidth,
        ch: el.clientHeight,
        ox: r.left + el.clientLeft,
        oy: r.top + el.clientTop,
        // Prefer the layout's own extent; the layer's box covers the views that
        // lay out without publishing one.
        contentW: laid?.width ?? layer.offsetWidth / z0,
        contentH: laid?.height ?? layer.offsetHeight / z0,
        z: z0,
        left: el.scrollLeft,
        top: el.scrollTop,
      };
      // Promote the layer for the duration of the gesture so the per-event
      // transform stays on the compositor; cleared again on commit.
      layer.style.willChange = "transform";
    }
    return gesture.current;
  }, [laid]);

  // Paint the gesture transform once per animation frame, however many wheel /
  // touch events arrived in between.
  const paintGesture = useCallback(() => {
    if (gestureRaf.current) return;
    gestureRaf.current = requestAnimationFrame(() => {
      gestureRaf.current = 0;
      const g = gesture.current;
      const layer = zoomLayerRef.current;
      if (!g || !layer) return;
      // Move the chart's top-left corner from where the committed render put it
      // to where the target zoom and scroll want it. (`.chart-zoom` carries
      // transform-origin: 0 0, so scale and translation compose with no centre
      // term to correct for.)
      const dx =
        centreOffset(g.cw, g.contentW, g.z) - g.left - (centreOffset(g.cw, g.contentW, g.z0) - g.left0);
      const dy =
        centreOffset(g.ch, g.contentH, g.z) - g.top - (centreOffset(g.ch, g.contentH, g.z0) - g.top0);
      layer.style.transform = `translate(${dx}px, ${dy}px) scale(${g.z / g.z0})`;
    });
  }, []);

  /** Scale the gesture by `factor` about the client point (cx, cy), keeping the
   *  content under that point fixed on screen. False = no layer to paint on. */
  const gestureZoom = useCallback((factor: number, cx: number, cy: number) => {
    const g = ensureGesture();
    if (!g) return false;
    const z = clampZoom(g.z * factor);
    if (z !== g.z) {
      g.left = scrollForZoom(g.left, cx - g.ox, g.cw, g.contentW, g.z, z);
      g.top = scrollForZoom(g.top, cy - g.oy, g.ch, g.contentH, g.z, z);
      g.z = z;
    }
    paintGesture();
    return true;
  }, [ensureGesture, paintGesture]);

  /** Pan the gesture by the fingers' midpoint travel. False = no layer. */
  const gesturePan = useCallback((mx: number, my: number) => {
    const g = ensureGesture();
    if (!g) return false;
    g.left = clampScroll(g.left - mx, g.cw, g.contentW, g.z);
    g.top = clampScroll(g.top - my, g.ch, g.contentH, g.z);
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
    // The target was kept scroll-reachable all along, so committing is just
    // handing (z, left, top) over — no geometry to re-derive, nothing to clamp.
    if (g.z === g.z0) {
      // Pure pan (or a pinch that cancelled itself out): no re-render is
      // coming, so clear the transform and set the scroll directly.
      layer.style.transform = "";
      layer.style.willChange = "";
      pendingScroll.current = null;
      el.scrollLeft = g.left;
      el.scrollTop = g.top;
      syncViewport();
      return;
    }
    pendingLayerReset.current = true;
    pendingScroll.current = { left: g.left, top: g.top };
    zoomRef.current = g.z;
    setZoom(g.z);
  }, [syncViewport]);

  // Re-scale around a focus point (cx, cy) given in canvas-client pixels, keeping
  // the layout point under that focus fixed on screen.
  const zoomAround = useCallback((next: number, cx: number, cy: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const clamped = clampZoom(next);
    const prev = zoomRef.current;
    if (clamped === prev) return;
    const layer = zoomLayerRef.current;
    const contentW = laid?.width ?? (layer ? layer.offsetWidth / prev : 0);
    const contentH = laid?.height ?? (layer ? layer.offsetHeight / prev : 0);
    // A commit from this same tick may not have reached the DOM yet, so the
    // scroll to zoom around is the pending one whenever there is one.
    const from = pendingScroll.current ?? { left: el.scrollLeft, top: el.scrollTop };
    pendingScroll.current = {
      left: scrollForZoom(from.left, cx, el.clientWidth, contentW, prev, clamped),
      top: scrollForZoom(from.top, cy, el.clientHeight, contentH, prev, clamped),
    };
    zoomRef.current = clamped;
    setZoom(clamped);
  }, [laid]);

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
      pendingScroll.current = null;
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
      // Wheels speak three units (pixels, lines, pages) and a mouse notch is
      // worth far more than a trackpad tick, so normalize to pixels and cap one
      // event: unnormalized, the same gesture zooms at wildly different rates
      // from one browser or device to the next.
      const px =
        e.deltaMode === 1 ? e.deltaY * WHEEL_LINE_PX : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
      const factor = Math.exp(-Math.max(-WHEEL_MAX_PX, Math.min(WHEEL_MAX_PX, px)) * 0.0015);
      // Fast path: paint the run of wheel events as one gesture and commit
      // when it goes idle. Without a ChartZoom layer, commit per event.
      if (gestureZoom(factor, e.clientX, e.clientY)) {
        if (wheelIdle.current) clearTimeout(wheelIdle.current);
        wheelIdle.current = window.setTimeout(commitGesture, 140);
        return;
      }
      const rect = el.getBoundingClientRect();
      zoomAround(zoomRef.current * factor, e.clientX - rect.left - el.clientLeft, e.clientY - rect.top - el.clientTop);
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
        zoomAround(zoomRef.current * (dist / lastDist), mid.x - rect.left - el.clientLeft, mid.y - rect.top - el.clientTop);
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
    if (panRaf.current) cancelAnimationFrame(panRaf.current);
    if (viewportRaf.current) cancelAnimationFrame(viewportRaf.current);
    if (wheelIdle.current) clearTimeout(wheelIdle.current);
  }, []);

  useEffect(() => {
    window.addEventListener("resize", queueViewport);
    return () => window.removeEventListener("resize", queueViewport);
  }, [queueViewport]);

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
  // The travel lives on the pan ref and is written to the scroll offsets once a
  // frame, so a trackpad that reports faster than the screen paints costs one
  // scroll per picture rather than one per event.

  /** Write the drag's accumulated travel to the scroll offsets. */
  const applyPan = useCallback(() => {
    const el = canvasRef.current;
    const p = pan.current;
    if (!el || !p || !p.moved) return;
    el.scrollLeft = p.left - p.dx;
    el.scrollTop = p.top - p.dy;
  }, []);

  const endPan = useCallback(() => {
    const p = pan.current;
    const el = canvasRef.current;
    if (!p) return;
    if (panRaf.current) {
      // A frame was still owed: land on the pointer's last reported position
      // rather than on the last one that happened to get painted.
      cancelAnimationFrame(panRaf.current);
      panRaf.current = 0;
      applyPan();
    }
    pan.current = null;
    if (p.moved) {
      dragged.current = true; // swallow the click that the drag would emit
      if (el?.hasPointerCapture(p.id)) el.releasePointerCapture(p.id);
      setPanning(false);
    }
  }, [applyPan]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    // Arm the click-swallow afresh: a drag that ended off-canvas leaves its
    // flag standing (no click ever came to clear it), and that flag must not
    // eat the next honest click on a node.
    dragged.current = false;
    if (e.pointerType === "touch" || e.button !== 0) return;
    const el = canvasRef.current;
    if (!el) return;
    pan.current = {
      x: e.clientX,
      y: e.clientY,
      left: el.scrollLeft,
      top: el.scrollTop,
      id: e.pointerId,
      moved: false,
      dx: 0,
      dy: 0,
    };
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const p = pan.current;
      const el = canvasRef.current;
      if (!p || !el) return;
      // Nothing is held down any more: the button came up somewhere we never
      // saw it (outside the window, or before the capture was taken). Without
      // this the chart goes on following the bare pointer around.
      if (e.buttons === 0) {
        endPan();
        return;
      }
      p.dx = e.clientX - p.x;
      p.dy = e.clientY - p.y;
      if (!p.moved) {
        if (Math.hypot(p.dx, p.dy) < 4) return; // ignore jitter, keep clicks clickable
        p.moved = true;
        el.setPointerCapture(p.id);
        setPanning(true);
      }
      // A trackpad can report several moves per frame; scrolling once per frame
      // keeps the pan on the paint rhythm instead of ahead of it.
      if (!panRaf.current) {
        panRaf.current = requestAnimationFrame(() => {
          panRaf.current = 0;
          applyPan();
        });
      }
    },
    [applyPan, endPan],
  );

  // A drag that ends off the canvas — past the window edge, or over something
  // that swallowed the event — still has to end the pan.
  useEffect(() => {
    window.addEventListener("pointerup", endPan);
    window.addEventListener("pointercancel", endPan);
    return () => {
      window.removeEventListener("pointerup", endPan);
      window.removeEventListener("pointercancel", endPan);
    };
  }, [endPan]);

  // After a pan, cancel the trailing click so dragging doesn't select a node.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (dragged.current) {
      e.stopPropagation();
      dragged.current = false;
    }
  }, []);

  // Double-click zooms toward the pointer, as the Map does; Shift zooms back
  // out. Only where the canvas itself was hit: a double-click that lands on a
  // person belongs to whatever the chart does with a click on them, and having
  // the view leap while their panel opens would be its own surprise.
  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const el = canvasRef.current;
      if (!el) return;
      const target = e.target as Element | null;
      if (target?.closest?.("g.tree-node, .timeline-row, .kin-dot, .kin-bar, a, button, input, select")) return;
      const rect = el.getBoundingClientRect();
      zoomAround(
        zoomRef.current * (e.shiftKey ? 1 / (ZOOM_STEP * ZOOM_STEP) : ZOOM_STEP * ZOOM_STEP),
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
    },
    [zoomAround],
  );

  return {
    canvasRef,
    zoomLayerRef,
    viewport,
    panning,
    scrollTo,
    canvasProps: {
      onScroll: queueViewport,
      onPointerDown,
      onPointerMove,
      onPointerUp: endPan,
      onPointerCancel: endPan,
      onClickCapture,
      onDoubleClick,
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

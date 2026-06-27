import { useCallback, useEffect, useRef, useState } from "react";
import { NODE_H, NODE_W, PAD, type Placed, type Viewport } from "./treeLayout";

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
  laid: { root: Placed } | undefined,
  nodesByKey: Map<string, Placed>,
): TreeCanvas {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ left: 0, top: 0, width: 0, height: 0 });
  const [panning, setPanning] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const pan = useRef<{ x: number; y: number; left: number; top: number; id: number; moved: boolean } | null>(null);
  const dragged = useRef(false);

  const syncViewport = useCallback(() => {
    const el = canvasRef.current;
    if (!el) return;
    setViewport({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight });
  }, []);

  // On (re)layout — initial load and mode switches — scroll so the starting
  // person (the tree root) is in view: pinned to the left, vertically centred.
  // Then re-measure for the minimap.
  useEffect(() => {
    const el = canvasRef.current;
    if (el && laid) {
      el.scrollLeft = Math.max(0, laid.root.x);
      el.scrollTop = Math.max(0, laid.root.y + PAD + NODE_H / 2 - el.clientHeight / 2);
    }
    syncViewport();
  }, [laid, syncViewport]);

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
      scrollTo(
        n.x + PAD + NODE_W / 2 - el.clientWidth / 2,
        n.y + PAD + NODE_H / 2 - el.clientHeight / 2,
      );
    },
    [selectedKey, nodesByKey, scrollTo],
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
  };
}

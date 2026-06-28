import { useRef } from "react";
import { NODE_H, NODE_W, PAD, type Placed, type Viewport } from "../tree/treeLayout";

/** Fraction of the visible canvas the minimap box may occupy on each axis. Width
   may run nearly edge-to-edge so an extreme, very wide tree gets a usefully large
   overview, while height stays short. The tree is scaled uniformly to fit inside
   this box, so the constraining axis hits its cap and the other takes only what it
   needs — keeping the overview proportional instead of stretched. */
const MINIMAP_MAX_W_FRACTION = 0.94;
const MINIMAP_MAX_H_FRACTION = 0.3;
/** Hard pixel floor so a tiny tree still renders a usable, clickable map. */
const MINIMAP_MIN = 120;

interface Props {
  nodes: Placed[];
  contentW: number;
  contentH: number;
  viewport: Viewport;
  onScrollTo: (left: number, top: number) => void;
  /** Fill colour for a node dot — each view colours by its own scheme. */
  fill: (n: Placed) => string;
  /** Box height for the current display settings (grows when the place line shows). */
  nodeH?: number;
  /** Canvas zoom. Node coords are native but the viewport rect is in scaled
   *  scroll pixels, so the map works in scaled space (everything × zoom). */
  zoom?: number;
}

/** Overview map of the whole tree with a draggable viewport rectangle. Shared by
 *  the Edit Tree and Compare Tree; only the node colouring differs (via `fill`). */
export function TreeMinimap({ nodes, contentW, contentH, viewport, onScrollTo, fill, nodeH = NODE_H, zoom = 1 }: Props) {
  const dragging = useRef(false);
  // Work in scaled (on-screen) space so the viewport rectangle — which is in
  // zoomed scroll pixels — lines up with the node dots.
  const cw = contentW * zoom;
  const ch = contentH * zoom;
  // Box capped to a fraction of the visible canvas, then a single uniform scale
  // fits the tree inside it: the constraining axis fills the cap, the other uses
  // only what it needs. No per-axis stretch, so proportions stay true.
  const maxW = Math.max(MINIMAP_MIN, viewport.width * MINIMAP_MAX_W_FRACTION);
  const maxH = Math.max(MINIMAP_MIN, viewport.height * MINIMAP_MAX_H_FRACTION);
  const scale = Math.min(maxW / cw, maxH / ch);
  const w = cw * scale;
  const h = ch * scale;

  const recentre = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;
    onScrollTo(x - viewport.width / 2, y - viewport.height / 2);
  };

  return (
    <svg
      className="tree-minimap"
      width={w}
      height={h}
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        recentre(e);
      }}
      onPointerMove={(e) => dragging.current && recentre(e)}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
    >
      {nodes.map((n) => (
        <rect
          key={n.key}
          x={(n.x + PAD) * zoom * scale}
          y={(n.y + PAD) * zoom * scale}
          width={Math.max(1, NODE_W * zoom * scale)}
          height={Math.max(1, nodeH * zoom * scale)}
          rx={1}
          fill={fill(n)}
        />
      ))}
      <rect
        className="tree-minimap-viewport"
        x={viewport.left * scale}
        y={viewport.top * scale}
        width={viewport.width * scale}
        height={viewport.height * scale}
      />
    </svg>
  );
}

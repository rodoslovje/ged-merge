import { useRef } from "react";
import { NODE_H, NODE_W, PAD, type Placed, type Viewport } from "../tree/treeLayout";

/** Maximum minimap extent (px); the tree is scaled to fit within this box. */
const MINIMAP_MAX_W = 240;
const MINIMAP_MAX_H = 280;
/** How far each axis may stretch past the uniform scale. Pure uniform scaling
   collapses an extreme aspect-ratio tree (e.g. a deep descendants chart that is
   very tall but only a few generations wide) into a useless sliver; allowing a
   bounded per-axis stretch keeps the minimap usable while ordinary balanced
   trees stay close to proportional. */
const MINIMAP_MAX_STRETCH = 6;

interface Props {
  nodes: Placed[];
  contentW: number;
  contentH: number;
  viewport: Viewport;
  onScrollTo: (left: number, top: number) => void;
  /** Fill colour for a node dot — each view colours by its own scheme. */
  fill: (n: Placed) => string;
}

/** Overview map of the whole tree with a draggable viewport rectangle. Shared by
 *  the Edit Tree and Compare Tree; only the node colouring differs (via `fill`). */
export function TreeMinimap({ nodes, contentW, contentH, viewport, onScrollTo, fill }: Props) {
  const dragging = useRef(false);
  // Independent per-axis scale, each bounded to MINIMAP_MAX_STRETCH × the
  // uniform fit so an extreme aspect ratio can't collapse one axis to a sliver.
  const fitX = MINIMAP_MAX_W / contentW;
  const fitY = MINIMAP_MAX_H / contentH;
  const uniform = Math.min(fitX, fitY);
  const sx = Math.min(fitX, uniform * MINIMAP_MAX_STRETCH);
  const sy = Math.min(fitY, uniform * MINIMAP_MAX_STRETCH);
  const w = contentW * sx;
  const h = contentH * sy;

  const recentre = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / sx;
    const y = (e.clientY - rect.top) / sy;
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
          x={(n.x + PAD) * sx}
          y={(n.y + PAD) * sy}
          width={Math.max(1, NODE_W * sx)}
          height={Math.max(1, NODE_H * sy)}
          rx={1}
          fill={fill(n)}
        />
      ))}
      <rect
        className="tree-minimap-viewport"
        x={viewport.left * sx}
        y={viewport.top * sy}
        width={viewport.width * sx}
        height={viewport.height * sy}
      />
    </svg>
  );
}

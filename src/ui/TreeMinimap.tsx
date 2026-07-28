import { useRef } from "react";
import { minimapFit, NODE_H, NODE_W, PAD, type ChartNode, type Viewport } from "../chart/treeLayout";

interface Props<T extends ChartNode> {
  nodes: T[];
  contentW: number;
  contentH: number;
  viewport: Viewport;
  onScrollTo: (left: number, top: number) => void;
  /** Fill colour for a node dot — each view colours by its own scheme. */
  fill: (n: T) => string;
  /** Box height for the current display settings (grows when the place line shows). */
  nodeH?: number;
  /** Canvas zoom. Node coords are native but the viewport rect is in scaled
   *  scroll pixels, so the map works in scaled space (everything × zoom). */
  zoom?: number;
}

/** Overview map of the whole chart with a draggable viewport rectangle. Generic
 *  over the node shape ({@link ChartNode}), so each view colours by its own
 *  scheme without casting. */
export function TreeMinimap<T extends ChartNode>({ nodes, contentW, contentH, viewport, onScrollTo, fill, nodeH = NODE_H, zoom = 1 }: Props<T>) {
  const dragging = useRef(false);
  // Work in scaled (on-screen) space so the viewport rectangle — which is in
  // zoomed scroll pixels — lines up with the node dots. minimapFit sizes the box
  // (a fraction of the canvas, translucent at rest; see .tree-minimap-box) and
  // returns one scale per axis: equal for ordinary charts, stretched on the
  // short axis only for the extreme ratios of deep trees.
  const { scaleX, scaleY, w, h } = minimapFit(contentW * zoom, contentH * zoom, viewport);

  const recentre = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scaleX;
    const y = (e.clientY - rect.top) / scaleY;
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
          x={(n.x + PAD) * zoom * scaleX}
          y={(n.y + PAD) * zoom * scaleY}
          width={Math.max(1, NODE_W * zoom * scaleX)}
          height={Math.max(1, nodeH * zoom * scaleY)}
          rx={1}
          fill={fill(n)}
        />
      ))}
      <rect
        className="tree-minimap-viewport"
        x={viewport.left * scaleX}
        y={viewport.top * scaleY}
        width={viewport.width * scaleX}
        height={viewport.height * scaleY}
      />
    </svg>
  );
}

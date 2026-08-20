// Zoom layer for the chart canvases: the SVG inside renders once at native
// size and zoom is applied as a CSS transform, so a pinch/wheel zoom step only
// updates this wrapper — no SVG re-layout, no React diff of the diagram (the
// chart bodies are memoized). The outer div takes the scaled footprint, which
// keeps the canvas's scroll extents identical to the old width×zoom sizing.

interface Props {
  /** The diagram's native (1×) size, including padding. */
  width: number;
  height: number;
  zoom: number;
  /** useTreeCanvas's zoomLayerRef: in-progress pinch/wheel gestures paint their
   *  transform straight onto this div, bypassing React until the gesture ends. */
  layerRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}

export function ChartZoom({ width, height, zoom, layerRef, children }: Props) {
  return (
    <div className="chart-zoom" ref={layerRef} style={{ width: width * zoom, height: height * zoom }}>
      <div className="chart-zoom-scale" style={{ width, height, transform: zoom === 1 ? undefined : `scale(${zoom})` }}>
        {children}
      </div>
    </div>
  );
}

import type { ChartHover } from "./useChartHover";
import { sexClass } from "./sex";

// The card a chart shows beside the pointer for the person under it: the full
// name in the sex colour with the lifespan, then the fields the chart options
// show, then the click hint — what the box or wedge had no room for. Rendered
// once per chart page, inside the canvas wrap, and never in the pointer's way.

export function ChartHoverCard({ hover }: { hover: ChartHover | null }) {
  if (!hover) return null;
  const { x, y, right, below, info } = hover;
  return (
    <div
      className="chart-hover-card"
      role="tooltip"
      style={{
        left: x,
        top: y,
        transform: `translate(${right ? "calc(-100% - 14px)" : "14px"}, ${below ? "calc(-100% - 12px)" : "16px"})`,
      }}
    >
      <div className={`chart-hover-name ${sexClass(info.sex)}`}>{info.name}</div>
      {info.lines.map((line, i) => (
        <div key={i} className="chart-hover-line">{line}</div>
      ))}
      {info.hint && <div className="chart-hover-hint">{info.hint}</div>}
    </div>
  );
}

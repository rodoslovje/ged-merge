import type { RefObject } from "react";
import { useChartHover, type HoverInfo } from "./useChartHover";
import { sexClass } from "./sex";
import { lineageClass } from "../match/kinship";

// The card a chart shows beside the pointer for the person under it, written
// the way Edit's person cards and the people list write a person: the name in
// the sex colour with the lifespan beside it in the data face, then the place
// and the kinship (coloured by lineage) as the chart options show them, then
// the click hint — what the box or wedge had no room for. Rendered once per
// chart page, inside the canvas wrap, and never in the pointer's way.
//
// The card watches the canvas itself rather than being handed a hover its host
// keeps: following the pointer means new coordinates every frame, and a chart
// of a few thousand boxes must not be re-rendered for each of them.

export function ChartHoverCard({
  canvasRef,
  infoFor,
}: {
  canvasRef: RefObject<HTMLElement | null>;
  /** What to say about the node under the pointer; undefined to say nothing. */
  infoFor: (key: string) => HoverInfo | undefined;
}) {
  const hover = useChartHover(canvasRef, infoFor);
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
      <div className="chart-hover-head">
        <span className={`person-name ${sexClass(info.sex)}`}>{info.name}</span>
        {info.years && <span className="person-years gm-data">{info.years}</span>}
      </div>
      {info.subtitle && <div className="chart-hover-line">{info.subtitle}</div>}
      {info.place && <div className="chart-hover-line">{info.place}</div>}
      {info.kinship && <div className={`chart-hover-kin ${lineageClass(info.kinshipLineage)}`}>{info.kinship}</div>}
      {/* A card for several people: each row written the way the head is, so a
          band of a dozen reads like a dozen person cards rather than a list. */}
      {info.people && (
        <ul className="chart-hover-people">
          {info.people.map((p) => (
            <li key={p.id}>
              <span className={`person-name ${sexClass(p.sex)}`}>{p.name}</span>
              {p.years && <span className="person-years gm-data">{p.years}</span>}
              {p.kinship && <span className="person-kinship">{p.kinship}</span>}
            </li>
          ))}
          {info.moreLabel && <li className="chart-hover-more">{info.moreLabel}</li>}
        </ul>
      )}
      {info.hint && <div className="chart-hover-hint">{info.hint}</div>}
    </div>
  );
}

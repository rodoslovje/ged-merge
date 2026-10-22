import { Fragment } from "react";
import { yearsSegments, type YearsApprox } from "../gedcom/lifespan";

/**
 * A lifespan line with its approximate years (ABT/CAL/EST, BEF, AFT, BET…)
 * in italics. `svg` renders the runs as `<tspan>`s for a chart's `<text>`.
 */
export function YearsText({ text, approx, svg }: { text: string; approx?: YearsApprox; svg?: boolean }) {
  if (!approx) return <>{text}</>;
  const Run = svg ? "tspan" : "span";
  return (
    <>
      {yearsSegments(text, approx).map((s, i) => (
        <Fragment key={i}>{s.approx ? <Run className="gm-approx">{s.text}</Run> : s.text}</Fragment>
      ))}
    </>
  );
}

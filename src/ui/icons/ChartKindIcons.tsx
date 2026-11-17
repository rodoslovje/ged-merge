/**
 * Small glyphs for chart kinds, drawn like {@link ChartIcon} (24-unit box, 2px
 * round strokes, `currentColor`): the fan, the relationship path and the
 * timeline. The family website's person page offers its charts by them.
 */

const svgProps = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

/** A half fan: rings of ancestors above their person. */
export function FanIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <path d="M2 20a10 10 0 0 1 20 0" />
      <path d="M7 20a5 5 0 0 1 10 0" />
      <line x1="12" y1="10" x2="12" y2="15" />
      <line x1="4.93" y1="12.93" x2="8.46" y2="16.46" />
      <line x1="19.07" y1="12.93" x2="15.54" y2="16.46" />
      <line x1="2" y1="20" x2="22" y2="20" />
    </svg>
  );
}

/** Two people joined through a common ancestor above them. */
export function RelationIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <circle cx="12" cy="5" r="2.2" />
      <circle cx="5" cy="19" r="2.2" />
      <circle cx="19" cy="19" r="2.2" />
      <path d="M12 7.2 6.2 16.9" />
      <path d="M12 7.2l5.8 9.7" />
    </svg>
  );
}

/** Lifespan bars on a year line. */
export function TimelineIcon({ size = 16 }: { size?: number }) {
  return (
    <svg {...svgProps(size)}>
      <line x1="4" y1="7" x2="15" y2="7" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="6" y1="17" x2="14" y2="17" />
      <line x1="3" y1="21" x2="21" y2="21" strokeWidth={1.5} />
    </svg>
  );
}

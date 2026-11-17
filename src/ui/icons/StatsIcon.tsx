/**
 * StatsIcon — a bar chart: Statistics. Monochrome, inherits the current text
 * colour via `currentColor`, drawn like {@link ChartIcon} (24-unit box, 2px
 * round strokes).
 */
export function StatsIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="4" y1="20" x2="20" y2="20" />
      <line x1="7" y1="16" x2="7" y2="11" />
      <line x1="12" y1="16" x2="12" y2="5" />
      <line x1="17" y1="16" x2="17" y2="8" />
    </svg>
  );
}

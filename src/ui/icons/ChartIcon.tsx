/**
 * ChartIcon — the app's tree glyph (two parents joined to a child), matching
 * the landing-page feature icon. Monochrome, inherits the current text colour
 * via `currentColor`. Used by the header Charts-hub trigger.
 */
export function ChartIcon({ size = 16 }: { size?: number }) {
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
      <circle cx="6.5" cy="5" r="2.2" />
      <circle cx="17.5" cy="5" r="2.2" />
      <circle cx="12" cy="19" r="2.2" />
      <path d="M6.5 7.2v3.3a2 2 0 0 0 2 2H12M17.5 7.2v3.3a2 2 0 0 1-2 2H12M12 12.5v4.3" />
    </svg>
  );
}

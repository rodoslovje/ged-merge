/**
 * ExternalIcon — an arrow out of the page: a link that leaves the site.
 * Monochrome, inherits the current text colour via `currentColor`, in
 * SearchIcon's stroke.
 */
export function ExternalIcon({ size = 16 }: { size?: number }) {
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
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="8,7 17,7 17,16" />
    </svg>
  );
}

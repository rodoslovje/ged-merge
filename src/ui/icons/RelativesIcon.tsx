/**
 * RelativesIcon — a group of people, one in front of two behind. Monochrome,
 * inherits the current text colour via `currentColor`. Marks Edit's toggle for
 * the Relatives panel.
 */
export function RelativesIcon({ size = 16 }: { size?: number }) {
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
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 21v-1a5 5 0 0 1 5-5h3a5 5 0 0 1 5 5v1" />
      <circle cx="4.5" cy="6.5" r="2.5" />
      <path d="M1 15.5a3.5 3.5 0 0 1 3.5-3.5h1.5" />
      <circle cx="19.5" cy="6.5" r="2.5" />
      <path d="M23 15.5a3.5 3.5 0 0 0-3.5-3.5H18" />
    </svg>
  );
}

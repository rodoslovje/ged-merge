/**
 * AddPersonIcon — a person silhouette with a plus. Monochrome, inherits the
 * current text colour via `currentColor`. Marks every "add a new, unattached
 * person" trigger: the header button, Edit's empty state, and the global
 * search's create row.
 */
export function AddPersonIcon({ size = 16 }: { size?: number }) {
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
      <circle cx="9" cy="7" r="4" />
      <path d="M2 21v-1.5A5.5 5.5 0 0 1 7.5 14h3a5.5 5.5 0 0 1 4.2 1.9" />
      <line x1="18.5" y1="14" x2="18.5" y2="21" />
      <line x1="15" y1="17.5" x2="22" y2="17.5" />
    </svg>
  );
}

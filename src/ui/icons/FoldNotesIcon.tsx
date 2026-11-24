/**
 * FoldNotesIcon — two arrowheads closing on a line (fold) or parting from it
 * (unfold). Monochrome, inherits the current text colour via `currentColor`.
 * Used by the Edit view's "collapse / expand notes" switch.
 */
export function FoldNotesIcon({ size = 16, folded = false }: { size?: number; folded?: boolean }) {
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
      <line x1="4" y1="12" x2="20" y2="12" />
      {folded ? (
        <>
          <polyline points="8 7 12 3 16 7" />
          <polyline points="8 17 12 21 16 17" />
        </>
      ) : (
        <>
          <polyline points="8 3 12 7 16 3" />
          <polyline points="8 21 12 17 16 21" />
        </>
      )}
    </svg>
  );
}

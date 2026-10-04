/**
 * ArrowIcon — a stroked left/right arrow. Monochrome, inherits the current text
 * colour via `currentColor`. Drawn rather than typed because the ←/→ font
 * glyphs come out hairline-thin beside the other toolbar icons. Used by
 * BackButton and the relationship chart's "start → target" title.
 */
export function ArrowIcon({ dir, size = 16 }: { dir: "left" | "right"; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {dir === "left" ? (
        <>
          <line x1="20" y1="12" x2="4" y2="12" />
          <polyline points="11,5 4,12 11,19" />
        </>
      ) : (
        <>
          <line x1="4" y1="12" x2="20" y2="12" />
          <polyline points="13,5 20,12 13,19" />
        </>
      )}
    </svg>
  );
}

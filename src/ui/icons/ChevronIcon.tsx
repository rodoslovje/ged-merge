/**
 * ChevronIcon — a left/right chevron (the arrow's head alone): "more this
 * way". Monochrome, inherits the current text colour via `currentColor`, in
 * SearchIcon's stroke.
 */
export function ChevronIcon({ dir, size = 16 }: { dir: "left" | "right"; size?: number }) {
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
      <polyline points={dir === "left" ? "15,5 8,12 15,19" : "9,5 16,12 9,19"} />
    </svg>
  );
}

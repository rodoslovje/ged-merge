/**
 * MenuIcon — three bars, the header's ☰ menu trigger. Drawn rather than typed:
 * the ☰ character sits on the font's baseline, a little low in its button
 * beside the SVG icons it lines up with. Inherits `currentColor`.
 */
export function MenuIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

/**
 * PinIcon — map-pin glyph marking an event that carries a coordinate.
 * Replaces the 📍 emoji, which always rendered in its own red regardless of
 * theme. Filled rather than stroked: at ~14px a stroked teardrop loses its
 * shape, and the solid form keeps the emoji's visual weight. Inherits the
 * current text colour via `currentColor`, so the caller picks the token.
 */
export function PinIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      {/* Teardrop with a knocked-out centre, so the hole shows the background
          through it at any size (evenodd, not a second opaque circle). */}
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2a7.5 7.5 0 0 0-7.5 7.5c0 5.05 6.36 11.62 6.63 11.9a1.2 1.2 0 0 0 1.74 0c.27-.28 6.63-6.85 6.63-11.9A7.5 7.5 0 0 0 12 2Zm0 10.2a2.7 2.7 0 1 1 0-5.4 2.7 2.7 0 0 1 0 5.4Z"
      />
    </svg>
  );
}

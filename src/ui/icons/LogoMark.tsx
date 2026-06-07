/**
 * GED Merge — logo. Drop-in React components.
 *
 *  <LogoMark />                     the Node-M mark (inherits text colour)
 *  <LogoMark size={32} />           sized
 *  <Wordmark />                     mark + "GED Merge" lockup
 *
 * The mark is monochrome and uses `currentColor`, so set the colour with CSS:
 *   <span style={{ color: "var(--accent)" }}><LogoMark /></span>
 */

export function LogoMark({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.1}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <line x1="9" y1="31" x2="9" y2="11" />
      <line x1="9" y1="11" x2="20" y2="23.5" />
      <line x1="31" y1="11" x2="20" y2="23.5" />
      <line x1="31" y1="31" x2="31" y2="11" />
      <circle cx="9" cy="11" r="3.3" />
      <circle cx="31" cy="11" r="3.3" />
      <circle cx="20" cy="23.5" r="3.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * Wordmark lockup. "GED" is set in IBM Plex Mono (it's the .ged file
 * extension — a deliberate file-tag), "Merge" in IBM Plex Sans. The mark
 * carries the only colour; the wordmark stays monochrome.
 */
export function Wordmark({ size = 22 }: { size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.5em", color: "var(--text)" }}>
      <span style={{ color: "var(--accent)", display: "inline-flex" }}>
        <LogoMark size={size * 1.5} />
      </span>
      <span style={{ fontSize: size, letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, letterSpacing: "0.02em" }}>GED</span>
        <span style={{ fontFamily: "var(--font-sans)", fontWeight: 600 }}>&nbsp;Merge</span>
      </span>
    </span>
  );
}

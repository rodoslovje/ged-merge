/**
 * HelpIcon — the header's keyboard-shortcuts button: a keycap with a question
 * mark. Monochrome, inherits the current text colour via `currentColor`.
 */
export function HelpIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9.6 9.6a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1 .9-1 1.7" />
      <circle cx="12" cy="16.6" r="0.6" fill="currentColor" />
    </svg>
  );
}

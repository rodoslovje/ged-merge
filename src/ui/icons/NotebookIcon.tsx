/**
 * NotebookIcon — a note sheet with a pencil stroke across its corner.
 * Monochrome, inherits the current text colour via `currentColor`. Marks the
 * "write a research note for later" trigger in the header and its menu.
 */
export function NotebookIcon({ size = 16 }: { size?: number }) {
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
      <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6" />
      <path d="M18.4 2.6a2 2 0 0 1 3 3L12 15l-4 1 1-4 9.4-9.4z" />
    </svg>
  );
}

// The one Back affordance for every sub-page reached from a parent view — the
// chart overlays (icon-only, leftmost in the toolbar), the Edit view's
// person-history Back and the Tools source-duplicates page (visible label).
// The destination label always reaches assistive tech and the tooltip, with
// the keyboard shortcut appended to the tooltip.

interface Props {
  /** Translated destination label, e.g. "Back to Edit". */
  label: string;
  /** Rendered into the tooltip as "label (hint)", e.g. "Esc" or "⌫". */
  shortcutHint?: string;
  /** Show the label next to the arrow instead of tooltip/aria only. */
  showLabel?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export function BackButton({ label, shortcutHint, showLabel = false, disabled, onClick }: Props) {
  return (
    <button
      className="tree-open-btn tree-back-btn"
      onClick={onClick}
      disabled={disabled}
      title={shortcutHint ? `${label} (${shortcutHint})` : label}
      aria-label={label}
    >
      <span aria-hidden="true">←</span>
      {showLabel && <span className="tree-back-label">{label}</span>}
    </button>
  );
}

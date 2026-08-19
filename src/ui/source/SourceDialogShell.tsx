import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useModalKeyboard } from "../../keyboard/useModalKeyboard";
import type { Translate } from "../../locales/i18n";

/**
 * The frame every source-side editor wears — Add Source, the Organize sources
 * field editor, the repository editor, the media-link editor. Overlay, header
 * with the record's own glyph, close ×, body, and the actions row; Escape,
 * the focus trap and focus restore come with it.
 *
 * Four dialogs used to carry four copies of this, and they had drifted: one
 * listened for Escape on the window (firing from behind other modals), two
 * trapped focus and two did not. The chrome is not what any of them is about,
 * so it lives here and each keeps only its own fields.
 */
export function SourceDialogShell({
  icon,
  title,
  t,
  onClose,
  className,
  children,
  actions,
  onKeyDown,
}: {
  /** The record's glyph — 📖 a source, 🏛 a repository, 🔗 a link, or a site's. */
  icon: string;
  title: string;
  t: Translate;
  onClose: () => void;
  /** Extra classes on the dialog box, for a variant's own width or spacing. */
  className?: string;
  children: ReactNode;
  /** The footer's buttons, in reading order — Remove, Cancel, Save. */
  actions: ReactNode;
  /** Keys the dialog answers itself — Ctrl+Enter confirming, and the like. */
  onKeyDown?: (e: ReactKeyboardEvent) => void;
}) {
  const ref = useModalKeyboard<HTMLDivElement>(true, onClose);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal add-source-dialog${className ? ` ${className}` : ""}`}
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="modal-header">
          <h2>
            <span className="add-source-badge" aria-hidden="true">{icon}</span>
            {title}
          </h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        <div className="add-source-actions">{actions}</div>
      </div>
    </div>
  );
}

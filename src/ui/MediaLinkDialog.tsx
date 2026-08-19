import { useEffect, useRef, useState } from "react";
import type { Translate } from "../locales/i18n";
import { linkHref, linkTooltip } from "./FieldValue";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";

/**
 * The media-link chip's dialog: a stripped-down sibling of Edit Source for a
 * link that is an `OBJE`, not a `SOUR` — one editable URL field with the same
 * hover ↗ beside it, and the same Remove / Cancel / Save footer. Saving a
 * changed URL rewrites the media record's `FILE` (a shared-record edit, like
 * editing a source's fields); Remove deletes the link, undo-safe.
 */
export function MediaLinkDialog({
  url,
  t,
  onClose,
  onSave,
  onRemove,
}: {
  url: string;
  t: Translate;
  onClose: () => void;
  /** Commit the edited URL (never blank — Save disables on an empty field). */
  onSave: (newUrl: string) => void;
  onRemove: () => void;
}) {
  const [value, setValue] = useState(url);
  const ref = useModalKeyboard(true, onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus with the caret at the start: plain autofocus parks it at the end,
  // scrolling a long URL so only its tail is visible.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(0, 0);
    el.scrollLeft = 0;
  }, []);
  const trimmed = value.trim();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal add-source-dialog media-link-dialog"
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("mediaLink.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>
            <span className="add-source-badge" aria-hidden="true">🔗</span>
            {t("mediaLink.title")}
          </h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>×</button>
        </div>
        <div className="modal-body">
          <label className="add-source-field add-source-url-row">
            <span>{t("addSource.field.url")}</span>
            <span className="add-source-url-wrap">
              <input ref={inputRef} className="edit-input" value={value} onChange={(e) => setValue(e.target.value)} />
              {trimmed && (
                <a
                  className="edit-link-open"
                  href={linkHref(trimmed)}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={linkTooltip(trimmed, t, t("edit.openLink"))}
                >
                  ↗
                </a>
              )}
            </span>
          </label>
        </div>
        <div className="add-source-actions">
          <button className="tree-open-btn add-source-remove" onClick={onRemove}>{t("editSource.remove")}</button>
          <button className="tree-open-btn" onClick={onClose}>{t("addSource.cancel")}</button>
          <button
            className="add-source-submit"
            disabled={!trimmed}
            onClick={() => (trimmed === url ? onClose() : onSave(trimmed))}
          >
            {t("editSource.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

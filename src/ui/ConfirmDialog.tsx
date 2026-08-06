import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";

interface Props {
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Cancel button label. Pass `null` for an acknowledge-only (alert) dialog
   *  with no cancel button. Defaults to the shared "Cancel" string. */
  cancelLabel?: string | null;
  /** Style the confirm button as destructive (red). Use only for irreversible
   *  actions like delete/remove; benign prompts keep the neutral accent style. */
  danger?: boolean;
  /** Open with the confirm button focused, so Enter takes the offer. Opt-in:
   *  most callers here ask before discarding work (replace the file, clear the
   *  cache, reload), where Enter must not be the answer. Ignored for `danger`. */
  defaultConfirm?: boolean;
  /** When set, renders a checkbox above the actions. `checked`/`onCheckedChange`
   *  let the caller persist the choice (e.g. a "Never ask again" preference). */
  checkboxLabel?: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Optional third action, shown left of Cancel — for a dismissal that also
   *  decides something, e.g. "Later" vs "Don't ask again". */
  altLabel?: string;
  onAlt?: () => void;
}

export function ConfirmDialog({ message, confirmLabel, onConfirm, onCancel, cancelLabel, danger, defaultConfirm, checkboxLabel, checked, onCheckedChange, altLabel, onAlt }: Props) {
  const { t } = useTranslation();
  const ref = useModalKeyboard(true, onCancel);
  // The trap parks focus on the first focusable control, which the optional
  // checkbox would win — leaving Enter doing nothing. Hand it to the button
  // that answers the question: the confirm when the caller says Enter should
  // take it (or when it stands alone), otherwise Cancel.
  const focusConfirm = cancelLabel === null || (!!defaultConfirm && !danger);
  const defaultBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { defaultBtn.current?.focus(); }, []);
  const [title, body] = message.split("\n\n");
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="confirm-dialog" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-dialog-title">{title}</p>
        {body && <p className="confirm-dialog-body">{body}</p>}
        {checkboxLabel && (
          <label className="confirm-dialog-check">
            <input
              type="checkbox"
              checked={checked ?? false}
              onChange={(e) => onCheckedChange?.(e.target.checked)}
            />
            {checkboxLabel}
          </label>
        )}
        <div className="confirm-dialog-actions">
          {cancelLabel !== null && (
            <button type="button" className="btn-secondary" ref={focusConfirm ? undefined : defaultBtn} onClick={onCancel}>
              {cancelLabel ?? t("confirm.cancel")}
            </button>
          )}
          <button
            type="button"
            className={`confirm-dialog-confirm ${danger ? "danger" : ""}`}
            ref={focusConfirm ? defaultBtn : undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          {/* Last in the DOM, first on screen (CSS `order`): opening focus and
              Tab must not land on the lasting answer before the two ordinary
              ones — the dialog focuses whichever control comes first. */}
          {altLabel && onAlt && (
            <button type="button" className="btn-secondary confirm-dialog-alt" onClick={onAlt}>
              {altLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

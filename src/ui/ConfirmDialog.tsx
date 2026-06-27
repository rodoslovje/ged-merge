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
  /** When set, renders a checkbox above the actions. `checked`/`onCheckedChange`
   *  let the caller persist the choice (e.g. a "Never ask again" preference). */
  checkboxLabel?: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}

export function ConfirmDialog({ message, confirmLabel, onConfirm, onCancel, cancelLabel, danger, checkboxLabel, checked, onCheckedChange }: Props) {
  const { t } = useTranslation();
  const ref = useModalKeyboard(true, onCancel);
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
            <button type="button" className="btn-secondary" onClick={onCancel}>
              {cancelLabel ?? t("confirm.cancel")}
            </button>
          )}
          <button
            type="button"
            className={`confirm-dialog-confirm ${danger ? "danger" : ""}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

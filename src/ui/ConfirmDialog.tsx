import { useTranslation } from "react-i18next";

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
}

export function ConfirmDialog({ message, confirmLabel, onConfirm, onCancel, cancelLabel, danger }: Props) {
  const { t } = useTranslation();
  const [title, body] = message.split("\n\n");
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="confirm-dialog-title">{title}</p>
        {body && <p className="confirm-dialog-body">{body}</p>}
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

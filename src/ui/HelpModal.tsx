import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Open the keyboard-shortcut cheat sheet (closing this guide first). */
  onShowShortcuts: () => void;
}

export function HelpModal({ isOpen, onClose, onShowShortcuts }: Props) {
  const { t } = useTranslation();
  const ref = useModalKeyboard(isOpen, onClose);

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("help.title")} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t("help.title")}</h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>×</button>
        </div>
        <div className="modal-body manual-content">
          <h3>{t("help.concepts.title")}</h3>
          <h4>{t("help.concepts.master.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.concepts.master.text") }} />
          <h4>{t("help.concepts.scoring.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.concepts.scoring.text") }} />

          <h3>{t("help.edit.title")}</h3>
          <h4>{t("help.edit.overview.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.edit.overview.text") }} />
          <h4>{t("help.edit.names.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.edit.names.text") }} />
          <h4>{t("help.edit.events.title")}</h4>
          <div dangerouslySetInnerHTML={{ __html: t("help.edit.events.text") }} />
          <h4>{t("help.edit.family.title")}</h4>
          <div dangerouslySetInnerHTML={{ __html: t("help.edit.family.text") }} />
          <h4>{t("help.edit.notes.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.edit.notes.text") }} />
          <h4>{t("help.edit.delete.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.edit.delete.text") }} />
          <h4>{t("help.edit.save.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.edit.save.text") }} />

          <h3>{t("help.features.title")}</h3>
          <h4>{t("help.features.review.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.features.review.text") }} />
          <h4>{t("help.features.tree.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.features.tree.text") }} />
          <h4>{t("help.features.resolve.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.features.resolve.text") }} />
          <h4>{t("help.features.decisions.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.features.decisions.text") }} />

          <h3>{t("help.merge.title")}</h3>
          <p dangerouslySetInnerHTML={{ __html: t("help.merge.text") }} />

          <h3>{t("shortcuts.title")}</h3>
          <p>
            {t("help.shortcuts.text")}{" "}
            <button type="button" className="link-button" onClick={onShowShortcuts}>
              {t("help.shortcuts.open")}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
import { useTranslation } from "react-i18next";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function HelpModal({ isOpen, onClose }: Props) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t("help.title")}</h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")}>×</button>
        </div>
        <div className="modal-body manual-content">
          <h3>{t("help.concepts.title")}</h3>
          <h4>{t("help.concepts.master.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.concepts.master.text") }} />
          <h4>{t("help.concepts.scoring.title")}</h4>
          <p dangerouslySetInnerHTML={{ __html: t("help.concepts.scoring.text") }} />

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
        </div>
      </div>
    </div>
  );
}
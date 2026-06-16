import { useTranslation } from "react-i18next";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  page: "privacy" | "terms";
}

export function LegalModal({ isOpen, onClose, page }: Props) {
  const { t } = useTranslation();

  if (!isOpen) return null;

  const title = page === "privacy" ? t("legal.tab.privacy") : t("legal.tab.terms");

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")}>×</button>
        </div>
        <div className="modal-body legal-content">
          <p className="legal-meta">
            {t("legal.effective")} · {t("legal.operator")}
          </p>
          <div className="legal-notice">
            <strong>{t("legal.coreNotice.title")}</strong>
            <p dangerouslySetInnerHTML={{ __html: t("legal.coreNotice.text") }} />
          </div>

          {page === "privacy" && (
            <>
              <h3>{t("legal.privacy.1.title")}</h3>
              <p dangerouslySetInnerHTML={{ __html: t("legal.privacy.1.p1") }} />
              <p dangerouslySetInnerHTML={{ __html: t("legal.privacy.1.p2") }} />
              <p dangerouslySetInnerHTML={{ __html: t("legal.privacy.1.p3") }} />

              <h3>{t("legal.privacy.2.title")}</h3>
              <p dangerouslySetInnerHTML={{ __html: t("legal.privacy.2.text") }} />

              <h3>{t("legal.privacy.3.title")}</h3>
              <p dangerouslySetInnerHTML={{ __html: t("legal.privacy.3.text") }} />

              <h3>{t("legal.privacy.4.title")}</h3>
              <p dangerouslySetInnerHTML={{ __html: t("legal.privacy.4.text") }} />
            </>
          )}

          {page === "terms" && (
            <>
              <h3>{t("legal.terms.1.title")}</h3>
              <p dangerouslySetInnerHTML={{ __html: t("legal.terms.1.text") }} />

              <h3>{t("legal.terms.2.title")}</h3>
              <p dangerouslySetInnerHTML={{ __html: t("legal.terms.2.text") }} />

              <h3>{t("legal.terms.3.title")}</h3>
              <p dangerouslySetInnerHTML={{ __html: t("legal.terms.3.text") }} />

              <h3>{t("legal.terms.4.title")}</h3>
              <p dangerouslySetInnerHTML={{ __html: t("legal.terms.4.text") }} />

              <h3>{t("legal.terms.5.title")}</h3>
              <p dangerouslySetInnerHTML={{ __html: t("legal.terms.5.text") }} />

              <h3>{t("legal.terms.6.title")}</h3>
              <p dangerouslySetInnerHTML={{ __html: t("legal.terms.6.text") }} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

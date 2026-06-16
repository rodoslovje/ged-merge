import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import { displayName } from "../match/relatives";

interface Props {
  changedPersonIds: Set<string>;
  changedFamilyIds: Set<string>;
  dataset: Dataset;
  fileName: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function EditPreview({ changedPersonIds, changedFamilyIds, dataset, fileName, onConfirm, onClose }: Props) {
  const { t } = useTranslation();

  const persons = [...changedPersonIds]
    .map((id) => dataset.individuals.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p);

  const families = [...changedFamilyIds]
    .map((id) => dataset.families.get(id))
    .filter((f): f is NonNullable<typeof f> => !!f);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t("save.preview.title")}</h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")}>×</button>
        </div>

        <div className="modal-body preview-body">
          <div className="preview-summary">
            <div className="preview-stat">
              <span className="preview-stat-num">{persons.length}</span>
              <span className="preview-stat-label">{t("save.preview.persons")}</span>
            </div>
            <div className="preview-stat">
              <span className="preview-stat-num">{families.length}</span>
              <span className="preview-stat-label">{t("save.preview.families")}</span>
            </div>
          </div>

          {persons.length > 0 && (
            <section className="preview-section">
              <h3>{t("save.preview.persons")}</h3>
              <ul className="preview-deferred">
                {persons.map((p) => (
                  <li key={p.id}>
                    <span className="preview-rec gm-file master">{displayName(p)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {families.length > 0 && (
            <section className="preview-section">
              <h3>{t("save.preview.families")}</h3>
              <ul className="preview-deferred">
                {families.map((f) => {
                  const husband = f.husband ? dataset.individuals.get(f.husband) : undefined;
                  const wife = f.wife ? dataset.individuals.get(f.wife) : undefined;
                  const parts = [husband && displayName(husband), wife && displayName(wife)].filter(Boolean);
                  return (
                    <li key={f.id}>
                      <span className="preview-rec">{parts.length ? parts.join(" & ") : f.id}</span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section className="preview-files">
            <p>{t("preview.files")}</p>
            <ul>
              <li><code>{fileName}</code></li>
            </ul>
            <p className="preview-note">{t("preview.untouched")}</p>
          </section>
        </div>

        <div className="preview-actions">
          <button className="btn-secondary" onClick={onClose}>{t("preview.cancel")}</button>
          <button className="export-btn" onClick={onConfirm}>
            {t("save.preview.download")}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useTranslation } from "react-i18next";
import type { Dataset, Individual } from "../gedcom/types";
import { displayName, primaryName } from "../match/relatives";
import { lifespanOf } from "../gedcom/lifespan";
import { sexClass } from "./sex";

function personLabel(p: Parameters<typeof primaryName>[0]): string {
  const n = primaryName(p);
  return n ? displayName(n) : "—";
}

function PersonInline({ p }: { p: Individual }) {
  const lifespan = lifespanOf(p);
  return (
    <>
      <span className={`preview-rec ${sexClass(p.sex)}`}>{personLabel(p)}</span>
      {lifespan && <span className="person-years gm-data"> {lifespan}</span>}
    </>
  );
}

interface Props {
  changedPersonIds: Set<string>;
  changedFamilyIds: Set<string>;
  dataset: Dataset;
  fileName: string;
  onConfirm: () => void;
  onClose: () => void;
  onNavigate?: (id: string) => void;
  onRemovePerson?: (id: string) => void;
  onRemoveFamily?: (id: string) => void;
}

export function EditPreview({ changedPersonIds, changedFamilyIds, dataset, fileName, onConfirm, onClose, onNavigate, onRemovePerson, onRemoveFamily }: Props) {
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
                    <div className="preview-item">
                      {onNavigate ? (
                        <button className="person-link" onClick={() => { onNavigate(p.id); onClose(); }}>
                          <PersonInline p={p} />
                        </button>
                      ) : (
                        <PersonInline p={p} />
                      )}
                      {onRemovePerson && (
                        <button className="preview-item-remove" title="Remove from save" onClick={() => onRemovePerson(p.id)}>×</button>
                      )}
                    </div>
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
                  return (
                    <li key={f.id}>
                      <div className="preview-item">
                        <span>
                          {husband && <PersonInline p={husband} />}
                          {husband && wife && <span className="muted"> &amp; </span>}
                          {wife && <PersonInline p={wife} />}
                          {!husband && !wife && <span className="preview-rec">{f.id}</span>}
                        </span>
                        {onRemoveFamily && (
                          <button className="preview-item-remove" title="Remove from save" onClick={() => onRemoveFamily(f.id)}>×</button>
                        )}
                      </div>
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

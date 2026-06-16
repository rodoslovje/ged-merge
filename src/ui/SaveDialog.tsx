import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ChangeReport, FieldChange } from "../merge/merge";
import type { Dataset } from "../gedcom/types";
import { lifespanOf } from "../gedcom/lifespan";
import { sexClass } from "./sex";

interface Props {
  report: ChangeReport;
  title: string;
  files: string[];
  downloadLabel: string;
  /** When present, shows the before/after total record count line (merge mode). */
  masterRecordCount?: number;
  onConfirm: () => void;
  onClose: () => void;
  /** IDs of records that came from edit mode (show navigate/remove buttons). */
  editRecordIds?: Set<string>;
  /** Called when the user clicks a person name to return to the editor. */
  onNavigate?: (id: string) => void;
  /** Called when the user removes a record from the pending save. */
  onRemove?: (id: string, kind: "individual" | "family") => void;
  /** When provided, individual records show sex colour and lifespan. */
  dataset?: Dataset;
}

interface RecordGroup {
  id: string;
  label: string;
  isNew: boolean;
  changes: FieldChange[];
}

export function SaveDialog({
  report,
  title,
  files,
  downloadLabel,
  masterRecordCount,
  onConfirm,
  onClose,
  editRecordIds,
  onNavigate,
  onRemove,
  dataset,
}: Props) {
  const { t } = useTranslation();

  const groups = useMemo(() => groupByRecord(report), [report]);

  const fieldCount = useMemo(
    () => report.changes.filter((c) => !c.newRecord && (c.from || c.to)).length,
    [report.changes],
  );

  const newRecords = report.newPersons + report.newFamilies;
  const finalCount = masterRecordCount != null ? masterRecordCount + newRecords : undefined;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")}>×</button>
        </div>

        <div className="modal-body preview-body">
          <div className="preview-summary">
            <Stat value={report.recordsChanged} label={t("preview.stat.records")} />
            {fieldCount > 0 && (
              <Stat value={fieldCount} label={t("preview.stat.fields")} />
            )}
            {report.newPersons > 0 && (
              <Stat value={report.newPersons} label={t("preview.stat.newPersons")} accent />
            )}
            {report.newFamilies > 0 && (
              <Stat value={report.newFamilies} label={t("preview.stat.newFamilies")} accent />
            )}
            {report.deferred.length > 0 && (
              <Stat value={report.deferred.length} label={t("preview.stat.deferred")} warn />
            )}
          </div>

          {finalCount != null && (
            <p className="preview-total">
              {t("preview.total", { before: masterRecordCount, after: finalCount, delta: newRecords })}
            </p>
          )}

          {report.placesReformatted > 0 && (
            <p className="preview-note">
              {t("preview.places", { count: report.placesReformatted, noted: report.placesNoted })}
            </p>
          )}

          {report.deferred.length > 0 && (
            <section className="preview-section">
              <h3 className="preview-warn">{t("preview.notMerged")}</h3>
              <ul className="preview-deferred">
                {report.deferred.map((d, i) => (
                  <li key={i}>
                    <span className="preview-rec">{report.recordLabels[d.recordId] ?? d.recordId}</span>
                    {" — "}
                    <span className="preview-field">{d.field}</span>: {d.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {groups.length > 0 ? (
            <section className="preview-section">
              <h3>{t("preview.changes")}</h3>
              {groups.map((g) => {
                const isEditRecord = editRecordIds?.has(g.id);
                const kind = report.recordKinds[g.id];
                const canNavigate = isEditRecord && kind === "individual" && !!onNavigate;
                const canRemove = isEditRecord && !!onRemove;
                const fieldRows = g.changes.filter((c) => !c.newRecord && (c.from || c.to));
                const indi = kind === "individual" ? dataset?.individuals.get(g.id) : undefined;
                const lifespan = indi ? lifespanOf(indi) : undefined;
                const labelClass = `preview-rec${indi ? ` ${sexClass(indi.sex)}` : ""}`;
                return (
                  <div className="preview-card" key={g.id}>
                    <div className="preview-card-head">
                      {canNavigate ? (
                        <button
                          className={`person-link ${labelClass}`}
                          onClick={() => { onNavigate(g.id); onClose(); }}
                        >
                          {g.label}
                          {lifespan && <span className="person-years gm-data"> {lifespan}</span>}
                        </button>
                      ) : (
                        <span className={labelClass}>
                          {g.label}
                          {lifespan && <span className="person-years gm-data"> {lifespan}</span>}
                        </span>
                      )}
                      <span className={`preview-badge ${g.isNew ? "is-new" : "is-edit"}`}>
                        {g.isNew ? t("preview.badge.new") : t("preview.badge.edited")}
                      </span>
                      {canRemove && (
                        <button
                          className="preview-item-remove"
                          title={t("save.preview.removeChange")}
                          onClick={() => onRemove(g.id, kind)}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    {fieldRows.length > 0 && (
                      <ul className="preview-fields">
                        {fieldRows.map((c, i) => (
                          <li key={i}>
                            <span className="preview-field">{c.field}</span>:{" "}
                            {c.action === "both" || !c.from ? (
                              <span className="preview-add">+ {c.to}</span>
                            ) : (
                              <>
                                <span className="preview-from">{c.from}</span>
                                {" → "}
                                <span className="preview-to">{c.to}</span>
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </section>
          ) : (
            <p className="preview-empty">{t("preview.nothing")}</p>
          )}

          <section className="preview-files">
            <p>{t("preview.files")}</p>
            <ul>
              {files.map((f) => (
                <li key={f}><code>{f}</code></li>
              ))}
            </ul>
            <p className="preview-note">{t("preview.untouched")}</p>
          </section>
        </div>

        <div className="preview-actions">
          <button className="btn-secondary" onClick={onClose}>{t("preview.cancel")}</button>
          <button className="export-btn" onClick={onConfirm} disabled={groups.length === 0}>
            {downloadLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, accent, warn }: { value: number; label: string; accent?: boolean; warn?: boolean }) {
  const cls = warn ? "is-warn" : accent ? "is-accent" : "";
  return (
    <div className="preview-stat">
      <span className={`preview-stat-num ${cls}`}>{value}</span>
      <span className="preview-stat-label">{label}</span>
    </div>
  );
}

function groupByRecord(report: ChangeReport): RecordGroup[] {
  const map = new Map<string, RecordGroup>();
  for (const c of report.changes) {
    let g = map.get(c.recordId);
    if (!g) {
      g = { id: c.recordId, label: report.recordLabels[c.recordId] ?? c.recordId, isNew: false, changes: [] };
      map.set(c.recordId, g);
    }
    if (c.newRecord) g.isNew = true;
    g.changes.push(c);
  }
  const groups = [...map.values()];
  groups.sort((a, b) => Number(b.isNew) - Number(a.isNew));
  return groups;
}

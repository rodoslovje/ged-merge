import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ChangeReport, FieldChange } from "../merge/merge";

interface Props {
  report: ChangeReport;
  /** Individuals + families in the master before merging, for the net total. */
  masterRecordCount: number;
  /** Base name of the files that will be downloaded (without extension). */
  fileBase: string;
  onConfirm: () => void;
  onClose: () => void;
}

interface RecordGroup {
  id: string;
  label: string;
  isNew: boolean;
  changes: FieldChange[];
}

/**
 * Pre-flight summary shown before the merged GEDCOM is written: headline counts,
 * per-record changes (new vs. edited), things that could not be merged, and the
 * output files. Nothing is written until the user confirms.
 */
export function MergePreview({ report, masterRecordCount, fileBase, onConfirm, onClose }: Props) {
  const { t } = useTranslation();

  const groups = useMemo(() => groupByRecord(report), [report]);
  const newRecords = report.newPersons + report.newFamilies;
  const finalCount = masterRecordCount + newRecords;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t("preview.title")}</h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")}>×</button>
        </div>

        <div className="modal-body preview-body">
          {/* Headline counts */}
          <div className="preview-summary">
            <Stat value={report.recordsChanged} label={t("preview.stat.records")} />
            <Stat value={report.changes.length} label={t("preview.stat.fields")} />
            <Stat value={report.newPersons} label={t("preview.stat.newPersons")} accent />
            <Stat value={report.newFamilies} label={t("preview.stat.newFamilies")} accent />
            <Stat value={report.deferred.length} label={t("preview.stat.deferred")} warn={report.deferred.length > 0} />
          </div>

          <p className="preview-total">
            {t("preview.total", { before: masterRecordCount, after: finalCount, delta: newRecords })}
          </p>

          {report.placesReformatted > 0 && (
            <p className="preview-note">
              {t("preview.places", { count: report.placesReformatted, noted: report.placesNoted })}
            </p>
          )}

          {/* Things that could not be merged — surfaced before the applied changes. */}
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

          {/* Applied changes, grouped per record. */}
          {groups.length > 0 ? (
            <section className="preview-section">
              <h3>{t("preview.changes")}</h3>
              {groups.map((g) => (
                <div className="preview-card" key={g.id}>
                  <div className="preview-card-head">
                    <span className="preview-rec">{g.label}</span>
                    <span className={`preview-badge ${g.isNew ? "is-new" : "is-edit"}`}>
                      {g.isNew ? t("preview.badge.new") : t("preview.badge.edited")}
                    </span>
                  </div>
                  <ul className="preview-fields">
                    {g.changes
                      .filter((c) => !c.newRecord)
                      .map((c, i) => (
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
                </div>
              ))}
            </section>
          ) : (
            <p className="preview-empty">{t("preview.nothing")}</p>
          )}

          {/* Footer: what gets written, reassurance that originals are untouched. */}
          <section className="preview-files">
            <p>{t("preview.files")}</p>
            <ul>
              <li><code>{fileBase}.merged.ged</code></li>
              <li><code>{fileBase}.merge-report.txt</code></li>
            </ul>
            <p className="preview-note">{t("preview.untouched")}</p>
          </section>
        </div>

        <div className="preview-actions">
          <button className="btn-secondary" onClick={onClose}>{t("preview.cancel")}</button>
          <button className="export-btn" onClick={onConfirm} disabled={groups.length === 0}>
            {t("preview.download")}
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

/** Group the flat change list by record, ordering new records first. */
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

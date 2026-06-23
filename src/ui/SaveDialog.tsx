import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ChangeReport, FieldChange } from "../merge/merge";
import type { Dataset } from "../gedcom/types";
import { lifespanOf } from "../gedcom/lifespan";
import { sexClass } from "./sex";
import { EVENT_ORDER } from "../review/fields";

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
  isRemoved: boolean;
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

  // Maps each event's translated group label (e.g. "Baptism") to its
  // lifecycle position, so preview cards list events birth-to-death instead
  // of in whatever order the merge/edit steps happened to record them.
  const eventOrder = useMemo(() => {
    const map = new Map<string, number>();
    EVENT_ORDER.forEach((tag, i) => map.set(t(`event.${tag}`), i));
    return map;
  }, [t]);

  const fieldCount = useMemo(
    () => report.changes.filter((c) => !c.newRecord && (c.from || c.to)).length,
    [report.changes],
  );
  // Fields added where the master had nothing before, as opposed to one
  // existing value replacing another.
  const newFields = useMemo(
    () => report.changes.filter((c) => !c.newRecord && !c.from && c.to).length,
    [report.changes],
  );

  const newRecords = report.newPersons + report.newFamilies;

  // Non-standard tags (e.g. _ITALIC) the merge would copy in from the
  // incoming file, grouped by tag name — unchecking one strips every instance
  // of it from the merged tree right before the file is downloaded.
  const customTagEntries = useMemo(() => Object.entries(report.customTags), [report.customTags]);
  const [excludedTags, setExcludedTags] = useState<Set<string>>(new Set());

  function toggleCustomTag(tag: string) {
    setExcludedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function handleConfirm() {
    for (const [tag, nodes] of customTagEntries) {
      if (!excludedTags.has(tag)) continue;
      for (const { parent, node } of nodes) {
        parent.children = parent.children.filter((c) => c !== node);
      }
    }
    onConfirm();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")}>×</button>
        </div>

        <div className="modal-body preview-body">
          <div className="preview-summary">
            <Stat
              value={report.recordsChanged}
              label={t("preview.stat.records")}
              delta={masterRecordCount != null ? newRecords : undefined}
              deltaTitle={t("preview.stat.newRecords", { count: newRecords })}
            />
            {fieldCount > 0 && (
              <Stat
                value={fieldCount}
                label={t("preview.stat.fields")}
                delta={newFields}
                deltaTitle={t("preview.stat.newFields", { count: newFields })}
              />
            )}
            {report.deferred.length > 0 && (
              <Stat value={report.deferred.length} label={t("preview.stat.deferred")} warn />
            )}
          </div>

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
                const spouses = kind === "family" ? report.familySpouses[g.id] : undefined;
                const headContent = spouses?.length ? (
                  spouses.map((s, i) => {
                    const sIndi = s.id ? dataset?.individuals.get(s.id) : undefined;
                    const sLifespan = sIndi ? lifespanOf(sIndi) : undefined;
                    return (
                      <span key={s.id ?? i} className={sIndi ? sexClass(sIndi.sex) : undefined}>
                        {i > 0 && " + "}
                        {s.name}
                        {sLifespan && <span className="person-years gm-data"> {sLifespan}</span>}
                      </span>
                    );
                  })
                ) : (
                  <>
                    {g.label}
                    {lifespan && <span className="person-years gm-data"> {lifespan}</span>}
                  </>
                );
                return (
                  <div className="preview-card" key={g.id}>
                    <div className="preview-card-head">
                      {canNavigate ? (
                        <button
                          className={`person-link ${labelClass}`}
                          onClick={() => { onNavigate(g.id); onClose(); }}
                        >
                          {headContent}
                        </button>
                      ) : (
                        <span className={labelClass}>
                          {headContent}
                        </span>
                      )}
                      <span className="preview-card-head-right">
                        <span className={`preview-badge ${g.isNew ? "is-new" : g.isRemoved ? "is-removed" : "is-edit"}`}>
                          {g.isNew ? t("preview.badge.new") : g.isRemoved ? t("preview.badge.removed") : t("preview.badge.edited")}
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
                      </span>
                    </div>
                    {fieldRows.length > 0 && (
                      <ul className="preview-fields">
                        {groupFieldRows(fieldRows, eventOrder).map((grp, gi) =>
                          grp.group ? (
                            <li key={gi} className="preview-field-group">
                              <span className="preview-field-group-label">{grp.group}</span>
                              <ul className="preview-fields preview-fields-nested">
                                {grp.rows.map((c, i) => (
                                  <li key={i}>
                                    {c.field !== grp.group && (
                                      <><span className="preview-field">{c.field}</span>: </>
                                    )}
                                    <FieldValue c={c} />
                                  </li>
                                ))}
                              </ul>
                            </li>
                          ) : (
                            grp.rows.map((c, i) => (
                              <li key={`${gi}-${i}`}>
                                <span className="preview-field">{c.field}</span>: <FieldValue c={c} />
                              </li>
                            ))
                          ),
                        )}
                      </ul>
                    )}
                  </div>
                );
              })}
            </section>
          ) : (
            <p className="preview-empty">{t("preview.nothing")}</p>
          )}

          {customTagEntries.length > 0 && (
            <section className="preview-section">
              <h3>{t("preview.customTags")}</h3>
              <p className="preview-note">{t("preview.customTagsHint")}</p>
              <ul className="preview-custom-tags">
                {customTagEntries.map(([tag, nodes]) => (
                  <li key={tag}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!excludedTags.has(tag)}
                        onChange={() => toggleCustomTag(tag)}
                      />
                      <code>{tag}</code> ({nodes.length})
                    </label>
                  </li>
                ))}
              </ul>
            </section>
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
          <button className="export-btn" onClick={handleConfirm} disabled={groups.length === 0}>
            {downloadLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldValue({ c }: { c: FieldChange }) {
  if (c.segments) {
    return (
      <>
        {c.segments.map((s, i) => (
          <span key={i}>
            {i > 0 && " · "}
            <span className={s.state === "changed" ? "preview-add" : s.state === "removed" ? "preview-from" : "preview-unchanged"}>
              {s.text}
            </span>
          </span>
        ))}
      </>
    );
  }
  if (c.action === "both" || !c.from) return <span className={c.unedited ? "preview-same" : "preview-add"}>+ {c.to}</span>;
  if (!c.to) return <span className="preview-from">{c.from}</span>;
  return (
    <>
      <span className="preview-from">{c.from}</span>
      {" → "}
      <span className={c.unedited ? "preview-same" : "preview-to"}>{c.to}</span>
    </>
  );
}

/** Collapses fields sharing the same event group (e.g. "Birth") so the preview
 *  shows the event name once, with its date/place/note/source fields indented
 *  underneath instead of repeating the event name each time. Keyed by group
 *  label (not just adjacency) so rows appended later — e.g. from a manual edit
 *  made after the merge step — still land under their existing event header.
 *  Groups are then sorted birth-to-death via `eventOrder`; non-event rows
 *  (notes, sources, …) have no entry in that map and sort after every event,
 *  keeping their original relative order (stable sort). */
function groupFieldRows(
  rows: FieldChange[],
  eventOrder: Map<string, number>,
): { group?: string; rows: FieldChange[] }[] {
  const groups: { group?: string; rows: FieldChange[] }[] = [];
  const byGroup = new Map<string, { group?: string; rows: FieldChange[] }>();
  for (const c of rows) {
    if (!c.group) {
      groups.push({ group: undefined, rows: [c] });
      continue;
    }
    let g = byGroup.get(c.group);
    if (!g) {
      g = { group: c.group, rows: [] };
      byGroup.set(c.group, g);
      groups.push(g);
    }
    g.rows.push(c);
  }
  groups.sort((a, b) => {
    const oa = a.group ? eventOrder.get(a.group) ?? Infinity : Infinity;
    const ob = b.group ? eventOrder.get(b.group) ?? Infinity : Infinity;
    return oa - ob;
  });
  return groups;
}

function Stat({
  value,
  label,
  accent,
  warn,
  delta,
  deltaTitle,
}: {
  value: number;
  label: string;
  accent?: boolean;
  warn?: boolean;
  /** Newly added count shown as a small "+N" badge next to the main number; hidden when 0. */
  delta?: number;
  /** Tooltip for the delta badge. */
  deltaTitle?: string;
}) {
  const cls = warn ? "is-warn" : accent ? "is-accent" : "";
  return (
    <div className="preview-stat">
      <span className="preview-stat-num-row">
        <span className={`preview-stat-num ${cls}`}>{value}</span>
        {!!delta && <span className="preview-stat-delta" title={deltaTitle}>+{delta}</span>}
      </span>
      <span className="preview-stat-label">{label}</span>
    </div>
  );
}

function groupByRecord(report: ChangeReport): RecordGroup[] {
  const map = new Map<string, RecordGroup>();
  for (const c of report.changes) {
    let g = map.get(c.recordId);
    if (!g) {
      g = { id: c.recordId, label: report.recordLabels[c.recordId] ?? c.recordId, isNew: false, isRemoved: false, changes: [] };
      map.set(c.recordId, g);
    }
    if (c.newRecord) g.isNew = true;
    if (c.removedRecord) g.isRemoved = true;
    g.changes.push(c);
  }
  const groups = [...map.values()];
  groups.sort((a, b) => Number(b.isNew) - Number(a.isNew));
  return groups;
}

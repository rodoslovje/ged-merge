import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalKeyboard } from "../keyboard/useModalKeyboard";
import { isItemizedChange, reportTotals, type ChangeReport, type FieldChange, type GraftJoinPerson } from "../merge/merge";
import type { Dataset, Individual } from "../gedcom/types";
import { lifespanOf } from "../gedcom/lifespan";
import { customEventLabel, eventDisplayLabel } from "../gedcom/eventTags";
import { sexClass } from "./sex";
import { EVENT_ORDER } from "../review/fields";
import { vendorTagInfo } from "../gedcom/vendorTags";
import { charsetNotices } from "./charsetNotice";
import { SourceRefs } from "./SourceRef";
import { LinkIcons } from "./FieldValue";
import type { Translate } from "../locales/i18n";

/** A change with no text value — it carries only source/link icons to render inline. */
function isIconChange(c: FieldChange): boolean {
  return !c.from && !c.to && !c.segments && !!(c.sources?.length || c.links?.length);
}


interface Props {
  report: ChangeReport;
  title: string;
  files: string[];
  downloadLabel: string;
  /** Confirm the download. Takes the vendor tags this dialog just stripped from
   *  the tree, so the change report can say the file lost them. */
  onConfirm: (excludedTags: string[]) => void;
  onClose: () => void;
  /** IDs of records that came from edit mode (show navigate/remove buttons). */
  editRecordIds?: Set<string>;
  /** Called when the user clicks a person name to return to the editor. */
  onNavigate?: (id: string) => void;
  /** Called when the user removes a record from the pending save. */
  onRemove?: (id: string, kind: "individual" | "family") => void;
  /** When provided, individual records show sex colour and lifespan. */
  dataset?: Dataset;
  /** Consistency findings on the output (e.g. dangling pointers) — shown as a
   *  warning strip so the user sees them before confirming the download. */
  integrityWarnings?: string[];
}

interface RecordGroup {
  id: string;
  label: string;
  isNew: boolean;
  /** A new record brought in by a whole-branch graft (import ancestors/descendants). */
  isImported: boolean;
  isRemoved: boolean;
  /** Found by the save-time audit rather than by change tracking: the record
   *  reaches the file different from how it arrived, with no field detail to
   *  show for it. */
  isUndescribed: boolean;
  changes: FieldChange[];
}

export function SaveDialog({
  report,
  title,
  files,
  downloadLabel,
  onConfirm,
  onClose,
  editRecordIds,
  onNavigate,
  onRemove,
  dataset,
  integrityWarnings,
}: Props) {
  const { t, i18n } = useTranslation();
  const modalRef = useModalKeyboard(true, onClose);

  const groups = useMemo(() => groupByRecord(report), [report]);

  // What the download does to the file's encoding, when it isn't a no-op —
  // the same wording the health check shows before the user ever gets here.
  const charsetNotes = dataset ? charsetNotices(dataset, t) : [];

  // Maps each event's translated group label (e.g. "Baptism") to its
  // lifecycle position, so preview cards list events birth-to-death instead
  // of in whatever order the merge/edit steps happened to record them.
  const eventOrder = useMemo(() => {
    const map = new Map<string, number>();
    EVENT_ORDER.forEach((tag, i) => map.set(t(`event.${tag}`), i));
    return map;
  }, [t]);

  // Counted by `reportTotals`, the same arithmetic the downloaded report's
  // summary uses — the two used to count different things and disagree.
  const totals = useMemo(() => reportTotals(report), [report]);

  // Non-standard tags (e.g. _ITALIC) the merge would copy in from the
  // incoming file, grouped by tag name — unchecking one strips every instance
  // of it from the merged tree right before the file is downloaded.
  const customTagEntries = useMemo(() => Object.entries(report.customTags), [report.customTags]);
  // Software-internal bookkeeping tags (per the vendor registry: `_UPD`,
  // `_COLOR*`, `_FLGS`, …) start unchecked — they carry no genealogical
  // content, so the default merge output stays clean. Everything else stays in
  // unless the user opts out.
  const [excludedTags, setExcludedTags] = useState<Set<string>>(
    () => new Set(Object.keys(report.customTags).filter((tag) => vendorTagInfo(tag)?.category === "internal")),
  );

  function toggleCustomTag(tag: string) {
    setExcludedTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  }

  function handleConfirm() {
    const stripped: string[] = [];
    for (const [tag, nodes] of customTagEntries) {
      if (!excludedTags.has(tag)) continue;
      stripped.push(tag);
      for (const { parent, node } of nodes) {
        parent.children = parent.children.filter((c) => c !== node);
      }
    }
    onConfirm(stripped);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>×</button>
        </div>

        <div className="modal-body preview-body">
          <div className="preview-summary">
            <Stat
              value={totals.recordsChanged}
              label={t("preview.stat.records")}
              delta={totals.newRecords || undefined}
              deltaTitle={t("preview.stat.newRecords", { count: totals.newRecords })}
            />
            {totals.fields > 0 && (
              <Stat
                value={totals.fields}
                label={t("preview.stat.fields")}
                delta={totals.newFields}
                deltaTitle={t("preview.stat.newFields", { count: totals.newFields })}
              />
            )}
            {/* Records the file has and the download won't. Nothing else in the
                dialog adds up to this number, and it is the one change no
                reader wants to find out about afterwards. */}
            {totals.removedRecords > 0 && (
              <Stat
                value={totals.removedRecords}
                label={t("preview.stat.removed")}
                warn
                deltaTitle={t("preview.stat.removedHint", { count: totals.removedRecords })}
              />
            )}
            {totals.deferred > 0 && (
              <Stat value={totals.deferred} label={t("preview.stat.deferred")} />
            )}
          </div>

          {/* The download is UTF-8 whatever the source was, and its header is
              rewritten to say so (see ensureUtf8Charset) — a silent change to
              a line other software trusts, so it's said out loud once, here,
              while the user can still decide not to download. */}
          {charsetNotes.map((note, i) => <p className="preview-note" key={i}>{note}</p>)}

          {integrityWarnings && integrityWarnings.length > 0 && (
            <section className="preview-section">
              <h3 className="preview-warn">{t("preview.integrity")}</h3>
              <ul className="preview-deferred">
                {integrityWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </section>
          )}

          {/* Identities the branch import acted on that nobody confirmed. The
              graft links records onto them, so a wrong one hangs a whole
              household off the wrong person — said out loud here, while the
              download can still be called off. */}
          {report.graftJoins.length > 0 && (
            <section className="preview-section">
              <h3>{t("preview.grafted")}</h3>
              <p className="preview-note">{t("preview.graftedHint")}</p>
              <ul className="preview-deferred preview-joins">
                {report.graftJoins.map((j, i) => (
                  <li key={i}>
                    <PersonLabel person={j.incoming} />
                    <span className="preview-join-arrow" aria-hidden="true">→</span>
                    <PersonLabel person={j.main} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.deferred.length > 0 && (
            <section className="preview-section">
              <h3>{t("preview.notMerged")}</h3>
              <p className="preview-note">{t("preview.notMergedHint")}</p>
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
                // Records (SOUR/OBJE) aren't offered for removal — `onRemove`
                // reverts a person/family snapshot, and they carry neither.
                const canRemove = isEditRecord && !!onRemove && kind !== "record";
                const spouses = kind === "family" ? report.familySpouses[g.id] : undefined;
                // A new person's name and sex are already in the card's header
                // (spelled out, and colouring the label) — repeating them as
                // "Given: + Jurij" rows says nothing. A new family's header
                // names both spouses the same way, so its "Father: + Borut
                // Bratuša" rows say nothing either. On an existing record the
                // same rows are a real before/after, so they stay.
                const fieldRows = g.changes.filter(
                  (c) =>
                    isItemizedChange(c) &&
                    !(c.identity && g.isNew && kind === "individual") &&
                    !(c.spouseSlot && g.isNew && spouses?.length),
                );
                // A record added by this merge isn't in the (pre-merge) dataset,
                // so its person styling and facts come from the incoming record
                // it was copied from.
                const newIndi = report.newIndividuals?.[g.id];
                const indi = kind === "individual" ? dataset?.individuals.get(g.id) ?? newIndi : undefined;
                // A whole-branch import can run to hundreds of people, and
                // spelling out every fact of every one of them buries the
                // handful of cards the user actually has to check. A grafted
                // person is a copy the user asked for wholesale, so the name
                // and years in the head say enough; people stitched in by a
                // confirmed match keep their facts, where the detail is the
                // point.
                const facts = newIndi && !g.isImported ? personFacts(newIndi, t, i18n.language) : [];
                const lifespan = indi ? lifespanOf(indi) : undefined;
                const labelClass = `preview-rec${indi ? ` ${sexClass(indi.sex)}` : ""}`;
                const headContent = spouses?.length ? (
                  spouses.map((s, i) => {
                    const sIndi = s.id
                      ? dataset?.individuals.get(s.id) ?? report.newIndividuals?.[s.id]
                      : undefined;
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
                        {/* "New" and "Incoming" both mark a record the file
                            didn't have; only the route differs, so each says
                            which one it took. */}
                        <span
                          className={`preview-badge ${g.isImported ? "is-incoming" : g.isNew ? "is-new" : g.isRemoved ? "is-removed" : "is-edit"}`}
                          title={g.isImported ? t("preview.badge.incomingHint") : g.isNew ? t("preview.badge.newHint") : undefined}
                        >
                          {g.isImported ? t("preview.badge.incoming") : g.isNew ? t("preview.badge.new") : g.isRemoved ? t("preview.badge.removed") : t("preview.badge.edited")}
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
                    {facts.length > 0 && (
                      <ul className="preview-fields">
                        {facts.map((f, i) => (
                          <li key={i}>
                            <span className="preview-field">{f.label}</span>:{" "}
                            <span className="preview-same">{f.text}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {fieldRows.length > 0 && (
                      <ul className="preview-fields">
                        {groupFieldRows(fieldRows, eventOrder).map((grp, gi) =>
                          grp.group ? (
                            <li key={gi} className="preview-field-group">
                              <span className="preview-field-group-label">{grp.group}</span>
                              <ul className="preview-fields preview-fields-nested">
                                {renderGroupRows(grp.rows, grp.group, t)}
                              </ul>
                            </li>
                          ) : (
                            grp.rows.map((c, i) => (
                              <li key={`${gi}-${i}`}>
                                {!c.noLabel && <><span className="preview-field">{c.field}</span>: </>}
                                {isIconChange(c) ? <ChangeIcons changes={[c]} t={t} /> : <FieldValue c={c} />}
                              </li>
                            ))
                          ),
                        )}
                      </ul>
                    )}
                    {/* A card with nothing under it says nothing, so the two
                        cases that produce one get a sentence: a record the
                        download leaves out, and one the save can tell has
                        changed but cannot itemize. Where the card does list
                        something, the listing is the explanation. */}
                    {fieldRows.length === 0 && facts.length === 0 && (g.isRemoved || g.isUndescribed) && (
                      <p className="preview-note">
                        {g.isRemoved ? t("preview.removedHint") : t("preview.undescribedHint")}
                      </p>
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
                {customTagEntries.map(([tag, nodes]) => {
                  const info = vendorTagInfo(tag);
                  const meaning = info && (i18n.language.startsWith("sl") ? info.meaning.sl : info.meaning.en);
                  return (
                    <li key={tag}>
                      <label>
                        <input
                          type="checkbox"
                          checked={!excludedTags.has(tag)}
                          onChange={() => toggleCustomTag(tag)}
                        />
                        <code>{tag}</code> ({nodes.length})
                        {info && <span className="preview-tag-meaning"> — {info.software}: {meaning}</span>}
                      </label>
                    </li>
                  );
                })}
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

/**
 * The facts a person brings with them, as one line per event. A record added by
 * the merge is copied into the tree wholesale rather than applied field by
 * field, so it produces no change rows — without this its card would show
 * nothing but a name, hiding the very data the user chose to bring in.
 */
function personFacts(indi: Individual, t: Translate, lang: string): { label: string; text: string }[] {
  const order = (tag: string) => {
    const i = EVENT_ORDER.indexOf(tag);
    return i === -1 ? EVENT_ORDER.length : i;
  };
  return [...indi.events]
    .sort((a, b) => order(a.tag) - order(b.tag))
    .map((e) => {
      const parts = [e.date?.raw, e.place?.raw, e.address?.raw, e.value].filter(Boolean) as string[];
      if (!parts.length) return undefined;
      // A custom EVEN/FACT reads under its own TYPE ("Civil Partnership"), the
      // way the review and the editor label it.
      const custom = (e.tag === "EVEN" || e.tag === "FACT") && customEventLabel(e.type, t, lang);
      return { label: custom || eventDisplayLabel(e.tag, t), text: parts.join(" · ") };
    })
    .filter((f): f is { label: string; text: string } => !!f);
}

/** Renders one event group's rows: text/segment rows as lines, with any
 *  source/link icons appended inline to the last data line (so they sit on the
 *  same row as the event's date/place data) — or on their own line when the
 *  event has no other change. */
function renderGroupRows(rows: FieldChange[], group: string, t: Translate) {
  const iconChanges = rows.filter(isIconChange);
  const dataRows = rows.filter((c) => !isIconChange(c));
  const icons = iconChanges.length ? <ChangeIcons changes={iconChanges} t={t} /> : null;

  if (dataRows.length === 0) {
    return icons ? <li>{icons}</li> : null;
  }
  return dataRows.map((c, i) => (
    <li key={i}>
      {c.field !== group && <><span className="preview-field">{c.field}</span>: </>}
      <FieldValue c={c} />
      {i === dataRows.length - 1 && icons && <> {icons}</>}
    </li>
  ));
}

/** The 📖/🔗 icons (with tooltip) for the citations/links a change added. */
function ChangeIcons({ changes, t }: { changes: FieldChange[]; t: Translate }) {
  const sources = changes.flatMap((c) => c.sources ?? []);
  const links = changes.flatMap((c) => c.links ?? []);
  return (
    <>
      {sources.length > 0 && <SourceRefs t={t} incomingSources={sources} />}
      {links.length > 0 && <LinkIcons urls={links} otherUrls={[]} />}
    </>
  );
}

function FieldValue({ c }: { c: FieldChange }) {
  if (c.segments) {
    return (
      <>
        {c.segments.map((s, i) => (
          <span key={i}>
            {i > 0 && " · "}
            {/* What the piece said before it was rewritten, struck through and
                followed by an arrow — the same before/after the dialog's other
                rows read as, kept inside the piece so the " · " between pieces
                still separates fields rather than versions. */}
            {s.from && (
              <>
                <span className="preview-from">{s.from}</span>
                {" → "}
              </>
            )}
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
 *  Groups are then sorted: the person's own identity (name, sex) first, since
 *  it sits on the record itself rather than on any event, then the events
 *  birth-to-death via `eventOrder`; the remaining non-event rows (notes,
 *  sources, …) have no entry in that map and sort last, each keeping its
 *  original relative order (stable sort). */
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
  // Finite, so the stable sort keeps equal-ranked rows in their original order
  // (Infinity - Infinity would hand it a NaN).
  const LAST = Number.MAX_SAFE_INTEGER;
  const rank = (g: { group?: string; rows: FieldChange[] }) => {
    if (g.group) return eventOrder.get(g.group) ?? LAST;
    return g.rows[0]?.identity ? -1 : LAST;
  };
  groups.sort((a, b) => rank(a) - rank(b));
  return groups;
}

/** A person the way the preview's cards write one: name in their sex's colour,
 *  lifespan trailing in the data face. */
function PersonLabel({ person }: { person: GraftJoinPerson }) {
  return (
    <span className={`preview-rec ${sexClass(person.sex)}`}>
      {person.name}
      {person.years && <span className="person-years gm-data"> {person.years}</span>}
    </span>
  );
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
      g = { id: c.recordId, label: report.recordLabels[c.recordId] ?? c.recordId, isNew: false, isImported: false, isRemoved: false, isUndescribed: false, changes: [] };
      map.set(c.recordId, g);
    }
    if (c.newRecord) g.isNew = true;
    if (c.viaGraft) g.isImported = true;
    if (c.removedRecord) g.isRemoved = true;
    if (c.undescribed) g.isUndescribed = true;
    g.changes.push(c);
  }
  const groups = [...map.values()];
  // What the reader most needs to look at, first: records the file gains, then
  // the ones it loses, then ordinary edits, and last the ones the save can only
  // say *that* it changed.
  const rank = (g: RecordGroup) =>
    g.isNew ? 0 : g.isRemoved ? 1 : g.isUndescribed && !g.changes.some(isItemizedChange) ? 3 : 2;
  groups.sort((a, b) => rank(a) - rank(b));
  return groups;
}

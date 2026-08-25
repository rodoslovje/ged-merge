import type { ReactNode } from "react";
import type { Translate } from "../../locales/i18n";
import { NonStandard, nonStandardTag, type SourceFieldKey } from "./standardFields";
import { SelectMenu } from "../DropdownMenu";
import { quayOptions } from "./quay";

/** The records a source dialog writes to besides the source itself: this
 *  citation of it (which lives on the person or event, not on the source), the
 *  repository holding it, and the page image. The source's own fields open the
 *  form and carry no caption — the dialog is titled after them. */
export type SourceGroup = "citation" | "repo" | "media";

/**
 * The caption between two blocks of fields, saying which of those records the
 * next block is written to. Without the seams a reader has no way to know that
 * changing the title changes every other citation of the same book while
 * changing the page changes only this one. Worded and set like the event
 * captions in the merge comparison — centred small-caps between two rules — so
 * the app divides a form the one way everywhere.
 */
export function SourceGroupHead({ group, t }: { group: SourceGroup; t: Translate }) {
  return <div className="add-source-group">{t(`addSource.group.${group}`)}</div>;
}

/** How good this citation's evidence is — the one field of the form that is a
 *  judgement rather than a reading, so it is a menu of the four `QUAY`
 *  meanings instead of a text box. Blank writes no `QUAY` at all. The label,
 *  hint and meanings are the Organize sources tool's own strings: the same
 *  question is asked in both places, and one wording keeps them agreeing. */
export function QuayField({ value, onChange, t }: { value: string; onChange: (value: string) => void; t: Translate }) {
  return (
    <label className="add-source-field" title={t("tools.sources.reshapeQuayHint")}>
      <span>{t("tools.sources.reshapeQuay")}</span>
      <SelectMenu className="edit-input" value={value} onChange={onChange} options={quayOptions(t)} />
    </label>
  );
}

/** The values a source form edits — every field any of its callers offers. */
export interface SourceFormValues {
  title: string;
  author: string;
  agency: string;
  publisher: string;
  place: string;
  dateRange: string;
  note: string;
  periodical: string;
  /** The archive's own id. Whether it is labelled a filing number or a call
   *  number — and so whether it stands here or beside the repository — is the
   *  file's own habit; see {@link idField}. */
  filingNumber: string;
  /** Which entry of the source this is: the citation's, not the source's. */
  page: string;
  /** How good this reference's evidence is (GEDCOM `QUAY`, 0–3) — the
   *  citation's too, and empty unless a recognized link proposed one. */
  quay: string;
}

/**
 * The fields of a source, in one order with one set of labels.
 *
 * Two dialogs edit a source in this app — Add Source, which writes a record,
 * and the Organize sources editor, which writes a proposal — and a reader
 * opening them from the same list found two different forms: different fields,
 * a different order, marks on one and not the other. What they edit differs;
 * what a source *is* does not.
 *
 * Order follows how an archive source fills them: what it is called, who wrote
 * and holds it, what it publishes and where, when, then the ids — the
 * periodical and the archive's number last, on the row above the repository
 * they belong to. `show` leaves out what a caller has no field for; `slots`
 * take the rows only that caller can render (its repository choices, its link).
 */
export function SourceFieldsForm({
  values,
  onChange,
  show,
  coverage,
  /** Whether this file states the archive's id beside the repository instead
   *  — then the field belongs to the repository row, not to these. */
  idOnRepo,
  /** Whether the page/quality pair describes a citation of this source. False
   *  in the standalone editor (Tools → Sources), which writes a source cited
   *  by nothing yet — there the page only names the image the link opens, so
   *  it stays among the source's own fields and gets no citation heading. */
  citation = true,
  t,
  repositoryRow,
  linkRow,
}: {
  values: SourceFormValues;
  onChange: (key: keyof SourceFormValues, value: string) => void;
  show: Partial<Record<keyof SourceFormValues, boolean>> & { title?: boolean };
  coverage: "vendor" | "standard";
  idOnRepo: boolean;
  citation?: boolean;
  t: Translate;
  repositoryRow?: ReactNode;
  linkRow?: ReactNode;
}) {
  const field = (key: keyof SourceFormValues, labelKey: string, autoFocus = false) => {
    if (show[key] === false) return null;
    const tag = nonStandardTag(key as SourceFieldKey, coverage);
    return (
      <label className="add-source-field">
        <span>
          {t(labelKey)}
          <NonStandard tag={tag} t={t} />
        </span>
        <input
          className="edit-input"
          autoFocus={autoFocus}
          value={values[key]}
          onChange={(e) => onChange(key, e.target.value)}
        />
      </label>
    );
  };

  const citationBlock = citation && (show.page !== false || show.quay !== false);
  return (
    <>
      {field("title", "addSource.field.title")}
      <div className="add-source-details-grid">
        {field("author", "addSource.field.author")}
        {field("agency", "addSource.field.agency")}
        {field("publisher", "addSource.field.publisher")}
        {field("place", "addSource.field.place")}
        {field("dateRange", "addSource.field.dateRange")}
        {field("note", "addSource.field.note")}
        {field("periodical", "addSource.field.periodical")}
        {!idOnRepo && field("filingNumber", "addSource.field.filingNumber")}
        {!citation && field("page", "addSource.field.page")}
      </div>
      {/* Where the source is kept belongs beside what the source is — both
          describe the book. The citation follows: which entry of it this is,
          and the page image that entry opens, which the caller's link row
          renders directly under it. */}
      {repositoryRow && (
        <>
          <SourceGroupHead group="repo" t={t} />
          {repositoryRow}
        </>
      )}
      {citationBlock && (
        <>
          <SourceGroupHead group="citation" t={t} />
          <div className="add-source-details-grid">
            {field("page", "addSource.field.page")}
            {show.quay !== false && <QuayField value={values.quay} onChange={(v) => onChange("quay", v)} t={t} />}
          </div>
        </>
      )}
      {linkRow && (
        <>
          <SourceGroupHead group="media" t={t} />
          {linkRow}
        </>
      )}
    </>
  );
}

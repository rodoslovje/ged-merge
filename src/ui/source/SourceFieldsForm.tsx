import type { ReactNode } from "react";
import type { Translate } from "../../locales/i18n";
import { NonStandard, nonStandardTag, type SourceFieldKey } from "./standardFields";

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
  t,
  repositoryRow,
  linkRow,
}: {
  values: SourceFormValues;
  onChange: (key: keyof SourceFormValues, value: string) => void;
  show: Partial<Record<keyof SourceFormValues, boolean>> & { title?: boolean };
  coverage: "vendor" | "standard";
  idOnRepo: boolean;
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

  return (
    <>
      {field("title", "addSource.field.title")}
      <div className="add-source-details-grid">
        {field("author", "addSource.field.author")}
        {field("agency", "addSource.field.agency")}
        {field("publisher", "addSource.field.publisher")}
        {field("place", "addSource.field.place")}
        {field("dateRange", "addSource.field.dateRange")}
        {field("page", "addSource.field.page")}
        {field("note", "addSource.field.note")}
        {field("periodical", "addSource.field.periodical")}
        {!idOnRepo && field("filingNumber", "addSource.field.filingNumber")}
      </div>
      {repositoryRow}
      {linkRow}
    </>
  );
}

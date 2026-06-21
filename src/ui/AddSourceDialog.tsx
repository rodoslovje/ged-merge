import { useEffect, useMemo, useState } from "react";
import type { Dataset } from "../gedcom/types";
import type { NewSourceFields } from "../gedcom/edit";
import { findExistingSource } from "../gedcom/source";
import { parseSourceInput } from "../gedcom/citationParse";
import { inferMasterProfile } from "../normalize/profile";
import { rewriteLinkLang } from "../normalize/links";
import { fetchPageTitle } from "../normalize/urlMetadata";
import type { Translate } from "../locales/i18n";

/** Fields confirmed by the dialog, ready for `EditView`'s commit handler to
 * decide whether to reuse an existing `SOUR`/`OBJE` or create new ones. */
export type AddSourceResult = NewSourceFields & { page?: string };

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (fields: AddSourceResult) => void;
  dataset: Dataset;
  t: Translate;
}

interface FormState {
  title: string;
  author: string;
  periodical: string;
  publisher: string;
  agency: string;
  filingNumber: string;
  page: string;
  url: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  title: "", author: "", periodical: "", publisher: "", agency: "", filingNumber: "", page: "", url: "", note: "",
};

function extractPage(url: string): string | undefined {
  return /[?&]pg=(\d+)/i.exec(url)?.[1];
}

function titleOf(dataset: Dataset, sourceXref: string): string | undefined {
  const rec = dataset.records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  return rec?.children.find((c) => c.tag === "TITL")?.value?.trim();
}

export function AddSourceDialog({ isOpen, onClose, onAdd, dataset, t }: Props) {
  const [text, setText] = useState("");
  const [fields, setFields] = useState<FormState>(EMPTY_FORM);
  const [fetching, setFetching] = useState(false);

  const masterLinkLangs = useMemo(() => inferMasterProfile(dataset).linkLangs, [dataset]);
  const parsed = useMemo(() => parseSourceInput(text), [text]);
  const normalizedUrl = useMemo(
    () => (parsed.url ? rewriteLinkLang(parsed.url, masterLinkLangs) : undefined),
    [parsed.url, masterLinkLangs],
  );
  const match = useMemo(
    () => (normalizedUrl ? findExistingSource(dataset, normalizedUrl) : undefined),
    [dataset, normalizedUrl],
  );
  const matchTitle = useMemo(() => (match ? titleOf(dataset, match.sourceXref) : undefined), [dataset, match]);
  const urlOnly =
    parsed.url !== undefined &&
    parsed.title === undefined && parsed.author === undefined &&
    parsed.periodical === undefined && parsed.publisher === undefined && parsed.note === undefined;

  // Re-seed the editable fields whenever the pasted text (and therefore its
  // parse) changes — but not on every render, so the user's own edits to a
  // field afterward (without touching the textarea again) aren't clobbered.
  useEffect(() => {
    setFields({
      title: match ? "" : parsed.title ?? "",
      author: match ? "" : parsed.author ?? "",
      periodical: match ? "" : parsed.periodical ?? "",
      publisher: match ? "" : parsed.publisher ?? "",
      agency: "",
      filingNumber: "",
      page: match?.page ?? extractPage(normalizedUrl ?? "") ?? "",
      url: normalizedUrl ?? "",
      note: match ? "" : parsed.note ?? "",
    });
  }, [text, parsed, normalizedUrl, match]);

  // Best-effort metadata fetch for a bare URL with nothing else to go on.
  useEffect(() => {
    if (!urlOnly || match || !normalizedUrl) {
      setFetching(false);
      return;
    }
    let cancelled = false;
    setFetching(true);
    fetchPageTitle(normalizedUrl).then((title) => {
      if (cancelled) return;
      setFetching(false);
      if (title) setFields((f) => (f.url === normalizedUrl && !f.title ? { ...f, title } : f));
    });
    return () => { cancelled = true; };
  }, [normalizedUrl, urlOnly, match]);

  if (!isOpen) return null;

  function reset() {
    setText("");
    setFields(EMPTY_FORM);
    setFetching(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleAdd() {
    const trim = (s: string) => s.trim() || undefined;
    onAdd({
      title: trim(fields.title),
      author: trim(fields.author),
      periodical: trim(fields.periodical),
      publisher: trim(fields.publisher),
      agency: trim(fields.agency),
      filingNumber: trim(fields.filingNumber),
      page: trim(fields.page),
      url: trim(fields.url),
      note: trim(fields.note),
    });
    reset();
  }

  const canAdd = Boolean(fields.url.trim() || fields.title.trim());
  const field = (key: keyof FormState, labelKey: string) => (
    <label className="add-source-field">
      <span>{t(labelKey)}</span>
      <input
        className="edit-input"
        value={fields[key]}
        onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
      />
    </label>
  );

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className="modal add-source-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{t("addSource.title")}</h2>
          <button className="modal-close" onClick={handleClose} title={t("help.close")}>×</button>
        </div>
        <div className="modal-body">
          <textarea
            className="edit-input add-source-textarea"
            rows={3}
            autoFocus
            placeholder={t("addSource.placeholder")}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {fetching && <div className="add-source-hint">{t("addSource.fetching")}</div>}
          {match && (
            <div className="add-source-hint">
              {matchTitle ? t("addSource.matchTitled", { title: matchTitle }) : t("addSource.match")}
            </div>
          )}
          {!match && (
            <>
              {field("title", "addSource.field.title")}
              {field("author", "addSource.field.author")}
              {field("periodical", "addSource.field.periodical")}
              {field("publisher", "addSource.field.publisher")}
              {field("agency", "addSource.field.agency")}
              {field("filingNumber", "addSource.field.filingNumber")}
              {field("note", "addSource.field.note")}
            </>
          )}
          {field("page", "addSource.field.page")}
          {field("url", "addSource.field.url")}
          <div className="add-source-actions">
            <button className="tree-open-btn" onClick={handleClose}>{t("addSource.cancel")}</button>
            <button className="tree-open-btn" disabled={!canAdd} onClick={handleAdd}>{t("addSource.add")}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dataset } from "../gedcom/types";
import type { EditSourceFields, NewSourceFields } from "../gedcom/edit";
import { findExistingSource } from "../gedcom/source";
import { parseSourceInput } from "../gedcom/citationParse";
import { inferMainProfile } from "../normalize/profile";
import { rewriteLinkLang } from "../normalize/links";
import { fetchPageHtml, fetchPageTitle } from "../normalize/urlMetadata";
import { fetchBookMeta, recognizeSourceUrl, type ReshapeMeta, type ReshapeSite } from "../tools/sourceReshape";
import { useSettings } from "./SettingsContext";
import { SITE_ICON } from "./tools/SourceCleanupView";
import { linkHref } from "./FieldValue";
import type { Translate } from "../locales/i18n";

/** Fields confirmed by the dialog, ready for `EditView`'s commit handler to
 * decide whether to reuse an existing `SOUR`/`OBJE` or create new ones.
 * `site`/`place`/`dateRange` are set when the URL matched one of the cleanup
 * tool's known sites — the commit side then applies the same PLAC/DATE/REPO
 * extras the Clean up sources tool writes. */
export type AddSourceResult = NewSourceFields & {
  page?: string;
  site?: ReshapeSite;
  place?: string;
  dateRange?: string;
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (fields: AddSourceResult) => void;
  dataset: Dataset;
  t: Translate;
  /** When given, the dialog edits an existing citation instead of adding a
   * new one: no paste-and-parse box, fields are prefilled and all editable,
   * and the footer offers Remove alongside Save/Cancel. */
  editing?: {
    fields: EditSourceFields;
    onSave: (fields: EditSourceFields) => void;
    onRemove: () => void;
  };
}

interface FormState {
  title: string;
  author: string;
  periodical: string;
  publisher: string;
  agency: string;
  place: string;
  filingNumber: string;
  page: string;
  url: string;
  note: string;
}

const EMPTY_FORM: FormState = {
  title: "", author: "", periodical: "", publisher: "", agency: "", place: "", filingNumber: "", page: "", url: "", note: "",
};

function extractPage(url: string): string | undefined {
  return /[?&]pg=(\d+)/i.exec(url)?.[1];
}

function titleOf(dataset: Dataset, sourceXref: string): string | undefined {
  const rec = dataset.records.find((r) => r.tag === "SOUR" && r.xref === sourceXref);
  return rec?.children.find((c) => c.tag === "TITL")?.value?.trim();
}

export function AddSourceDialog({ isOpen, onClose, onAdd, dataset, t, editing }: Props) {
  const [text, setText] = useState("");
  const [fields, setFields] = useState<FormState>(EMPTY_FORM);
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<ReshapeMeta | undefined>();
  const { settings } = useSettings();
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const mainLinkLangs = useMemo(() => inferMainProfile(dataset).linkLangs, [dataset]);
  const parsed = useMemo(() => parseSourceInput(text), [text]);
  const normalizedUrl = useMemo(
    () => (parsed.url ? rewriteLinkLang(parsed.url, mainLinkLangs) : undefined),
    [parsed.url, mainLinkLangs],
  );
  // The same site recognition the Clean up sources tool runs — a Matricula /
  // Geneanet / Find a Grave / … URL proposes the identical source fields here,
  // so a hand-added source leaves no work for a later cleanup pass.
  const recognized = useMemo(
    () => (normalizedUrl ? recognizeSourceUrl(normalizedUrl, text) : undefined),
    [normalizedUrl, text],
  );
  const match = useMemo(
    () => (normalizedUrl ? findExistingSource(dataset.records, normalizedUrl) : undefined),
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
  // Skipped while editing an existing citation (no textarea to parse).
  useEffect(() => {
    if (editing) return;
    setFetched(undefined);
    setFields({
      // For a recognized site the composed proposal ("Katarina Abdonec - WW2 -
      // SIstory.si") beats the generic parse's bare quoted name — same title
      // the cleanup tool would write.
      title: match ? "" : recognized?.proposed.title ?? parsed.title ?? "",
      author: match ? "" : parsed.author ?? "",
      periodical: match ? "" : parsed.periodical ?? "",
      // When the site proposal claims the parenthesized institute as the
      // agency (SIstory), it doesn't repeat as the publisher.
      publisher: match || parsed.publisher === recognized?.proposed.agency ? "" : parsed.publisher ?? "",
      agency: match ? "" : recognized?.proposed.agency ?? "",
      place: match ? "" : recognized?.proposed.place ?? parsed.place ?? "",
      filingNumber: match ? "" : recognized?.proposed.filingNumber ?? "",
      page: match?.page ?? recognized?.page ?? extractPage(normalizedUrl ?? "") ?? "",
      url: normalizedUrl ?? "",
      note: match ? "" : parsed.note ?? "",
    });
  }, [editing, text, parsed, normalizedUrl, match, recognized]);

  // Editing an existing citation: seed directly from its current fields.
  useEffect(() => {
    if (!editing) return;
    const f = editing.fields;
    setFields({
      title: f.title ?? "",
      author: f.author ?? "",
      periodical: f.periodical ?? "",
      publisher: f.publisher ?? "",
      agency: f.agency ?? "",
      place: f.place ?? "",
      filingNumber: f.filingNumber ?? "",
      page: f.page ?? "",
      url: f.url ?? "",
      note: f.note ?? "",
    });
  }, [editing]);

  // Best-effort metadata fetch for a bare URL with nothing else to go on.
  // Gated behind the opt-in setting — this is the one path that sends a URL off
  // the user's machine (to the public CORS relay), so it's off by default.
  // A recognized site URL goes through the cleanup tool's per-site parsers
  // (curated title, agency, place, date range) instead of the raw page title.
  useEffect(() => {
    if (editing || !settings.allowLinkFetch || !urlOnly || match || !normalizedUrl) {
      setFetching(false);
      return;
    }
    let cancelled = false;
    setFetching(true);
    const proposal = recognized?.proposed;
    const request: Promise<ReshapeMeta | undefined> = recognized
      ? fetchBookMeta(recognized.site, recognized.bookUrl, fetchPageHtml)
      : fetchPageTitle(normalizedUrl).then((title) => (title ? { title } : undefined));
    request.then((meta) => {
      if (cancelled) return;
      setFetching(false);
      if (!meta) return;
      setFetched(meta);
      // Fetched metadata upgrades a field only while it still holds the
      // offline proposal (or is empty) — the user's own edits always win.
      const upgrade = (current: string, proposed: string | undefined, value: string | undefined) =>
        value && (!current.trim() || current === proposed) ? value : current;
      setFields((f) =>
        f.url === normalizedUrl
          ? {
              ...f,
              title: upgrade(f.title, proposal?.title, meta.title),
              author: upgrade(f.author, undefined, meta.author),
              periodical: upgrade(f.periodical, undefined, meta.periodical),
              publisher: upgrade(f.publisher, undefined, meta.publisher),
              agency: upgrade(f.agency, proposal?.agency, meta.agency),
              place: upgrade(f.place, proposal?.place, meta.place),
            }
          : f,
      );
    });
    return () => { cancelled = true; };
  }, [editing, normalizedUrl, urlOnly, match, settings.allowLinkFetch, recognized]);

  useEffect(() => {
    if (!isOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") handleClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]); // handleClose intentionally omitted — stable by design, only wraps onClose prop

  // Remember what was focused before the dialog opened (this render runs before
  // the dialog's own autoFocus), so focus can return there when it closes — a
  // keyboard user lands back on the trigger and can Tab onward.
  if (isOpen && !wasOpenRef.current) {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
  }
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (isOpen || !wasOpen) return;
    const el = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (el && document.contains(el)) el.focus();
  }, [isOpen]);

  if (!isOpen) return null;

  function reset() {
    setText("");
    setFields(EMPTY_FORM);
    setFetching(false);
    setFetched(undefined);
  }

  function handleClose() {
    reset();
    onClose();
  }

  function trimmedFields(fields: FormState) {
    const trim = (s: string) => s.trim() || undefined;
    return {
      title: trim(fields.title),
      author: trim(fields.author),
      periodical: trim(fields.periodical),
      publisher: trim(fields.publisher),
      agency: trim(fields.agency),
      place: trim(fields.place),
      filingNumber: trim(fields.filingNumber),
      page: trim(fields.page),
      url: trim(fields.url),
      note: trim(fields.note),
    };
  }

  function handleAdd() {
    onAdd({
      ...trimmedFields(fields),
      site: recognized?.site,
      dateRange: fetched?.dateRange,
    });
    reset();
  }

  function handleSave() {
    if (!editing) return;
    editing.onSave({ ...trimmedFields(fields), objeXref: editing.fields.objeXref });
    reset();
  }

  function handleRemove() {
    if (!editing) return;
    editing.onRemove();
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
      <div className="modal add-source-dialog" role="dialog" aria-modal="true" aria-label={t(editing ? "editSource.title" : "addSource.title")} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <span className="add-source-badge" aria-hidden="true">📖</span>
            {t(editing ? "editSource.title" : "addSource.title")}
          </h2>
          <button className="modal-close" onClick={handleClose} title={t("help.close")} aria-label={t("help.close")}>×</button>
        </div>
        <div className="modal-body">
          {!editing && (
            <label className="add-source-field">
              <span>{t("addSource.field.link")}</span>
              <textarea
                className="edit-input add-source-textarea"
                rows={3}
                autoFocus
                placeholder={t("addSource.placeholder")}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
          )}
          {match && (
            <div className="add-source-hint">
              {matchTitle ? t("addSource.matchTitled", { title: matchTitle }) : t("addSource.match")}
            </div>
          )}
          {!match && !editing && recognized && (
            <div className="add-source-chip">
              <span className="add-source-chip-check" aria-hidden="true">{fetching ? "…" : "✓"}</span>
              <span>{t(fetching ? "addSource.fetching" : "addSource.recognized")}</span>
              <span className="add-source-chip-site">
                {SITE_ICON[recognized.site]} {t(`tools.sources.reshapeSite.${recognized.site}`)}
              </span>
            </div>
          )}
          {!match && !editing && recognized && !settings.allowLinkFetch && (
            <div className="add-source-hint">{t("addSource.recognizedFetchOff", { setting: t("settings.links.fetch") })}</div>
          )}
          {fetching && !recognized && <div className="add-source-hint">{t("addSource.fetching")}</div>}
          {!match && (
            <>
              {field("title", "addSource.field.title")}
              <div className="add-source-details-grid">
                {field("author", "addSource.field.author")}
                {field("periodical", "addSource.field.periodical")}
                {field("publisher", "addSource.field.publisher")}
                {field("agency", "addSource.field.agency")}
                {field("place", "addSource.field.place")}
                {field("filingNumber", "addSource.field.filingNumber")}
                {field("page", "addSource.field.page")}
                {field("note", "addSource.field.note")}
              </div>
            </>
          )}
          {match && field("page", "addSource.field.page")}
          <div className="add-source-url-row">
            {field("url", "addSource.field.url")}
            {editing && fields.url.trim() && (
              <a className="edit-link-open" href={linkHref(fields.url.trim())} target="_blank" rel="noopener noreferrer" title={t("edit.openLink")}>
                ↗
              </a>
            )}
          </div>
        </div>
        <div className="add-source-actions">
          {editing && (
            <button className="tree-open-btn add-source-remove" onClick={handleRemove}>{t("editSource.remove")}</button>
          )}
          <button className="tree-open-btn" onClick={handleClose}>{t("addSource.cancel")}</button>
          {editing ? (
            <button className="add-source-submit" onClick={handleSave}>{t("editSource.save")}</button>
          ) : (
            <button className="add-source-submit" disabled={!canAdd} onClick={handleAdd}>{t("addSource.add")}</button>
          )}
        </div>
      </div>
    </div>
  );
}

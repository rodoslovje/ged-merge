import { useEffect, useMemo, useRef, useState } from "react";
import type { Dataset } from "../gedcom/types";
import type { EditSourceFields, NewSourceFields } from "../gedcom/edit";
import { findExistingSource } from "../gedcom/source";
import { parseSourceInput } from "../gedcom/citationParse";
import { inferMainProfile } from "../normalize/profile";
import { rewriteLinkLang } from "../normalize/links";
import { fetchPageHtml, fetchPageTitle } from "../normalize/urlMetadata";
import { fetchBookMeta, makePlaceResolver, narrowFsRegister, proposedSiteRepo, recognizeSourceUrl, SITE_ICON, splitFsRegisters, type ReshapeMeta, type ReshapeSite } from "../tools/sourceReshape";
import { prefersSourceRepos } from "../gedcom/source";
import { childText } from "../gedcom/node";
import { useSettings } from "./SettingsContext";
import { SelectMenu } from "./DropdownMenu";
import { linkHref, linkTooltip } from "./FieldValue";
import type { Translate } from "../locales/i18n";

/** Fields confirmed by the dialog, ready for `EditView`'s commit handler to
 * decide whether to reuse an existing `SOUR`/`OBJE` or create new ones.
 * `site`/`place`/`dateRange` are set when the URL matched one of the cleanup
 * tool's known sites — the commit side then applies the same PLAC/DATE/REPO
 * extras the Organize sources tool writes. */
export type AddSourceResult = NewSourceFields & {
  page?: string;
  site?: ReshapeSite;
  place?: string;
  dateRange?: string;
  /** The Repository dropdown's explicit choice: an existing `REPO` xref, or
   * `""` for none. Always sent by the dialog, so what it showed is what the
   * save writes — the automatic site-repo fallback only serves older callers. */
  repoXref?: string;
  /** Create the recognized site's repository record and link it (the
   * dropdown's "＋ …" option). */
  repoCreateSite?: boolean;
  /** Create a new repository with this name and link it (the dropdown's
   * "New repository" option). */
  repoCreateName?: string;
  /** Call number (`CALN`) written on the source's repository link. */
  repoCaln?: string;
  /** The FamilySearch collection behind the link, when the lookup found it —
   *  names the repository the "＋ …" choice would create, and gives it the
   *  collection's own page as WWW. */
  collection?: string;
  collectionId?: string;
};

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (fields: AddSourceResult) => void;
  dataset: Dataset;
  t: Translate;
  /** When given, the dialog edits an existing citation instead of adding a
   * new one: no paste-and-parse box, fields are prefilled and all editable,
   * and the footer offers Remove alongside Save/Cancel. Omit `onRemove` to
   * hide the Remove button (e.g. a source record other citations still use). */
  editing?: {
    fields: EditSourceFields;
    onSave: (fields: EditSourceFields) => void;
    onRemove?: () => void;
  };
  /** Standalone mode (Tools → Sources): the confirmed fields create a `SOUR`
   * record cited by nothing yet, so a URL that matches an existing source has
   * nothing to add — the match hint says so and the Add button is disabled. */
  standalone?: boolean;
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

export function AddSourceDialog({ isOpen, onClose, onAdd, dataset, t, editing, standalone }: Props) {
  const [text, setText] = useState("");
  const [fields, setFields] = useState<FormState>(EMPTY_FORM);
  // The Repository dropdown: "" = none, a REPO xref, "@create@" for the
  // recognized site's proposed new repository, or "@new@" for a hand-named one.
  const [repoSel, setRepoSel] = useState("");
  // Name for the "@new@" repository choice.
  const [repoName, setRepoName] = useState("");
  // Call number (CALN) on the source's repository link.
  const [repoCaln, setRepoCaln] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetched, setFetched] = useState<ReshapeMeta | undefined>();
  // One register of a book that holds several ("Births … 1892-1899 Marriages …
  // 1858-1890"), once the reader says which one this page is.
  const [register, setRegister] = useState<string | undefined>();
  // Whether the Repository dropdown holds a hand-picked choice — a later
  // lookup improves only what the dialog itself put there.
  const repoTouched = useRef(false);
  const { settings } = useSettings();
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  const mainLinkLangs = useMemo(() => inferMainProfile(dataset).linkLangs, [dataset]);
  // Places shown in the dialog already match the file's own place format —
  // the same resolution commit applies, so what you see is what gets saved.
  const resolvePlace = useMemo(() => makePlaceResolver(dataset.records), [dataset]);
  const parsed = useMemo(() => parseSourceInput(text), [text]);
  const normalizedUrl = useMemo(
    () => (parsed.url ? rewriteLinkLang(parsed.url, mainLinkLangs) : undefined),
    [parsed.url, mainLinkLangs],
  );
  // The same site recognition the Organize sources tool runs — a Matricula /
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
  const repos = useMemo(
    () =>
      dataset.records
        .filter((r) => r.tag === "REPO" && r.xref)
        .map((r) => ({ xref: r.xref!, name: childText(r, "NAME")?.trim() || r.xref! }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [dataset],
  );
  // What the automatic site-repo linking would pick for this URL: the site's
  // existing repository, or the name of the one it would create. Depends only
  // on the pasted URL (not the live form fields), so seeding the dropdown from
  // it can't clobber the user's later edits.
  const repoDefault = useMemo(
    () => (recognized && normalizedUrl ? proposedSiteRepo(dataset.records, recognized.site, normalizedUrl, recognized.proposed.agency) : undefined),
    [recognized, normalizedUrl, dataset],
  );
  // The same proposal once the lookup has named the link's collection: a file
  // that keeps one repository per FamilySearch collection ("FamilySearch.org -
  // Croatia Church Books 1516-1994") can only be matched by that name, and a
  // repository created for the link takes it too. Deliberately separate from
  // `repoDefault` — it must not re-seed the fields the lookup just filled.
  const repoFetched = useMemo(
    () =>
      recognized && normalizedUrl && (fetched?.collection || fetched?.collectionId)
        ? proposedSiteRepo(dataset.records, recognized.site, normalizedUrl, recognized.proposed.agency, {
            title: fetched.collection,
            id: fetched.collectionId,
          })
        : undefined,
    [recognized, normalizedUrl, dataset, fetched?.collection, fetched?.collectionId],
  );
  const repoProposal = repoFetched ?? repoDefault;
  // The registers this book holds, and the metadata as the chosen one leaves
  // it — what the Add actually writes.
  const registers = useMemo(() => splitFsRegisters(fetched?.book), [fetched?.book]);
  const chosen = useMemo(
    () => (fetched && register ? narrowFsRegister(fetched, register) : fetched),
    [fetched, register],
  );
  // Whether the file's convention hangs sources off repositories — decides if
  // the create-proposal is preselected or merely offered.
  const layoutPrefersRepos = useMemo(() => {
    const override = settings.formatOverrides.sourceLayout ?? "auto";
    return override !== "auto" ? override === "repository" : prefersSourceRepos(dataset.records);
  }, [settings.formatOverrides.sourceLayout, dataset]);
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
      author: match ? "" : parsed.author ?? recognized?.proposed.author ?? "",
      periodical: match ? "" : parsed.periodical ?? "",
      // When the site proposal claims the parenthesized institute as the
      // agency (SIstory), it doesn't repeat as the publisher.
      publisher: match || parsed.publisher === recognized?.proposed.agency ? "" : parsed.publisher ?? "",
      agency: match ? "" : recognized?.proposed.agency ?? "",
      place: match ? "" : resolvePlace(recognized?.proposed.place ?? parsed.place) ?? "",
      filingNumber: match ? "" : recognized?.proposed.filingNumber ?? "",
      page: match?.page ?? recognized?.page ?? extractPage(normalizedUrl ?? "") ?? "",
      url: normalizedUrl ?? "",
      note: match ? "" : parsed.note ?? "",
    });
    setRepoSel(match ? "" : repoDefault?.xref ?? (repoDefault?.createName && layoutPrefersRepos ? "@create@" : ""));
    setRepoName("");
    setRepoCaln("");
    setRegister(undefined);
    repoTouched.current = false;
  }, [editing, text, parsed, normalizedUrl, match, recognized, resolvePlace, repoDefault, layoutPrefersRepos]);

  // A collection the lookup named can point at the file's own repository for
  // it, which the URL alone could not find.
  useEffect(() => {
    if (!repoFetched?.xref || repoTouched.current) return;
    setRepoSel(repoFetched.xref);
  }, [repoFetched]);

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
    setRepoSel(f.repoXref ?? "");
    setRepoName("");
    setRepoCaln(f.repoCaln ?? "");
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
              place: upgrade(f.place, resolvePlace(proposal?.place), resolvePlace(meta.place)),
              page: upgrade(f.page, recognized?.page, meta.page),
            }
          : f,
      );
    });
    return () => { cancelled = true; };
  }, [editing, normalizedUrl, urlOnly, match, settings.allowLinkFetch, recognized, resolvePlace]);

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
    setRepoSel("");
    setRepoName("");
    setRepoCaln("");
    setFetching(false);
    setFetched(undefined);
    setRegister(undefined);
    repoTouched.current = false;
  }

  /** Pick one register of a multi-register book (or all of it again): the
   *  title follows, and with it the event the citation lands on. */
  function pickRegister(part: string | undefined) {
    setRegister(part);
    const narrowed = fetched && part ? narrowFsRegister(fetched, part) : fetched;
    if (narrowed?.title) setFields((f) => ({ ...f, title: narrowed.title! }));
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
      // Fetched over offline-recognized — Newspapers.com carries the issue
      // date right in the citation prose, with no fetchable page behind it.
      dateRange: chosen?.dateRange ?? recognized?.proposed.dateRange,
      collection: fetched?.collection,
      collectionId: fetched?.collectionId,
      repoXref: repoSel === "@create@" || repoSel === "@new@" ? undefined : repoSel,
      repoCreateSite: repoSel === "@create@" || undefined,
      repoCreateName: repoSel === "@new@" ? repoName.trim() || undefined : undefined,
      repoCaln: repoCaln.trim() || undefined,
    });
    reset();
  }

  function handleSave() {
    if (!editing) return;
    // A picked repo (or an explicit clear, when the prefill carried a repo
    // field) is sent as-is; an untouched dropdown on a prefill without one
    // (the legacy-link promote) stays undefined so the automatic site-repo
    // behavior still applies. "@new@" sends the typed name instead — and with
    // the name still empty, the repository link is simply left as it was.
    const repoCreateName = repoSel === "@new@" ? repoName.trim() || undefined : undefined;
    const repoXref = repoSel === "@new@" ? undefined : repoSel || (editing.fields.repoXref !== undefined ? "" : undefined);
    editing.onSave({ ...trimmedFields(fields), objeXref: editing.fields.objeXref, repoXref, repoCreateName, repoCaln });
    reset();
  }

  function handleRemove() {
    if (!editing?.onRemove) return;
    editing.onRemove();
    reset();
  }

  const canAdd = Boolean(fields.url.trim() || fields.title.trim()) && !(standalone && match);
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
              {standalone
                ? matchTitle
                  ? t("addSource.matchStandaloneTitled", { title: matchTitle })
                  : t("addSource.matchStandalone")
                : matchTitle
                  ? t("addSource.matchTitled", { title: matchTitle })
                  : t("addSource.match")}
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
          {!match && !editing && registers.length > 1 && (
            <div className="add-source-registers">
              <span className="add-source-registers-label">{t("addSource.register")}</span>
              <button
                type="button"
                className={`add-source-register${register === undefined ? " is-on" : ""}`}
                onClick={() => pickRegister(undefined)}
              >
                {t("addSource.register.whole")}
              </button>
              {registers.map((part) => (
                <button
                  key={part}
                  type="button"
                  className={`add-source-register${register === part ? " is-on" : ""}`}
                  onClick={() => pickRegister(part)}
                >
                  {part}
                </button>
              ))}
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
                {/* Page is citation-local — editing the record itself (Tools →
                    Sources) has no citation to carry it. */}
                {!(standalone && editing) && field("page", "addSource.field.page")}
                {field("note", "addSource.field.note")}
              </div>
            </>
          )}
          {match && !standalone && field("page", "addSource.field.page")}
          {!match && (
            <div className="add-source-details-grid">
              <label className="add-source-field">
                <span>{t("addSource.field.repo")}</span>
                <SelectMenu
                  className="edit-input"
                  value={repoSel}
                  onChange={(v) => {
                    repoTouched.current = true;
                    setRepoSel(v);
                  }}
                  // The special choices sit outside the sorted repository
                  // group: no-repo first, the create actions last.
                  groups={[
                    { items: [{ value: "", label: t("tools.sources.noRepo") }] },
                    {
                      label: t("tools.sources.dupKind.repo"),
                      items: repos.map((r) => ({ value: r.xref, label: r.name })),
                    },
                    {
                      items: [
                        ...(!editing && !repoProposal?.xref && repoProposal?.createName
                          ? [{ value: "@create@", label: t("addSource.repo.create", { name: repoProposal.createName }) }]
                          : []),
                        { value: "@new@", label: t("addSource.repo.new") },
                      ],
                    },
                  ]}
                />
              </label>
              {repoSel === "@new@" && (
                <label className="add-source-field">
                  <span>{t("addSource.field.repoName")}</span>
                  <input className="edit-input" value={repoName} onChange={(e) => setRepoName(e.target.value)} autoFocus />
                </label>
              )}
              {repoSel !== "" && (
                <label className="add-source-field">
                  <span>{t("addSource.field.caln")}</span>
                  <input className="edit-input" value={repoCaln} onChange={(e) => setRepoCaln(e.target.value)} />
                </label>
              )}
            </div>
          )}
          <div className="add-source-url-row">
            {field("url", "addSource.field.url")}
            {editing && fields.url.trim() && (
              <a className="edit-link-open" href={linkHref(fields.url.trim())} target="_blank" rel="noopener noreferrer" title={linkTooltip(fields.url.trim(), t, t("edit.openLink"))}>
                ↗
              </a>
            )}
          </div>
        </div>
        <div className="add-source-actions">
          {editing?.onRemove && (
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

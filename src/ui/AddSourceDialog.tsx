import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Dataset } from "../gedcom/types";
import { getSourceLookup, type EditSourceFields, type NewSourceFields } from "../gedcom/edit";
import { findExistingSource, type FsSourceHint } from "../gedcom/source";
import { parseSourceInput } from "../gedcom/citationParse";
import { inferMainProfile } from "../normalize/profile";
import { familySearchPageUrl, rewriteLinkLang } from "../normalize/links";
import { makePlaceResolver, narrowFsRegister, proposedSiteRepo, recognizeSourceUrl, siteSourceTitle, SITE_ICON, splitFsRegisters, type ReshapeMeta, type ReshapeSite } from "../tools/sourceReshape";
import { detectSourceCoverage, repoLinkWanted, writesCallNumbers } from "../gedcom/source";
import { childText } from "../gedcom/node";
import { useSettings } from "./SettingsContext";
import { useDebounced } from "./tools/shared";
import { SelectMenu } from "./DropdownMenu";
import { idField } from "./source/standardFields";
import { SourceFieldsForm } from "./source/SourceFieldsForm";
import { useSourceLookup } from "./source/useSourceLookup";
import { SourceDialogShell } from "./source/SourceDialogShell";
import { SourceLinkRow } from "./source/SourceLinkRow";
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
  const [fetched, setFetched] = useState<ReshapeMeta | undefined>();
  // One register of a book that holds several ("Births … 1892-1899 Marriages …
  // 1858-1890"), once the reader says which one this page is.
  const [register, setRegister] = useState<string | undefined>();
  // Whether the Repository dropdown holds a hand-picked choice — a later
  // lookup improves only what the dialog itself put there.
  const repoTouched = useRef(false);
  const { settings } = useSettings();
  const { targetOf, lookUp, fetching } = useSourceLookup(settings.allowLinkFetch);

  const mainLinkLangs = useMemo(() => inferMainProfile(dataset).linkLangs, [dataset]);
  // Places shown in the dialog already match the file's own place format —
  // the same resolution commit applies, so what you see is what gets saved.
  const resolvePlace = useMemo(() => makePlaceResolver(dataset.records), [dataset]);
  const parsed = useMemo(() => parseSourceInput(text), [text]);
  const normalizedUrl = useMemo(
    // A FamilySearch link keeps its ark, the image it was copied at and the
    // film that image belongs to: the rest is viewer state, which would make
    // one page look like two sources.
    () => (parsed.url ? familySearchPageUrl(rewriteLinkLang(parsed.url, mainLinkLangs)) : undefined),
    [parsed.url, mainLinkLangs],
  );
  // The same site recognition the Organize sources tool runs — a Matricula /
  // Geneanet / Find a Grave / … URL proposes the identical source fields here,
  // so a hand-added source leaves no work for a later cleanup pass.
  const recognized = useMemo(
    () => (normalizedUrl ? recognizeSourceUrl(normalizedUrl, text) : undefined),
    [normalizedUrl, text],
  );
  // What this FamilySearch link belongs to, beyond what its URL says: two
  // images of one film share no part of their addresses, so the film and the
  // collection — from the pasted citation, or from the lookup once it answers
  // — are what decide which source the page joins.
  const fsHint = useMemo<FsSourceHint | undefined>(
    () =>
      recognized?.site === "familysearch"
        ? {
            film: fetched?.filingNumber ?? recognized.proposed.filingNumber,
            collection: fetched?.collection ?? recognized.collection,
            image: fetched?.page ?? recognized.page,
          }
        : undefined,
    [recognized, fetched?.filingNumber, fetched?.collection, fetched?.page],
  );
  // The existing-source match runs off the version-cached lookup (rebuilt
  // only when a SOUR/OBJE actually changes) — debounced besides, so a URL
  // being typed character by character doesn't re-match on every keystroke
  // (a paste is one change and settles immediately after).
  const settledUrl = useDebounced(normalizedUrl, 250);
  const match = useMemo(
    () => (settledUrl ? findExistingSource(dataset.records, settledUrl, fsHint, getSourceLookup(dataset.records)) : undefined),
    [dataset, settledUrl, fsHint],
  );
  const repos = useMemo(
    () =>
      dataset.records
        .filter((r) => r.tag === "REPO" && r.xref)
        .map((r) => ({ xref: r.xref!, name: childText(r, "NAME")?.trim() || r.xref! }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    // The dataset object is mutated in place by session edits, so re-scan on
    // every open: a repository created by an earlier Add this session must be
    // offered by name — the proposal can pick its xref, and a value missing
    // from the list renders as the raw "@R…@".
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, isOpen],
  );
  // What the automatic site-repo linking would pick for this URL: the site's
  // existing repository, or the name of the one it would create. Depends only
  // on the pasted URL (not the live form fields), so seeding the dropdown from
  // it can't clobber the user's later edits.
  const repoDefault = useMemo(
    () =>
      recognized && normalizedUrl
        ? proposedSiteRepo(
            dataset.records,
            recognized.site,
            normalizedUrl,
            recognized.proposed.agency,
            // The place and collection a pasted citation names say which
            // country's repository holds the source; a bare URL says neither.
            {
              title: recognized.collection ?? recognized.proposed.title,
              place: recognized.proposed.place,
            },
          )
        : undefined,
    [recognized, normalizedUrl, dataset],
  );
  // The same proposal once the lookup has answered: it names the collection
  // and the place the records cover, which is what picks the country's
  // repository. Deliberately separate from `repoDefault` — it must not re-seed
  // the fields the lookup just filled.
  const repoFetched = useMemo(
    () =>
      recognized && normalizedUrl && (fetched?.collection || fetched?.collectionId || fetched?.place)
        ? proposedSiteRepo(dataset.records, recognized.site, normalizedUrl, recognized.proposed.agency, {
            title: fetched.collection,
            id: fetched.collectionId,
            place: fetched.place ?? recognized.proposed.place,
          })
        : undefined,
    [recognized, normalizedUrl, dataset, fetched?.collection, fetched?.collectionId, fetched?.place],
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
  const layoutPrefersRepos = useMemo(
    () => repoLinkWanted(dataset.records, settings.formatOverrides.sourceLayout),
    [settings.formatOverrides.sourceLayout, dataset],
  );
  // Which shape this file states a source's coverage in — it decides whether
  // the Place and Agency fields are the standard's own or the flat vendor
  // ones, and so whether they are marked.
  const coverage = useMemo(() => {
    const override = settings.formatOverrides.sourceCoverage ?? "auto";
    return override !== "auto" ? override : detectSourceCoverage(dataset.records);
  }, [settings.formatOverrides.sourceCoverage, dataset]);
  /** Whether this file states the archive's id beside the repository — then
   *  the source's own filing-number field is not the one that gets written. */
  const idOnRepo = useMemo(
    () => idField(dataset.records, coverage, repoSel !== "").caln,
    [dataset, coverage, repoSel],
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
      author: match ? "" : parsed.author ?? recognized?.proposed.author ?? "",
      // A recognized FamilySearch citation's details are already claimed by
      // the proposal's own fields — the generic parse's leftovers ("images,
      // FamilySearch" as periodical, the access date as publisher, the entry
      // repeated as note) say nothing the source wants.
      periodical: match || recognized?.cited ? "" : parsed.periodical ?? "",
      // When the site proposal claims the parenthesized institute as the
      // agency (SIstory), it doesn't repeat as the publisher.
      publisher: match || recognized?.cited || parsed.publisher === recognized?.proposed.agency ? "" : parsed.publisher ?? "",
      agency: match ? "" : recognized?.proposed.agency ?? "",
      place: match ? "" : resolvePlace(recognized?.proposed.place ?? parsed.place) ?? "",
      filingNumber: match ? "" : recognized?.proposed.filingNumber ?? "",
      page: match?.page ?? recognized?.page ?? extractPage(normalizedUrl ?? "") ?? "",
      url: normalizedUrl ?? "",
      note: match || recognized?.cited ? "" : parsed.note ?? "",
    });
    const preselectCreate = !match && !repoDefault?.xref && Boolean(repoDefault?.createName) && layoutPrefersRepos;
    setRepoSel(match ? "" : repoDefault?.xref ?? (preselectCreate ? "@create@" : ""));
    // The proposed record's name sits in the editable name field, so the
    // user can adjust it before anything is created.
    setRepoName(preselectCreate ? repoDefault!.createName! : "");
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

  /**
   * Read the page behind the URL again and fill these fields from it — the
   * button the editor offers. A record written offline (or before the site
   * could answer) holds what the link alone said: an id for a title and
   * little else. The answer lands in the form, not in the file, so it is
   * checked before Save writes any of it; a field the lookup cannot speak to
   * keeps what it has.
   */
  async function refetch() {
    const url = fields.url.trim();
    if (!url || fetching) return;
    const asked = rewriteLinkLang(url, mainLinkLangs);
    const site = targetOf(asked);
    const meta = await lookUp(asked, { anyPage: true });
    if (!meta) return;
    setFetched(meta);
    const keep = (current: string, value: string | undefined) => value?.trim() || current;
    // The archive's id — a Geneanet view, a Matricula book — is as good
    // offline as it is after the lookup, and goes in the one field this file
    // states ids in: the repository link's call number, or the source's own
    // filing number. Never both (see `writesCallNumbers`).
    const id = meta.filingNumber ?? site?.proposed.filingNumber;
    const callNumbers = writesCallNumbers(dataset.records);
    setFields((f) => {
      const filingNumber = callNumbers ? f.filingNumber : keep(f.filingNumber, id);
      // The title takes the id itself, not the field it happened to land in:
      // in a call-number file the filing number stays empty, and the graves of
      // one cemetery would go back to sharing a name.
      const named = id || f.filingNumber || repoCaln;
      return {
        ...f,
        // Named the way the tool names one: what the page calls the thing,
        // with the id that tells this cemetery's graves apart.
        title: siteSourceTitle(site?.site, keep(f.title, meta.title), named) ?? f.title,
        author: keep(f.author, meta.author),
        periodical: keep(f.periodical, meta.periodical),
        publisher: keep(f.publisher, meta.publisher),
        agency: keep(f.agency, meta.agency),
        place: keep(f.place, resolvePlace(meta.place)),
        filingNumber,
        page: keep(f.page, meta.page ?? site?.page),
      };
    });
    if (callNumbers) setRepoCaln((caln) => caln.trim() || id || fields.filingNumber);
  }

  // Best-effort metadata fetch for a bare URL with nothing else to go on.
  // Gated behind the opt-in setting — this is the one path that sends a URL off
  // the user's machine (to the public CORS relay), so it's off by default.
  // A recognized site URL goes through the cleanup tool's per-site parsers
  // (curated title, agency, place, date range) instead of the raw page title.
  useEffect(() => {
    if (editing || !settings.allowLinkFetch || !urlOnly || match || !normalizedUrl) return;
    let cancelled = false;
    const proposal = recognized?.proposed;
    void lookUp(normalizedUrl, { anyPage: true }).then((meta) => {
      if (cancelled || !meta) return;
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
  }, [editing, normalizedUrl, urlOnly, match, settings.allowLinkFetch, recognized, resolvePlace, lookUp]);

  if (!isOpen) return null;

  function reset() {
    setText("");
    setFields(EMPTY_FORM);
    setRepoSel("");
    setRepoName("");
    setRepoCaln("");
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
    const url = trim(fields.url);
    return {
      title: trim(fields.title),
      author: trim(fields.author),
      periodical: trim(fields.periodical),
      publisher: trim(fields.publisher),
      agency: trim(fields.agency),
      place: trim(fields.place),
      filingNumber: trim(fields.filingNumber),
      page: trim(fields.page),
      // The same normalization the paste path applies — a viewer-state URL
      // pasted straight into the field must not store what the paste box
      // would have trimmed.
      url: url && familySearchPageUrl(rewriteLinkLang(url, mainLinkLangs)),
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
      // The lookup's collection first; the citation's own quoted one when no
      // lookup ran — either names the repository the "＋ …" choice creates.
      collection: fetched?.collection ?? recognized?.collection,
      collectionId: fetched?.collectionId,
      repoXref: repoSel === "@create@" || repoSel === "@new@" ? undefined : repoSel,
      repoCreateSite: repoSel === "@create@" || undefined,
      // For the site proposal this is the (possibly edited) name of the record
      // to create — the site/collection WWW still goes under it.
      repoCreateName: repoSel === "@new@" || repoSel === "@create@" ? repoName.trim() || undefined : undefined,
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

  /**
   * Confirm the dialog from the keyboard — what the Add / Save button does,
   * without tabbing the length of the form to reach it. ⌘/Ctrl+Enter works in
   * every field, including the paste box where a plain Enter is a line break;
   * a plain Enter confirms from the one-line fields, the way a form submits.
   * A menu's own Enter (the Repository dropdown) is left alone.
   */
  function onDialogKeyDown(e: ReactKeyboardEvent) {
    if (e.key !== "Enter" || e.defaultPrevented || e.altKey || e.shiftKey) return;
    const chord = e.metaKey || e.ctrlKey;
    const el = e.target as HTMLElement;
    if (!chord && (el.tagName !== "INPUT" || (el as HTMLInputElement).type !== "text")) return;
    if (editing) {
      e.preventDefault();
      handleSave();
    } else if (canAdd) {
      e.preventDefault();
      handleAdd();
    }
  }
  return (
    <SourceDialogShell
      icon="📖"
      title={t(editing ? "editSource.title" : "addSource.title")}
      t={t}
      onClose={handleClose}
      onKeyDown={onDialogKeyDown}
      actions={
        <>
          {editing?.onRemove && (
            <button className="tree-open-btn add-source-remove" onClick={handleRemove}>{t("editSource.remove")}</button>
          )}
          <button className="tree-open-btn" onClick={handleClose}>{t("addSource.cancel")}</button>
          {editing ? (
            <button className="add-source-submit" onClick={handleSave}>{t("editSource.save")}</button>
          ) : (
            <button className="add-source-submit" disabled={!canAdd} onClick={handleAdd}>{t("addSource.add")}</button>
          )}
        </>
      }
    >
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
            <SourceFieldsForm
              values={{ ...fields, dateRange: "" }}
              onChange={(key, value) => setFields((f) => ({ ...f, [key]: value }))}
              show={{
                // Page is citation-local — editing the record itself (Tools →
                // Sources) has no citation to carry it. A source's own year
                // range is not among this dialog's fields; the site lookup
                // writes it, and the Organize sources editor offers it.
                page: !(standalone && editing),
                dateRange: false,
              }}
              coverage={coverage}
              idOnRepo={idOnRepo}
              t={t}
            />
          )}
          {/* A link that matches a source the file already has adds only its
              page — the source's own fields are the file's, not a proposal's. */}
          {match && !standalone && (
            <label className="add-source-field">
              <span>{t("addSource.field.page")}</span>
              <input
                className="edit-input"
                value={fields.page}
                onChange={(e) => setFields((f) => ({ ...f, page: e.target.value }))}
              />
            </label>
          )}
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
                    // Picking the site proposal seeds its name for editing; a
                    // hand-named repository starts from a blank field.
                    if (v === "@create@") setRepoName(repoProposal?.createName ?? "");
                    else if (v === "@new@") setRepoName("");
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
              {/* The call number is written on this link (`REPO > CALN`), so
                  it stands beside it — and only where the file states its ids
                  there: the same value would otherwise be asked for twice,
                  once as the source's own filing number. */}
              {repoSel !== "" && idOnRepo && (
                <label className="add-source-field">
                  <span>{t("addSource.field.caln")}</span>
                  <input className="edit-input" value={repoCaln} onChange={(e) => setRepoCaln(e.target.value)} />
                </label>
              )}
              {/* After the call number, so the long name gets its own
                  full-width row under the dropdown | call-number pair. */}
              {(repoSel === "@new@" || repoSel === "@create@") && (
                <label className="add-source-field add-source-field-wide">
                  <span>{t("addSource.field.repoName")}</span>
                  {/* autoFocus only for the hand-named choice: the proposal can
                      be preselected by the paste itself, mid-typing. */}
                  <input
                    className="edit-input"
                    value={repoName}
                    onChange={(e) => {
                      // An edited name is a hand-picked choice — the lookup
                      // must not replace it with the repository it finds.
                      repoTouched.current = true;
                      setRepoName(e.target.value);
                    }}
                    autoFocus={repoSel === "@new@"}
                  />
                </label>
              )}
            </div>
          )}
          {/* Read the page again and fill these fields from it — for a record
              made before the lookup could answer, or made offline from the
              link alone. Offered while editing a record that has a link; the
              fields are the reader's to check before Save writes any of it. */}
          <SourceLinkRow
            label={t("addSource.field.url")}
            value={fields.url}
            onChange={(v) => setFields((f) => ({ ...f, url: v }))}
            onLookUp={editing && fields.url.trim() ? () => void refetch() : undefined}
            fetching={fetching}
            lookupAllowed={settings.allowLinkFetch}
            t={t}
          />
    </SourceDialogShell>
  );
}

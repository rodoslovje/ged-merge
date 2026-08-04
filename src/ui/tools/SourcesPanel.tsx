import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "../SettingsContext";
import type { Dataset } from "../../gedcom/types";
import { buildSourceTree, type SourceTree, type RepoGroup, type SourceEntry, type MediaEntry } from "../../tools/sources";
import { MediaThumb, type MediaGalleryItem } from "../PersonMedia";
import { useMediaFolder } from "../MediaFolderContext";
import { isPrivateNode } from "../../gedcom/private";
import { sourceTitle } from "../../gedcom/source";
import type { MediaEditFields } from "../MediaViewer";
import { mediaMetaRows } from "../MediaViewer";
import { type ToolsScans } from "../useToolsScans";
import { AddSourceDialog, type AddSourceResult } from "../AddSourceDialog";
import { repoRecordEditFields, sourceRecordEditFields, type EditRepoFields, type EditSourceFields } from "../../gedcom/edit";
import { ToolsLoading, TreeSearch, UsageList, someMatch, useDebounced } from "./shared";
import { SourceCleanupView } from "./SourceCleanupView";
import { ToolSummary } from "./ToolSummary";

/** Lightbox side panel for a media object: the person/family records that
 *  reference the image (the descriptive caption rows are supplied separately as
 *  the photo's `meta`), and the sources the image is attached to as a page /
 *  front page / cutout. `onNavigate` closes the lightbox before jumping to the
 *  record in Edit mode; `onShowSource` closes it and filters the tree to the
 *  clicked source. */
function MediaDetails({
  dataset,
  media,
  onNavigate,
  onShowSource,
}: {
  dataset: Dataset;
  media: MediaEntry;
  onNavigate: (id: string) => void;
  onShowSource: (title: string) => void;
}) {
  const { t } = useTranslation();
  const inSources = dataset.records.filter(
    (r) => r.tag === "SOUR" && r.xref && r.children.some((c) => c.tag === "OBJE" && c.value?.trim() === media.xref),
  );
  return (
    <>
      <div className="media-lightbox-uses-head">
        {t("tools.sources.referencedBy", { count: media.usedBy.length })}
      </div>
      {media.usedBy.length > 0 ? (
        <UsageList dataset={dataset} uses={media.usedBy} onNavigate={onNavigate} />
      ) : (
        <p className="tools-clean">{t("tools.sources.referencedByNone")}</p>
      )}
      {inSources.length > 0 && (
        <>
          <div className="media-lightbox-uses-head">
            {t("tools.sources.mediaInSources", { count: inSources.length })}
          </div>
          <ul className="tools-usage">
            {inSources.map((s) => (
              <li key={s.xref}>
                <button className="tools-issue-link" onClick={() => onShowSource(sourceTitle(s) || s.xref!)}>
                  📖 {sourceTitle(s) || s.xref}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * A group's `MediaEntry` list (a source's media, or an unattached bucket).
 * With the media folder loaded, the local-file photos show as a person-style
 * thumbnail tray — front pages, cutouts — each opening the shared viewer with
 * prev/next across the siblings and the referenced-by panel. URL pages and
 * (without a folder) unresolvable files stay collapsible rows. The tray (and
 * each photo's index in it) is computed once for the whole group.
 */
function MediaRows({
  entries,
  dataset,
  onNavigate,
  onEditMediaInfo,
  onShowSource,
  isOpen,
  toggle,
  rowKey,
  iconFor,
}: {
  entries: MediaEntry[];
  dataset: Dataset;
  onNavigate: (id: string) => void;
  /** Write edited viewer fields to the shared `OBJE` record (undoable). */
  onEditMediaInfo: (objeXref: string, fields: MediaEditFields) => void;
  /** Filter the tree to a source title (from the viewer's in-sources list). */
  onShowSource: (title: string) => void;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  rowKey: (m: MediaEntry) => string;
  iconFor: (m: MediaEntry) => string;
}) {
  const { t } = useTranslation();
  const { folderName } = useMediaFolder();
  const { items, indexOf } = useMemo(() => {
    const photos = entries.filter((m) => !m.url && m.file);
    const items: MediaGalleryItem[] = photos.map((m) => {
      const rec = dataset.records.find((r) => r.tag === "OBJE" && r.xref === m.xref);
      return {
        file: m.file!,
        title: m.title || m.xref,
        // The editor's inputs replace the static rows (same as the Edit view).
        meta: rec ? undefined : mediaMetaRows(m, t),
        details: (close: () => void) => (
          <MediaDetails
            dataset={dataset}
            media={m}
            onNavigate={(id) => { close(); onNavigate(id); }}
            onShowSource={(title) => { close(); onShowSource(title); }}
          />
        ),
        // The same editable info panel the Edit view offers, committed to the
        // shared OBJE record through the tools undo flow.
        edit: rec
          ? {
              file: m.file!,
              initial: {
                title: m.title ?? "",
                date: m.date ?? "",
                place: m.place ?? "",
                description: m.description ?? "",
                private: isPrivateNode(rec),
              },
              onSave: (fields: MediaEditFields) => onEditMediaInfo(m.xref, fields),
            }
          : undefined,
      };
    });
    return { items, indexOf: new Map(photos.map((m, i) => [m, i] as const)) };
  }, [entries, dataset, onNavigate, onEditMediaInfo, onShowSource, t]);

  // Only with a loaded folder do file entries leave the row list for the tray —
  // without one there is nothing to render, so the titled rows stay.
  const trayEntries = folderName ? entries.filter((m) => indexOf.has(m)) : [];
  const rowEntries = folderName ? entries.filter((m) => !indexOf.has(m)) : entries;

  return (
    <>
      {trayEntries.length > 0 && (
        <div className="tools-media-tray">
          {trayEntries.map((m) => (
            <MediaThumb
              key={m.xref}
              file={m.file!}
              icon={iconFor(m)}
              caption={m.title || m.xref}
              gallery={items}
              index={indexOf.get(m)!}
              large
              count={m.usedBy.length}
            />
          ))}
        </div>
      )}
      {rowEntries.map((m) => {
        const photoIndex = indexOf.get(m);
        const key = rowKey(m);
        return (
          <TreeRow
            key={key}
            open={isOpen(key)}
            onToggle={() => toggle(key)}
            hasChildren={m.usedBy.length > 0}
            count={m.usedBy.length || undefined}
            href={m.url}
            titleText={m.url ?? m.file}
            label={
              <span className="tools-tree-meta">
                {photoIndex !== undefined && m.file ? (
                  <MediaThumb file={m.file} icon={iconFor(m)} gallery={items} index={photoIndex} />
                ) : (
                  iconFor(m)
                )}{" "}
                {m.title || m.xref}
              </span>
            }
          >
            <UsageList dataset={dataset} uses={m.usedBy} onNavigate={onNavigate} />
          </TreeRow>
        );
      })}
    </>
  );
}

/** A collapsible tree row: a ▶ toggle, a label, a usage count, and nested content. */
function TreeRow({
  open,
  onToggle,
  hasChildren,
  label,
  count,
  href,
  titleText,
  prominent,
  action,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  hasChildren: boolean;
  label: ReactNode;
  count?: number;
  href?: string;
  /** Tooltip shown on hover over the label — e.g. a media link or filename. */
  titleText?: string;
  /** Emphasize the label as a top-level grouping (e.g. a repository). */
  prominent?: boolean;
  /** Hover-revealed row action (e.g. the ✎ edit button on a source row). */
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="tools-tree-node">
      <div className="tools-tree-row">
        {hasChildren ? (
          <button
            className={`tools-pair-toggle ${open ? "open" : ""}`}
            onClick={onToggle}
            aria-expanded={open}
          >
            ▶
          </button>
        ) : (
          <span className="tools-tree-bullet">·</span>
        )}
        <span
          className={`tools-tree-label${hasChildren ? " clickable" : ""}${prominent ? " lead" : ""}`}
          title={titleText}
          onClick={hasChildren ? onToggle : undefined}
        >
          {label}
        </span>
        {href && (
          <a className="tools-tree-link" href={href} target="_blank" rel="noreferrer" title={href}>
            ↗
          </a>
        )}
        {count != null && <span className="tools-chip-count">{count}</span>}
        {action}
      </div>
      {open && hasChildren && <div className="tools-tree-children">{children}</div>}
    </li>
  );
}

/** Editor for a repository's own record: the GEDCOM repository fields —
 *  name, postal address, phone, e-mail, link and note. */
function RepoEditDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: EditRepoFields;
  onSave: (fields: EditRepoFields) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [fields, setFields] = useState<EditRepoFields>(initial);
  const set = (key: keyof EditRepoFields) => (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal add-source-dialog" role="dialog" aria-modal="true" aria-label={t("editRepo.title")} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            <span className="add-source-badge" aria-hidden="true">🏛</span>
            {t("editRepo.title")}
          </h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>×</button>
        </div>
        <div className="modal-body">
          <label className="add-source-field">
            <span>{t("editRepo.name")}</span>
            <input className="edit-input" autoFocus value={fields.name ?? ""} onChange={set("name")} />
          </label>
          <label className="add-source-field">
            <span>{t("editRepo.addr")}</span>
            <textarea className="edit-input add-source-textarea" rows={2} value={fields.addr ?? ""} onChange={set("addr")} />
          </label>
          <div className="add-source-details-grid">
            <label className="add-source-field">
              <span>{t("editRepo.phone")}</span>
              <input className="edit-input" value={fields.phone ?? ""} onChange={set("phone")} />
            </label>
            <label className="add-source-field">
              <span>{t("editRepo.email")}</span>
              <input className="edit-input" value={fields.email ?? ""} onChange={set("email")} />
            </label>
          </div>
          <label className="add-source-field">
            <span>{t("addSource.field.url")}</span>
            <input className="edit-input" value={fields.url ?? ""} onChange={set("url")} />
          </label>
          <label className="add-source-field">
            <span>{t("addSource.field.note")}</span>
            <input className="edit-input" value={fields.note ?? ""} onChange={set("note")} />
          </label>
        </div>
        <div className="add-source-actions">
          <button className="tree-open-btn" onClick={onClose}>{t("addSource.cancel")}</button>
          <button className="add-source-submit" onClick={() => onSave(fields)}>
            {t("editSource.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Keep media whose title/xref/file matches `q`. */
const mediaMatches = (m: MediaEntry, q: string) => someMatch(q, m.title, m.xref, m.file, m.url);

/** Keep sources whose own fields, or any of their media, match `q`. */
const sourceMatches = (src: SourceEntry, q: string) =>
  someMatch(q, src.title, src.xref, src.filingNumber, src.tooltip) ||
  src.media.some((m) => mediaMatches(m, q));

/** Prune the repo list to those matching `q` (whole subtree kept on a repo-level
 * match; otherwise only matching sources are retained). Repos/sources that
 * survive solely as ancestors of a deeper match are collected in `openRepos` /
 * `openSources` so they expand down to (not past) the matching entries. */
function filterRepos(repos: RepoGroup[], q: string): {
  repos: RepoGroup[];
  openRepos: Set<RepoGroup>;
  openSources: Set<SourceEntry>;
} {
  const out: RepoGroup[] = [];
  const openRepos = new Set<RepoGroup>();
  const openSources = new Set<SourceEntry>();
  for (const repo of repos) {
    if (someMatch(q, repo.name, repo.xref, repo.tooltip)) {
      out.push(repo);
      continue;
    }
    const sources = repo.sources.filter((s) => sourceMatches(s, q));
    if (sources.length === 0) continue;
    const kept = { ...repo, sources };
    out.push(kept);
    openRepos.add(kept);
    for (const s of sources) {
      // Source kept only because one of its media matched → open it to reveal that medium.
      if (!someMatch(q, s.title, s.xref, s.filingNumber, s.tooltip)) openSources.add(s);
    }
  }
  return { repos: out, openRepos, openSources };
}

/** Keys to also open below a source that funnels into a single medium with no
 * citations of its own. */
function srcDescendants(src: SourceEntry): string[] {
  return src.media.length === 1 && src.usedBy.length === 0 ? [`m:${src.media[0].xref}`] : [];
}

/** Keys to also open below a repo that holds exactly one source (drilling on
 * through that source's own single-child chain). */
function repoDescendants(repo: RepoGroup): string[] {
  if (repo.sources.length !== 1) return [];
  const src = repo.sources[0];
  return [`s:${src.xref}`, ...srcDescendants(src)];
}

/** Keys to open on first load so the tree expands down to the first level that
 *  offers a choice: when there is a single top-level entry (e.g. only the "No
 *  repository" bucket), open it and drill on through any single-child chain. */
function initialSourceOpen(tree: SourceTree): Set<string> {
  const open = new Set<string>();
  const hasLinks = tree.unattachedLinks.length > 0;
  const hasMedia = tree.unattachedMedia.length > 0;
  const topCount = tree.repos.length + (hasLinks ? 1 : 0) + (hasMedia ? 1 : 0);
  if (topCount !== 1) return open;
  if (tree.repos.length === 1) {
    const repo = tree.repos[0];
    open.add(`r:${repo.xref ?? "none"}`);
    for (const k of repoDescendants(repo)) open.add(k);
  } else if (hasLinks) {
    open.add("unattachedLinks");
  } else if (hasMedia) {
    open.add("unattached");
  }
  return open;
}

export function SourcesPanel({
  dataset,
  scans,
  fileName,
  onNavigate,
  onAddSource,
  onEditSource,
  onRemoveSource,
  onEditRepo,
  onEditMediaInfo,
  active,
}: {
  dataset: Dataset;
  scans: ToolsScans;
  fileName: string;
  onNavigate: (id: string) => void;
  /** Create a standalone `SOUR` record (cited by nothing yet) from the Add
   * Source dialog's confirmed fields — an undoable whole-file edit. */
  onAddSource: (fields: AddSourceResult) => void;
  /** Write edited fields to an existing `SOUR` record — an undoable whole-file edit. */
  onEditSource: (sourceXref: string, fields: EditSourceFields) => void;
  /** Delete an uncited `SOUR` record (and its orphaned page media). */
  onRemoveSource: (sourceXref: string) => void;
  /** Write a `REPO` record's fields — an undoable whole-file edit. */
  onEditRepo: (repoXref: string, fields: EditRepoFields) => void;
  /** Write the viewer-edited fields of a shared `OBJE` record — an undoable
   * whole-file edit. */
  onEditMediaInfo: (objeXref: string, fields: MediaEditFields) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<SourceTree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [editSrc, setEditSrc] = useState<SourceEntry | null>(null);
  const [editRepo, setEditRepo] = useState<RepoGroup | null>(null);
  const [query, setQuery] = useState("");
  // Switches the panel body between the containment tree and the cleanup tool.
  const [view, setView] = useState<"tree" | "cleanup">("tree");
  const { settings } = useSettings();
  // Scanned automatically (in the tools worker) so the toggles can show their
  // counts; cached at the ToolsView level so revisits don't re-scan.
  const dupReport = scans.sourceDuplicates.status === "done" ? scans.sourceDuplicates.result : null;
  const reshapeReport = scans.sourceReshape.status === "done" ? scans.sourceReshape.result : null;

  useEffect(() => {
    setTree(null);
    setOpen(new Set());
    setQuery("");
    setView("tree");
    setAddOpen(false);
    setEditSrc(null);
    setEditRepo(null);
  }, [dataset]);

  useEffect(() => {
    if (active && !tree) {
      const built = buildSourceTree(dataset);
      setTree(built);
      setOpen(initialSourceOpen(built));
    }
  }, [active, tree, dataset]);

  // The reshape report depends on the format overrides — the fingerprint in
  // the deps re-checks freshness when the user changes them mid-session.
  const fmt = settings.formatOverrides;
  const reshapeSalt = `${fmt.pageMedia ?? ""}|${fmt.sourceLayout ?? ""}|${fmt.baptism ?? ""}|${fmt.doubledLinks ?? ""}`;
  useEffect(() => {
    // Fresh, not just ensured: the cleanup view applies against the live
    // records, so a report cached before in-place edits must not drive it.
    if (active) {
      scans.ensureFresh("sourceDuplicates");
      scans.ensureFresh("sourceReshape");
    }
  }, [active, scans, reshapeSalt]);

  const dupCount = dupReport?.groups.length ?? 0;
  const reshapeCount = reshapeReport?.groups.length ?? 0;

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Expand `key` and, unless it's already open, also open its single-child
  // chain so one click drills down to the first branching level.
  const openWith = (key: string, descendants: string[]) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      next.add(key);
      for (const k of descendants) next.add(k);
      return next;
    });

  // Refresh the containment tree after this panel's own add/edit/remove —
  // the dataset mutates in place, so the [dataset] reset never fires for it.
  // Rebuilt in place, keeping the expanded rows and scroll position: nulling
  // the tree instead would flash the loading state and collapse everything
  // back to the initial view mid-work.
  const closeDialog = () => {
    setAddOpen(false);
    setEditSrc(null);
    setEditRepo(null);
  };
  const refreshTree = useCallback(() => setTree(buildSourceTree(dataset)), [dataset]);

  // Viewer edits change the tree's labels (title/date) — refresh it after the
  // commit. The open viewer keeps its own resolved items and stays up.
  const editMediaInfo = (objeXref: string, fields: MediaEditFields) => {
    onEditMediaInfo(objeXref, fields);
    refreshTree();
  };

  // The viewer's in-sources list jumps back to the tree filtered to that
  // source — the search expands ancestors down to the match.
  const showSource = (title: string) => setQuery(title);

  // Memoized so the dialog's prefill effect fires once per opened source, not
  // on every panel render (a fresh `editing` object would clobber typing).
  const editing = useMemo(() => {
    if (!editSrc) return undefined;
    const node = dataset.records.find((r) => r.tag === "SOUR" && r.xref === editSrc.xref);
    if (!node) return undefined;
    return {
      fields: sourceRecordEditFields(dataset.records, node),
      onSave: (fields: EditSourceFields) => {
        onEditSource(editSrc.xref, fields);
        closeDialog();
        refreshTree();
      },
      // Remove only for a source nothing cites — deleting a cited record
      // would leave its citations dangling.
      ...(editSrc.usedBy.length === 0
        ? {
            onRemove: () => {
              onRemoveSource(editSrc.xref);
              closeDialog();
              refreshTree();
            },
          }
        : {}),
    };
  }, [editSrc, dataset, onEditSource, onRemoveSource, refreshTree]);

  // Prefill for the repository editor, read from the live record.
  const repoEditInitial = useMemo(() => {
    if (!editRepo?.xref) return undefined;
    const node = dataset.records.find((r) => r.tag === "REPO" && r.xref === editRepo.xref);
    return node ? repoRecordEditFields(dataset.records, node) : undefined;
  }, [editRepo, dataset]);

  const q = useDebounced(query).trim().toLowerCase();
  const filtering = q.length > 0;

  const filtered = useMemo(() => {
    if (!tree) return null;
    if (!filtering) return { tree, openRepos: new Set<RepoGroup>(), openSources: new Set<SourceEntry>() };
    const { repos, openRepos, openSources } = filterRepos(tree.repos, q);
    return {
      tree: {
        ...tree,
        repos,
        unattachedLinks: tree.unattachedLinks.filter((m) => mediaMatches(m, q)),
        unattachedMedia: tree.unattachedMedia.filter((m) => mediaMatches(m, q)),
      },
      openRepos,
      openSources,
    };
  }, [tree, filtering, q]);

  // Filtering expands ancestors down to (not past) the matches; the user expands further.
  const isOpen = (key: string) => open.has(key);

  if (view === "cleanup" && (dupReport || reshapeReport))
    return (
      <SourceCleanupView
        reshapeReport={reshapeReport}
        dupReport={dupReport}
        dataset={dataset}
        fileName={fileName}
        onNavigate={onNavigate}
        onBack={() => setView("tree")}
        active={active}
      />
    );

  if (!tree || !filtered) return <ToolsLoading label={t("tools.running")} />;

  const empty =
    filtered.tree.repos.length === 0 &&
    filtered.tree.unattachedLinks.length === 0 &&
    filtered.tree.unattachedMedia.length === 0;

  const unattachedGroup = (key: string, labelKey: string, icon: string, entries: typeof tree.unattachedMedia) => {
    if (entries.length === 0) return false;
    return (
      <TreeRow
        open={isOpen(key) || filtering}
        onToggle={() => toggle(key)}
        hasChildren
        count={entries.length}
        label={t(labelKey)}
      >
        <ul className="tools-tree">
          <MediaRows
            entries={entries}
            dataset={dataset}
            onNavigate={onNavigate}
            onEditMediaInfo={editMediaInfo}
            onShowSource={showSource}
            isOpen={isOpen}
            toggle={toggle}
            rowKey={(m) => `${key}:${m.xref}`}
            iconFor={() => icon}
          />
        </ul>
      </TreeRow>
    );
  };

  return (
    <>
      <div className="tools-filter-row">
        <TreeSearch value={query} onChange={setQuery} />
        <div className="tools-chip-group">
          <button className="tools-chip" onClick={() => setAddOpen(true)}>
            ＋ {t("tools.sources.add")}
          </button>
          <ScanChip
            label={t("tools.sources.cleanupToggle")}
            status={combinedScanStatus(scans.sourceDuplicates.status, scans.sourceReshape.status)}
            count={dupCount + reshapeCount}
            hint={t("tools.sources.cleanupChipHint", {
              links: reshapeReport?.totalOccurrences ?? 0,
              groups: reshapeCount,
              dups: dupCount,
            })}
            onOpen={() => setView("cleanup")}
          />
        </div>
        <ToolSummary>
          {t("tools.sources.summary", {
            repos: tree.repoCount,
            sources: tree.sourceCount,
            media: tree.mediaCount,
          })}
        </ToolSummary>
      </div>
      {empty ? (
        <p className="tools-clean">{filtering ? t("tools.search.noMatch") : t("tools.sources.none")}</p>
      ) : (
        <ul className="tools-tree">
          {filtered.tree.repos.map((repo) => {
            // Keyed by xref alone (unique; one synthetic no-repo bucket), so a
            // repo stays open across rebuilds even when sorting moves it.
            const repoKey = `r:${repo.xref ?? "none"}`;
            return (
              <TreeRow
                key={repoKey}
                open={isOpen(repoKey) || filtered.openRepos.has(repo)}
                onToggle={() => openWith(repoKey, repoDescendants(repo))}
                hasChildren={repo.sources.length > 0}
                count={repo.sources.length}
                href={repo.url}
                titleText={repo.tooltip || repo.xref}
                prominent
                action={
                  repo.xref ? (
                    <button
                      className="tools-place-edit-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditRepo(repo);
                      }}
                      title={t("editRepo.title")}
                    >
                      ✎
                    </button>
                  ) : undefined
                }
                label={repo.xref ? repo.name || repo.xref : t("tools.sources.noRepo")}
              >
                <ul className="tools-tree">
                  {repo.sources.map((src) => {
                    const srcKey = `s:${src.xref}`;
                    const hasKids = src.media.length > 0 || src.usedBy.length > 0;
                    return (
                      <TreeRow
                        key={srcKey}
                        open={isOpen(srcKey) || filtered.openSources.has(src)}
                        onToggle={() => openWith(srcKey, srcDescendants(src))}
                        hasChildren={hasKids}
                        count={src.usedBy.length}
                        titleText={src.tooltip || src.xref}
                        action={
                          <button
                            className="tools-place-edit-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditSrc(src);
                            }}
                            title={t("editSource.title")}
                          >
                            ✎
                          </button>
                        }
                        label={
                          <>
                            {src.title || src.xref}
                            {src.filingNumber && (
                              <span className="tools-tree-meta"> · {src.filingNumber}</span>
                            )}
                          </>
                        }
                      >
                        <MediaRows
                          entries={src.media}
                          dataset={dataset}
                          onNavigate={onNavigate}
                          onEditMediaInfo={editMediaInfo}
                          onShowSource={showSource}
                          isOpen={isOpen}
                          toggle={toggle}
                          rowKey={(m) => `m:${m.xref}`}
                          iconFor={(m) => (m.url ? "🔗" : "🖼")}
                        />
                        {src.usedBy.length > 0 && (
                          <div className="tools-usage-block">
                            <UsageList dataset={dataset} uses={src.usedBy} onNavigate={onNavigate} />
                          </div>
                        )}
                      </TreeRow>
                    );
                  })}
                </ul>
              </TreeRow>
            );
          })}
          {unattachedGroup("unattachedLinks", "tools.sources.unattachedLinks", "🔗", filtered.tree.unattachedLinks)}
          {unattachedGroup("unattached", "tools.sources.unattached", "🖼", filtered.tree.unattachedMedia)}
        </ul>
      )}
      <AddSourceDialog
        isOpen={addOpen || editing !== undefined}
        onClose={closeDialog}
        onAdd={(fields) => {
          onAddSource(fields);
          closeDialog();
          refreshTree(); // rebuilt (now including the new record) by the active-panel effect
        }}
        dataset={dataset}
        t={t}
        editing={editing}
        standalone
      />
      {editRepo?.xref && repoEditInitial && (
        <RepoEditDialog
          key={editRepo.xref}
          initial={repoEditInitial}
          onClose={closeDialog}
          onSave={(fields) => {
            onEditRepo(editRepo.xref!, fields);
            closeDialog();
            refreshTree();
          }}
        />
      )}
    </>
  );
}

type ScanStatus = "idle" | "running" | "cancelled" | "error" | "done";

/** The cleanup chip: spinner while either scan is still coming, usable as soon
 *  as at least one scan delivered (a failure of one must not take out the
 *  other's tool), hidden only when neither produced a report. */
function combinedScanStatus(a: ScanStatus, b: ScanStatus): ScanStatus {
  if (a === "done" && b === "done") return "done";
  if (a === "running" || a === "idle" || b === "running" || b === "idle") return "running";
  return a === "done" || b === "done" ? "done" : "error";
}

/** Sub-tool chip in the Sources header: a spinner while its whole-file scan is
 *  still running (so the button's spot is visible immediately), the count once
 *  done, nothing when the scan found no work (or failed). */
function ScanChip({
  label,
  status,
  count,
  hint,
  onOpen,
}: {
  label: string;
  status: "idle" | "running" | "cancelled" | "error" | "done";
  count: number;
  /** Breakdown of what the count is made of, shown as the chip's tooltip. */
  hint?: string;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  if (status === "done" && count === 0) return null;
  if (status === "error" || status === "cancelled") return null;
  const pending = status !== "done";
  return (
    <button
      className="tools-chip tools-dup-toggle"
      onClick={onOpen}
      disabled={pending}
      title={pending ? t("tools.running") : hint}
    >
      {label}{" "}
      {pending ? <span className="spinner" aria-hidden="true" /> : <span className="tools-chip-count">{count}</span>}
    </button>
  );
}

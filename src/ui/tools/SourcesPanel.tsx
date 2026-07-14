import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import { buildSourceTree, type SourceTree, type RepoGroup, type SourceEntry, type MediaEntry } from "../../tools/sources";
import { MediaThumb, type MediaGalleryItem } from "../PersonMedia";
import { mediaMetaRows } from "../MediaViewer";
import { type ToolsScans } from "../useToolsScans";
import { ToolsLoading, TreeSearch, UsageList, someMatch, useDebounced } from "./shared";
import { SourceCleanupView } from "./SourceCleanupView";

/** Lightbox side panel for a media object: the person/family records that
 *  reference the image (the descriptive caption rows are supplied separately as
 *  the photo's `meta`). `onNavigate` closes the lightbox before jumping to the
 *  record in Edit mode. */
function MediaDetails({
  dataset,
  media,
  onNavigate,
}: {
  dataset: Dataset;
  media: MediaEntry;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
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
    </>
  );
}

/**
 * One `TreeRow` per `MediaEntry` in a group (a source's media, or an unattached
 * bucket). The group's local-file photos form a single navigable tray: each
 * thumbnail opens the viewer on its own photo with prev/next across the
 * siblings. URL-only entries show `iconFor(m)` instead. The tray (and each
 * photo's index in it) is computed once for the whole group.
 */
function MediaRows({
  entries,
  dataset,
  onNavigate,
  isOpen,
  toggle,
  rowKey,
  iconFor,
}: {
  entries: MediaEntry[];
  dataset: Dataset;
  onNavigate: (id: string) => void;
  isOpen: (key: string) => boolean;
  toggle: (key: string) => void;
  rowKey: (m: MediaEntry) => string;
  iconFor: (m: MediaEntry) => string;
}) {
  const { t } = useTranslation();
  const { items, indexOf } = useMemo(() => {
    const photos = entries.filter((m) => !m.url && m.file);
    const items: MediaGalleryItem[] = photos.map((m) => ({
      file: m.file!,
      title: m.title || m.xref,
      meta: mediaMetaRows(m, t),
      details: (close: () => void) => (
        <MediaDetails dataset={dataset} media={m} onNavigate={(id) => { close(); onNavigate(id); }} />
      ),
    }));
    return { items, indexOf: new Map(photos.map((m, i) => [m, i] as const)) };
  }, [entries, dataset, onNavigate, t]);

  return (
    <>
      {entries.map((m) => {
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
      </div>
      {open && hasChildren && <div className="tools-tree-children">{children}</div>}
    </li>
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
    open.add(`r:${repo.xref ?? "none"}:0`);
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
  active,
}: {
  dataset: Dataset;
  scans: ToolsScans;
  fileName: string;
  onNavigate: (id: string) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<SourceTree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  // Switches the panel body between the containment tree and the cleanup tool.
  const [view, setView] = useState<"tree" | "cleanup">("tree");
  // Scanned automatically (in the tools worker) so the toggles can show their
  // counts; cached at the ToolsView level so revisits don't re-scan.
  const dupReport = scans.sourceDuplicates.status === "done" ? scans.sourceDuplicates.result : null;
  const reshapeReport = scans.sourceReshape.status === "done" ? scans.sourceReshape.result : null;

  useEffect(() => {
    setTree(null);
    setOpen(new Set());
    setQuery("");
    setView("tree");
  }, [dataset]);

  useEffect(() => {
    if (active && !tree) {
      const built = buildSourceTree(dataset);
      setTree(built);
      setOpen(initialSourceOpen(built));
    }
  }, [active, tree, dataset]);

  useEffect(() => {
    if (active) {
      scans.ensure("sourceDuplicates");
      scans.ensure("sourceReshape");
    }
  }, [active, scans]);

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

  if (view === "cleanup" && dupReport && reshapeReport)
    return (
      <SourceCleanupView
        reshapeReport={reshapeReport}
        dupReport={dupReport}
        dataset={dataset}
        fileName={fileName}
        onBack={() => setView("tree")}
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
          <ScanChip
            label={t("tools.sources.cleanupToggle")}
            status={combinedScanStatus(scans.sourceDuplicates.status, scans.sourceReshape.status)}
            count={dupCount + reshapeCount}
            onOpen={() => setView("cleanup")}
          />
        </div>
        <p className="tools-summary">
          {t("tools.sources.summary", {
            repos: tree.repoCount,
            sources: tree.sourceCount,
            media: tree.mediaCount,
          })}
        </p>
      </div>
      {empty ? (
        <p className="tools-clean">{filtering ? t("tools.search.noMatch") : t("tools.sources.none")}</p>
      ) : (
        <ul className="tools-tree">
          {filtered.tree.repos.map((repo, ri) => {
            const repoKey = `r:${repo.xref ?? "none"}:${ri}`;
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
    </>
  );
}

type ScanStatus = "idle" | "running" | "cancelled" | "error" | "done";

/** The cleanup chip waits for both of its scans; a failure of either hides it. */
function combinedScanStatus(a: ScanStatus, b: ScanStatus): ScanStatus {
  if (a === "error" || b === "error" || a === "cancelled" || b === "cancelled") return "error";
  return a === "done" && b === "done" ? "done" : "running";
}

/** Sub-tool chip in the Sources header: a spinner while its whole-file scan is
 *  still running (so the button's spot is visible immediately), the count once
 *  done, nothing when the scan found no work (or failed). */
function ScanChip({
  label,
  status,
  count,
  onOpen,
}: {
  label: string;
  status: "idle" | "running" | "cancelled" | "error" | "done";
  count: number;
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
      title={pending ? t("tools.running") : undefined}
    >
      {label}{" "}
      {pending ? <span className="spinner" aria-hidden="true" /> : <span className="tools-chip-count">{count}</span>}
    </button>
  );
}

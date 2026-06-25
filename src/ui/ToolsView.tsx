import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import { validateDataset, type ValidationReport, type IssueCategory } from "../tools/validate";
import { findDuplicates, type DuplicatePair } from "../tools/duplicates";
import { bulkNormalize } from "../tools/bulkNormalize";
import { buildSourceTree, type SourceTree, type SourceUse, type RepoGroup, type SourceEntry, type MediaEntry } from "../tools/sources";
import { buildPlaceTree, type PlaceNode, type PlaceTree, UNSPECIFIED, UNSPECIFIED_PLACE } from "../tools/places";
import { collectPlaceSegments, previewPlaceRename, type PlaceRenamePreview } from "../tools/placeEdit";
import { collectNodeUseIds } from "../tools/places";
import { countryCode } from "../gedcom/countryCode";
import { serializeGedcom } from "../gedcom/serialize";
import { downloadText } from "./download";
import { individualFieldRows } from "../review/fields";
import { ReadOnlyCompare, type PersonNav } from "./ReadOnlyCompare";
import { PersonLink } from "./PersonLink";
import { MediaThumb, type MediaGalleryItem } from "./PersonPhotos";

type Tool = "validate" | "duplicates" | "normalize" | "sources" | "places";

const TOOLS: Tool[] = ["validate", "duplicates", "normalize", "sources", "places"];

/** Max issue rows rendered at once — keeps an unvirtualized list responsive on
 *  files with thousands of findings; the rest are summarized as "…and N more". */
const MAX_ROWS = 1000;

interface Props {
  /** The live master dataset — every tool operates on the whole file. */
  dataset: Dataset;
  /** Master file name, used to name the normalized download. */
  fileName: string;
  /** Jump to a person/family record in Edit mode. */
  onNavigate: (id: string) => void;
  /** True when the Tools tab is the visible mode. */
  active: boolean;
  /** Rename a place segment in the given records and push to the undo stack. */
  onApplyPlaceRename: (from: string, to: string, scope: Set<string>) => void;
}

type AsyncState<T> =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: T };

/** Let React paint the "working…" state before a blocking computation runs. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function ToolsView({ dataset, fileName, onNavigate, active, onApplyPlaceRename }: Props) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<Tool>("validate");

  return (
    <div className="tools-view">
      <div className="tools-head">
        <h2 className="tools-title">{t("tools.title")}</h2>
        <p className="tools-subtitle">{t("tools.subtitle")}</p>
      </div>
      <div className="tools-subtabs" role="tablist">
        {TOOLS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tool === id}
            className={`tools-tab ${tool === id ? "active" : ""}`}
            onClick={() => setTool(id)}
          >
            <span className="tools-tab-label">{t(`tools.tool.${id}`)}</span>
            <span className="tools-tab-desc">{t(`tools.tool.${id}.desc`)}</span>
          </button>
        ))}
      </div>
      <div className="tools-panel">
        {tool === "validate" && (
          <ValidatePanel dataset={dataset} onNavigate={onNavigate} active={active} />
        )}
        {tool === "duplicates" && (
          <DuplicatesPanel dataset={dataset} onNavigate={onNavigate} />
        )}
        {tool === "normalize" && (
          <NormalizePanel dataset={dataset} fileName={fileName} />
        )}
        {tool === "sources" && (
          <SourcesPanel dataset={dataset} onNavigate={onNavigate} active={active} />
        )}
        {tool === "places" && (
          <PlacesPanel dataset={dataset} onNavigate={onNavigate} active={active} onApplyPlaceRename={onApplyPlaceRename} />
        )}
      </div>
    </div>
  );
}

// ── Validation ─────────────────────────────────────────────────────────────

const CATEGORIES: IssueCategory[] = [
  "brokenLink",
  "deathBeforeBirth",
  "futureDate",
  "missingVitals",
  "missingName",
  "missingSex",
  "orphan",
];

function ValidatePanel({
  dataset,
  onNavigate,
  active,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  // Only compute once the tab is actually shown, then memoize per dataset.
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [filter, setFilter] = useState<IssueCategory | "all">("all");

  useEffect(() => {
    setReport(null);
    setFilter("all");
  }, [dataset]);

  useEffect(() => {
    if (active && !report) setReport(validateDataset(dataset));
  }, [active, report, dataset]);

  const shown = useMemo(() => {
    if (!report) return [];
    return filter === "all" ? report.issues : report.issues.filter((i) => i.category === filter);
  }, [report, filter]);

  if (!report) return <div className="tools-loading">{t("tools.running")}</div>;

  const total = report.issues.length;
  return (
    <>
      <p className="tools-summary">
        {t("tools.validate.summary", { indi: report.individualCount, fam: report.familyCount })}
      </p>
      {total === 0 ? (
        <p className="tools-clean">{t("tools.validate.clean")}</p>
      ) : (
        <>
          <div className="tools-chips">
            <button
              className={`tools-chip ${filter === "all" ? "active" : ""}`}
              onClick={() => setFilter("all")}
            >
              {t("tools.validate.all")} <span className="tools-chip-count">{total}</span>
            </button>
            {CATEGORIES.filter((c) => report.counts[c] > 0).map((c) => (
              <button
                key={c}
                className={`tools-chip ${filter === c ? "active" : ""}`}
                onClick={() => setFilter(c)}
              >
                {t(`tools.validate.cat.${c}`)} <span className="tools-chip-count">{report.counts[c]}</span>
              </button>
            ))}
          </div>
          <ul className="tools-issues">
            {shown.slice(0, MAX_ROWS).map((issue, i) => (
              <li key={`${issue.id}-${issue.category}-${i}`} className={`tools-issue sev-${issue.severity}`}>
                <PersonLink dataset={dataset} id={issue.id} fallback={issue.subject} onNavigate={onNavigate} />
                <span className="tools-issue-msg">{t(issue.messageKey, issue.messageVars)}</span>
              </li>
            ))}
          </ul>
          {shown.length > MAX_ROWS && (
            <p className="tools-more">{t("tools.validate.more", { count: shown.length - MAX_ROWS })}</p>
          )}
        </>
      )}
    </>
  );
}

// ── Duplicates ───────────────────────────────────────────────────────────────

function DuplicatesPanel({
  dataset,
  onNavigate,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<AsyncState<DuplicatePair[]>>({ status: "idle" });
  // Pair whose side-by-side comparison is expanded inline, keyed "aId-bId".
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setState({ status: "idle" });
    setExpanded(null);
  }, [dataset]);

  async function run() {
    setState({ status: "running" });
    setExpanded(null);
    await nextTick();
    setState({ status: "done", result: findDuplicates(dataset) });
  }

  return (
    <>
      <p className="tools-intro">{t("tools.duplicates.intro")}</p>
      <button className="nav-btn primary tools-run" onClick={run} disabled={state.status === "running"}>
        {state.status === "running" ? t("tools.running") : t("tools.duplicates.run")}
      </button>
      {state.status === "done" && (
        state.result.length === 0 ? (
          <p className="tools-clean">{t("tools.duplicates.none")}</p>
        ) : (
          <>
            <p className="tools-summary">{t("tools.duplicates.found", { count: state.result.length })}</p>
            <ul className="tools-pairs">
              {state.result.map((p) => {
                const key = `${p.aId}-${p.bId}`;
                const open = expanded === key;
                return (
                  <li key={key} className="tools-pair">
                    <div className="tools-pair-row">
                      <button
                        className={`tools-pair-toggle ${open ? "open" : ""}`}
                        onClick={() => setExpanded(open ? null : key)}
                        title={open ? t("tools.duplicates.hideCompare") : t("tools.duplicates.showCompare")}
                        aria-expanded={open}
                      >
                        ▶
                      </button>
                      <span className={`tools-cat cat-${p.category}`}>{Math.round(p.score)}</span>
                      <PersonLink dataset={dataset} id={p.aId} fallback={p.aLabel} onNavigate={onNavigate} />
                      <span className="tools-pair-sep">↔</span>
                      <PersonLink dataset={dataset} id={p.bId} fallback={p.bLabel} onNavigate={onNavigate} />
                    </div>
                    {open && (
                      <DuplicateCompare
                        dataset={dataset}
                        pair={p}
                        onNavigate={onNavigate}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )
      )}
    </>
  );
}

/** Read-only side-by-side field comparison of one duplicate pair — both records
 *  live in the same master dataset, so each column navigates into Edit mode. */
function DuplicateCompare({
  dataset,
  pair,
  onNavigate,
}: {
  dataset: Dataset;
  pair: DuplicatePair;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const a = dataset.individuals.get(pair.aId);
  const b = dataset.individuals.get(pair.bId);
  const rows = useMemo(
    () => individualFieldRows(t, a, b, dataset, dataset),
    [t, a, b, dataset],
  );
  const nav: PersonNav = {
    linkable: (id) => dataset.individuals.has(id),
    onNavigate,
  };
  return (
    <div className="tools-pair-compare">
      <ReadOnlyCompare
        rows={rows}
        masterPerson={nav}
        incomingPerson={nav}
        masterLabel={pair.aLabel}
        incomingLabel={pair.bLabel}
        hideHeader
      />
    </div>
  );
}

// ── Bulk normalize ───────────────────────────────────────────────────────────

function NormalizePanel({ dataset, fileName }: { dataset: Dataset; fileName: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<AsyncState<{ dataset: Dataset; report: NormalizationReport }>>({ status: "idle" });
  // Which passes the user wants applied on download; the preview report above
  // always reflects all three so the counts show what each would change.
  const [selected, setSelected] = useState<NormalizeOptions>({ dates: true, places: true, links: true });

  useEffect(() => {
    setState({ status: "idle" });
    setSelected({ dates: true, places: true, links: true });
  }, [dataset]);

  async function run() {
    setState({ status: "running" });
    await nextTick();
    setState({ status: "done", result: bulkNormalize(dataset) });
  }

  function download() {
    // Re-run with only the selected passes so the download honors the checkboxes.
    const { dataset: out } = bulkNormalize(dataset, selected);
    const base = fileName.replace(/\.ged$/i, "");
    const text = serializeGedcom(out.records, {
      eol: dataset.eol,
      finalNewline: dataset.finalNewline,
    });
    downloadText(`${base}.normalized.ged`, text);
  }

  return (
    <>
      <p className="tools-intro">{t("tools.normalize.intro")}</p>
      <button className="nav-btn primary tools-run" onClick={run} disabled={state.status === "running"}>
        {state.status === "running" ? t("tools.running") : t("tools.normalize.run")}
      </button>
      {state.status === "done" && (() => {
        const { report } = state.result;
        const changed = report.datesChanged + report.placesReshaped + report.linksConverted;
        if (changed === 0) return <p className="tools-clean">{t("tools.normalize.none")}</p>;
        const counts = {
          dates: report.datesChanged,
          places: report.placesReshaped,
          links: report.linksConverted,
        };
        const toggle = (key: keyof NormalizeOptions) =>
          setSelected((s) => ({ ...s, [key]: !s[key] }));
        // Selected sum guards the download: only passes that are both checked
        // and actually change something count toward "anything to apply".
        const selectedChanges =
          (selected.dates ? counts.dates : 0) +
          (selected.places ? counts.places : 0) +
          (selected.links ? counts.links : 0);
        return (
          <>
            <ul className="tools-norm-summary">
              <NormCheck label={t("tools.normalize.dates", { count: counts.dates })}
                checked={selected.dates} count={counts.dates} onChange={() => toggle("dates")} />
              <NormCheck label={t("tools.normalize.places", { count: counts.places })}
                checked={selected.places} count={counts.places} onChange={() => toggle("places")} />
              <NormCheck label={t("tools.normalize.links", { count: counts.links })}
                checked={selected.links} count={counts.links} onChange={() => toggle("links")} />
            </ul>
            {selected.dates && <NormExamples title={t("tools.normalize.exDates")} examples={report.dateExamples} />}
            {selected.places && <NormExamples title={t("tools.normalize.exPlaces")} examples={report.placeExamples} />}
            {selected.links && <NormExamples title={t("tools.normalize.exLinks")} examples={report.linkExamples} />}
            <button className="nav-btn tools-run" onClick={download} disabled={selectedChanges === 0}>
              {t("tools.normalize.download")}
            </button>
          </>
        );
      })()}
    </>
  );
}

/** One selectable normalization-count row: a checkbox in front of the count.
 *  Passes with nothing to change are disabled — there is nothing to opt into. */
function NormCheck({
  label,
  checked,
  count,
  onChange,
}: {
  label: string;
  checked: boolean;
  count: number;
  onChange: () => void;
}) {
  return (
    <li>
      <label className={`tools-norm-check ${count === 0 ? "disabled" : ""}`}>
        <input type="checkbox" checked={checked && count > 0} disabled={count === 0} onChange={onChange} />
        <span>{label}</span>
      </label>
    </li>
  );
}

function NormExamples({ title, examples }: { title: string; examples: { before: string; after: string }[] }) {
  if (!examples.length) return null;
  return (
    <div className="tools-examples">
      <div className="tools-examples-title">{title}</div>
      <ul>
        {examples.map((e, i) => (
          <li key={i}>
            <span className="tools-ex-from">{e.before}</span>
            <span className="tools-pair-sep">→</span>
            <span className="tools-ex-to">{e.after}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Shared usage list ────────────────────────────────────────────────────────

/** Records that cite a source/media or use a place; each navigates into Edit. */
function UsageList({ dataset, uses, onNavigate }: { dataset: Dataset; uses: SourceUse[]; onNavigate: (id: string) => void }) {
  const { t } = useTranslation();
  if (uses.length === 0) return null;
  return (
    <ul className="tools-usage">
      {uses.slice(0, MAX_ROWS).map((u, i) => (
        <li key={`${u.persons.map((p) => p.id).join("-")}-${i}`}>
          {u.persons.map((p, j) => (
            <span key={p.id}>
              {j > 0 && <span className="tools-usage-amp">&amp;</span>}
              <PersonLink dataset={dataset} id={p.id} fallback={p.label} onNavigate={onNavigate} />
            </span>
          ))}
        </li>
      ))}
      {uses.length > MAX_ROWS && (
        <li className="tools-more">{t("tools.validate.more", { count: uses.length - MAX_ROWS })}</li>
      )}
    </ul>
  );
}

/** Lightbox side panel for a media object: its record id/filename plus every
 *  person/family record that references the image. `onNavigate` closes the
 *  lightbox before jumping to the record in Edit mode. */
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
      {(media.file || media.date || media.place || media.description) && (
        <dl className="media-lightbox-meta">
          {media.date && (
            <div>
              <dt>{t("tools.sources.mediaDate")}</dt>
              <dd>{media.date}</dd>
            </div>
          )}
          {media.place && (
            <div>
              <dt>{t("tools.sources.mediaPlace")}</dt>
              <dd>{media.place}</dd>
            </div>
          )}
          {media.description && (
            <div>
              <dt>{t("tools.sources.mediaDesc")}</dt>
              <dd>{media.description}</dd>
            </div>
          )}
          {media.file && (
            <div>
              <dt>{t("tools.sources.mediaFile")}</dt>
              <dd>{media.file}</dd>
            </div>
          )}
        </dl>
      )}
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

/** A collapsible tree row: a ▶ toggle, a label, a usage count, and nested content. */
function TreeRow({
  open,
  onToggle,
  hasChildren,
  label,
  count,
  href,
  titleText,
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
        <span className="tools-tree-label" title={titleText}>{label}</span>
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

/** Returns `value` delayed by `delay` ms — updates only after typing pauses,
 * so the tree isn't re-filtered on every keystroke. */
function useDebounced<T>(value: T, delay = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

// ── Sources explorer ─────────────────────────────────────────────────────────

/** True when any of the strings contain `q` (already lower-cased). */
const someMatch = (q: string, ...vals: (string | undefined)[]) =>
  vals.some((v) => v?.toLowerCase().includes(q));

/** Keep media whose title/xref/file matches `q`. */
const mediaMatches = (m: MediaEntry, q: string) => someMatch(q, m.title, m.xref, m.file, m.url);

/** Keep sources whose own fields, or any of their media, match `q`. */
const sourceMatches = (src: SourceEntry, q: string) =>
  someMatch(q, src.title, src.xref, src.filingNumber, src.tooltip) ||
  src.media.some((m) => mediaMatches(m, q));

/** Prune the repo list to those matching `q` (whole subtree kept on a repo-level
 * match; otherwise only matching sources are retained). */
function filterRepos(repos: RepoGroup[], q: string): RepoGroup[] {
  const out: RepoGroup[] = [];
  for (const repo of repos) {
    if (someMatch(q, repo.name, repo.xref, repo.tooltip)) {
      out.push(repo);
      continue;
    }
    const sources = repo.sources.filter((s) => sourceMatches(s, q));
    if (sources.length > 0) out.push({ ...repo, sources });
  }
  return out;
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

function SourcesPanel({
  dataset,
  onNavigate,
  active,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<SourceTree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  useEffect(() => {
    setTree(null);
    setOpen(new Set());
    setQuery("");
  }, [dataset]);

  useEffect(() => {
    if (active && !tree) setTree(buildSourceTree(dataset));
  }, [active, tree, dataset]);

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
  // While filtering, every surviving branch is forced open so matches are visible.
  const isOpen = (key: string) => filtering || open.has(key);

  const filtered = useMemo(() => {
    if (!tree) return null;
    if (!filtering) return tree;
    return {
      ...tree,
      repos: filterRepos(tree.repos, q),
      unattachedLinks: tree.unattachedLinks.filter((m) => mediaMatches(m, q)),
      unattachedMedia: tree.unattachedMedia.filter((m) => mediaMatches(m, q)),
    };
  }, [tree, filtering, q]);

  // The local-file photos within a media group (a source's media, or an
  // unattached bucket), as a navigable tray for the viewer. URL-only links have
  // no thumbnail, so they're excluded; `photos.indexOf(m)` gives each photo's
  // tray position.
  const mediaGallery = (group: MediaEntry[]): { photos: MediaEntry[]; items: MediaGalleryItem[] } => {
    const photos = group.filter((m) => !m.url && m.file);
    const items = photos.map((m) => ({
      file: m.file!,
      title: m.title || m.xref,
      details: (close: () => void) => (
        <MediaDetails dataset={dataset} media={m} onNavigate={(id) => { close(); onNavigate(id); }} />
      ),
    }));
    return { photos, items };
  };

  if (!tree || !filtered) return <div className="tools-loading">{t("tools.running")}</div>;

  const empty =
    filtered.repos.length === 0 &&
    filtered.unattachedLinks.length === 0 &&
    filtered.unattachedMedia.length === 0;

  const unattachedGroup = (key: string, labelKey: string, icon: string, entries: typeof tree.unattachedMedia) => {
    if (entries.length === 0) return false;
    const { photos, items } = mediaGallery(entries);
    return (
      <TreeRow
        open={isOpen(key)}
        onToggle={() => toggle(key)}
        hasChildren
        count={entries.length}
        label={t(labelKey)}
      >
        <ul className="tools-tree">
          {entries.map((m) => (
            <TreeRow
              key={`${key}:${m.xref}`}
              open={isOpen(`${key}:${m.xref}`)}
              onToggle={() => toggle(`${key}:${m.xref}`)}
              hasChildren={m.usedBy.length > 0}
              count={m.usedBy.length || undefined}
              href={m.url}
              titleText={m.url ?? m.file}
              label={<span className="tools-tree-meta">{!m.url && m.file ? <MediaThumb file={m.file} icon={icon} gallery={items} index={photos.indexOf(m)} /> : icon} {m.title || m.xref}</span>}
            >
              <UsageList dataset={dataset} uses={m.usedBy} onNavigate={onNavigate} />
            </TreeRow>
          ))}
        </ul>
      </TreeRow>
    );
  };

  return (
    <>
      <p className="tools-intro">{t("tools.sources.intro")}</p>
      <p className="tools-summary">
        {t("tools.sources.summary", {
          repos: tree.repoCount,
          sources: tree.sourceCount,
          media: tree.mediaCount,
        })}
      </p>
      <TreeSearch value={query} onChange={setQuery} />
      {empty ? (
        <p className="tools-clean">{filtering ? t("tools.search.noMatch") : t("tools.sources.none")}</p>
      ) : (
        <ul className="tools-tree">
          {filtered.repos.map((repo, ri) => {
            const repoKey = `r:${repo.xref ?? "none"}:${ri}`;
            return (
              <TreeRow
                key={repoKey}
                open={isOpen(repoKey)}
                onToggle={() => openWith(repoKey, repoDescendants(repo))}
                hasChildren={repo.sources.length > 0}
                count={repo.sources.length}
                href={repo.url}
                titleText={repo.tooltip || repo.xref}
                label={repo.xref ? repo.name || repo.xref : t("tools.sources.noRepo")}
              >
                <ul className="tools-tree">
                  {repo.sources.map((src) => {
                    const srcKey = `s:${src.xref}`;
                    const hasKids = src.media.length > 0 || src.usedBy.length > 0;
                    return (
                      <TreeRow
                        key={srcKey}
                        open={isOpen(srcKey)}
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
                        {(() => {
                          const { photos, items } = mediaGallery(src.media);
                          return src.media.map((m) => (
                          <TreeRow
                            key={`m:${m.xref}`}
                            open={isOpen(`m:${m.xref}`)}
                            onToggle={() => toggle(`m:${m.xref}`)}
                            hasChildren={m.usedBy.length > 0}
                            count={m.usedBy.length || undefined}
                            href={m.url}
                            titleText={m.url ?? m.file}
                            label={
                              <span className="tools-tree-meta">
                                {!m.url && m.file ? (
                                  <MediaThumb
                                    file={m.file}
                                    icon="🖼"
                                    gallery={items}
                                    index={photos.indexOf(m)}
                                  />
                                ) : m.url ? "🔗" : "🖼"}{" "}
                                {m.title || m.xref}
                              </span>
                            }
                          >
                            <UsageList dataset={dataset} uses={m.usedBy} onNavigate={onNavigate} />
                          </TreeRow>
                        ));
                        })()}
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
          {unattachedGroup("unattachedLinks", "tools.sources.unattachedLinks", "🔗", filtered.unattachedLinks)}
          {unattachedGroup("unattached", "tools.sources.unattached", "🖼", filtered.unattachedMedia)}
        </ul>
      )}
    </>
  );
}

// ── Places explorer ──────────────────────────────────────────────────────────

/** Prune a place node to those whose name matches `q` (already lower-cased)
 * anywhere in the subtree. A node matching by name keeps its whole subtree;
 * otherwise only matching descendant branches are retained. */
function filterPlaceNode(node: PlaceNode, q: string): PlaceNode | null {
  if (node.name.toLowerCase().includes(q)) return node;
  const children: PlaceNode[] = [];
  for (const child of node.children) {
    const kept = filterPlaceNode(child, q);
    if (kept) children.push(kept);
  }
  if (children.length === 0) return null;
  return { ...node, children };
}

function PlacesPanel({
  dataset,
  onNavigate,
  active,
  onApplyPlaceRename,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
  onApplyPlaceRename: (from: string, to: string, scope: Set<string>) => void;
}) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<PlaceTree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  useEffect(() => {
    setTree(null);
    setOpen(new Set());
    setQuery("");
  }, [dataset]);

  useEffect(() => {
    if (active && !tree) setTree(buildPlaceTree(dataset));
  }, [active, tree, dataset]);

  // Expanding a place opens it and then keeps drilling through any single-child
  // chain (a node with exactly one sub-place and no usages of its own), so one
  // click lands on the first level that actually offers a choice. Collapsing
  // just closes the clicked node.
  const togglePlace = (node: PlaceNode, path: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(path)) {
        next.delete(path);
        return next;
      }
      let cur: PlaceNode = node;
      let curPath = path;
      next.add(curPath);
      while (cur.children.length === 1 && cur.uses.length === 0) {
        cur = cur.children[0];
        curPath = `${curPath}/${cur.name}`;
        next.add(curPath);
      }
      return next;
    });

  const q = useDebounced(query).trim().toLowerCase();
  const filtering = q.length > 0;
  // While filtering, every surviving branch is forced open so matches are visible.
  const isOpen = (key: string) => filtering || open.has(key);

  const roots = useMemo(() => {
    if (!tree) return [];
    if (!filtering) return tree.roots;
    return tree.roots
      .map((node) => filterPlaceNode(node, q))
      .filter((n): n is PlaceNode => n !== null);
  }, [tree, filtering, q]);

  // All distinct segments for rename autocomplete — recomputed whenever the tree rebuilds.
  const allSegments = useMemo(() => tree ? collectPlaceSegments(dataset) : [], [tree, dataset]);

  function handleRename(from: string, to: string, scope: Set<string>) {
    // Capture the path of `from` in the current tree before rebuild so we can
    // derive the correct destination path (avoids opening the wrong "Wayne" in
    // a different state when multiple nodes share the target name).
    let fromPath: string | null = null;
    if (tree) {
      const findFrom = (node: PlaceNode, path: string): boolean => {
        if (node.name === from) { fromPath = path; return true; }
        for (const child of node.children) {
          if (findFrom(child, `${path}/${child.name}`)) return true;
        }
        return false;
      };
      for (const root of tree.roots) { if (findFrom(root, root.name)) break; }
    }

    onApplyPlaceRename(from, to, scope);
    const newTree = buildPlaceTree(dataset);
    setTree(newTree);

    // Build the expected path: substitute `to` for `from`, or remove the segment when deleting.
    const expectedPath = fromPath
      ? to
        ? (fromPath as string).split("/").map(s => s === from ? to : s).join("/")
        : (fromPath as string).split("/").filter(s => s !== from).join("/")
      : null;

    const toOpen = new Set<string>();
    if (expectedPath) {
      const parts = expectedPath.split("/");
      for (let i = 1; i <= parts.length; i++) toOpen.add(parts.slice(0, i).join("/"));
    }
    setOpen(toOpen);
  }

  if (!tree) return <div className="tools-loading">{t("tools.running")}</div>;

  return (
    <>
      <p className="tools-intro">{t("tools.places.intro")}</p>
      <p className="tools-summary">
        {t("tools.places.summary", { distinct: tree.distinctCount, uses: tree.totalUses })}
      </p>
      <TreeSearch value={query} onChange={setQuery} />
      {roots.length === 0 ? (
        <p className="tools-clean">{filtering ? t("tools.search.noMatch") : t("tools.places.none")}</p>
      ) : (
        <ul className="tools-tree">
          {roots.map((node) => (
            <PlaceTreeRow
              key={node.name}
              dataset={dataset}
              node={node}
              path={node.name}
              depth={0}
              isOpen={isOpen}
              toggle={togglePlace}
              onNavigate={onNavigate}
              onRename={handleRename}
              allSegments={allSegments}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function PlaceTreeRow({
  dataset,
  node,
  path,
  depth,
  isOpen,
  toggle,
  onNavigate,
  onRename,
  allSegments,
}: {
  dataset: Dataset;
  node: PlaceNode;
  path: string;
  depth: number;
  isOpen: (key: string) => boolean;
  toggle: (node: PlaceNode, path: string) => void;
  onNavigate: (id: string) => void;
  onRename: (from: string, to: string, scope: Set<string>) => void;
  allSegments: string[];
}) {
  const { t } = useTranslation();
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const debouncedRename = useDebounced(renameValue, 250);

  const nodeScope = useMemo(() => collectNodeUseIds(node), [node]);

  const hasChildren = node.children.length > 0 || node.uses.length > 0;
  const open = isOpen(path);
  const isSynthetic = node.name === UNSPECIFIED || node.name === UNSPECIFIED_PLACE;
  const name =
    node.name === UNSPECIFIED
      ? t("tools.places.unspecified")
      : node.name === UNSPECIFIED_PLACE
        ? t("tools.places.unspecifiedPlace")
        : node.name;
  const code = depth === 0 && !isSynthetic ? countryCode(node.name) : undefined;
  const flag = code ? [...code.toUpperCase()].map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65)).join("") : undefined;
  const labelNode = flag ? <>{flag} {name}</> : name;

  // Compute rename preview whenever the value differs from the current name.
  const preview = useMemo((): PlaceRenamePreview | null => {
    const target = debouncedRename.trim();
    if (!editing || target === node.name) return null;
    return previewPlaceRename(dataset, node.name, target, nodeScope);
  }, [editing, debouncedRename, node.name, dataset, nodeScope]);

  function openEdit() {
    setRenameValue(node.name);
    setEditing(true);
  }

  function handleApply() {
    const target = renameValue.trim();
    if (target === node.name) return;
    onRename(node.name, target, nodeScope);
    setEditing(false);
    setRenameValue("");
  }

  const datalistId = `place-segs-${uid}`;
  const targetTrimmed = renameValue.trim();
  const applyDisabled = targetTrimmed === node.name;
  // Show "Delete" when target is cleared; "Merge" when it already exists.
  const isDelete = !applyDisabled && targetTrimmed === "";
  const isMerge = !applyDisabled && !isDelete && allSegments.includes(targetTrimmed);

  return (
    <li className={node.isAddress ? "tools-tree-node tools-tree-addr" : "tools-tree-node"}>
      <div className="tools-tree-row">
        {hasChildren ? (
          <button
            className={`tools-pair-toggle ${open ? "open" : ""}`}
            onClick={() => toggle(node, path)}
            aria-expanded={open}
          >
            ▶
          </button>
        ) : (
          <span className="tools-tree-bullet">·</span>
        )}
        <span className="tools-tree-label">{labelNode}</span>
        <span className="tools-chip-count">{node.count}</span>
        {!isSynthetic && !editing && (
          <button
            className="tools-place-edit-btn"
            onClick={openEdit}
            title={t("tools.places.rename.open")}
          >
            ✏
          </button>
        )}
        {editing && (
          <button
            className="tools-place-edit-btn tools-place-edit-cancel"
            onClick={() => setEditing(false)}
            title={t("tools.places.rename.cancel")}
          >
            ✕
          </button>
        )}
      </div>

      {editing && (
        <div className="tools-place-rename">
          <datalist id={datalistId}>
            {allSegments.map((s) => <option key={s} value={s} />)}
          </datalist>
          <input
            type="text"
            className="tools-place-rename-input"
            value={renameValue}
            list={datalistId}
            autoFocus
            placeholder={t("tools.places.rename.placeholder")}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !applyDisabled) handleApply();
              if (e.key === "Escape") setEditing(false);
            }}
          />
          {preview && (
            <span className="tools-place-rename-hint">
              {preview.affectedCount > 0
                ? t("tools.places.rename.count", { count: preview.affectedCount })
                : t("tools.places.rename.noMatch")}
            </span>
          )}
          <button
            className="nav-btn primary tools-place-rename-apply"
            onClick={handleApply}
            disabled={applyDisabled}
          >
            {isDelete ? t("tools.places.rename.delete") : isMerge ? t("tools.places.rename.merge") : t("tools.places.rename.apply")}
          </button>
        </div>
      )}

      {open && hasChildren && (
        <div className="tools-tree-children">
          <ul className="tools-tree">
            {node.children.map((child) => (
              <PlaceTreeRow
                key={child.name}
                dataset={dataset}
                node={child}
                path={`${path}/${child.name}`}
                depth={depth + 1}
                isOpen={isOpen}
                toggle={toggle}
                onNavigate={onNavigate}
                onRename={onRename}
                allSegments={allSegments}
              />
            ))}
          </ul>
          <UsageList dataset={dataset} uses={node.uses} onNavigate={onNavigate} />
        </div>
      )}
    </li>
  );
}

/** Shared search box for the Sources/Places explorers. */
function TreeSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="tools-search">
      <input
        type="search"
        className="tools-search-input"
        placeholder={t("tools.search.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

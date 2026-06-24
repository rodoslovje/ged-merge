import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import { validateDataset, type ValidationReport, type IssueCategory } from "../tools/validate";
import { findDuplicates, type DuplicatePair } from "../tools/duplicates";
import { bulkNormalize } from "../tools/bulkNormalize";
import { buildSourceTree, type SourceTree, type SourceUse } from "../tools/sources";
import { buildPlaceTree, type PlaceNode, type PlaceTree, UNSPECIFIED } from "../tools/places";
import { serializeGedcom } from "../gedcom/serialize";
import { downloadText } from "./download";
import { individualFieldRows } from "../review/fields";
import { ReadOnlyCompare, type PersonNav } from "./ReadOnlyCompare";
import { PersonLink } from "./PersonLink";

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
}

type AsyncState<T> =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: T };

/** Let React paint the "working…" state before a blocking computation runs. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function ToolsView({ dataset, fileName, onNavigate, active }: Props) {
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
          <PlacesPanel dataset={dataset} onNavigate={onNavigate} active={active} />
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

// ── Sources explorer ─────────────────────────────────────────────────────────

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

  useEffect(() => {
    setTree(null);
    setOpen(new Set());
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

  if (!tree) return <div className="tools-loading">{t("tools.running")}</div>;

  const empty =
    tree.repos.length === 0 &&
    tree.unattachedLinks.length === 0 &&
    tree.unattachedMedia.length === 0;

  const unattachedGroup = (key: string, labelKey: string, icon: string, entries: typeof tree.unattachedMedia) =>
    entries.length > 0 && (
      <TreeRow
        open={open.has(key)}
        onToggle={() => toggle(key)}
        hasChildren
        count={entries.length}
        label={t(labelKey)}
      >
        <ul className="tools-tree">
          {entries.map((m) => (
            <TreeRow
              key={`${key}:${m.xref}`}
              open={open.has(`${key}:${m.xref}`)}
              onToggle={() => toggle(`${key}:${m.xref}`)}
              hasChildren={m.usedBy.length > 0}
              count={m.usedBy.length || undefined}
              href={m.url}
              titleText={m.url ?? m.file}
              label={<span className="tools-tree-meta">{icon} {m.title || m.xref}</span>}
            >
              <UsageList dataset={dataset} uses={m.usedBy} onNavigate={onNavigate} />
            </TreeRow>
          ))}
        </ul>
      </TreeRow>
    );

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
      {empty ? (
        <p className="tools-clean">{t("tools.sources.none")}</p>
      ) : (
        <ul className="tools-tree">
          {tree.repos.map((repo, ri) => {
            const repoKey = `r:${repo.xref ?? "none"}:${ri}`;
            return (
              <TreeRow
                key={repoKey}
                open={open.has(repoKey)}
                onToggle={() => toggle(repoKey)}
                hasChildren={repo.sources.length > 0}
                count={repo.sources.length}
                href={repo.url}
                label={repo.xref ? repo.name || repo.xref : t("tools.sources.noRepo")}
              >
                <ul className="tools-tree">
                  {repo.sources.map((src) => {
                    const srcKey = `s:${src.xref}`;
                    const hasKids = src.media.length > 0 || src.usedBy.length > 0;
                    return (
                      <TreeRow
                        key={srcKey}
                        open={open.has(srcKey)}
                        onToggle={() => toggle(srcKey)}
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
                        {src.media.map((m) => (
                          <TreeRow
                            key={`m:${m.xref}`}
                            open={open.has(`m:${m.xref}`)}
                            onToggle={() => toggle(`m:${m.xref}`)}
                            hasChildren={m.usedBy.length > 0}
                            count={m.usedBy.length || undefined}
                            href={m.url}
                            titleText={m.url ?? m.file}
                            label={
                              <span className="tools-tree-meta">
                                {m.url ? "🔗" : "🖼"} {m.title || m.xref}
                              </span>
                            }
                          >
                            <UsageList dataset={dataset} uses={m.usedBy} onNavigate={onNavigate} />
                          </TreeRow>
                        ))}
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
          {unattachedGroup("unattachedLinks", "tools.sources.unattachedLinks", "🔗", tree.unattachedLinks)}
          {unattachedGroup("unattached", "tools.sources.unattached", "🖼", tree.unattachedMedia)}
        </ul>
      )}
    </>
  );
}

// ── Places explorer ──────────────────────────────────────────────────────────

function PlacesPanel({
  dataset,
  onNavigate,
  active,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<PlaceTree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    setTree(null);
    setOpen(new Set());
  }, [dataset]);

  useEffect(() => {
    if (active && !tree) setTree(buildPlaceTree(dataset));
  }, [active, tree, dataset]);

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (!tree) return <div className="tools-loading">{t("tools.running")}</div>;

  return (
    <>
      <p className="tools-intro">{t("tools.places.intro")}</p>
      <p className="tools-summary">
        {t("tools.places.summary", { distinct: tree.distinctCount, uses: tree.totalUses })}
      </p>
      {tree.roots.length === 0 ? (
        <p className="tools-clean">{t("tools.places.none")}</p>
      ) : (
        <ul className="tools-tree">
          {tree.roots.map((node) => (
            <PlaceTreeRow
              key={node.name}
              dataset={dataset}
              node={node}
              path={node.name}
              open={open}
              toggle={toggle}
              onNavigate={onNavigate}
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
  open,
  toggle,
  onNavigate,
}: {
  dataset: Dataset;
  node: PlaceNode;
  path: string;
  open: Set<string>;
  toggle: (key: string) => void;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const hasChildren = node.children.length > 0 || node.uses.length > 0;
  const name = node.name === UNSPECIFIED ? t("tools.places.unspecified") : node.name;
  return (
    <TreeRow
      open={open.has(path)}
      onToggle={() => toggle(path)}
      hasChildren={hasChildren}
      count={node.count}
      label={name}
    >
      <ul className="tools-tree">
        {node.children.map((child) => (
          <PlaceTreeRow
            key={child.name}
            dataset={dataset}
            node={child}
            path={`${path}/${child.name}`}
            open={open}
            toggle={toggle}
            onNavigate={onNavigate}
          />
        ))}
      </ul>
      <UsageList dataset={dataset} uses={node.uses} onNavigate={onNavigate} />
    </TreeRow>
  );
}

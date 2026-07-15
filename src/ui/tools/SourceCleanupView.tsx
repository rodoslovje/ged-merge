import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import {
  ALL_SITES,
  fetchReshapeMeta,
  isFetchableSite,
  reshapeSources,
  type ReshapeEnrichment,
  type ReshapeGroup,
  type ReshapeOccurrence,
  type ReshapeReport,
  type ReshapeSite,
} from "../../tools/sourceReshape";
import { dedupeSources, type DuplicateReport, type DupGroup, type DupKind } from "../../tools/sourceDuplicates";
import { familySpouses } from "../../tools/sources";
import { PersonLink } from "../PersonLink";
import { downloadOptions, ensureUtf8Charset, serializeGedcom } from "../../gedcom/serialize";
import { sourceTooltip } from "../../gedcom/source";
import { fetchPageHtml } from "../../normalize/urlMetadata";
import { downloadText } from "../download";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { BackButton } from "../BackButton";
import { useSettings } from "../SettingsContext";

const SITES: readonly ReshapeSite[] = ALL_SITES;
/** Site glyphs — shared with the Add Source dialog's recognized-link chip. */
export const SITE_ICON: Record<ReshapeSite, string> = {
  matricula: "⛪",
  geneanet: "🪦",
  findagrave: "🪦",
  legacy: "📰",
  sistory: "🎖️",
  familysearch: "🌳",
  other: "🔗",
};
const QUAY_CHOICES = ["", "3", "2", "1", "0"];

const DUP_KINDS: DupKind[] = ["media", "source", "repo"];
const DUP_KIND_ICON: Record<DupKind, string> = { media: "🖼", source: "📚", repo: "🏛" };

/** The default-kept member of a group (the one the finder flagged as survivor). */
function defaultSurvivor(g: DupGroup): string {
  return (g.members.find((m) => m.survivor) ?? g.members[0]).xref;
}

/** A copy of `g` with `xref` marked as the kept record (the rest fold into it). */
function withSurvivor(g: DupGroup, xref: string): DupGroup {
  return { ...g, members: g.members.map((m) => ({ ...m, survivor: m.xref === xref })) };
}

/** Labeled selector for the GEDCOM citation data-quality value (QUAY 0–3). */
function QuaySelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useTranslation();
  return (
    <label className="tools-reshape-site" title={t("tools.sources.reshapeQuayHint")}>
      {t("tools.sources.reshapeQuay")}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {QUAY_CHOICES.map((q) => (
          <option key={q} value={q}>
            {q === "" ? t("tools.sources.reshapeQuay.none") : `${q} – ${t(`tools.sources.reshapeQuay.${q}`)}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Whole-file source cleanup, one download: the *reshape* section turns bare
 * Matricula / Geneanet / Find a Grave / FamilySearch links into proper source
 * records with pointer citations; the *duplicates* section collapses records
 * describing the same media/source/repository. Applying runs reshape first,
 * then dedupe (so re-pointing also covers the just-written citations), and
 * serializes a single `.gedmerge.ged` — the live dataset is never touched.
 */
export function SourceCleanupView({
  reshapeReport: reshapeReportProp,
  dupReport: dupReportProp,
  dataset,
  fileName,
  onNavigate,
  onBack,
}: {
  /** Null when that scan failed — the other tool keeps working. */
  reshapeReport: ReshapeReport | null;
  dupReport: DuplicateReport | null;
  dataset: Dataset;
  fileName: string;
  onNavigate: (id: string) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const reshapeReport = useMemo<ReshapeReport>(
    () =>
      reshapeReportProp ?? {
        groups: [],
        totalOccurrences: 0,
        bySite: { matricula: 0, geneanet: 0, findagrave: 0, legacy: 0, sistory: 0, familysearch: 0, other: 0 },
      },
    [reshapeReportProp],
  );
  const dupReport = useMemo<DuplicateReport>(
    () => dupReportProp ?? { groups: [], byKind: { media: 0, source: 0, repo: 0 } },
    [dupReportProp],
  );
  // Only the first site category with hits is pre-checked — converting one
  // site at a time keeps the change reviewable; the other categories (and
  // especially generic "other" links) are a click away.
  const [sites, setSites] = useState<Set<ReshapeSite>>(() => {
    const first = SITES.find((s) => s !== "other" && reshapeReport.bySite[s] > 0);
    return new Set<ReshapeSite>(first ? [first] : []);
  });
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [relocate, setRelocate] = useState(true);
  const [quay, setQuay] = useState("");
  /** Per-reference QUAY overrides, keyed `${groupId}:${memberIndex}`. */
  const [quayOverrides, setQuayOverrides] = useState<Map<string, string>>(new Map());
  const [enrichment, setEnrichment] = useState<ReshapeEnrichment>(new Map());
  const [fetching, setFetching] = useState<{ done: number; total: number } | null>(null);
  /** Books the last fetch run could not retrieve (relay down / blocked). */
  const [fetchFailed, setFetchFailed] = useState(0);
  // Duplicates: excluded groups + survivor overrides keyed by group id.
  const [dupExcluded, setDupExcluded] = useState<Set<string>>(new Set());
  const [survivors, setSurvivors] = useState<Map<string, string>>(new Map());

  // Esc leaves the sub-page, matching the chart overlays.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isEditableTarget(e.target) || isModalOpen()) return;
      e.preventDefault();
      onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const toggleIn = (set: (fn: (s: Set<string>) => Set<string>) => void) => (id: string) =>
    set((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleGroup = toggleIn(setExcluded);
  const toggleExpand = toggleIn(setExpanded);
  const toggleDupGroup = toggleIn(setDupExcluded);

  const toggleSite = (site: ReshapeSite) =>
    setSites((s) => {
      const next = new Set(s);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });

  const visibleGroups = useMemo(() => reshapeReport.groups.filter((g) => sites.has(g.site)), [reshapeReport, sites]);
  const selectedGroups = useMemo(
    () =>
      visibleGroups
        .filter((g) => !excluded.has(g.id))
        .map((g) => ({
          ...g,
          quay: quay || undefined,
          members: g.members.map((m, i) => {
            const override = quayOverrides.get(`${g.id}:${i}`);
            return override ? { ...m, quay: override } : m;
          }),
        })),
    [visibleGroups, excluded, quayOverrides, quay],
  );
  const citationCount = selectedGroups.reduce((n, g) => n + g.members.length, 0);
  // Books the fetch button will actually check: only *selected* new-source
  // groups on fetchable sites, and only those not already fetched.
  // URL-titled sources are "existing" but get rewritten — they want enrichment
  // as much as brand-new ones do.
  const fetchableGroups = selectedGroups.filter(
    (g) => (!g.existingSourceXref || g.urlTitled) && !enrichment.has(g.id) && isFetchableSite(g.site),
  );

  const selectedDupGroups = dupReport.groups
    .filter((g) => !dupExcluded.has(g.id))
    .map((g) => withSurvivor(g, survivors.get(g.id) ?? defaultSurvivor(g)));
  const removeCount = selectedDupGroups.reduce((n, g) => n + g.removable, 0);

  function download() {
    // Reshape first (its existing-source targets are original xrefs), then
    // dedupe — which also re-points the citations the reshape just wrote.
    const { records: reshaped } = reshapeSources(dataset.records, selectedGroups, enrichment, { relocate });
    const { records } = dedupeSources(reshaped, selectedDupGroups);
    const base = fileName.replace(/\.ged$/i, "");
    ensureUtf8Charset(records, dataset); // downloads are UTF-8 bytes
    const text = serializeGedcom(records, downloadOptions(dataset));
    downloadText(`${base}.gedmerge.ged`, text);
  }

  async function fetchDetails() {
    const targets = fetchableGroups;
    setFetching({ done: 0, total: targets.length });
    setFetchFailed(0);
    const fetched = await fetchReshapeMeta(
      targets,
      fetchPageHtml,
      (done, total) => setFetching({ done, total }),
      // Stream each resolved book into the list immediately — titles improve
      // one by one instead of all at once at the end.
      (id, meta) => setEnrichment((prev) => new Map(prev).set(id, meta)),
    );
    setFetchFailed(targets.filter((g) => !fetched.has(g.id)).length);
    setFetching(null);
  }

  // No automatic fetching: the Settings toggle only *permits* the proxy; each
  // run of it is an explicit click on the "Fetch book details" button.

  // Fetched title → the existing source's own title (correct diacritics, no
  // fetch needed) → the offline URL-derived guess.
  const groupTitle = (g: ReshapeGroup) =>
    enrichment.get(g.id)?.title ?? (g.existingSourceXref ? g.existingSourceTitle : undefined) ?? g.proposed.title;

  // Full field-per-row tooltip for the new/existing badge — same "TAG: value"
  // style as the Sources tree's record tooltips.
  const sourNodes = useMemo(() => {
    const map = new Map<string, (typeof dataset.records)[number]>();
    for (const r of dataset.records) if (r.tag === "SOUR" && r.xref) map.set(r.xref, r);
    return map;
  }, [dataset]);

  const badgeTooltip = (g: ReshapeGroup): string => {
    if (g.existingSourceXref) {
      const node = sourNodes.get(g.existingSourceXref);
      const fields = node ? sourceTooltip(node) : g.existingSourceTitle ?? "";
      return [g.existingSourceXref, fields].filter(Boolean).join("\n");
    }
    const meta = enrichment.get(g.id);
    return [
      `TITL: ${meta?.title ?? g.proposed.title}`,
      (meta?.agency ?? g.proposed.agency) && `AGNC: ${meta?.agency ?? g.proposed.agency}`,
      (meta?.place ?? g.proposed.place) && `PLAC: ${meta?.place ?? g.proposed.place}`,
      g.proposed.filingNumber && `FILN: ${g.proposed.filingNumber}`,
      meta?.dateRange && `DATE: ${meta.dateRange}`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  const hasReshape = reshapeReport.groups.length > 0;
  const hasDups = dupReport.groups.length > 0;
  const nothingSelected = selectedGroups.length === 0 && selectedDupGroups.length === 0;

  return (
    <>
      <div className="tools-filter-row">
        <BackButton label={t("tools.sources.dupBack")} shortcutHint="Esc" showLabel onClick={onBack} />
        <p className="tools-summary">
          {[
            hasReshape && t("tools.sources.reshapeFound", { count: visibleGroups.length }),
            hasDups && t("tools.sources.dupFound", { count: dupReport.groups.length }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      {hasReshape && (
        <section className="tools-cleanup-section">
          <div className="tools-dup-kind-head">
            {t("tools.sources.reshapeHeading")}
            <span className="tools-chip-count">{visibleGroups.length}</span>
            <div className="tools-dup-bulk">
              <button className="tools-issue-link" onClick={() => setExcluded(new Set())}>
                {t("tools.sources.dupSelectAll")}
              </button>
              <button
                className="tools-issue-link"
                onClick={() => setExcluded(new Set(reshapeReport.groups.map((g) => g.id)))}
              >
                {t("tools.sources.dupSelectNone")}
              </button>
              <button
                className="tools-issue-link"
                onClick={() =>
                  setExpanded((s) => new Set([...s, ...visibleGroups.map((g) => g.id)]))
                }
              >
                {t("tools.sources.expandAll")}
              </button>
              <button
                className="tools-issue-link"
                onClick={() =>
                  setExpanded((s) => new Set([...s].filter((id) => !visibleGroups.some((g) => g.id === id))))
                }
              >
                {t("tools.sources.collapseAll")}
              </button>
            </div>
          </div>
          <p className="tools-intro">{t("tools.sources.reshapeIntro")}</p>

          <div className="tools-reshape-options">
            {SITES.filter((s) => reshapeReport.bySite[s] > 0).map((site) => (
              <label key={site} className="tools-reshape-site">
                <input type="checkbox" checked={sites.has(site)} onChange={() => toggleSite(site)} />
                {SITE_ICON[site]} {t(`tools.sources.reshapeSite.${site}`)}
                <span className="tools-chip-count">{reshapeReport.bySite[site]}</span>
              </label>
            ))}
          </div>
          <div className="tools-reshape-options">
            <label className="tools-reshape-site" title={t("tools.sources.reshapePlaceHint")}>
              <input type="checkbox" checked={relocate} onChange={() => setRelocate((v) => !v)} />
              {t("tools.sources.reshapePlace")}
            </label>
            <QuaySelect value={quay} onChange={setQuay} />
          </div>

          <ul className="tools-tree">
            {visibleGroups.map((g) => (
              <ReshapeGroupRow
                key={g.id}
                group={g}
                title={groupTitle(g)}
                badgeTooltip={badgeTooltip(g)}
                checked={!excluded.has(g.id)}
                open={expanded.has(g.id)}
                relocate={relocate}
                defaultQuay={quay}
                quayOf={(i) => quayOverrides.get(`${g.id}:${i}`) ?? ""}
                onQuay={(i, v) => setQuayOverrides((m) => new Map(m).set(`${g.id}:${i}`, v))}
                dataset={dataset}
                onNavigate={onNavigate}
                onToggleCheck={() => toggleGroup(g.id)}
                onToggleOpen={() => toggleExpand(g.id)}
              />
            ))}
          </ul>
        </section>
      )}

      {hasDups && (
        <section className="tools-cleanup-section">
          <div className="tools-dup-kind-head">
            {t("tools.sources.dupHeading")}
            <span className="tools-chip-count">{dupReport.groups.length}</span>
            <div className="tools-dup-bulk">
              <button className="tools-issue-link" onClick={() => setDupExcluded(new Set())}>
                {t("tools.sources.dupSelectAll")}
              </button>
              <button
                className="tools-issue-link"
                onClick={() => setDupExcluded(new Set(dupReport.groups.map((g) => g.id)))}
              >
                {t("tools.sources.dupSelectNone")}
              </button>
              <button
                className="tools-issue-link"
                onClick={() => setExpanded((s) => new Set([...s, ...dupReport.groups.map((g) => g.id)]))}
              >
                {t("tools.sources.expandAll")}
              </button>
              <button
                className="tools-issue-link"
                onClick={() =>
                  setExpanded((s) => new Set([...s].filter((id) => !dupReport.groups.some((g) => g.id === id))))
                }
              >
                {t("tools.sources.collapseAll")}
              </button>
            </div>
          </div>
          <p className="tools-intro">{t("tools.sources.dupIntro")}</p>

          {DUP_KINDS.filter((k) => dupReport.byKind[k] > 0).map((kind) => (
            <div key={kind} className="tools-dup-kind">
              <div className="tools-dup-kind-head">
                {DUP_KIND_ICON[kind]} {t(`tools.sources.dupKind.${kind}`)}
                <span className="tools-chip-count">{dupReport.byKind[kind]}</span>
              </div>
              <ul className="tools-tree">
                {dupReport.groups
                  .filter((g) => g.kind === kind)
                  .map((g) => (
                    <DupGroupRow
                      key={g.id}
                      group={g}
                      checked={!dupExcluded.has(g.id)}
                      survivorXref={survivors.get(g.id) ?? defaultSurvivor(g)}
                      open={expanded.has(g.id)}
                      onToggleCheck={() => toggleDupGroup(g.id)}
                      onToggleOpen={() => toggleExpand(g.id)}
                      onChooseSurvivor={(xref) => setSurvivors((m) => new Map(m).set(g.id, xref))}
                    />
                  ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      <div className="tools-dup-actions">
        <button className="nav-btn primary tools-run" onClick={download} disabled={nothingSelected}>
          {t("tools.sources.cleanupDownload")}
        </button>
        {settings.allowLinkFetch && (fetchableGroups.length > 0 || fetching !== null) && (
          <button
            className="nav-btn tools-run"
            onClick={fetchDetails}
            disabled={fetching !== null}
            title={t("tools.sources.reshapeFetchHint")}
          >
            {fetching
              ? t("tools.sources.reshapeFetching", { done: fetching.done, total: fetching.total })
              : `${t("tools.sources.reshapeFetch")} (${fetchableGroups.length})`}
          </button>
        )}
        {fetchFailed > 0 && !fetching && (
          <span className="tools-fix-hint">{t("tools.sources.reshapeFetchFailed", { count: fetchFailed })}</span>
        )}
        {!nothingSelected && (
          <span className="tools-fix-hint">
            {[
              selectedGroups.length > 0 &&
                t("tools.sources.reshapeDownloadCount", { groups: selectedGroups.length, citations: citationCount }),
              selectedDupGroups.length > 0 &&
                t("tools.sources.dupDownloadCount", { groups: selectedDupGroups.length, records: removeCount }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </div>
    </>
  );
}

/** One book/grave/film group: checkbox, title, badges, and expandable members. */
function ReshapeGroupRow({
  group,
  title,
  badgeTooltip,
  checked,
  open,
  relocate,
  defaultQuay,
  quayOf,
  onQuay,
  dataset,
  onNavigate,
  onToggleCheck,
  onToggleOpen,
}: {
  group: ReshapeGroup;
  title: string;
  /** Field-per-row summary of the source the group creates or reuses. */
  badgeTooltip: string;
  checked: boolean;
  open: boolean;
  relocate: boolean;
  /** The global QUAY, shown as each reference's placeholder value. */
  defaultQuay: string;
  quayOf: (memberIndex: number) => string;
  onQuay: (memberIndex: number, value: string) => void;
  dataset: Dataset;
  onNavigate: (id: string) => void;
  onToggleCheck: () => void;
  onToggleOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="tools-tree-node">
      <div className="tools-tree-row">
        <input type="checkbox" className="tools-dup-check" checked={checked} onChange={onToggleCheck} />
        <button className={`tools-pair-toggle ${open ? "open" : ""}`} onClick={onToggleOpen} aria-expanded={open}>
          ▶
        </button>
        <span className="tools-tree-label clickable" onClick={onToggleOpen} title={group.bookUrl}>
          {SITE_ICON[group.site]} {title}
        </span>
        {group.bookType !== "unknown" && (
          <span className="tools-tree-meta">{t(`tools.sources.reshapeType.${group.bookType}`)}</span>
        )}
        {group.pages.length > 0 && (
          <span className="tools-tree-meta">{t("tools.sources.reshapePages", { count: group.pages.length })}</span>
        )}
        {group.existingSourceXref ? (
          <span className="tools-reshape-badge reuse" title={badgeTooltip}>
            {t("tools.sources.reshapeReuses")}
          </span>
        ) : (
          <span className="tools-reshape-badge new" title={badgeTooltip}>
            {t("tools.sources.reshapeNew")}
          </span>
        )}
        <span className="tools-chip-count">{group.members.length}</span>
      </div>
      {open && (
        <div className="tools-tree-children">
          <ul className="tools-dup-members">
            {group.members.map((m, i) => (
              <MemberRow
                key={`${m.recordXref}:${i}`}
                member={m}
                relocate={relocate}
                defaultQuay={defaultQuay}
                quay={quayOf(i)}
                onQuay={(v) => onQuay(i, v)}
                dataset={dataset}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

function MemberRow({
  member: m,
  relocate,
  defaultQuay,
  quay,
  onQuay,
  dataset,
  onNavigate,
}: {
  member: ReshapeOccurrence;
  relocate: boolean;
  defaultQuay: string;
  quay: string;
  onQuay: (value: string) => void;
  dataset: Dataset;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  const at = m.eventTag ?? t("tools.sources.reshapeRecordLevel");
  // Family occurrences link through the spouses (Edit navigates to persons).
  const famSpouses = m.recordTag === "FAM" ? familySpouses(dataset, m.recordXref) : [];
  return (
    <li className="tools-dup-member">
      {m.recordTag === "INDI" ? (
        <PersonLink dataset={dataset} id={m.recordXref} fallback={m.recordLabel} onNavigate={onNavigate} />
      ) : famSpouses.length > 0 ? (
        <span>
          {famSpouses.map((p, j) => (
            <span key={p.id}>
              {j > 0 && <span className="tools-usage-amp">&amp;</span>}
              <PersonLink dataset={dataset} id={p.id} fallback={p.label} onNavigate={onNavigate} />
            </span>
          ))}
        </span>
      ) : (
        <span className="tools-dup-title" title={m.url}>
          {m.recordLabel}
        </span>
      )}
      <span className="tools-tree-meta">
        {at}
        {relocate && m.targetEvent && ` → ${m.targetEvent}`}
        {m.foldedInto && ` → ${m.foldedInto} (${t("tools.sources.reshapeFolded")})`} ·{" "}
        {t(`tools.sources.reshapeShape.${m.shape}`)}
        {m.page && ` · ${t("tools.sources.reshapePage", { page: m.page })}`}
      </span>
      {!m.foldedInto && (
        <select
          className="tools-quay-mini"
          value={quay}
          onChange={(e) => onQuay(e.target.value)}
          title={t("tools.sources.reshapeQuayHint")}
        >
          <option value="">
            {defaultQuay
              ? `${defaultQuay} – ${t(`tools.sources.reshapeQuay.${defaultQuay}`)}`
              : t("tools.sources.reshapeQuay.none")}
          </option>
          {["3", "2", "1", "0"].map((q) => (
            <option key={q} value={q}>
              {q} – {t(`tools.sources.reshapeQuay.${q}`)}
            </option>
          ))}
        </select>
      )}
      <a className="tools-tree-meta" href={m.url} target="_blank" rel="noreferrer">
        ↗
      </a>
    </li>
  );
}

/** One duplicate group: a checkbox to include it in the fix, the shared
 *  link/title, and an expandable list of its members with a radio to pick which
 *  record to keep (the rest fold into it). */
function DupGroupRow({
  group,
  checked,
  survivorXref,
  open,
  onToggleCheck,
  onToggleOpen,
  onChooseSurvivor,
}: {
  group: DupGroup;
  checked: boolean;
  survivorXref: string;
  open: boolean;
  onToggleCheck: () => void;
  onToggleOpen: () => void;
  onChooseSurvivor: (xref: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="tools-tree-node">
      <div className="tools-tree-row">
        <input type="checkbox" className="tools-dup-check" checked={checked} onChange={onToggleCheck} />
        <button
          className={`tools-pair-toggle ${open ? "open" : ""}`}
          onClick={onToggleOpen}
          aria-expanded={open}
        >
          ▶
        </button>
        <span className="tools-tree-label clickable" onClick={onToggleOpen} title={group.label}>
          {group.label}
        </span>
        <span className="tools-chip-count">{group.members.length}</span>
      </div>
      {open && (
        <div className="tools-tree-children">
          <ul className="tools-dup-members">
            {group.members.map((m) => {
              const keep = m.xref === survivorXref;
              return (
                <li key={m.xref} className={keep ? "tools-dup-member survivor" : "tools-dup-member"}>
                  <label className="tools-dup-keep-pick" title={t("tools.sources.dupKeepThis")}>
                    <input
                      type="radio"
                      name={`surv-${group.id}`}
                      checked={keep}
                      onChange={() => onChooseSurvivor(m.xref)}
                    />
                    {keep && <span className="tools-dup-keep">{t("tools.sources.dupKeep")}</span>}
                  </label>
                  <span className="tools-dup-title">{m.title}</span>
                  {m.detail && m.detail !== m.title && <span className="tools-tree-meta">{m.detail}</span>}
                  {m.usage > 0 && (
                    <span className="tools-tree-meta">· {t("tools.sources.dupUsage", { count: m.usage })}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </li>
  );
}

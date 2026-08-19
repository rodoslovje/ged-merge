import { useEffect, useMemo, useState } from "react";
import { linkHref, linkTooltip } from "../FieldValue";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../../gedcom/types";
import {
  ALL_SITES,
  SITE_ICON,
  baptismTargetTag,
  fetchReshapeMeta,
  isFetchableSite,
  mergeFsBooks,
  makePlaceResolver,
  parsePastedFsCitation,
  reshapeOptionsFromOverrides,
  type ReshapeEnrichment,
  type ReshapeGroup,
  type ReshapeMeta,
  type ReshapeOccurrence,
  type ReshapeReport,
  type ReshapeSite,
} from "../../tools/sourceReshape";
import { type DuplicateReport, type DupGroup, type DupKind } from "../../tools/sourceDuplicates";
import { applySourceCleanup } from "../../tools/sourceCleanupApply";
import { type RepoRegroupGroup, type RepoRegroupReport } from "../../tools/repoRegroup";
import type { Translate } from "../../locales/i18n";
import type { RecordPatch } from "../historyTypes";
import { familySpouses, recordCitedBy } from "../../tools/sources";
import { UsageList } from "./shared";
import { PersonLink } from "../PersonLink";
import { sourceTooltip } from "../../gedcom/source";
import { parseSourceInput } from "../../gedcom/citationParse";
import { fetchPageHtml } from "../../normalize/urlMetadata";
import { linkKey } from "../../normalize/links";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { BackButton } from "../BackButton";
import { SelectMenu } from "../DropdownMenu";
import { useSettings } from "../SettingsContext";
import { ToolSummary } from "./ToolSummary";

const SITES: readonly ReshapeSite[] = ALL_SITES;
const QUAY_CHOICES = ["", "3", "2", "1", "0"];

const DUP_KINDS: DupKind[] = ["media", "source", "repo"];
const DUP_KIND_ICON: Record<DupKind, string> = { media: "🖼", source: "📚", repo: "🏛" };

/** The ↗ that opens a row's page, shown when the row's detail is a link —
 *  the same affordance the Sources tree and the person cards carry. */
function RowLink({ url, t }: { url: string | undefined; t: Translate }) {
  const href = url ? linkHref(url) : undefined;
  if (!href) return null;
  return (
    <a className="tools-tree-link" href={href} target="_blank" rel="noreferrer" title={linkTooltip(url!, t)}>
      ↗
    </a>
  );
}

/** The ✎ that opens a record in the editor the Sources tree uses. Hidden until
 *  its row is hovered, like every other row action in Tools. */
function RowEdit({
  xref,
  kind,
  onEditRecord,
  t,
}: {
  xref: string;
  kind: "source" | "repo";
  onEditRecord: ((xref: string, kind: "source" | "repo") => void) | undefined;
  t: Translate;
}) {
  if (!onEditRecord) return null;
  return (
    <button
      className="tools-place-edit-btn"
      title={t(kind === "repo" ? "editRepo.title" : "editSource.title")}
      onClick={(e) => {
        e.stopPropagation();
        onEditRecord(xref, kind);
      }}
    >
      ✎
    </button>
  );
}

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
      <SelectMenu
        value={value}
        onChange={onChange}
        options={QUAY_CHOICES.map((q) => ({
          value: q,
          label: q === "" ? t("tools.sources.reshapeQuay.none") : `${q} – ${t(`tools.sources.reshapeQuay.${q}`)}`,
        }))}
      />
    </label>
  );
}

/**
 * Whole-file source cleanup, applied to the open file: the *reshape* section
 * turns bare Matricula / Geneanet / Find a Grave / FamilySearch links into
 * proper source records with pointer citations; the *duplicates* section
 * collapses records describing the same media/source/repository. Applying runs
 * reshape first, then dedupe (so re-pointing also covers the just-written
 * citations), and lands as one undoable step the next save takes along — like
 * every other Tools repair, no separate download.
 */
export function SourceCleanupView({
  reshapeReport: reshapeReportProp,
  dupReport: dupReportProp,
  dataset,
  regroupReport,
  onNavigate,
  onBack,
  onApplyPatches,
  onRescan,
  scanning,
  onEditRecord,
  active,
}: {
  /** Null when that scan failed — the other tool keeps working. */
  reshapeReport: ReshapeReport | null;
  dupReport: DuplicateReport | null;
  /** Which FamilySearch sources sit away from their country's repository —
   *  read by the panel, so its chip can count this page's work too. */
  regroupReport: RepoRegroupReport;
  dataset: Dataset;
  onNavigate: (id: string) => void;
  onBack: () => void;
  /** Apply the run as one undoable step; returns how many records changed. */
  onApplyPatches: (patches: RecordPatch[]) => number;
  /** Re-run the whole-file scans this page lists — what the apply just
   *  rewrote is what they describe, so their rows are stale the moment it
   *  lands. */
  onRescan?: () => void;
  /** Whether one of those scans is running right now. */
  scanning?: boolean;
  /** Open a record in the editor the Sources tree uses — every field it holds,
   *  its link included, from the row that named it. */
  onEditRecord?: (xref: string, kind: "source" | "repo") => void;
  /** Whether this view is the one on screen — the Esc-to-leave shortcut must
   *  not fire from a hidden, still-mounted panel (it would drop its state). */
  active: boolean;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const reshapeReport = useMemo<ReshapeReport>(
    () =>
      reshapeReportProp ?? {
        groups: [],
        totalOccurrences: 0,
        bySite: { matricula: 0, geneanet: 0, geneanettree: 0, findagrave: 0, billiongraves: 0, legacy: 0, newspapers: 0, sistory: 0, dlib: 0, googlebooks: 0, youtube: 0, wikipedia: 0, biografija: 0, obrazi: 0, familysearch: 0, other: 0 },
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
  /** Also shorten the links already stored on the media the run touches. Off
   *  by default: those records are otherwise fine. */
  const [tidyLinks, setTidyLinks] = useState(false);
  const [quay, setQuay] = useState("");
  /** Per-reference QUAY overrides, keyed `${groupId}:${memberIndex}`. */
  const [quayOverrides, setQuayOverrides] = useState<Map<string, string>>(new Map());
  const [enrichment, setEnrichment] = useState<ReshapeEnrichment>(new Map());
  /** Group whose source fields are open in the manual editor. */
  const [editGroup, setEditGroup] = useState<ReshapeGroup | null>(null);
  /** Groups marked "remove references" — the apply strips their links (dead
   *  URLs) instead of converting them into sources. */
  const [removeMarked, setRemoveMarked] = useState<Set<string>>(new Set());
  const [fetching, setFetching] = useState<{ done: number; total: number } | null>(null);
  /** Books the last fetch run could not retrieve (relay down / blocked). */
  const [fetchFailed, setFetchFailed] = useState(0);
  /** Records the last apply changed — the run's own receipt, cleared as soon
   *  as the re-scan brings a fresh report in. */
  const [applied, setApplied] = useState(0);
  // Duplicates: excluded groups + survivor overrides keyed by group id.
  const [dupExcluded, setDupExcluded] = useState<Set<string>>(new Set());
  const [survivors, setSurvivors] = useState<Map<string, string>>(new Map());
  // Repositories: the countries whose regroup is unticked.
  const [regroupExcluded, setRegroupExcluded] = useState<Set<string>>(new Set());

  // Esc leaves the sub-page, matching the chart overlays — but only while it
  // is the view on screen (see the `active` prop).
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isEditableTarget(e.target) || isModalOpen()) return;
      e.preventDefault();
      onBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onBack]);

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
  const toggleRegroupGroup = toggleIn(setRegroupExcluded);

  const toggleSite = (site: ReshapeSite) =>
    setSites((s) => {
      const next = new Set(s);
      if (next.has(site)) next.delete(site);
      else next.add(site);
      return next;
    });

  // Once the lookups are in, the FamilySearch pages that belong to one book
  // become one row — one source with a page citation each, instead of one
  // source per image. Everything below works on the folded report; the fetch
  // itself still goes image by image, since that is where a page number is.
  // The fold refreshes each member's shown move with the enriched book type;
  // baptism moves follow the same override-or-file habit the apply resolves.
  const baptismTag = useMemo(
    () => settings.formatOverrides?.baptism ?? baptismTargetTag(dataset.records),
    [settings.formatOverrides, dataset],
  );
  const folded = useMemo(
    () => mergeFsBooks(reshapeReport, enrichment, baptismTag),
    [reshapeReport, enrichment, baptismTag],
  );
  // The receipt outlives the re-scan the apply itself starts — that scan is
  // how the rows it rewrote leave the page, and the receipt is the only thing
  // left saying what happened. It is cleared when the next run begins.
  const visibleGroups = useMemo(() => folded.report.groups.filter((g) => sites.has(g.site)), [folded, sites]);
  const selectedGroups = useMemo(
    () =>
      visibleGroups
        .filter((g) => !excluded.has(g.id))
        .map((g) => ({
          ...g,
          quay: quay || undefined,
          removeLinks: removeMarked.has(g.id) || undefined,
          members: g.members.map((m, i) => {
            const override = quayOverrides.get(`${g.id}:${i}`);
            return override ? { ...m, quay: override } : m;
          }),
        })),
    [visibleGroups, excluded, quayOverrides, quay, removeMarked],
  );
  // Books the fetch button will actually check: only *selected* new-source
  // groups on fetchable sites, and only those not already fetched.
  // URL-titled sources are "existing" but get rewritten — they want enrichment
  // as much as brand-new ones do.
  // …and it works on the *unfolded* groups: one lookup per image, each
  // answering with that image's own page number. A book already folded is
  // fetched, and one whose row is unticked is left out with it.
  // A page that already has a source is looked up too, where the lookup is
  // what tells one book from another: it says which record the page belongs
  // to, and carries that page's own number. Elsewhere a source already in the
  // file needs nothing fetched — its fields are the file's, not a proposal.
  const fetchableGroups = reshapeReport.groups.filter(
    (g) =>
      sites.has(g.site) &&
      !excluded.has(folded.keyOf.get(g.id) ?? g.id) &&
      (!g.existingSourceXref || g.urlTitled || g.site === "familysearch") &&
      !removeMarked.has(g.id) &&
      !enrichment.has(g.id) &&
      isFetchableSite(g.site, g.bookUrl),
  );

  const selectedDupGroups = dupReport.groups
    .filter((g) => !dupExcluded.has(g.id))
    .map((g) => withSurvivor(g, survivors.get(g.id) ?? defaultSurvivor(g)));

  const selectedRegroupGroups = regroupReport.groups.filter((g) => !regroupExcluded.has(g.id));

  function apply() {
    setApplied(0);
    // Reshape first (its existing-source targets are original xrefs), then
    // dedupe — which also re-points the citations the reshape just wrote.
    const patches = applySourceCleanup(
      dataset,
      {
        groups: selectedGroups,
        enrichment: folded.enrichment,
        options: {
          ...reshapeOptionsFromOverrides(settings.formatOverrides),
          relocate,
          tidyLinks,
          mergeGroups: folded.keyOf,
        },
      },
      selectedDupGroups,
      selectedRegroupGroups,
    );
    setApplied(onApplyPatches(patches));
    // The lists describe exactly what the apply just rewrote, so they are
    // stale the moment it lands — the groups it converted are gone, and what
    // it left behind is what the next run should see.
    onRescan?.();
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

  // The same file-format place matching the apply runs, so the tooltip shows
  // the value that will actually be written ("Ravna Gora, Općina Ravna Gora,
  // Primorsko-Goranska, Croatia" → the file's own "Ravna Gora,…" entry).
  const resolvePlace = useMemo(() => makePlaceResolver(dataset.records), [dataset]);

  // Fetched title → the existing source's own title (correct diacritics, no
  // fetch needed) → the offline URL-derived guess.
  const groupTitle = (g: ReshapeGroup) =>
    folded.enrichment.get(g.id)?.title ?? (g.existingSourceXref ? g.existingSourceTitle : undefined) ?? g.proposed.title;

  // Full field-per-row tooltip for the new/existing badge — same "TAG: value"
  // style as the Sources tree's record tooltips.
  const sourNodes = useMemo(() => {
    const map = new Map<string, (typeof dataset.records)[number]>();
    for (const r of dataset.records) if (r.tag === "SOUR" && r.xref) map.set(r.xref, r);
    return map;
  }, [dataset]);

  // Localized labels for the SOUR fields the tooltips show — the same
  // vocabulary as the Add Source dialog; unknown tags keep their raw name.
  const FIELD_LABEL_KEYS: Record<string, string> = {
    TITL: "addSource.field.title",
    AUTH: "addSource.field.author",
    PERI: "addSource.field.periodical",
    PUBL: "addSource.field.publisher",
    AGNC: "addSource.field.agency",
    PLAC: "addSource.field.place",
    FILN: "addSource.field.filingNumber",
    NOTE: "addSource.field.note",
    PAGE: "addSource.field.page",
    DATE: "addSource.field.dateRange",
  };
  const fieldLabel = (tag: string) => (FIELD_LABEL_KEYS[tag] ? t(FIELD_LABEL_KEYS[tag]) : tag);
  const localizeTooltip = (text: string) =>
    text.replace(/^([A-Z_][A-Z0-9_]{2,}): /gm, (_, tag: string) => `${fieldLabel(tag)}: `);

  const badgeTooltip = (g: ReshapeGroup): string => {
    if (g.existingSourceXref) {
      const node = sourNodes.get(g.existingSourceXref);
      const fields = node ? localizeTooltip(sourceTooltip(node)) : g.existingSourceTitle ?? "";
      return [g.existingSourceXref, fields].filter(Boolean).join("\n");
    }
    const meta = folded.enrichment.get(g.id);
    // The same field values the apply writes: fetched over offline-proposed,
    // the place matched against the file's own place format.
    const place = resolvePlace(meta?.place ?? g.proposed.place);
    return [
      `${fieldLabel("TITL")}: ${meta?.title ?? g.proposed.title}`,
      (meta?.author ?? g.proposed.author) && `${fieldLabel("AUTH")}: ${meta?.author ?? g.proposed.author}`,
      (meta?.agency ?? g.proposed.agency) && `${fieldLabel("AGNC")}: ${meta?.agency ?? g.proposed.agency}`,
      place && `${fieldLabel("PLAC")}: ${place}`,
      (meta?.filingNumber ?? g.proposed.filingNumber) &&
        `${fieldLabel("FILN")}: ${meta?.filingNumber ?? g.proposed.filingNumber}`,
      (meta?.dateRange ?? g.proposed.dateRange) && `${fieldLabel("DATE")}: ${meta?.dateRange ?? g.proposed.dateRange}`,
    ]
      .filter(Boolean)
      .join("\n");
  };

  const hasReshape = reshapeReport.groups.length > 0;
  const hasDups = dupReport.groups.length > 0;
  const hasRegroup = regroupReport.groups.length > 0;
  const nothingSelected =
    selectedGroups.length === 0 && selectedDupGroups.length === 0 && selectedRegroupGroups.length === 0;

  // The page's one primary action, on the head of the first list it acts on —
  // where Geocoding and Naming keep theirs. It covers every section, so it is
  // rendered once: on the links list when there is one, else on the duplicates,
  // else on the repositories. Its count says how many groups will change; the
  // summary above already spells out what the file holds, so nothing repeats it.
  const otherSelected = selectedDupGroups.length + selectedRegroupGroups.length;
  const applyAction = (
    <>
      <button className="nav-btn primary tools-run" onClick={apply} disabled={nothingSelected}>
        {/* Named after what it will actually do to the ticked rows: convert
            links into sources, merge duplicates away, gather sources under
            their repository — or, with more than one list in play, the lot at
            once, which only "apply" covers. */}
        {otherSelected === 0
          ? t("tools.sources.applyConvert", { count: selectedGroups.length })
          : selectedGroups.length === 0 && selectedRegroupGroups.length === 0
            ? t("tools.sources.applyMerge", { count: selectedDupGroups.length })
            : selectedGroups.length === 0 && selectedDupGroups.length === 0
              ? t("tools.sources.applyRegroup", { count: selectedRegroupGroups.length })
              : t("tools.sources.cleanupApply", { count: selectedGroups.length + otherSelected })}
      </button>
    </>
  );

  // What the run did and what is happening now, kept out of the lists: an
  // apply that clears the page takes every section with it, and the receipt
  // must not go down with them.
  const runStatus = (applied > 0 || scanning) && (
    <p className="tools-fix-hint tools-cleanup-status">
      {applied > 0 && t("tools.sources.cleanupApplied", { count: applied })}
      {/* The lists empty out while the file is read again — said plainly, so a
          page that has gone quiet does not read as a page that lost its work. */}
      {scanning && (
        <>
          {applied > 0 && " "}
          <span className="spinner" aria-hidden="true" /> {t("tools.running")}
        </>
      )}
    </p>
  );

  return (
    <>
      {/* Which page this is, beside the way back from it, with the file's own
          totals on the right — the shape every Tools sub-page shares. */}
      <div className="tools-filter-row">
        <BackButton label={t("tools.sources.dupBack")} shortcutHint="Esc" showLabel onClick={onBack} />
        <h2 className="tools-page-title">{t("tools.sources.cleanupToggle")}</h2>
        <ToolSummary>
          {[
            hasReshape &&
              t("tools.sources.reshapeFound", {
                links: visibleGroups.reduce((n, g) => n + g.members.length, 0),
                groups: visibleGroups.length,
              }),
            hasDups && t("tools.sources.dupFound", { count: dupReport.groups.length }),
            hasRegroup && t("tools.sources.regroupFound", { count: regroupReport.total }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </ToolSummary>
      </div>

      {runStatus}

      {hasReshape && (
        <section className="tools-cleanup-section">
          {/* No heading of its own: the page is called Organize sources, the
              summary counts its groups, and the paragraph below says what the
              list holds — a fourth telling would only repeat them. */}
          <div className="tools-dup-kind-head">
            <div className="tools-dup-bulk">
              {applyAction}
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
            <label className="tools-reshape-site" title={t("tools.sources.tidyLinksHint")}>
              <input type="checkbox" checked={tidyLinks} onChange={() => setTidyLinks((v) => !v)} />
              {t("tools.sources.tidyLinks")}
            </label>
            <QuaySelect value={quay} onChange={setQuay} />
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
                // Only groups whose source fields the apply writes are
                // hand-editable — a reused real-titled source is left alone.
                onEdit={!g.existingSourceXref || g.urlTitled ? () => setEditGroup(g) : undefined}
                removeMarked={removeMarked.has(g.id)}
                onToggleRemove={() => toggleIn(setRemoveMarked)(g.id)}
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
              {!hasReshape && applyAction}
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
                      dataset={dataset}
                      checked={!dupExcluded.has(g.id)}
                      survivorXref={survivors.get(g.id) ?? defaultSurvivor(g)}
                      open={expanded.has(g.id)}
                      onToggleCheck={() => toggleDupGroup(g.id)}
                      onToggleOpen={() => toggleExpand(g.id)}
                      onChooseSurvivor={(xref) => setSurvivors((m) => new Map(m).set(g.id, xref))}
                      onNavigate={onNavigate}
                      onEditRecord={onEditRecord}
                    />
                  ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {hasRegroup && (
        <section className="tools-cleanup-section">
          <div className="tools-dup-kind-head">
            {t("tools.sources.regroupHeading")}
            <span className="tools-chip-count">{regroupReport.groups.length}</span>
            <div className="tools-dup-bulk">
              {!hasReshape && !hasDups && applyAction}
              <button className="tools-issue-link" onClick={() => setRegroupExcluded(new Set())}>
                {t("tools.sources.dupSelectAll")}
              </button>
              <button
                className="tools-issue-link"
                onClick={() => setRegroupExcluded(new Set(regroupReport.groups.map((g) => g.id)))}
              >
                {t("tools.sources.dupSelectNone")}
              </button>
            </div>
          </div>
          <p className="tools-intro">{t("tools.sources.regroupIntro")}</p>
          <ul className="tools-tree">
            {regroupReport.groups.map((group) => (
              <RegroupRow
                key={group.id}
                group={group}
                checked={!regroupExcluded.has(group.id)}
                open={expanded.has(`repo:${group.id}`)}
                onToggleCheck={() => toggleRegroupGroup(group.id)}
                onToggleOpen={() => toggleExpand(`repo:${group.id}`)}
                onNavigate={onNavigate}
                onEditRecord={onEditRecord}
                t={t}
              />
            ))}
          </ul>
        </section>
      )}

      {editGroup && (
        <GroupEditDialog
          key={editGroup.id}
          group={editGroup}
          meta={folded.enrichment.get(editGroup.id)}
          resolvePlace={resolvePlace}
          onSave={(meta) => setEnrichment((prev) => new Map(prev).set(editGroup.id, meta))}
          onClose={() => setEditGroup(null)}
        />
      )}
    </>
  );
}

/** Manual editor for one group's source fields. Saved values land in the same
 *  per-group enrichment map fetched metadata uses, so the list title, badge
 *  tooltip and apply all pick them up — and the fetch skips the group
 *  afterwards (the user's edits win). Clearing a field writes nothing. */
function GroupEditDialog({
  group,
  meta,
  resolvePlace,
  onSave,
  onClose,
}: {
  group: ReshapeGroup;
  /** The group's fetched/edited metadata so far — the editor's baseline. */
  meta: ReshapeMeta | undefined;
  resolvePlace: (place: string | undefined) => string | undefined;
  onSave: (meta: ReshapeMeta) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [fields, setFields] = useState(() => ({
    title: meta?.title ?? group.proposed.title,
    author: meta?.author ?? group.proposed.author ?? "",
    agency: meta?.agency ?? group.proposed.agency ?? "",
    place: resolvePlace(meta?.place ?? group.proposed.place) ?? "",
    filingNumber: meta?.filingNumber ?? group.proposed.filingNumber ?? "",
    dateRange: meta?.dateRange ?? group.proposed.dateRange ?? "",
    // Which entry of the source this is — "Entry for Anna Rakar and Martin
    // Sadec, 9 July 1901". It belongs to the citation, so it is offered only
    // where the group is a single link and there is one citation to carry it.
    page: meta?.page ?? group.members[0]?.page ?? group.pages[0] ?? "",
  }));
  // The page is the citation's, not the source's — editable here only where
  // every reference in the group points at one link, and so shares it. A group
  // spanning several links (a book's pages) carries a page per member instead,
  // shown on the member's own row.
  const onePage = new Set(group.members.map((m) => linkKey(m.url))).size <= 1;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // A citation pasted from the site itself (FamilySearch's "Copy citation",
  // whose record pages no lookup can reach) fills the fields in one go. Only
  // what it actually names is written — the rest of the form stands.
  const [pasted, setPasted] = useState("");
  /** What a pasted citation says beyond the six editable fields: the register
   *  type (which decides the event a citation lands on) and, for a group that
   *  is one link, which entry of the source it is. */
  const [citedExtras, setCitedExtras] = useState<ReshapeMeta | undefined>();
  function fillFromCitation(text: string) {
    setPasted(text);
    const cited = parsePastedFsCitation(text);
    const generic = cited ? undefined : parseSourceInput(text);
    setCitedExtras(
      cited && {
        bookType: cited.bookType,
        collection: cited.collection,
        // A page belongs to a link; a group spanning several would stamp every
        // citation with one record's entry.
        page: onePage ? cited.page : undefined,
      },
    );
    const take = (was: string, ...found: (string | undefined)[]) => found.find((v) => v?.trim())?.trim() ?? was;
    setFields((f) => ({
      title: take(f.title, cited?.title, generic?.title),
      author: take(f.author, cited?.author, generic?.author),
      agency: take(f.agency, cited?.agency, generic?.publisher),
      place: take(f.place, resolvePlace(cited?.place ?? generic?.place)),
      filingNumber: take(f.filingNumber, cited?.filingNumber),
      dateRange: take(f.dateRange, cited?.dateRange),
      page: onePage ? take(f.page, cited?.page) : f.page,
    }));
  }

  const field = (key: keyof typeof fields, labelKey: string, autoFocus = false) => (
    <label className="add-source-field">
      <span>{t(labelKey)}</span>
      <input
        className="edit-input"
        autoFocus={autoFocus}
        value={fields[key]}
        onChange={(e) => setFields((f) => ({ ...f, [key]: e.target.value }))}
      />
    </label>
  );

  function save() {
    onSave({
      ...meta,
      ...citedExtras,
      // A blanked title falls back to the proposal — sources need one; the
      // other fields keep the emptied value, which the apply then omits.
      title: fields.title.trim() || group.proposed.title,
      author: fields.author.trim(),
      agency: fields.agency.trim(),
      place: fields.place.trim(),
      filingNumber: fields.filingNumber.trim(),
      dateRange: fields.dateRange.trim(),
      ...(onePage ? { page: fields.page.trim() } : {}),
    });
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal add-source-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("editSource.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>
            <span className="add-source-badge" aria-hidden="true">{SITE_ICON[group.site]}</span>
            {t("editSource.title")}
          </h2>
          <button className="modal-close" onClick={onClose} title={t("help.close")} aria-label={t("help.close")}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <label className="add-source-field">
            <span>{t("tools.sources.pasteCitation")}</span>
            {/* Focused on open: the dialog's fastest path is pasting a copied
                citation straight in, no click first. */}
            <textarea
              className="edit-input add-source-textarea"
              rows={2}
              autoFocus
              placeholder={t("addSource.placeholder")}
              value={pasted}
              onChange={(e) => fillFromCitation(e.target.value)}
            />
          </label>
          {field("title", "addSource.field.title")}
          <div className="add-source-details-grid">
            {field("author", "addSource.field.author")}
            {field("agency", "addSource.field.agency")}
            {field("place", "addSource.field.place")}
            {field("filingNumber", "addSource.field.filingNumber")}
            {field("dateRange", "addSource.field.dateRange")}
            {onePage && field("page", "addSource.field.page")}
          </div>
        </div>
        <div className="add-source-actions">
          <button className="nav-btn" onClick={onClose}>
            {t("addSource.cancel")}
          </button>
          <button className="nav-btn primary" onClick={save}>
            {t("editSource.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One book/grave/film group: checkbox, title, badges, and expandable members. */
function ReshapeGroupRow({
  group,
  title,
  badgeTooltip,
  checked,
  open,
  onEdit,
  removeMarked,
  onToggleRemove,
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
  /** Opens the manual field editor; absent for reused real-titled sources. */
  onEdit?: () => void;
  /** The group is marked "remove references" — apply strips its links. */
  removeMarked: boolean;
  onToggleRemove: () => void;
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
        <span
          className={`tools-tree-label clickable${removeMarked ? " tools-reshape-removed" : ""}`}
          onClick={onToggleOpen}
          title={linkTooltip(group.bookUrl, t)}
        >
          {SITE_ICON[group.site]} {title}
        </span>
        <a className="tools-tree-meta" href={group.bookUrl} target="_blank" rel="noreferrer" title={linkTooltip(group.bookUrl, t)}>
          ↗
        </a>
        {group.bookType !== "unknown" && (
          <span className="tools-tree-meta">{t(`tools.sources.reshapeType.${group.bookType}`)}</span>
        )}
        {group.pages.length > 0 && (
          <span className="tools-tree-meta">{t("tools.sources.reshapePages", { count: group.pages.length })}</span>
        )}
        {/* A record page no lookup can reach — the paste box in ✎ is the way
            its details arrive, and this row is exactly where to say so. */}
        {group.site === "familysearch" && !removeMarked && !isFetchableSite(group.site, group.bookUrl) && (
          <span className="tools-tree-meta" title={t("tools.sources.fsSigninHint")}>
            🔒 {t("tools.sources.fsSignin")}
          </span>
        )}
        {removeMarked ? (
          <span className="tools-reshape-badge remove" title={t("tools.sources.reshapeRemoveHint")}>
            {t("tools.sources.reshapeRemoveBadge")}
          </span>
        ) : group.existingSourceXref ? (
          <span className="tools-reshape-badge reuse" title={badgeTooltip}>
            {t("tools.sources.reshapeReuses")}
          </span>
        ) : (
          <span className="tools-reshape-badge new" title={badgeTooltip}>
            {t("tools.sources.reshapeNew")}
          </span>
        )}
        {onEdit && !removeMarked && (
          <button className="tools-issue-link" onClick={onEdit} title={t("editSource.title")}>
            ✎
          </button>
        )}
        <button
          className="tools-issue-link"
          onClick={onToggleRemove}
          aria-pressed={removeMarked}
          title={t(removeMarked ? "tools.sources.reshapeRemoveUndo" : "tools.sources.reshapeRemoveHint")}
        >
          {removeMarked ? "↩" : "🗑"}
        </button>
        {/* The count is the expand toggle, as in the geocoding and naming
            lists: the persons it counts are the member rows below. */}
        <button
          className="tools-chip-count tools-count-toggle"
          aria-pressed={open}
          aria-expanded={open}
          title={t("tools.sources.reshapeCountToggle")}
          onClick={onToggleOpen}
        >
          {group.members.length}
        </button>
      </div>
      {open && (
        <div className="tools-tree-children">
          <ul className="tools-dup-members">
            {group.members.map((m, i) => (
              <MemberRow
                key={`${m.recordXref}:${i}`}
                member={m}
                groupUrlKey={linkKey(group.bookUrl)}
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
  groupUrlKey,
  relocate,
  defaultQuay,
  quay,
  onQuay,
  dataset,
  onNavigate,
}: {
  member: ReshapeOccurrence;
  /** The group's canonical link identity — a member whose URL matches it
   *  (same page for everyone) doesn't repeat the header's ↗. */
  groupUrlKey: string;
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
        <SelectMenu
          className="tools-quay-mini"
          value={quay}
          onChange={onQuay}
          title={t("tools.sources.reshapeQuayHint")}
          options={[
            {
              value: "",
              label: defaultQuay
                ? `${defaultQuay} – ${t(`tools.sources.reshapeQuay.${defaultQuay}`)}`
                : t("tools.sources.reshapeQuay.none"),
            },
            ...["3", "2", "1", "0"].map((q) => ({
              value: q,
              label: `${q} – ${t(`tools.sources.reshapeQuay.${q}`)}`,
            })),
          ]}
        />
      )}
      {linkKey(m.url) !== groupUrlKey && (
        <a className="tools-tree-meta" href={m.url} target="_blank" rel="noreferrer" title={linkTooltip(m.url, t)}>
          ↗
        </a>
      )}
    </li>
  );
}

/** One duplicate group: a checkbox to include it in the fix, the shared
 *  link/title, and an expandable list of its members with a radio to pick which
 *  record to keep (the rest fold into it). */
function DupGroupRow({
  group,
  dataset,
  checked,
  survivorXref,
  open,
  onToggleCheck,
  onToggleOpen,
  onChooseSurvivor,
  onNavigate,
  onEditRecord,
}: {
  group: DupGroup;
  dataset: Dataset;
  checked: boolean;
  survivorXref: string;
  open: boolean;
  onToggleCheck: () => void;
  onToggleOpen: () => void;
  onChooseSurvivor: (xref: string) => void;
  onNavigate: (id: string) => void;
  onEditRecord?: (xref: string, kind: "source" | "repo") => void;
}) {
  const { t } = useTranslation();
  // The header count is the people toggle, as the counts in the geocoding and
  // naming lists are: clicking it opens the persons whose records cite this
  // group (and the row with them). A repository's citers are `SOUR` records,
  // not persons, so its count stays plain.
  const [peopleOpen, setPeopleOpen] = useState(false);
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
        {group.kind === "repo" ? (
          <span className="tools-chip-count">{group.members.length}</span>
        ) : (
          <button
            className="tools-chip-count tools-count-toggle"
            aria-pressed={peopleOpen}
            title={t("tools.sources.dupUsageToggle")}
            onClick={() => {
              const next = !peopleOpen;
              setPeopleOpen(next);
              if (next && !open) onToggleOpen();
            }}
          >
            {group.members.length}
          </button>
        )}
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
                  <RowLink url={m.detail ?? group.label} t={t} />
                  {group.kind !== "media" && (
                    <RowEdit xref={m.xref} kind={group.kind === "repo" ? "repo" : "source"} onEditRecord={onEditRecord} t={t} />
                  )}
                </li>
              );
            })}
          </ul>
          {peopleOpen && (
            <DupGroupUses dataset={dataset} xrefs={group.members.map((m) => m.xref)} onNavigate={onNavigate} />
          )}
        </div>
      )}
    </li>
  );
}

/** One country's regroup: a checkbox to include it, the repository its sources
 *  join, and an expandable list of the sources moving — each with the record it
 *  hangs off today, and a mark on the repositories the move empties. */
function RegroupRow({
  group,
  checked,
  open,
  onToggleCheck,
  onToggleOpen,
  onNavigate,
  onEditRecord,
  t,
}: {
  group: RepoRegroupGroup;
  checked: boolean;
  open: boolean;
  onToggleCheck: () => void;
  onToggleOpen: () => void;
  onNavigate: (id: string) => void;
  onEditRecord?: (xref: string, kind: "source" | "repo") => void;
  t: Translate;
}) {
  return (
    <li className="tools-tree-node">
      <div className="tools-tree-row">
        <input type="checkbox" className="tools-dup-check" checked={checked} onChange={onToggleCheck} />
        <button className={`tools-pair-toggle ${open ? "open" : ""}`} onClick={onToggleOpen} aria-expanded={open}>
          ▶
        </button>
        <span className="tools-tree-label clickable" onClick={onToggleOpen} title={group.repoName}>
          {group.repoName}
        </span>
        <span className="tools-chip-count">{group.moves.length}</span>
        {group.targetXref && <RowEdit xref={group.targetXref} kind="repo" onEditRecord={onEditRecord} t={t} />}
        <span className="tools-tree-meta">
          {group.targetXref
            ? t("tools.sources.regroupExisting")
            : t("tools.sources.regroupNew")}
          {group.emptied.length > 0 && ` · ${t("tools.sources.regroupEmptied", { count: group.emptied.length })}`}
        </span>
      </div>
      {open && (
        <div className="tools-tree-children">
          <ul className="tools-dup-members">
            {group.moves.map((move) => (
              <li key={move.sourceXref} className="tools-dup-member">
                <span className="tools-dup-title clickable" onClick={() => onNavigate(move.sourceXref)}>
                  {move.title}
                </span>
                {/* Where it hangs today — which of them the move empties is
                    the header's count, not a mark on every row. */}
                <span className="tools-tree-meta">{move.fromName ?? t("tools.sources.noRepo")}</span>
                <RowEdit xref={move.sourceXref} kind="source" onEditRecord={onEditRecord} t={t} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** The persons citing a duplicate group's records, resolved only when its
 *  count is opened — a whole-file pointer walk has no place in the row render. */
function DupGroupUses({
  dataset,
  xrefs,
  onNavigate,
}: {
  dataset: Dataset;
  xrefs: string[];
  onNavigate: (id: string) => void;
}) {
  const uses = useMemo(() => recordCitedBy(dataset, xrefs), [dataset, xrefs]);
  return (
    <div className="tools-dup-uses">
      <UsageList dataset={dataset} uses={uses} onNavigate={onNavigate} />
    </div>
  );
}

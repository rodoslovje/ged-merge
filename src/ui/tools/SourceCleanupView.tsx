import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { linkTooltip, safeLinkHref } from "../FieldValue";
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
  proposedSiteRepo,
  recognizeSourceUrl,
  reshapeOptionsFromOverrides,
  type RecognizedSourceUrl,
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
import { type PageMediaGroup, type PageMediaReport } from "../../tools/pageMediaCheck";
import type { Translate } from "../../locales/i18n";
import type { RecordPatch } from "../historyTypes";
import { familySpouses, recordCitedBy } from "../../tools/sources";
import { personMatches, TreeSearch, UsageList, useDebounced, usePersonNameIndex } from "./shared";
import { foldSearch, queryTerms } from "../globalSearch";
import { PersonLink } from "../PersonLink";
import { detectSourceCoverage, repoLinkWanted, sourceTooltip } from "../../gedcom/source";
import { idField } from "../source/standardFields";
import { SourceDialogShell } from "../source/SourceDialogShell";
import { SourceLinkRow } from "../source/SourceLinkRow";
import { SourceFieldsForm, type SourceFormValues } from "../source/SourceFieldsForm";
import { useSourceLookup } from "../source/useSourceLookup";
import { childText } from "../../gedcom/node";
import { parseSourceInput } from "../../gedcom/citationParse";
import { fetchPageHtml } from "../../normalize/urlMetadata";
import { familySearchPageUrl, linkKey } from "../../normalize/links";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { BackButton } from "../BackButton";
import { SelectMenu } from "../DropdownMenu";
import { useSettings } from "../SettingsContext";
import { ToolSummary } from "./ToolSummary";

const SITES: readonly ReshapeSite[] = ALL_SITES;
const QUAY_CHOICES = ["", "3", "2", "1", "0"];

/** The page's lists, in the order their tabs stand. */
const CLEANUP_TABS = ["dups", "repos", "links", "pages"] as const;
type CleanupTab = (typeof CLEANUP_TABS)[number];

const DUP_KINDS: DupKind[] = ["media", "source", "repo"];
const DUP_KIND_ICON: Record<DupKind, string> = { media: "🖼", source: "📚", repo: "🏛" };

/** The ↗ that opens a row's page, shown only where the row really has one —
 *  the same affordance the Sources tree and the person cards carry. What counts
 *  as a page is `safeLinkHref`'s to say: a filing number, a source's title or a
 *  scan's local filename gets no arrow rather than a dead one. Every row of
 *  this view draws its arrow here — the reshape rows pass their own class. */
function RowLink({ url, t, className = "tools-tree-link" }: { url: string | undefined; t: Translate; className?: string }) {
  const href = safeLinkHref(url);
  if (!href) return null;
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer" title={linkTooltip(url!, t)}>
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
  pageMediaReport,
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
  /** Citations whose record does not link the page image their source holds —
   *  empty where the file keeps page images under the source alone. */
  pageMediaReport: PageMediaReport;
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
  // Which site's links the list shows — the geocoding page's chip row, and the
  // same rule: one chip at a time, "All" the way back. Converting one site at a
  // time keeps the change reviewable, so the first site with hits leads and the
  // generic "other" links are never what a reader lands on.
  const [site, setSite] = useState<ReshapeSite | null>(
    () => SITES.find((s) => s !== "other" && reshapeReport.bySite[s] > 0) ?? null,
  );
  const sites = useMemo<Set<ReshapeSite>>(
    () => new Set(site ? [site] : SITES.filter((s) => reshapeReport.bySite[s] > 0)),
    [site, reshapeReport],
  );
  /** Which list is on screen. The four kinds of work this page does are four
   *  lists, and stacked they buried each other: a file with hundreds of pages
   *  to link put every other list — and the run button with them — a long
   *  scroll away. Tabs, as on the geocoding page, and only for the lists that
   *  have something in them. */
  const [tab, setTab] = useState<CleanupTab | null>(null);
  const [search, setSearch] = useState("");
  const query = foldSearch(useDebounced(search.trim()));
  const terms = useMemo(() => queryTerms(query), [query]);
  const personNames = usePersonNameIndex(dataset);
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
  /** Links the reader put in a group's place (group id → link): a FamilySearch
   *  record page traded for the image behind it. The lookup, the row and the
   *  apply all read the traded link where there is one. */
  const [urlSwaps, setUrlSwaps] = useState<Map<string, string>>(new Map());
  /** Groups marked "remove references" — the apply strips their links (dead
   *  URLs) instead of converting them into sources. */
  const [removeMarked, setRemoveMarked] = useState<Set<string>>(new Set());
  const [fetching, setFetching] = useState<{ done: number; total: number } | null>(null);
  /** Books the last fetch run could not retrieve (relay down / blocked). */
  const [fetchFailed, setFetchFailed] = useState(0);
  /** Records the last apply changed — the run's own receipt, cleared as soon
   *  as the re-scan brings a fresh report in. */
  const [applied, setApplied] = useState(0);
  // Duplicates and repositories are ticked into a run rather than out of one:
  // both merge records away, and a page that arrives with every group armed
  // makes one stray click a file-wide change. Empty to start; Select all is
  // one click for the reader who wants the lot.
  const [dupSelected, setDupSelected] = useState<Set<string>>(new Set());
  const [survivors, setSurvivors] = useState<Map<string, string>>(new Map());
  const [regroupSelected, setRegroupSelected] = useState<Set<string>>(new Set());
  const [pageMediaSelected, setPageMediaSelected] = useState<Set<string>>(new Set());

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
  const toggleDupGroup = toggleIn(setDupSelected);
  const toggleRegroupGroup = toggleIn(setRegroupSelected);
  const togglePageMediaGroup = toggleIn(setPageMediaSelected);

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
  /** Whether a row survives the filter box: any of the words it shows, or the
   *  name of a person it concerns. A blank box keeps everything. */
  const matches = useCallback(
    (people: readonly string[] | undefined, ...text: (string | undefined)[]) => {
      if (!query) return true;
      if (text.some((v) => v && foldSearch(v).includes(query))) return true;
      return personMatches(people, personNames, terms);
    },
    [query, terms, personNames],
  );

  const visibleGroups = useMemo(
    () =>
      folded.report.groups.filter(
        (g) =>
          sites.has(g.site) &&
          matches(
            g.members.map((m) => m.recordXref),
            g.proposed.title,
            g.existingSourceTitle,
            g.bookUrl,
            ...g.members.map((m) => m.recordLabel),
          ),
      ),
    [folded, sites, matches],
  );
  /** The other three lists, narrowed by the same box. Duplicates and
   *  repositories are searched by what their rows say — the people citing a
   *  duplicate are resolved only when a row is opened (a whole-file pointer
   *  walk), and doing that for every row on every keystroke is not a filter,
   *  it is a freeze. */
  const visibleDupGroups = useMemo(
    () =>
      dupReport.groups.filter((g) =>
        matches(undefined, g.label, ...g.members.flatMap((m) => [m.title, m.detail, m.url])),
      ),
    [dupReport, matches],
  );
  const visibleRegroupGroups = useMemo(
    () =>
      regroupReport.groups.filter((g) =>
        matches(undefined, g.repoName, ...g.moves.flatMap((m) => [m.title, m.fromName])),
      ),
    [regroupReport, matches],
  );
  const visiblePageMediaGroups = useMemo(
    () =>
      pageMediaReport.groups.filter((g) =>
        matches([...g.missing, ...g.unfiled].map((m) => m.recordXref), g.title),
      ),
    [pageMediaReport, matches],
  );

  /** How many rows each chip would show — the groups themselves, read off the
   *  very list the rows come from, so the chip and the list can never disagree. */
  const groupsBySite = useMemo(() => {
    const bySite: Partial<Record<ReshapeSite, number>> = {};
    for (const g of folded.report.groups) bySite[g.site] = (bySite[g.site] ?? 0) + 1;
    return { all: folded.report.groups.length, bySite };
  }, [folded]);
  // A traded link, keyed by the link it replaces: the trade rides on each
  // occurrence rather than the group, so it still finds its references after
  // the pages of one film are folded into a single book. The page comes with
  // it — the one the editor settled on, in place of the number read off the
  // link that left.
  const swapByLink = useMemo(() => {
    const map = new Map<string, { url: string; page: string | undefined }>();
    for (const g of reshapeReport.groups) {
      const url = urlSwaps.get(g.id);
      if (url) map.set(linkKey(g.bookUrl), { url, page: enrichment.get(g.id)?.page });
    }
    return map;
  }, [reshapeReport, urlSwaps, enrichment]);
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
            const swap = swapByLink.get(linkKey(m.url));
            const withQuay = override ? { ...m, quay: override } : m;
            return swap ? { ...withQuay, swapUrl: swap.url, page: swap.page } : withQuay;
          }),
        })),
    [visibleGroups, excluded, quayOverrides, quay, removeMarked, swapByLink],
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
  // A link traded in the ✎ editor is the one looked up — that trade is what
  // turns a page no lookup reaches into one it does.
  const linkOf = useCallback((g: ReshapeGroup) => urlSwaps.get(g.id) ?? g.bookUrl, [urlSwaps]);
  // A FamilySearch page nothing but its own link names — a record page or a
  // catalog film, which no lookup reaches — would convert into a source called
  // after the ark and nothing more. Such a row arrives unticked: paste its
  // citation, or trade the link for the image behind it (✎), and it joins the
  // run. Everything else is ticked as before.
  const heldBack = useCallback(
    (g: ReshapeGroup) =>
      g.site === "familysearch" &&
      !g.existingSourceXref &&
      !isFetchableSite(g.site, linkOf(g)) &&
      !folded.enrichment.has(g.id) &&
      // Nothing beyond the link named it: the title is the one the bare link
      // alone proposes, so no citation text around it said more.
      recognizeSourceUrl(g.bookUrl)?.proposed.title === g.proposed.title,
    [linkOf, folded],
  );
  // Seeded into the unticked set as each fresh scan lands, so the tick is an
  // ordinary tick from there on — the editor unticks nothing back.
  const heldBackIds = useMemo(
    () => new Set(reshapeReport.groups.filter(heldBack).map((g) => g.id)),
    // The list is the scan's, read once per scan: re-running it as the reader
    // fills groups in would re-untick rows they have since ticked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reshapeReport],
  );
  useEffect(() => {
    if (heldBackIds.size) setExcluded((prev) => new Set([...prev, ...heldBackIds]));
  }, [heldBackIds]);
  /** How many rows on screen are waiting like that — the count falls as they
   *  are filled in, and the reader can tick any of them anyway. */
  const heldBackCount = visibleGroups.filter((g) => excluded.has(g.id) && heldBack(g)).length;

  /** Rows holding a traded link — a folded book among them, where the trade
   *  was made on one of the pages it now gathers. */
  const swappedRows = useMemo(() => {
    const ids = new Set<string>();
    for (const id of urlSwaps.keys()) ids.add(folded.keyOf.get(id) ?? id);
    return ids;
  }, [urlSwaps, folded]);
  const fetchableGroups = reshapeReport.groups
    .filter(
      (g) =>
        sites.has(g.site) &&
        !excluded.has(folded.keyOf.get(g.id) ?? g.id) &&
        (!g.existingSourceXref || g.urlTitled || g.site === "familysearch") &&
        !removeMarked.has(g.id) &&
        !enrichment.has(g.id) &&
        isFetchableSite(g.site, linkOf(g)),
    )
    .map((g) => (urlSwaps.has(g.id) ? { ...g, bookUrl: urlSwaps.get(g.id)! } : g));

  const selectedDupGroups = dupReport.groups
    .filter((g) => dupSelected.has(g.id))
    .map((g) => withSurvivor(g, survivors.get(g.id) ?? defaultSurvivor(g)));

  const selectedRegroupGroups = regroupReport.groups.filter((g) => regroupSelected.has(g.id));

  const selectedPageMediaGroups = pageMediaReport.groups.filter((g) => pageMediaSelected.has(g.id));

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
      selectedPageMediaGroups,
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
  const hasPageMedia = pageMediaReport.groups.length > 0;

  // Whether a tab is offered at all — a tab that opens an empty list is a
  // promise the page cannot keep — read from the *unfiltered* lists, so typing
  // in the box never makes the tabs jump about under the reader's hand.
  const openTabs = CLEANUP_TABS.filter(
    (k) =>
      ({ dups: hasDups, repos: hasRegroup, links: hasReshape, pages: hasPageMedia })[k],
  );
  // What each list holds altogether — a tab says how much work is in it, not
  // how much of it a chip or the filter box is letting through. What those
  // leave is the section's own count, and the chips' own.
  const tabCounts: Record<CleanupTab, number> = {
    dups: dupReport.groups.length,
    repos: regroupReport.groups.length,
    links: groupsBySite.all,
    pages: pageMediaReport.groups.length,
  };
  /** The rows each tab is showing, by the key its disclosure state uses. */
  const shownIds: Record<CleanupTab, string[]> = {
    dups: visibleDupGroups.map((g) => g.id),
    repos: visibleRegroupGroups.map((g) => `repo:${g.id}`),
    links: visibleGroups.map((g) => g.id),
    pages: visiblePageMediaGroups.map((g) => g.id),
  };
  /** Tick or untick everything the open tab shows — the filter's doing is
   *  respected: what a chip or the box has hidden is not silently ticked. */
  const selectShown = (all: boolean) => {
    if (!activeTab) return;
    if (activeTab === "links") {
      // This list is kept the other way round: every group converts unless it
      // is excluded, so "none" excludes what is on screen and "all" clears it.
      setExcluded((prev) => {
        const next = new Set(prev);
        for (const id of shownIds.links) if (all) next.delete(id); else next.add(id);
        return next;
      });
      return;
    }
    const setter =
      activeTab === "dups" ? setDupSelected : activeTab === "repos" ? setRegroupSelected : setPageMediaSelected;
    const ids =
      activeTab === "dups"
        ? visibleDupGroups.map((g) => g.id)
        : activeTab === "repos"
          ? visibleRegroupGroups.map((g) => g.id)
          : visiblePageMediaGroups.map((g) => g.id);
    setter((prev) => {
      const next = new Set(prev);
      for (const id of ids) if (all) next.add(id); else next.delete(id);
      return next;
    });
  };
  const expandShown = (open: boolean) => {
    if (!activeTab) return;
    const ids = shownIds[activeTab];
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const id of ids) if (open) next.add(id); else next.delete(id);
      return next;
    });
  };
  /** The two openers, wherever a list puts its own chips. */
  const expandActions = (
    <>
      <button className="tools-issue-link" onClick={() => expandShown(true)}>
        {t("tools.sources.expandAll")}
      </button>
      <button className="tools-issue-link" onClick={() => expandShown(false)}>
        {t("tools.sources.collapseAll")}
      </button>
    </>
  );

  /** …and what is on screen right now, for the line that says a filter has
   *  emptied the list. */
  const shownCounts: Record<CleanupTab, number> = {
    dups: visibleDupGroups.length,
    repos: visibleRegroupGroups.length,
    links: visibleGroups.length,
    pages: visiblePageMediaGroups.length,
  };
  // The reader's choice while it still has rows; otherwise the first list that
  // does — an apply empties the tab it ran on, and the page must not go blank
  // while three other lists wait behind it.
  const activeTab: CleanupTab | undefined = (tab && openTabs.includes(tab) ? tab : undefined) ?? openTabs[0];
  const nothingSelected =
    selectedGroups.length === 0 &&
    selectedDupGroups.length === 0 &&
    selectedRegroupGroups.length === 0 &&
    selectedPageMediaGroups.length === 0;

  // The page's one primary action, on the head of the first list it acts on —
  // where Geocoding and Naming keep theirs. It covers every section, so it is
  // rendered once: on the links list when there is one, else on the duplicates,
  // else on the repositories. Its count says how many groups will change; the
  // summary above already spells out what the file holds, so nothing repeats it.
  const otherSelected =
    selectedDupGroups.length + selectedRegroupGroups.length + selectedPageMediaGroups.length;
  // Which single list the ticked rows all come from, if they do — the button
  // then says what it will actually do rather than the catch-all "apply".
  const counts = {
    links: selectedGroups.length,
    dups: selectedDupGroups.length,
    repos: selectedRegroupGroups.length,
    pages: selectedPageMediaGroups.length,
  };
  const ticked = (Object.keys(counts) as (keyof typeof counts)[]).filter((k) => counts[k] > 0);
  const onlySelected = ticked.length === 1 ? ticked[0] : undefined;
  // Page images are counted one by one: the rows are sources, but what the
  // button writes is a pointer per citation.
  const pageMediaCount = selectedPageMediaGroups.reduce((n, g) => n + g.missing.length + g.unfiled.length, 0);
  const applyAction = (
    <>
      <button className="nav-btn primary tools-run" onClick={apply} disabled={nothingSelected}>
        {/* Named after what it will actually do to the ticked rows: convert
            links into sources, merge duplicates away, gather sources under
            their repository — or, with more than one list in play, the lot at
            once, which only "apply" covers. */}
        {onlySelected === "links"
          ? t("tools.sources.applyConvert", { count: selectedGroups.length })
          : onlySelected === "dups"
            ? t("tools.sources.applyMerge", { count: selectedDupGroups.length })
            : onlySelected === "repos"
              ? t("tools.sources.applyRegroup", { count: selectedRegroupGroups.length })
              : onlySelected === "pages"
                ? t("tools.sources.applyPageMedia", { count: pageMediaCount })
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
            hasPageMedia && t("tools.sources.pageMediaFound", { count: pageMediaReport.total }),
            pageMediaReport.unfiled > 0 && t("tools.sources.pageUnfiledFound", { count: pageMediaReport.unfiled }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </ToolSummary>
      </div>

      {runStatus}

      {/* The tabs, and the run button beside them: one action for everything
          ticked across the lists, always within reach of the top of the page. */}
      {openTabs.length > 0 && (
        <div className="tools-geo-tabs-row">
          <div className="tools-geo-tabs" role="tablist">
            {openTabs.map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={activeTab === k}
                className={activeTab === k ? "active" : ""}
                onClick={() => setTab(k)}
              >
                {t(`tools.sources.tab.${k}`)} <span className="tools-chip-count">{tabCounts[k]}</span>
              </button>
            ))}
          </div>
          <div className="tools-dup-bulk">
            {applyAction}
            {/* Ticking rows is what the run button acts on, so the two stand
                together — the openers travel with the list instead. */}
            <button className="tools-issue-link" onClick={() => selectShown(true)}>
              {t("tools.sources.dupSelectAll")}
            </button>
            <button className="tools-issue-link" onClick={() => selectShown(false)}>
              {t("tools.sources.dupSelectNone")}
            </button>
          </div>
          {/* One box for whichever list is open. It narrows by what a row says
              — a book's title, a repository's name, a link — and by the name of
              a person the row concerns, which is how a reader looks for "the
              entries for Marija Kovačič" with no title to type. */}
          <TreeSearch value={search} onChange={setSearch} />
        </div>
      )}

      {query && activeTab && shownCounts[activeTab] === 0 && (
        <p className="tools-clean">{t("tools.search.noMatch")}</p>
      )}

      {hasReshape && activeTab === "links" && (
        <section className="tools-cleanup-section">
          {/* No heading of its own: the page is called Organize sources, the
              summary counts its groups, and the paragraph below says what the
              list holds — a fourth telling would only repeat them. */}
          <p className="tools-intro">{t("tools.sources.reshapeIntro")}</p>

          {/* One chip per site, the geocoding pages' filter row. Each count is
              the rows the click shows — books, graves, films — not the links
              inside them: a chip reading 34 above a list of twenty rows is a
              chip that lies, however true the link count is. The links are
              counted in the page summary, where they say something. */}
          <div className="tools-chips">
            <button className={`tools-chip ${site === null ? "active" : ""}`} onClick={() => setSite(null)}>
              {t("tools.geocode.filter.all")} <span className="tools-chip-count">{groupsBySite.all}</span>
            </button>
            {SITES.filter((s) => (groupsBySite.bySite[s] ?? 0) > 0).map((s) => (
              <button
                key={s}
                className={`tools-chip ${site === s ? "active" : ""}`}
                onClick={() => setSite(s)}
              >
                {SITE_ICON[s]} {t(`tools.sources.reshapeSite.${s}`)}{" "}
                <span className="tools-chip-count">{groupsBySite.bySite[s]}</span>
              </button>
            ))}
            {expandActions}
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
            {heldBackCount > 0 && (
              <span className="tools-fix-hint" title={t("tools.sources.fsSigninHint")}>
                {t("tools.sources.heldBack", { count: heldBackCount })}
              </span>
            )}
          </div>

          <ul className="tools-tree">
            {visibleGroups.map((g) => (
              <ReshapeGroupRow
                key={g.id}
                group={g}
                title={groupTitle(g)}
                link={linkOf(g)}
                swapped={swappedRows.has(g.id)}
                badgeTooltip={badgeTooltip(g)}
                checked={!excluded.has(g.id)}
                open={expanded.has(g.id)}
                // Only groups whose source fields the apply writes are
                // hand-editable — a reused real-titled source is left alone.
                // A source this run writes is edited as a proposal — the fields
                // it would create. One the file already keeps has no proposal
                // to edit: its ✎ opens the record itself, in the editor the
                // Sources tree uses. Either way the row carries one.
                onEdit={
                  !g.existingSourceXref || g.urlTitled
                    ? () => setEditGroup(g)
                    : onEditRecord
                      ? () => onEditRecord(g.existingSourceXref!, "source")
                      : undefined
                }
                editsRecord={Boolean(g.existingSourceXref && !g.urlTitled)}
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

      {hasDups && activeTab === "dups" && (
        <section className="tools-cleanup-section">
          <div className="tools-dup-kind-head">
            {t("tools.sources.dupHeading")}
            <span className="tools-chip-count">{visibleDupGroups.length}</span>
            <div className="tools-dup-bulk">{expandActions}</div>
          </div>
          <p className="tools-intro">{t("tools.sources.dupIntro")}</p>

          {DUP_KINDS.filter((k) => visibleDupGroups.some((g) => g.kind === k)).map((kind) => (
            <div key={kind} className="tools-dup-kind">
              <div className="tools-dup-kind-head">
                {DUP_KIND_ICON[kind]} {t(`tools.sources.dupKind.${kind}`)}
                <span className="tools-chip-count">{visibleDupGroups.filter((g) => g.kind === kind).length}</span>
              </div>
              <ul className="tools-tree">
                {visibleDupGroups
                  .filter((g) => g.kind === kind)
                  .map((g) => (
                    <DupGroupRow
                      key={g.id}
                      group={g}
                      dataset={dataset}
                      checked={dupSelected.has(g.id)}
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

      {hasRegroup && activeTab === "repos" && (
        <section className="tools-cleanup-section">
          <div className="tools-dup-kind-head">
            {t("tools.sources.regroupHeading")}
            <span className="tools-chip-count">{visibleRegroupGroups.length}</span>
            <div className="tools-dup-bulk">{expandActions}</div>
          </div>
          <p className="tools-intro">{t("tools.sources.regroupIntro")}</p>
          <ul className="tools-tree">
            {visibleRegroupGroups.map((group) => (
              <RegroupRow
                key={group.id}
                group={group}
                checked={regroupSelected.has(group.id)}
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

      {hasPageMedia && activeTab === "pages" && (
        <section className="tools-cleanup-section">
          <div className="tools-dup-kind-head">
            {t("tools.sources.pageMediaHeading")}
            <span className="tools-chip-count">{visiblePageMediaGroups.length}</span>
            <div className="tools-dup-bulk">{expandActions}</div>
          </div>
          <p className="tools-intro">{t("tools.sources.pageMediaIntro")}</p>
          <ul className="tools-tree">
            {visiblePageMediaGroups.map((group) => (
              <PageMediaRow
                key={group.id}
                group={group}
                dataset={dataset}
                checked={pageMediaSelected.has(group.id)}
                open={expanded.has(group.id)}
                onToggleCheck={() => togglePageMediaGroup(group.id)}
                onToggleOpen={() => toggleExpand(group.id)}
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
          dataset={dataset}
          link={linkOf(editGroup)}
          resolvePlace={resolvePlace}
          onSave={(meta, link) => {
            setEnrichment((prev) => new Map(prev).set(editGroup.id, meta));
            // Filled in by hand, so it is no longer a page nothing names: the
            // row it was held back from joins the run.
            setExcluded((prev) => {
              if (!prev.has(editGroup.id)) return prev;
              const next = new Set(prev);
              next.delete(editGroup.id);
              return next;
            });
            setUrlSwaps((prev) => {
              const next = new Map(prev);
              // Back to the group's own link is no trade at all.
              if (linkKey(link) === linkKey(editGroup.bookUrl)) next.delete(editGroup.id);
              else next.set(editGroup.id, link);
              return next;
            });
          }}
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
  dataset,
  link,
  resolvePlace,
  onSave,
  onClose,
}: {
  group: ReshapeGroup;
  /** The group's fetched/edited metadata so far — the editor's baseline. */
  meta: ReshapeMeta | undefined;
  /** The open file — its repositories are the choices the editor offers. */
  dataset: Dataset;
  /** The link this source is being written from: the group's own, or the one
   *  an earlier visit to this editor put in its place. */
  link: string;
  resolvePlace: (place: string | undefined) => string | undefined;
  onSave: (meta: ReshapeMeta, link: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { settings } = useSettings();
  const [fields, setFields] = useState<SourceFormValues>(() => ({
    title: meta?.title ?? group.proposed.title,
    author: meta?.author ?? group.proposed.author ?? "",
    agency: meta?.agency ?? group.proposed.agency ?? "",
    // Written by the apply from the lookup's answer, so the reader gets to
    // correct them like the rest.
    publisher: meta?.publisher ?? "",
    periodical: meta?.periodical ?? "",
    note: "",
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


  /** The link the source is written from — the group's own until the reader
   *  puts another in its place. Offered only where the group is one link (as
   *  the page is): a book folded out of many images has no single link to
   *  trade. */
  const [url, setUrl] = useState(link);
  /** Fields the reader typed in — a paste or a lookup never overwrites one. */
  const touched = useRef(new Set<keyof typeof fields>());

  // Which repository the source will hang off. The apply decides this on its
  // own — the file's own REPO habit, and the site's repository for the place
  // the records come from — but the decision was made off-screen, so the
  // editor now shows it and takes another answer: one of the file's, the
  // proposal outright, or none.
  const repos = useMemo(
    () =>
      dataset.records
        .filter((r) => r.tag === "REPO" && r.xref)
        .map((r) => ({ xref: r.xref!, name: childText(r, "NAME")?.trim() || r.xref! }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [dataset],
  );
  const wantsRepo = useMemo(
    () => repoLinkWanted(dataset.records, settings.formatOverrides?.sourceLayout),
    [dataset, settings.formatOverrides?.sourceLayout],
  );
  const coverage = useMemo(() => {
    const override = settings.formatOverrides?.sourceCoverage ?? "auto";
    return override !== "auto" ? override : detectSourceCoverage(dataset.records);
  }, [settings.formatOverrides?.sourceCoverage, dataset]);
  /** "" = none, an xref, or "@create@" for the proposal. Starts on what the
   *  apply would do by itself, so leaving it alone changes nothing. */
  const [repoSel, setRepoSel] = useState(meta?.repoXref ?? "");
  /** Whether the reader picked a repository themselves — a later lookup then
   *  improves nothing here, only what the dialog itself put there. */
  const repoTouched = useRef(meta?.repoXref !== undefined);
  // What this file calls the archive's id, and whether that name is an
  // extension: the same rule the Add Source dialog states, from one place.
  const idLabel = idField(dataset.records, coverage, repoSel !== "");
  const { targetOf, lookUp: readPage, fetching, failed } = useSourceLookup(settings.allowLinkFetch);

  // A citation pasted from the site itself (FamilySearch's "Copy citation",
  // whose record pages no lookup can reach) fills the fields in one go, and so
  // does the page behind a pasted link. Only what they actually name is
  // written — a field the reader typed always stands.
  const [pasted, setPasted] = useState("");
  /** What a paste or a lookup says beyond the six editable fields: the register
   *  type (which decides the event a citation lands on), the collection that
   *  names the repository, the book a film's pages share. */
  const [extras, setExtras] = useState<ReshapeMeta | undefined>();

  // Which repository the source will hang off — read from what the dialog
  // *now* holds, not from what it opened with: the place a lookup fills in is
  // exactly what tells a FamilySearch source which country's (or state's)
  // repository it belongs to, so the row has to follow the fetch.
  const repoProposal = useMemo(
    () =>
      proposedSiteRepo(dataset.records, group.site, url.trim() || link, fields.agency || undefined, {
        title: extras?.collection || fields.title || group.proposed.title,
        id: extras?.collectionId,
        place: fields.place || undefined,
      }),
    [dataset, group, url, link, fields.agency, fields.title, fields.place, extras?.collection, extras?.collectionId],
  );
  // …and the choice follows it, until the reader makes one of their own.
  useEffect(() => {
    if (repoTouched.current) return;
    setRepoSel(repoProposal?.xref ?? (wantsRepo && repoProposal?.createName ? "@create@" : ""));
  }, [repoProposal, wantsRepo]);

  /** Fill what the reader has not typed; blank answers leave the field alone. */
  const fill = useCallback((found: Partial<Record<keyof typeof fields, string | undefined>>) => {
    setFields((f) => {
      const next = { ...f };
      for (const [key, value] of Object.entries(found)) {
        const k = key as keyof typeof fields;
        if (!touched.current.has(k) && value?.trim()) next[k] = value.trim();
      }
      return next;
    });
  }, []);

  /** The site lookup a link is worth running, or nothing — an unrecognized
   *  link, and a FamilySearch record page (sign-in only) among them. */
  const lookupTarget = (value: string) => targetOf(value, { readable: true });

  /** Read the page behind a link and fill these fields from what it says. */
  const lookUp = useCallback(
    async (target: RecognizedSourceUrl): Promise<void> => {
      const found = await readPage(target.bookUrl);
      if (!found) return;
      setExtras((prev) => ({ ...prev, ...found }));
      fill({
        title: found.title,
        author: found.author,
        agency: found.agency,
        publisher: found.publisher,
        periodical: found.periodical,
        place: resolvePlace(found.place),
        filingNumber: found.filingNumber,
        dateRange: found.dateRange,
        page: onePage ? found.page ?? target.page : undefined,
      });
    },
    [readPage, fill, resolvePlace, onePage],
  );

  /** Put another link in the source's place. The ids the old link supplied —
   *  its title, its filing number, which page of the source this is — are read
   *  off the new one instead, so nothing of the page being left behind stays
   *  in the fields; the lookup then improves what it can. */
  function relink(next: string) {
    setUrl(next);
    const rec = next.trim() ? recognizeSourceUrl(familySearchPageUrl(next.trim())) : undefined;
    if (!rec || linkKey(rec.bookUrl) === linkKey(url)) return;
    setFields((f) => ({
      ...f,
      title: touched.current.has("title") ? f.title : rec.proposed.title,
      filingNumber: touched.current.has("filingNumber") ? f.filingNumber : rec.proposed.filingNumber ?? "",
      page: !onePage || touched.current.has("page") ? f.page : rec.page ?? "",
    }));
  }

  function fillFromCitation(text: string) {
    setPasted(text);
    const cited = parsePastedFsCitation(text);
    const generic = parseSourceInput(text);
    // A pasted citation carries the page it was copied from: FamilySearch's
    // image citations name the image, and that link is one a lookup can read
    // where the record page it replaces was not.
    if (generic.url) relink(generic.url);
    if (cited) {
      setExtras((prev) => ({
        ...prev,
        bookType: cited.bookType,
        collection: cited.collection,
        book: cited.book,
        // A page belongs to a link; a group spanning several would stamp every
        // citation with one record's entry.
        page: onePage ? cited.page : undefined,
      }));
    }
    fill({
      title: cited?.title ?? generic.title,
      author: cited?.author ?? generic.author,
      agency: cited?.agency ?? generic.publisher,
      place: resolvePlace(cited?.place ?? generic.place),
      filingNumber: cited?.filingNumber,
      dateRange: cited?.dateRange,
      page: onePage ? cited?.page : undefined,
    });
  }

  // A link the reader put in place of the group's own is read the moment it
  // settles — that is the whole point of trading a sign-in-only record page
  // for the image behind it. The group's own link is left to the button: it
  // was already looked up (or is one no lookup reaches), and opening the
  // editor is not a request to go online.
  const settledUrl = useDebounced(url.trim(), 400);
  useEffect(() => {
    if (!settings.allowLinkFetch) return;
    const target = targetOf(settledUrl, { readable: true });
    if (target && linkKey(target.bookUrl) !== linkKey(link)) void lookUp(target);
  }, [settledUrl, link, settings.allowLinkFetch, lookUp, targetOf]);

  function save() {
    onSave(
      {
        ...meta,
        ...extras,
        // A blanked title falls back to the proposal — sources need one; the
        // other fields keep the emptied value, which the apply then omits.
        title: fields.title.trim() || group.proposed.title,
        author: fields.author.trim(),
        agency: fields.agency.trim(),
        publisher: fields.publisher.trim() || undefined,
        periodical: fields.periodical.trim() || undefined,
        place: fields.place.trim(),
        filingNumber: fields.filingNumber.trim(),
        dateRange: fields.dateRange.trim(),
        ...(onePage ? { page: fields.page.trim() } : { page: undefined }),
        repoXref: repoSel,
      },
      onePage ? url.trim() || link : link,
    );
    onClose();
  }

  return (
    <SourceDialogShell
      icon={SITE_ICON[group.site]}
      title={t("editSource.title")}
      t={t}
      onClose={onClose}
      actions={
        <>
          <button className="nav-btn" onClick={onClose}>
            {t("addSource.cancel")}
          </button>
          <button className="nav-btn primary" onClick={save}>
            {t("editSource.save")}
          </button>
        </>
      }
    >
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
          {/* The link the source is written from. Trading it is how a
              FamilySearch record page — sign-in only, so no lookup reaches it
              — becomes the image it was indexed from, which answers with the
              collection, the archive and the film. */}
          {onePage && (
            <SourceLinkRow
              label={t("addSource.field.link")}
              title={t("tools.sources.swapLinkHint")}
              value={url}
              onChange={relink}
              onLookUp={
                lookupTarget(url)
                  ? () => {
                      const target = lookupTarget(url);
                      if (target) void lookUp(target);
                    }
                  : undefined
              }
              fetching={fetching}
              lookupAllowed={settings.allowLinkFetch}
              t={t}
            />
          )}
          {failed && <div className="add-source-hint">{t("tools.sources.lookupFailed")}</div>}
          <SourceFieldsForm
            values={fields}
            onChange={(key, value) => {
              touched.current.add(key);
              setFields((f) => ({ ...f, [key]: value }));
            }}
            // The proposal has no note of its own, and its link has a row of
            // its own above (it can be traded, which a plain URL field cannot
            // say). The page is a citation's, so it is offered only where the
            // group is one link and one citation carries it.
            show={{ note: false, page: onePage }}
            coverage={coverage}
            idOnRepo={idLabel.caln}
            t={t}
            repositoryRow={
              /* Only a source this run creates has a repository to choose —
                 one the file already keeps hangs where it hangs. The call
                 number is written on that link (`REPO > CALN`), so it stands
                 beside it. */
              !group.existingSourceXref ? (
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
                      groups={[
                        { items: [{ value: "", label: t("tools.sources.noRepo") }] },
                        {
                          label: t("tools.sources.dupKind.repo"),
                          items: repos.map((r) => ({ value: r.xref, label: r.name })),
                        },
                        ...(repoProposal?.createName
                          ? [
                              {
                                items: [
                                  {
                                    value: "@create@",
                                    label: t("addSource.repo.create", { name: repoProposal.createName }),
                                  },
                                ],
                              },
                            ]
                          : []),
                      ]}
                    />
                  </label>
                  {idLabel.caln && (
                    <label className="add-source-field">
                      <span>{t("addSource.field.caln")}</span>
                      <input
                        className="edit-input"
                        value={fields.filingNumber}
                        onChange={(e) => {
                          touched.current.add("filingNumber");
                          setFields((f) => ({ ...f, filingNumber: e.target.value }));
                        }}
                      />
                    </label>
                  )}
                </div>
              ) : null
            }
          />
    </SourceDialogShell>
  );
}

/** One book/grave/film group: checkbox, title, badges, and expandable members. */
function ReshapeGroupRow({
  group,
  title,
  link,
  swapped,
  badgeTooltip,
  checked,
  open,
  onEdit,
  editsRecord,
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
  /** The link the source is written from — the group's own, or the one the ✎
   *  editor put in its place. */
  link: string;
  /** Whether a link of this row was traded for another in that editor. */
  swapped: boolean;
  /** Field-per-row summary of the source the group creates or reuses. */
  badgeTooltip: string;
  checked: boolean;
  open: boolean;
  /** Opens the field editor for a proposed source, or — see `editsRecord` —
   *  the record editor for one the file already keeps. */
  onEdit?: () => void;
  /** Whether that ✎ opens the existing record rather than the proposal. */
  editsRecord?: boolean;
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
          title={linkTooltip(link, t)}
        >
          {SITE_ICON[group.site]} {title}
        </span>
        <RowLink url={link} t={t} className="tools-tree-meta" />
        {/* The reader traded this group's link for another in the ✎ editor —
            the media the apply writes carries the new one. */}
        {swapped && !removeMarked && (
          <span className="tools-tree-meta" title={t("tools.sources.swapLinkHint")}>
            ⇄ {t("tools.sources.swapLinkBadge")}
          </span>
        )}
        {group.bookType !== "unknown" && (
          <span className="tools-tree-meta">{t(`tools.sources.reshapeType.${group.bookType}`)}</span>
        )}
        {group.pages.length > 0 && (
          <span className="tools-tree-meta">{t("tools.sources.reshapePages", { count: group.pages.length })}</span>
        )}
        {/* A record page no lookup can reach — the paste box in ✎ is the way
            its details arrive, and this row is exactly where to say so. */}
        {group.site === "familysearch" && !removeMarked && !isFetchableSite(group.site, link) && (
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
          <button
            className="tools-issue-link"
            onClick={onEdit}
            title={editsRecord ? t("tools.sources.editRecordHint") : t("editSource.title")}
          >
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
      {linkKey(m.url) !== groupUrlKey && <RowLink url={m.url} t={t} className="tools-tree-meta" />}
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
                  <RowLink url={m.url} t={t} />
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

/** One source whose citations are missing their page image: a checkbox to
 *  include it, the count of pointers the apply would write, and the citations
 *  themselves — each naming the person, where on the record it sits and which
 *  page it cites. A source that also holds citations no image can be matched to
 *  says so under the list, rather than leaving them out unsaid. */
function PageMediaRow({
  group,
  dataset,
  checked,
  open,
  onToggleCheck,
  onToggleOpen,
  onNavigate,
  onEditRecord,
  t,
}: {
  group: PageMediaGroup;
  dataset: Dataset;
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
        <span className="tools-tree-label clickable" onClick={onToggleOpen} title={group.title}>
          📖 {group.title}
        </span>
        <span className="tools-chip-count">{group.missing.length + group.unfiled.length}</span>
        <RowEdit xref={group.sourceXref} kind="source" onEditRecord={onEditRecord} t={t} />
        <span className="tools-tree-meta">
          {[
            group.missing.length > 0 && t("tools.sources.pageMediaCount", { count: group.missing.length }),
            group.unfiled.length > 0 && t("tools.sources.pageUnfiledCount", { count: group.unfiled.length }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </div>
      {open && (
        <div className="tools-tree-children">
          <ul className="tools-dup-members">
            {group.missing.map((m, i) => {
              // A family's citation links through its spouses, as everywhere
              // else on this page — Edit navigates to persons, not families.
              const famSpouses = dataset.families.has(m.recordXref) ? familySpouses(dataset, m.recordXref) : [];
              return (
                <li key={`${m.recordXref}-${m.eventTag ?? ""}-${m.objeXref}-${i}`} className="tools-dup-member">
                  {famSpouses.length > 0 ? (
                    <span>
                      {famSpouses.map((p, j) => (
                        <span key={p.id}>
                          {j > 0 && <span className="tools-usage-amp">&amp;</span>}
                          <PersonLink dataset={dataset} id={p.id} fallback={p.label} onNavigate={onNavigate} />
                        </span>
                      ))}
                    </span>
                  ) : (
                    <PersonLink dataset={dataset} id={m.recordXref} fallback={m.recordXref} onNavigate={onNavigate} />
                  )}
                  <span className="tools-tree-meta">
                    {m.eventTag ?? t("tools.sources.pageMediaRecord")}
                    {m.page && ` · ${t("tools.sources.pageMediaPage", { page: m.page })}`}
                  </span>
                </li>
              );
            })}
          </ul>
          {group.unfiled.length > 0 && (
            <>
              <p className="tools-fix-hint">{t("tools.sources.pageUnfiledHint")}</p>
              <ul className="tools-dup-members">
                {group.unfiled.map((u, i) => {
                  const famSpouses = dataset.families.has(u.recordXref) ? familySpouses(dataset, u.recordXref) : [];
                  return (
                    <li key={`u-${u.recordXref}-${u.eventTag ?? ""}-${u.objeXref}-${i}`} className="tools-dup-member">
                      {famSpouses.length > 0 ? (
                        <span>
                          {famSpouses.map((p, j) => (
                            <span key={p.id}>
                              {j > 0 && <span className="tools-usage-amp">&amp;</span>}
                              <PersonLink dataset={dataset} id={p.id} fallback={p.label} onNavigate={onNavigate} />
                            </span>
                          ))}
                        </span>
                      ) : (
                        <PersonLink dataset={dataset} id={u.recordXref} fallback={u.recordXref} onNavigate={onNavigate} />
                      )}
                      <span className="tools-tree-meta">
                        {u.eventTag ?? t("tools.sources.pageMediaRecord")}
                        {u.page && ` · ${t("tools.sources.pageMediaPage", { page: u.page })}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {group.ambiguous > 0 && (
            <p className="tools-fix-hint">{t("tools.sources.pageMediaAmbiguous", { count: group.ambiguous })}</p>
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

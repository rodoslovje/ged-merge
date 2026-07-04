import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Dataset } from "../gedcom/types";
import type { NormalizationReport, NormalizeOptions } from "../normalize/types";
import { validateDataset, type ValidationReport, type ValidationIssue, type IssueCategory } from "../tools/validate";
import { countInferableSex } from "../tools/fixSex";
import { countFixableDates } from "../tools/fixDates";
import { validateStructure, type StructureReport, type StructCategory, type StructIssue } from "../tools/structure";
import { collectLocalMediaFiles, type MediaFileUse } from "../tools/mediaFiles";
import { findDuplicates, makeDuplicatePair, type DuplicatePair } from "../tools/duplicates";
import { bulkNormalize } from "../tools/bulkNormalize";
import {
  findLiving,
  privatizeDataset,
  defaultPrivacyOptions,
  type PrivacyOptions,
  type FlaggedPerson,
  type NameStrategy,
  type PrivacyAction,
  type ResnMode,
  type StripCategory,
} from "../tools/privacy";
import { buildSourceTree, type SourceTree, type SourceUse, type RepoGroup, type SourceEntry, type MediaEntry } from "../tools/sources";
import { findSourceDuplicates, dedupeSources, type DuplicateReport, type DupGroup, type DupKind } from "../tools/sourceDuplicates";
import { buildPlaceTree, countDistinctPlaces, type PlaceNode, type PlaceTree, UNSPECIFIED, UNSPECIFIED_PLACE } from "../tools/places";
import { collectPlaceSegments, previewPlaceRename, type PlaceRenamePreview } from "../tools/placeEdit";
import { collectNodeUseIds } from "../tools/places";
import { countryCode } from "../gedcom/countryCode";
import { downloadOptions, ensureUtf8Charset, serializeGedcom } from "../gedcom/serialize";
import { downloadText } from "./download";
import { revealEdgeWhitespace } from "./whitespace";
import { individualFieldRows } from "../review/fields";
import { duplicateDefaults, relatedSeparateRecords } from "../tools/mergeDuplicate";
import { defaultChoice, type CandidateDecision, type FieldChoice, type FieldRow } from "../review/types";
import { type PersonNav } from "./ReadOnlyCompare";
import { isEditableTarget, isModalOpen } from "../keyboard/shortcuts";
import { BackButton } from "./BackButton";
import { FieldValue, LinkIcons, RelativeGrid } from "./FieldValue";
import { SourceRefs } from "./SourceRef";
import { ConfirmDialog } from "./ConfirmDialog";
import { PersonLink } from "./PersonLink";
import { useMediaFolder } from "./MediaFolderContext";
import { MediaThumb, type MediaGalleryItem } from "./PersonPhotos";
import { mediaMetaRows } from "./PhotoViewer";

type Tool = "validate" | "duplicates" | "normalize" | "privacy" | "sources" | "places";

const TOOLS: Tool[] = ["validate", "duplicates", "normalize", "privacy", "sources", "places"];

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
  /** Remove all broken family pointers and push to the undo stack. Returns the
   *  number of records changed, so the panel can re-validate and report. */
  onFixBrokenLinks: () => number;
  /** Infer SEX from family role for unspecified spouses and push to the undo
   *  stack. Returns the number of records changed, so the panel can re-validate. */
  onFixSexFromRole: () => number;
  /** Repair safely-fixable unparseable dates (stray whitespace) and push to the
   *  undo stack. Returns the number of records changed, so the panel can re-validate. */
  onFixDates: () => number;
  /** Remove redundant duplicate CHIL/FAMS/FAMC pointer lines and push to the undo
   *  stack. Returns the number of records changed, so the panel can re-validate. */
  onFixDuplicatePointers: () => number;
  /** Merge a duplicate pair: fold the removed record into the survivor (kept)
   *  per the field choices, mutating the dataset in place and pushing to undo.
   *  Returns true when the merge applied (records changed). */
  onMergeDuplicate: (survivorId: string, removedId: string, decision: CandidateDecision) => boolean;
}

type AsyncState<T> =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; result: T };

/** Let React paint the "working…" state before a blocking computation runs. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A Tools-tab "working…" placeholder: the same spinner + accent row the file
 *  loader uses for "Parsing and validating…", shown while a panel computes. */
function ToolsLoading({ label }: { label: string }) {
  return (
    <div className="tools-loading">
      <div className="parsing-status">
        <span className="spinner" aria-hidden="true" />
        {label}
      </div>
    </div>
  );
}

export function ToolsView({ dataset, fileName, onNavigate, active, onApplyPlaceRename, onFixBrokenLinks, onFixSexFromRole, onFixDates, onFixDuplicatePointers, onMergeDuplicate }: Props) {
  const { t } = useTranslation();
  const [tool, setTool] = useState<Tool>("validate");

  // Cheap whole-file counts for the header overview; recomputed only per dataset.
  const stats = useMemo(() => ({
    indi: dataset.individuals.size,
    fam: dataset.families.size,
    sources: dataset.records.filter((r) => r.tag === "SOUR" && r.xref).length,
    media: dataset.records.filter((r) => r.tag === "OBJE" && r.xref).length,
    places: countDistinctPlaces(dataset),
  }), [dataset]);

  return (
    <div className="tools-view">
      <div className="tools-head">
        <p className="tools-stats">{t("tools.stats", stats)}</p>
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
          <ValidatePanel dataset={dataset} onNavigate={onNavigate} active={active} onFixBrokenLinks={onFixBrokenLinks} onFixSexFromRole={onFixSexFromRole} onFixDates={onFixDates} onFixDuplicatePointers={onFixDuplicatePointers} />
        )}
        {tool === "duplicates" && (
          <DuplicatesPanel dataset={dataset} onNavigate={onNavigate} active={active} onMergeDuplicate={onMergeDuplicate} />
        )}
        {tool === "normalize" && (
          <NormalizePanel dataset={dataset} fileName={fileName} active={active} />
        )}
        {tool === "privacy" && (
          <PrivacyPanel dataset={dataset} fileName={fileName} onNavigate={onNavigate} active={active} />
        )}
        {tool === "sources" && (
          <SourcesPanel dataset={dataset} fileName={fileName} onNavigate={onNavigate} active={active} />
        )}
        {tool === "places" && (
          <PlacesPanel dataset={dataset} onNavigate={onNavigate} active={active} onApplyPlaceRename={onApplyPlaceRename} />
        )}
      </div>
    </div>
  );
}

// ── Validation ─────────────────────────────────────────────────────────────

/** One-button repair flows; the suffix is the i18n key segment (`fix<Suffix>`). */
type FixKind = "links" | "sex" | "dates" | "dups";
const FIX_SUFFIX: Record<FixKind, string> = { links: "Links", sex: "Sex", dates: "Dates", dups: "DupPointers" };

/** The Health-Check filter each fix previews before it runs, so confirming the
 *  fix happens with the affected findings on screen. */
const FIX_CATEGORY: Record<FixKind, IssueCategory | StructCategory> = {
  links: "brokenLink",
  dups: "duplicatePointer",
  sex: "missingSex",
  dates: "badDate",
};

const CATEGORIES: IssueCategory[] = [
  "brokenLink",
  "duplicatePointer",
  "pedigreeLoop",
  "roleSexConflict",
  "deathBeforeBirth",
  "ageAtDeath",
  "ageAtMarriage",
  "parentAge",
  "spouseAgeGap",
  "futureDate",
  "missingVitals",
  "missingName",
  "missingSex",
  "orphan",
];

/** Sort weight per severity, so a unified list shows errors → warnings → info. */
const SEV_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** A row in the unified Health Check list — a record-level finding or a structural
 *  ("spec") one. Both carry a severity so they interleave by it in the "All" view. */
type IssueRow =
  | { kind: "record"; severity: string; issue: ValidationIssue }
  | { kind: "struct"; severity: string; issue: StructIssue };

function ValidatePanel({
  dataset,
  onNavigate,
  active,
  onFixBrokenLinks,
  onFixSexFromRole,
  onFixDates,
  onFixDuplicatePointers,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
  onFixBrokenLinks: () => number;
  onFixSexFromRole: () => number;
  onFixDates: () => number;
  onFixDuplicatePointers: () => number;
}) {
  const { t } = useTranslation();
  // Only compute once the tab is actually shown, then memoize per dataset.
  const [report, setReport] = useState<ValidationReport | null>(null);
  // Structural ("spec") pass over the raw line tree + parser warnings, shown as
  // its own section above the record-level issues.
  const [structure, setStructure] = useState<StructureReport | null>(null);
  const [filter, setFilter] = useState<IssueCategory | StructCategory | "all">("all");
  const [query, setQuery] = useState("");
  // Transient confirmation after a one-button fix: which fix, and how many
  // records it repaired.
  const [fixDone, setFixDone] = useState<{ kind: FixKind; count: number } | null>(null);
  // A fix the user has requested but not yet confirmed. Requesting it switches
  // the filter to that fix's category so the affected findings are on screen
  // behind the confirmation dialog.
  const [pendingFix, setPendingFix] = useState<FixKind | null>(null);

  // Photo-folder check: the local media files referenced by the dataset, and —
  // once checked — the subset not found in the loaded folder. The check is
  // user-triggered (a button click) because resolving a restored folder handle
  // can need permission, which the browser only grants under a user gesture.
  const { folderName, resolveFile } = useMediaFolder();
  const mediaFiles = useMemo(() => collectLocalMediaFiles(dataset), [dataset]);
  const [mediaMissing, setMediaMissing] = useState<MediaFileUse[] | null>(null);
  const [mediaChecking, setMediaChecking] = useState(false);

  async function runMediaCheck() {
    setMediaChecking(true);
    const results = await Promise.all(mediaFiles.map((f) => resolveFile(f.file)));
    setMediaMissing(mediaFiles.filter((_, i) => results[i] === null));
    setMediaChecking(false);
  }

  // Step 1: clicking a fix button shows the affected findings (switch the
  // filter to the fix's category), then asks for confirmation.
  function requestFix(kind: FixKind) {
    setFilter(FIX_CATEGORY[kind]);
    setPendingFix(kind);
  }

  // Step 2: the user confirmed — apply the fix and refresh both lists.
  function applyFix(kind: FixKind) {
    setPendingFix(null);
    const changed =
      kind === "links" ? onFixBrokenLinks()
      : kind === "sex" ? onFixSexFromRole()
      : kind === "dates" ? onFixDates()
      : onFixDuplicatePointers();
    setFixDone({ kind, count: changed });
    // App mutated the live dataset in place — re-validate to refresh both lists.
    setReport(validateDataset(dataset));
    setStructure(validateStructure(dataset));
    setFilter("all");
  }

  useEffect(() => {
    setReport(null);
    setStructure(null);
    setFilter("all");
    setQuery("");
    setFixDone(null);
    setPendingFix(null);
  }, [dataset]);

  // A new dataset or a changed folder invalidates a prior photo check.
  useEffect(() => {
    setMediaMissing(null);
    setMediaChecking(false);
  }, [dataset, folderName]);

  useEffect(() => {
    if (active && !report) {
      setReport(validateDataset(dataset));
      setStructure(validateStructure(dataset));
    }
  }, [active, report, dataset]);

  const q = useDebounced(query).trim().toLowerCase();

  // The unified Health Check list: record-level findings and structural ("spec")
  // findings merged into one stream, filtered by the active category chip and the
  // search box, then sorted errors → warnings → info so both kinds interleave.
  const shown = useMemo<IssueRow[]>(() => {
    const rows: IssueRow[] = [];
    for (const issue of report?.issues ?? []) {
      if (filter !== "all" && issue.category !== filter) continue;
      if (q && !issue.subject.toLowerCase().includes(q)) continue;
      rows.push({ kind: "record", severity: issue.severity, issue });
    }
    for (const issue of structure?.issues ?? []) {
      if (filter !== "all" && issue.category !== filter) continue;
      // Structural rows have no person subject; match the search on the tag/record.
      if (q && !`${issue.sample ?? ""} ${issue.recordId ?? ""}`.toLowerCase().includes(q)) continue;
      rows.push({ kind: "struct", severity: issue.severity, issue });
    }
    rows.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    return rows;
  }, [report, structure, filter, q]);

  // How many "No sex" records can be resolved from family role (a subset of the
  // missingSex findings). Recomputed when the report changes (e.g. after a fix).
  const inferableSex = useMemo(
    () => (report && report.counts.missingSex > 0 ? countInferableSex(dataset) : 0),
    [report, dataset],
  );

  // How many unparseable dates can be safely repaired (a subset of the badDate
  // structural findings). Recomputed when the structure report changes.
  const fixableDates = useMemo(
    () => (structure && structure.counts.badDate > 0 ? countFixableDates(dataset) : 0),
    [structure, dataset],
  );

  if (!report) return <ToolsLoading label={t("tools.running")} />;

  // Record-level + structural findings count together toward the total / "All".
  const total = report.issues.length + (structure?.issues.length ?? 0);

  // The available fix actions, with their counts, gathered into one list. The
  // media-folder check is a read-only probe and so carries no count to repair.
  const fixActions: { kind: FixKind; count: number }[] = [];
  if (report.counts.brokenLink > 0) fixActions.push({ kind: "links", count: report.counts.brokenLink });
  if (report.counts.duplicatePointer > 0) fixActions.push({ kind: "dups", count: report.counts.duplicatePointer });
  if (inferableSex > 0) fixActions.push({ kind: "sex", count: inferableSex });
  if (fixableDates > 0) fixActions.push({ kind: "dates", count: fixableDates });
  const showMediaCheck = !!folderName && mediaFiles.length > 0 && mediaMissing === null;
  const pendingCount = pendingFix
    ? (fixActions.find((a) => a.kind === pendingFix)?.count ?? 0)
    : 0;

  return (
    <>
      {fixDone !== null && (
        <p className="tools-clean tools-clean--ok">
          {t(
            `tools.validate.fix${FIX_SUFFIX[fixDone.kind]}${fixDone.count > 0 ? "Done" : "None"}`,
            { count: fixDone.count },
          )}
        </p>
      )}
      {mediaMissing !== null && (
        mediaMissing.length === 0 ? (
          <p className="tools-clean tools-clean--ok">{t("tools.validate.media.allFound", { count: mediaFiles.length })}</p>
        ) : (
          <div className="tools-struct">
            <div className="tools-examples-title">{t("tools.validate.media.title")}</div>
            <p className="tools-fix-hint">
              {t("tools.validate.media.missing", { count: mediaMissing.length, total: mediaFiles.length })}
            </p>
            <ul className="tools-issues">
              {mediaMissing.map((m, i) => (
                <li key={`${m.file}-${i}`} className="tools-issue sev-warning">
                  <span className="tools-issue-msg" title={m.title ?? m.file}>{m.file}</span>
                  {m.usedBy.length > 0 && <UsageList dataset={dataset} uses={m.usedBy} onNavigate={onNavigate} />}
                </li>
              ))}
            </ul>
          </div>
        )
      )}
      {(showMediaCheck || fixActions.length > 0) && (
        <ul className="tools-fix-list">
          {showMediaCheck && (
            <li className="tools-fix-item">
              <button className="nav-btn tools-run" onClick={runMediaCheck} disabled={mediaChecking}>
                {t("tools.validate.media.check", { count: mediaFiles.length })}
              </button>
              <span className="tools-fix-hint">{t("tools.validate.media.checkHint", { name: folderName })}</span>
            </li>
          )}
          {fixActions.map(({ kind, count }) => (
            <li key={kind} className="tools-fix-item">
              <button className="nav-btn tools-run" onClick={() => requestFix(kind)}>
                {t(`tools.validate.fix${FIX_SUFFIX[kind]}`, { count })}
              </button>
              <span className="tools-fix-hint">{t(`tools.validate.fix${FIX_SUFFIX[kind]}Hint`)}</span>
            </li>
          ))}
        </ul>
      )}
      {pendingFix !== null && (
        <ConfirmDialog
          message={`${t(`tools.validate.fix${FIX_SUFFIX[pendingFix]}`, { count: pendingCount })}\n\n${t(`tools.validate.fix${FIX_SUFFIX[pendingFix]}Hint`)}`}
          confirmLabel={t("tools.validate.applyFix")}
          onConfirm={() => applyFix(pendingFix)}
          onCancel={() => setPendingFix(null)}
        />
      )}
      {total === 0 ? (
        !(mediaMissing && mediaMissing.length > 0) && <p className="tools-clean">{t("tools.validate.clean")}</p>
      ) : (
        <>
          <div className="tools-filter-row">
            <TreeSearch value={query} onChange={setQuery} />
            <div className="tools-chips">
              {CATEGORIES.filter((c) => report.counts[c] > 0).map((c) => (
                <button
                  key={c}
                  className={`tools-chip ${filter === c ? "active" : ""}`}
                  onClick={() => setFilter(c)}
                >
                  {t(`tools.validate.cat.${c}`)} <span className="tools-chip-count">{report.counts[c]}</span>
                </button>
              ))}
              {STRUCT_CATEGORIES.filter((c) => (structure?.counts[c] ?? 0) > 0).map((c) => (
                <button
                  key={c}
                  className={`tools-chip ${filter === c ? "active" : ""}`}
                  onClick={() => setFilter(c)}
                >
                  {t(`tools.validate.struct.cat.${c}`)} <span className="tools-chip-count">{structure!.counts[c]}</span>
                </button>
              ))}
              <button
                className={`tools-chip ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                {t("tools.validate.all")} <span className="tools-chip-count">{total}</span>
              </button>
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="tools-clean">{t("tools.search.noMatch")}</p>
          ) : (
            <ul className="tools-issues">
              {shown.map((row, i) =>
                row.kind === "record" ? (
                  <li key={`r-${row.issue.id}-${row.issue.category}-${i}`} className={`tools-issue sev-${row.issue.severity}`}>
                    <PersonLink dataset={dataset} id={row.issue.id} fallback={row.issue.subject} onNavigate={onNavigate} />
                    <span className="tools-issue-msg">{t(row.issue.messageKey, row.issue.messageVars)}</span>
                  </li>
                ) : (
                  <StructRow key={`s-${row.issue.category}-${i}`} issue={row.issue} dataset={dataset} onNavigate={onNavigate} />
                ),
              )}
            </ul>
          )}
        </>
      )}
    </>
  );
}

// ── Structural ("spec") validation ───────────────────────────────────────────

const STRUCT_CATEGORIES: StructCategory[] = [
  "syntax",
  "level",
  "strayCont",
  "danglingXref",
  "duplicateXref",
  "encoding",
  "version",
  "unknownTag",
  "badDate",
  "customTag",
];

/** A record reference for a structural issue: an individual renders as a clickable
 *  person link; a family expands to its husband & wife links (so the row reads as
 *  the couple, not a bare @F..@ xref). Any other top-level record (SOUR, REPO,
 *  OBJE, NOTE, HEAD, …) is shown as plain `TAG @id@` to identify its type —
 *  *not* a link, since GED Merge can't open those records. */
function RecordRef({
  dataset,
  id,
  tag,
  onNavigate,
}: {
  dataset: Dataset;
  id?: string;
  tag?: string;
  onNavigate: (id: string) => void;
}) {
  if (id && dataset.individuals.has(id)) {
    return <PersonLink dataset={dataset} id={id} fallback={id} onNavigate={onNavigate} />;
  }
  const fam = id ? dataset.families.get(id) : undefined;
  const spouses = fam ? [fam.husband, fam.wife].filter((s): s is string => !!s) : [];
  if (spouses.length > 0) {
    return (
      <span className="tools-couple-ref">
        {spouses.map((sid, i) => (
          <span key={sid}>
            {i > 0 && <span className="tools-usage-amp">&amp;</span>}
            <PersonLink dataset={dataset} id={sid} fallback={sid} onNavigate={onNavigate} />
          </span>
        ))}
      </span>
    );
  }
  return <span className="tools-struct-rec">{[tag, id].filter(Boolean).join(" ")}</span>;
}

function StructRow({
  issue,
  dataset,
  onNavigate,
}: {
  issue: StructIssue;
  dataset: Dataset;
  onNavigate: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li className={`tools-issue sev-${issue.severity}`} title={issue.tooltip}>
      {issue.recordTag ? (
        <RecordRef dataset={dataset} id={issue.recordId} tag={issue.recordTag} onNavigate={onNavigate} />
      ) : issue.line != null ? (
        <span className="tools-struct-loc">{t("tools.validate.struct.atLine", { line: issue.line })}</span>
      ) : null}
      <span className="tools-issue-msg">{t(issue.messageKey, issue.messageVars)}</span>
      {issue.fix && (
        <span className="tools-struct-fixable" title={t("tools.validate.struct.fixableTitle", { value: issue.fix })}>
          {t("tools.validate.struct.fixable", { value: issue.fix })}
        </span>
      )}
    </li>
  );
}

// ── Duplicates ───────────────────────────────────────────────────────────────

function DuplicatesPanel({
  dataset,
  onNavigate,
  active,
  onMergeDuplicate,
}: {
  dataset: Dataset;
  onNavigate: (id: string) => void;
  active: boolean;
  onMergeDuplicate: (survivorId: string, removedId: string, decision: CandidateDecision) => boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<AsyncState<DuplicatePair[]>>({ status: "idle" });
  // Pair whose side-by-side comparison is expanded inline, keyed "aId-bId".
  const [expanded, setExpanded] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Keyboard-highlighted pair (index into the currently shown list).
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(0);
  selectedRef.current = selected;
  const listRef = useRef<HTMLUListElement>(null);
  // Mirror `expanded` so the keydown handler (which doesn't re-subscribe on
  // every open/close) can read the live value.
  const expandedRef = useRef<string | null>(null);
  expandedRef.current = expanded;

  // Apply a merge, then drop from the list the merged pair and any other pair
  // that referenced the now-removed record (it no longer exists).
  function handleMerge(survivorId: string, removedId: string, decision: CandidateDecision) {
    if (!onMergeDuplicate(survivorId, removedId, decision)) return;
    setExpanded(null);
    setState((s) =>
      s.status === "done"
        ? { status: "done", result: s.result.filter((p) => p.aId !== removedId && p.bId !== removedId) }
        : s,
    );
  }

  // Open a related pair surfaced from inside an open comparison (a spouse/parent
  // that is a separate record on each side). Reuse the pair if it's already in
  // the list, otherwise synthesize and prepend it, then clear any filter and
  // expand it so the user can complete that merge too.
  function openPair(aId: string, bId: string) {
    if (state.status !== "done") return;
    const pair = state.result.find(
      (p) => (p.aId === aId && p.bId === bId) || (p.aId === bId && p.bId === aId),
    );
    if (!pair) {
      const made = makeDuplicatePair(dataset, aId, bId);
      if (!made) return;
      setState({ status: "done", result: [made, ...state.result] });
      setQuery("");
      setSelected(0); // prepended → top of the (unfiltered) list
      setExpanded(`${made.aId}-${made.bId}`);
      return;
    }
    setQuery("");
    setSelected(state.result.indexOf(pair));
    setExpanded(`${pair.aId}-${pair.bId}`);
  }

  useEffect(() => {
    setState({ status: "idle" });
    setExpanded(null);
    setQuery("");
    setSelected(0);
  }, [dataset]);

  // Run the (potentially heavy) scan the first time the tab is shown, letting
  // React paint the "working…" state before the blocking computation.
  useEffect(() => {
    if (!active || state.status !== "idle") return;
    let cancelled = false;
    setState({ status: "running" });
    void nextTick().then(() => {
      if (!cancelled) setState({ status: "done", result: findDuplicates(dataset) });
    });
    return () => { cancelled = true; };
  }, [active, state.status, dataset]);

  const q = useDebounced(query).trim().toLowerCase();
  const pairs = state.status === "done" ? state.result : null;
  const shown = useMemo(() => {
    if (!pairs) return [];
    return q ? pairs.filter((p) => someMatch(q, p.aLabel, p.bLabel)) : pairs;
  }, [pairs, q]);

  // Keep the highlight inside the (re)filtered list: a new filter starts at the
  // top; merging out a pair clamps to the last remaining one.
  useEffect(() => { setSelected(0); }, [q]);
  useEffect(() => {
    setSelected((i) => (shown.length === 0 ? 0 : Math.min(i, shown.length - 1)));
  }, [shown.length]);

  // Bring the keyboard-highlighted pair into view as it moves.
  useEffect(() => {
    (listRef.current?.children[selected] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // Left/Right step the highlight between candidate pairs; Up/Down scroll the
  // surrounding list (when it overflows) so a long list can be read without
  // moving the selection. Mirrors the Merge view's compare-panel shortcuts.
  useEffect(() => {
    if (!active || shown.length === 0) return;
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isModalOpen()) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      // Step the highlight; if a candidate is already open, keep the compare
      // open and stick it to the one we land on.
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const next = e.key === "ArrowLeft"
          ? Math.max(0, selectedRef.current - 1)
          : Math.min(shown.length - 1, selectedRef.current + 1);
        setSelected(next);
        if (expandedRef.current !== null) {
          const p = shown[next];
          if (p) setExpanded(`${p.aId}-${p.bId}`);
        }
        return;
      }
      if (e.key === "Enter") {
        const p = shown[selectedRef.current];
        if (!p) return;
        e.preventDefault();
        const key = `${p.aId}-${p.bId}`;
        setExpanded((cur) => (cur === key ? null : key));
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const el = listRef.current?.closest(".tools-view") as HTMLElement | null;
        if (!el || el.scrollHeight <= el.clientHeight) return;
        e.preventDefault();
        el.scrollBy({ top: e.key === "ArrowDown" ? 96 : -96, behavior: "smooth" });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, shown]);

  if (state.status !== "done") return <ToolsLoading label={t("tools.duplicates.running")} />;

  return (
    <>
      {state.result.length === 0 ? (
        <p className="tools-clean">{t("tools.duplicates.none")}</p>
      ) : (
        <>
          <div className="tools-filter-row">
            <TreeSearch value={query} onChange={setQuery} />
            <p className="tools-summary">{t("tools.duplicates.found", { count: state.result.length })}</p>
          </div>
          {shown.length === 0 ? (
            <p className="tools-clean">{t("tools.search.noMatch")}</p>
          ) : (
            <ul className="tools-pairs" ref={listRef}>
              {shown.map((p, i) => {
                const key = `${p.aId}-${p.bId}`;
                const open = expanded === key;
                return (
                  <li key={key} className={`tools-pair ${i === selected ? "selected" : ""}`}>
                    <div className="tools-pair-row" onMouseDown={() => setSelected(i)}>
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
                        onMerge={handleMerge}
                        onOpenPair={openPair}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </>
  );
}

const CHOICES: FieldChoice[] = ["master", "incoming", "both"];

/**
 * Editable side-by-side comparison of one duplicate pair. Both records live in
 * the same master dataset, so each column navigates into Edit mode. The left
 * (master) record is the survivor; per-field M/I/B controls choose what it keeps
 * — seeded by `duplicateDefaults` (more precise dates win, one-sided fields are
 * combined). The Merge button (behind a confirmation) folds the right record
 * into the left and deletes it.
 */
function DuplicateCompare({
  dataset,
  pair,
  onNavigate,
  onMerge,
  onOpenPair,
}: {
  dataset: Dataset;
  pair: DuplicatePair;
  onNavigate: (id: string) => void;
  onMerge: (survivorId: string, removedId: string, decision: CandidateDecision) => void;
  onOpenPair: (aId: string, bId: string) => void;
}) {
  const { t } = useTranslation();
  const a = dataset.individuals.get(pair.aId);
  const b = dataset.individuals.get(pair.bId);
  const rows = useMemo(
    () => individualFieldRows(t, a, b, dataset, dataset),
    [t, a, b, dataset],
  );
  // Relatives (spouses/parents) that are a separate record on each side: until
  // they're merged too, this merge can't fold their shared families/children.
  const related = useMemo(() => relatedSeparateRecords(rows), [rows]);
  const [fields, setFields] = useState<Record<string, FieldChoice>>(() => duplicateDefaults(rows));
  const [confirming, setConfirming] = useState(false);
  // Re-seed defaults if the underlying rows change (e.g. dataset edited elsewhere).
  useEffect(() => { setFields(duplicateDefaults(rows)); }, [rows]);

  const nav: PersonNav = {
    linkable: (id) => dataset.individuals.has(id),
    onNavigate,
  };
  const setChoice = (key: string, c: FieldChoice) => setFields((f) => ({ ...f, [key]: c }));

  function renderChoiceCell(row: FieldRow, choice: FieldChoice) {
    if (row.state === "conflict" || row.state === "incoming-only") {
      return CHOICES.map((c) => (
        <button
          key={c}
          className={`choice ${c}${choice === c ? " active" : ""}`}
          title={t(`choice.${c}.title`)}
          onClick={() => setChoice(row.key, c)}
        >
          {t(`choice.${c}.label`)}
        </button>
      ));
    }
    if (row.state === "agree") return <span className="muted">=</span>;
    return <span className="gm-master-tag">{t("compare.keepMaster")}</span>;
  }

  return (
    <div className="tools-pair-compare">
      <table className="compare">
        <thead>
          <tr className="compare-head">
            <th />
            <th className="compare-col compare-col-master">{t("tools.duplicates.surviving")}</th>
            <th className="compare-col compare-col-incoming">{t("tools.duplicates.candidate")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            if (row.isGroupHeader) {
              const isEventHeader = !!row.isEventHeader;
              return (
                <tr key={row.key} className={isEventHeader ? "group-header-row event-header-row" : "group-header-row"}>
                  <td colSpan={4} className={isEventHeader ? "group-header-cell event-header-cell" : "group-header-cell"}>
                    {row.label}
                  </td>
                </tr>
              );
            }
            const choice = fields[row.key] ?? defaultChoice(row);
            const hasSources = !!(row.masterSources || row.incomingSources || row.masterLinkIcons || row.incomingLinkIcons);
            return (
              <tr key={row.key} className={`field ${row.state}`}>
                <td className="f-label">{row.displayLabel ?? row.label}</td>
                {row.relatives ? (
                  <td className="f-rel" colSpan={3}>
                    <RelativeGrid
                      pairs={row.relatives}
                      masterChosen={choice !== "incoming"}
                      incomingChosen={choice !== "master"}
                      masterPerson={nav}
                      incomingPerson={nav}
                      renderChoice={() => renderChoiceCell(row, choice)}
                    />
                  </td>
                ) : hasSources ? (
                  <>
                    <td className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} masterSources={row.masterSources} />
                      {row.masterLinkIcons?.length ? <LinkIcons urls={row.masterLinkIcons} otherUrls={row.incomingLinkIcons} /> : null}
                    </td>
                    <td className={choice !== "master" ? "f-val gm-data chosen" : "f-val gm-data"}>
                      <SourceRefs t={t} masterSources={row.incomingSources} compareAgainst={row.masterSources} />
                      {row.incomingLinkIcons?.length ? <LinkIcons urls={row.incomingLinkIcons} otherUrls={row.masterLinkIcons} /> : null}
                    </td>
                  </>
                ) : (
                  <>
                    <td className={choice !== "incoming" ? "f-val gm-data chosen" : "f-val gm-data"} title={row.masterTitle}>
                      <FieldValue
                        text={row.master}
                        links={row.masterLinks}
                        linkIcons={row.masterLinkIcons}
                        otherLinkIcons={row.incomingLinkIcons}
                        person={row.masterRefs ? { refs: row.masterRefs, ...nav } : undefined}
                      />
                    </td>
                    <td className={choice !== "master" ? "f-val gm-data chosen" : "f-val gm-data"} title={row.incomingTitle}>
                      <FieldValue
                        text={row.incoming}
                        links={row.incomingLinks}
                        otherLinks={row.masterLinks}
                        linkIcons={row.incomingLinkIcons}
                        otherLinkIcons={row.masterLinkIcons}
                        person={row.incomingRefs ? { refs: row.incomingRefs, ...nav } : undefined}
                      />
                    </td>
                  </>
                )}
                {row.relatives ? null : <td className="f-choice">{renderChoiceCell(row, choice)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
      {related.length > 0 && (
        <div className="tools-related-hint">
          <span>{t("tools.duplicates.relatedHint")}</span>{" "}
          {related.map((r, i) => (
            <span key={`${r.aId}-${r.bId}`}>
              {i > 0 && ", "}
              <button
                className="tools-issue-link"
                title={t("tools.duplicates.relatedOpen")}
                onClick={() => onOpenPair(r.aId, r.bId)}
              >
                {r.label}
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="tools-merge-bar">
        <span className="tools-merge-hint">{t("tools.duplicates.survivorHint", { name: pair.aLabel })}</span>
        <button className="nav-btn primary tools-run" onClick={() => setConfirming(true)}>
          {t("tools.duplicates.merge")}
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          danger
          message={t("tools.duplicates.mergeConfirm", { survivor: pair.aLabel, removed: pair.bLabel })}
          confirmLabel={t("tools.duplicates.merge")}
          onConfirm={() => {
            setConfirming(false);
            onMerge(pair.aId, pair.bId, { status: "confirmed", fields });
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}

// ── Bulk normalize ───────────────────────────────────────────────────────────

function NormalizePanel({ dataset, fileName, active }: { dataset: Dataset; fileName: string; active: boolean }) {
  const { t } = useTranslation();
  const [state, setState] = useState<AsyncState<{ dataset: Dataset; report: NormalizationReport }>>({ status: "idle" });
  // Which passes the user wants applied on download; the preview report above
  // always reflects all three so the counts show what each would change.
  const [selected, setSelected] = useState<NormalizeOptions>({ dates: true, places: true, links: true, names: true });

  useEffect(() => {
    setState({ status: "idle" });
    setSelected({ dates: true, places: true, links: true, names: true });
  }, [dataset]);

  // Run the preview the first time the tab is shown, letting React paint the
  // "working…" state before the blocking computation.
  useEffect(() => {
    if (!active || state.status !== "idle") return;
    let cancelled = false;
    setState({ status: "running" });
    void nextTick().then(() => {
      if (!cancelled) setState({ status: "done", result: bulkNormalize(dataset) });
    });
    return () => { cancelled = true; };
  }, [active, state.status, dataset]);

  function download() {
    // Re-run with only the selected passes so the download honors the checkboxes.
    const { dataset: out } = bulkNormalize(dataset, selected);
    const base = fileName.replace(/\.ged$/i, "");
    ensureUtf8Charset(out.records, out); // downloads are UTF-8 bytes
    const text = serializeGedcom(out.records, downloadOptions(dataset));
    downloadText(`${base}.gedmerge.ged`, text);
  }

  if (state.status !== "done") return <ToolsLoading label={t("tools.normalize.running")} />;

  return (
    <>
      {state.status === "done" && (() => {
        const { report } = state.result;
        const changed = report.datesChanged + report.placesReshaped + report.linksConverted + report.nameVariantsReshaped + report.unknownNamesReshaped;
        if (changed === 0) return <p className="tools-clean tools-clean--ok">{t("tools.normalize.none")}</p>;
        const counts = {
          dates: report.datesChanged,
          places: report.placesReshaped,
          links: report.linksConverted,
          // The "names" pass also cleans unknown-name placeholders (NN, ____).
          names: report.nameVariantsReshaped + report.unknownNamesReshaped,
        };
        const toggle = (key: keyof NormalizeOptions) =>
          setSelected((s) => ({ ...s, [key]: !s[key] }));
        // Selected sum guards the download: only passes that are both checked
        // and actually change something count toward "anything to apply".
        const selectedChanges =
          (selected.dates ? counts.dates : 0) +
          (selected.places ? counts.places : 0) +
          (selected.links ? counts.links : 0) +
          (selected.names ? counts.names : 0);
        return (
          <>
            <p className="tools-intro">{t("tools.normalize.intro")}</p>
            <ul className="tools-norm-summary">
              <NormCheck label={t("tools.normalize.dates", { count: counts.dates })}
                checked={selected.dates} count={counts.dates} onChange={() => toggle("dates")} />
              <NormCheck label={t("tools.normalize.places", { count: counts.places })}
                checked={selected.places} count={counts.places} onChange={() => toggle("places")} />
              <NormCheck label={t("tools.normalize.links", { count: counts.links })}
                checked={selected.links} count={counts.links} onChange={() => toggle("links")} />
              <NormCheck label={t("tools.normalize.names", { count: counts.names })}
                checked={selected.names} count={counts.names} onChange={() => toggle("names")} />
            </ul>
            {selected.dates && <NormExamples title={t("tools.normalize.exDates")} examples={report.dateExamples} />}
            {selected.places && <NormExamples title={t("tools.normalize.exPlaces")} examples={report.placeExamples} />}
            {selected.links && <NormExamples title={t("tools.normalize.exLinks")} examples={report.linkExamples} />}
            {selected.names && <NormExamples title={t("tools.normalize.exNames")} examples={[...report.nameVariantExamples, ...report.unknownNameExamples]} />}
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
            <span className="tools-ex-from">{revealEdgeWhitespace(e.before)}</span>
            <span className="tools-pair-sep">→</span>
            <span className="tools-ex-to">{revealEdgeWhitespace(e.after)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Privacy ──────────────────────────────────────────────────────────────────

const NAME_STRATEGIES: NameStrategy[] = ["living", "private", "initials", "initialSurname", "surnameOnly"];
const ACTIONS: PrivacyAction[] = ["sanitize", "remove", "removeDescendants"];
const RESN_MODES: ResnMode[] = ["stripStamp", "stripOnly", "markOnly"];
const STRIP_CATS: StripCategory[] = ["events", "notes", "sources", "media", "contact"];

/** A short plain-text audit of what the redaction did, downloaded alongside. */
function privacyReportText(flagged: FlaggedPerson[], opts: PrivacyOptions): string {
  const lines = [
    "GED Merge — privacy redaction report",
    `Living threshold: ${opts.livingThresholdYears} years`,
    `Action: ${opts.action} · names: ${opts.nameStrategy} · RESN: ${opts.resn}`,
    "",
    `Flagged living people (${flagged.length}):`,
    ...flagged.map((f) => {
      const note = f.estimate
        ? ` — est. born ~${f.estimate.estimatedYear} via ${f.estimate.relation} ${f.estimate.relativeName} (b. ${f.estimate.relativeYear})`
        : "";
      return `  ${f.id}  ${f.subject}  [${f.reason}]${note}`;
    }),
  ];
  return lines.join("\n") + "\n";
}

function PrivacyPanel({
  dataset,
  fileName,
  onNavigate,
  active,
}: {
  dataset: Dataset;
  fileName: string;
  onNavigate: (id: string) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [options, setOptions] = useState<PrivacyOptions>(defaultPrivacyOptions);
  const [ready, setReady] = useState(false);
  const [showList, setShowList] = useState(false);

  useEffect(() => {
    setOptions(defaultPrivacyOptions());
    setReady(false);
    setShowList(false);
  }, [dataset]);

  // Defer the first scan one tick so the "working…" state paints first.
  useEffect(() => {
    if (!active || ready) return;
    let cancelled = false;
    void nextTick().then(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [active, ready]);

  const flagged = useMemo(() => (ready ? findLiving(dataset, options) : []), [ready, dataset, options]);
  const counts = useMemo(() => {
    const c = { birth: 0, relative: 0, unknown: 0, recentDeath: 0 };
    for (const f of flagged) c[f.reason]++;
    return c;
  }, [flagged]);

  if (!ready) return <ToolsLoading label={t("tools.privacy.running")} />;

  const markOnly = options.resn === "markOnly";
  const showSanitize = !markOnly && options.action === "sanitize";

  const set = (patch: Partial<PrivacyOptions>) => setOptions((o) => ({ ...o, ...patch }));
  const toggleStrip = (cat: StripCategory) =>
    setOptions((o) => ({ ...o, strip: { ...o.strip, [cat]: !o.strip[cat] } }));
  const toggleFile = (key: keyof PrivacyOptions["file"]) =>
    setOptions((o) => ({ ...o, file: { ...o.file, [key]: !o.file[key] } }));

  function download() {
    const { records, report } = privatizeDataset(dataset, options);
    const base = fileName.replace(/\.ged$/i, "");
    ensureUtf8Charset(records, dataset); // downloads are UTF-8 bytes
    downloadText(`${base}.gedmerge.ged`, serializeGedcom(records, downloadOptions(dataset)));
    downloadText(`${base}.gedmerge.report.txt`, privacyReportText(report.flagged, options));
  }

  return (
    <div className="tools-privacy">
      <p className="tools-intro">{t("tools.privacy.intro")}</p>

      {/* Threshold + recent-death */}
      <div className="tools-privacy-group">
        <label className="tools-privacy-inline">
          {t("tools.privacy.threshold")}
          <input
            type="number"
            min={0}
            className="tools-privacy-num"
            value={options.livingThresholdYears}
            onChange={(e) => set({ livingThresholdYears: Math.max(0, Number(e.target.value) || 0) })}
          />
          {t("tools.privacy.thresholdYears")}
        </label>
        <label className="tools-privacy-inline">
          {t("tools.privacy.recentDeath")}
          <input
            type="number"
            min={0}
            className="tools-privacy-num"
            value={options.alsoRecentlyDeceasedYears}
            onChange={(e) => set({ alsoRecentlyDeceasedYears: Math.max(0, Number(e.target.value) || 0) })}
          />
          {t("tools.privacy.thresholdYears")}
          {options.alsoRecentlyDeceasedYears === 0 && <span className="muted"> {t("tools.privacy.recentDeathOff")}</span>}
        </label>
        <RadioRow
          label={t("tools.privacy.unknownBirth")}
          name="privacy-unknown"
          value={options.unknownBirthPolicy}
          options={[
            { id: "living", label: t("tools.privacy.unknownBirth.living") },
            { id: "skip", label: t("tools.privacy.unknownBirth.skip") },
          ]}
          onChange={(v) => set({ unknownBirthPolicy: v as PrivacyOptions["unknownBirthPolicy"] })}
        />
      </div>

      {/* RESN mode */}
      <RadioRow
        label={t("tools.privacy.resn")}
        name="privacy-resn"
        value={options.resn}
        options={RESN_MODES.map((m) => ({ id: m, label: t(`tools.privacy.resn.${m}`) }))}
        onChange={(v) => set({ resn: v as ResnMode })}
      />

      {/* Action (disabled in mark-only mode) */}
      {!markOnly && (
        <RadioRow
          label={t("tools.privacy.action")}
          name="privacy-action"
          value={options.action}
          options={ACTIONS.map((a) => ({ id: a, label: t(`tools.privacy.action.${a}`) }))}
          onChange={(v) => set({ action: v as PrivacyAction })}
        />
      )}

      {/* Name strategy + strip scope (sanitize only) */}
      {showSanitize && (
        <>
          <div className="tools-privacy-group">
            <div className="tools-privacy-legend">{t("tools.privacy.name")}</div>
            <div className="tools-privacy-radios">
              {NAME_STRATEGIES.map((s) => (
                <label key={s} className={`tools-norm-check ${options.nameStrategy === s ? "active" : ""}`}>
                  <input
                    type="radio"
                    name="privacy-name"
                    checked={options.nameStrategy === s}
                    onChange={() => set({ nameStrategy: s })}
                  />
                  <span>{t(`tools.privacy.name.${s}`)}</span>
                  {s === "private" && options.nameStrategy === "private" && (
                    <input
                      type="text"
                      className="tools-privacy-text"
                      value={options.customName}
                      placeholder="Private"
                      onChange={(e) => set({ customName: e.target.value })}
                      onClick={(e) => e.stopPropagation()}
                    />
                  )}
                </label>
              ))}
            </div>
          </div>
          <div className="tools-privacy-group">
            <div className="tools-privacy-legend">{t("tools.privacy.strip")}</div>
            <ul className="tools-norm-summary">
              {STRIP_CATS.map((cat) => (
                <li key={cat}>
                  <label className="tools-norm-check">
                    <input type="checkbox" checked={options.strip[cat]} onChange={() => toggleStrip(cat)} />
                    <span>{t(`tools.privacy.strip.${cat}`)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* File-level privacy */}
      <div className="tools-privacy-group">
        <div className="tools-privacy-legend">{t("tools.privacy.file")}</div>
        <ul className="tools-norm-summary">
          {(["stripSubmitter", "stripExternalIds", "scrubAddress", "scrubEmail", "scrubPhone"] as const).map((key) => (
            <li key={key}>
              <label className="tools-norm-check">
                <input type="checkbox" checked={options.file[key]} onChange={() => toggleFile(key)} />
                <span>{t(`tools.privacy.file.${key}`)}</span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      {/* Affected preview */}
      {flagged.length === 0 ? (
        <p className="tools-clean">{t("tools.privacy.none")}</p>
      ) : (
        <div className="tools-privacy-group">
          <p className="tools-summary">{t("tools.privacy.affected", { count: flagged.length })}</p>
          <p className="tools-fix-hint">
            {t("tools.privacy.breakdown", counts)}
            {counts.recentDeath > 0 && t("tools.privacy.breakdownRecent", counts)}
          </p>
          <button className="tools-issue-link" onClick={() => setShowList((s) => !s)}>
            {showList ? t("tools.privacy.hideList") : t("tools.privacy.showList")}
          </button>
          {showList && (
            <ul className="tools-issues">
              {flagged.map((f) => (
                <li key={f.id} className="tools-issue">
                  <PersonLink dataset={dataset} id={f.id} fallback={f.subject} onNavigate={onNavigate} />
                  <span className="tools-issue-msg" title={t(`tools.privacy.reasonHint.${f.reason}`)}>
                    {t(`tools.privacy.reason.${f.reason}`)}
                  </span>
                  {f.estimate && (
                    <span className="tools-issue-detail">
                      {t("tools.privacy.reason.relativeDetail", {
                        year: f.estimate.estimatedYear,
                        relation: t(`tools.privacy.relation.${f.estimate.relation}`),
                        name: f.estimate.relativeName,
                        relativeYear: f.estimate.relativeYear,
                      })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button className="nav-btn primary tools-run" onClick={download} disabled={flagged.length === 0}>
        {t("tools.privacy.download")}
      </button>
    </div>
  );
}

/** A labeled inline group of radio buttons sharing one `name`. */
function RadioRow({
  label,
  name,
  value,
  options,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="tools-privacy-group">
      <div className="tools-privacy-legend">{label}</div>
      <div className="tools-privacy-radios">
        {options.map((o) => (
          <label key={o.id} className={`tools-norm-check ${value === o.id ? "active" : ""}`}>
            <input type="radio" name={name} checked={value === o.id} onChange={() => onChange(o.id)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ── Shared usage list ────────────────────────────────────────────────────────

/** Records that cite a source/media or use a place; each navigates into Edit. */
function UsageList({ dataset, uses, onNavigate }: { dataset: Dataset; uses: SourceUse[]; onNavigate: (id: string) => void }) {
  if (uses.length === 0) return null;
  return (
    <ul className="tools-usage">
      {uses.map((u, i) => (
        <li key={`${u.persons.map((p) => p.id).join("-")}-${i}`}>
          {u.persons.map((p, j) => (
            <span key={p.id}>
              {j > 0 && <span className="tools-usage-amp">&amp;</span>}
              <PersonLink dataset={dataset} id={p.id} fallback={p.label} onNavigate={onNavigate} />
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

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

function SourcesPanel({
  dataset,
  fileName,
  onNavigate,
  active,
}: {
  dataset: Dataset;
  fileName: string;
  onNavigate: (id: string) => void;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [tree, setTree] = useState<SourceTree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  // Switches the panel body between the containment tree and the duplicate finder.
  const [showDuplicates, setShowDuplicates] = useState(false);
  // Scanned automatically so the toggle can show the count (only when > 0).
  const [dupReport, setDupReport] = useState<DuplicateReport | null>(null);

  useEffect(() => {
    setTree(null);
    setOpen(new Set());
    setQuery("");
    setShowDuplicates(false);
    setDupReport(null);
  }, [dataset]);

  useEffect(() => {
    if (active && !tree) {
      const built = buildSourceTree(dataset);
      setTree(built);
      setOpen(initialSourceOpen(built));
    }
  }, [active, tree, dataset]);

  // Find duplicates once the tab is shown (after the tree, so the tree paints
  // first), then leave it cached for the toggle badge and the finder view.
  useEffect(() => {
    if (!active || dupReport) return;
    let cancelled = false;
    void nextTick().then(() => {
      if (!cancelled) setDupReport(findSourceDuplicates(dataset));
    });
    return () => { cancelled = true; };
  }, [active, dupReport, dataset]);

  const dupCount = dupReport?.groups.length ?? 0;

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

  if (showDuplicates && dupReport)
    return <SourceDuplicatesView report={dupReport} dataset={dataset} fileName={fileName} onBack={() => setShowDuplicates(false)} />;

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
        {dupCount > 0 && (
          <button className="tools-chip tools-dup-toggle" onClick={() => setShowDuplicates(true)}>
            {t("tools.sources.dupToggle")} <span className="tools-chip-count">{dupCount}</span>
          </button>
        )}
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

// ── Source duplicate finder ──────────────────────────────────────────────────

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

/**
 * Lists the media/source/repository records that describe the same thing under
 * different ids (scan supplied by the parent). The user picks which groups to
 * merge and, within each, which record to keep, then downloads a deduplicated
 * GEDCOM (the live dataset is never touched — same contract as the Normalize
 * panel). Each selected group collapses to its chosen survivor with every
 * citation re-pointed onto it.
 */
function SourceDuplicatesView({
  report,
  dataset,
  fileName,
  onBack,
}: {
  report: DuplicateReport;
  dataset: Dataset;
  fileName: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  // Groups excluded from the fix (default: all selected). Survivor overrides
  // keyed by group id (default: the finder's pick).
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [survivors, setSurvivors] = useState<Map<string, string>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

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

  const back = <BackButton label={t("tools.sources.dupBack")} shortcutHint="Esc" showLabel onClick={onBack} />;

  const toggleGroup = (id: string) =>
    setExcluded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const chooseSurvivor = (id: string, xref: string) =>
    setSurvivors((m) => new Map(m).set(id, xref));

  const selectedGroups = report.groups
    .filter((g) => !excluded.has(g.id))
    .map((g) => withSurvivor(g, survivors.get(g.id) ?? defaultSurvivor(g)));
  const removeCount = selectedGroups.reduce((n, g) => n + g.removable, 0);

  function download() {
    const { records } = dedupeSources(dataset.records, selectedGroups);
    const base = fileName.replace(/\.ged$/i, "");
    ensureUtf8Charset(records, dataset); // downloads are UTF-8 bytes
    const text = serializeGedcom(records, downloadOptions(dataset));
    downloadText(`${base}.gedmerge.ged`, text);
  }

  return (
    <>
      <div className="tools-filter-row">
        {back}
        <div className="tools-dup-bulk">
          <button className="tools-issue-link" onClick={() => setExcluded(new Set())}>
            {t("tools.sources.dupSelectAll")}
          </button>
          <button className="tools-issue-link" onClick={() => setExcluded(new Set(report.groups.map((g) => g.id)))}>
            {t("tools.sources.dupSelectNone")}
          </button>
        </div>
        <p className="tools-summary">{t("tools.sources.dupFound", { count: report.groups.length })}</p>
      </div>
      <p className="tools-intro">{t("tools.sources.dupIntro")}</p>

      {DUP_KINDS.filter((k) => report.byKind[k] > 0).map((kind) => (
        <div key={kind} className="tools-dup-kind">
          <div className="tools-dup-kind-head">
            {DUP_KIND_ICON[kind]} {t(`tools.sources.dupKind.${kind}`)}
            <span className="tools-chip-count">{report.byKind[kind]}</span>
          </div>
          <ul className="tools-tree">
            {report.groups
              .filter((g) => g.kind === kind)
              .map((g) => (
                <DupGroupRow
                  key={g.id}
                  group={g}
                  checked={!excluded.has(g.id)}
                  survivorXref={survivors.get(g.id) ?? defaultSurvivor(g)}
                  open={expanded.has(g.id)}
                  onToggleCheck={() => toggleGroup(g.id)}
                  onToggleOpen={() => toggleExpand(g.id)}
                  onChooseSurvivor={(xref) => chooseSurvivor(g.id, xref)}
                />
              ))}
          </ul>
        </div>
      ))}

      <div className="tools-dup-actions">
        <button className="nav-btn primary tools-run" onClick={download} disabled={selectedGroups.length === 0}>
          {t("tools.sources.dupDownload")}
        </button>
        {selectedGroups.length > 0 && (
          <span className="tools-fix-hint">
            {t("tools.sources.dupDownloadCount", { groups: selectedGroups.length, records: removeCount })}
          </span>
        )}
      </div>
    </>
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

// ── Places explorer ──────────────────────────────────────────────────────────

/** Prune a place node to those whose name matches `q` (already lower-cased)
 * anywhere in the subtree. A node matching by name keeps its whole subtree;
 * otherwise only matching descendant branches are retained. Paths of nodes that
 * survive solely as ancestors of a match are collected in `autoOpen` so they can
 * be expanded down to (but not past) the matching entries. */
function filterPlaceNode(node: PlaceNode, q: string, path: string, autoOpen: Set<string>): PlaceNode | null {
  if (node.name.toLowerCase().includes(q)) return node;
  const children: PlaceNode[] = [];
  for (const child of node.children) {
    const kept = filterPlaceNode(child, q, `${path}/${child.name}`, autoOpen);
    if (kept) children.push(kept);
  }
  if (children.length === 0) return null;
  autoOpen.add(path);
  return { ...node, children };
}

/** Keys to open on first load: when there is a single root place, open it and
 *  drill on through any single-child chain so the tree lands on the first level
 *  that offers a choice. */
function initialPlaceOpen(roots: PlaceNode[]): Set<string> {
  const open = new Set<string>();
  if (roots.length !== 1) return open;
  let node = roots[0];
  let path = node.name;
  open.add(path);
  while (node.children.length === 1 && node.uses.length === 0) {
    node = node.children[0];
    path = `${path}/${node.name}`;
    open.add(path);
  }
  return open;
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
    if (active && !tree) {
      const built = buildPlaceTree(dataset);
      setTree(built);
      setOpen(initialPlaceOpen(built.roots));
    }
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

  const { roots, autoOpen } = useMemo(() => {
    const ao = new Set<string>();
    if (!tree) return { roots: [] as PlaceNode[], autoOpen: ao };
    if (!filtering) return { roots: tree.roots, autoOpen: ao };
    const r = tree.roots
      .map((node) => filterPlaceNode(node, q, node.name, ao))
      .filter((n): n is PlaceNode => n !== null);
    return { roots: r, autoOpen: ao };
  }, [tree, filtering, q]);

  // Filtering expands ancestors down to (not past) the matches; the user expands further.
  const isOpen = (key: string) => autoOpen.has(key) || open.has(key);

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

  if (!tree) return <ToolsLoading label={t("tools.running")} />;

  return (
    <>
      <div className="tools-filter-row">
        <TreeSearch value={query} onChange={setQuery} />
        <p className="tools-summary">
          {t("tools.places.summary", { countries: tree.countryCount, distinct: tree.distinctCount, uses: tree.totalUses })}
        </p>
      </div>
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
        <span
          className={`tools-tree-label${hasChildren ? " clickable" : ""}${depth === 0 ? " lead" : ""}`}
          onClick={hasChildren ? () => toggle(node, path) : undefined}
        >
          {labelNode}
        </span>
        <span className="tools-chip-count">{node.count}</span>
        {!isSynthetic && !editing && (
          <button
            className="tools-place-edit-btn"
            onClick={openEdit}
            title={t("tools.places.rename.open")}
          >
            ✏︎
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

/** Shared search box for the Sources/Places explorers. A clear button appears
 *  once there's text to clear. */
function TreeSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <div className="tools-search">
      <input
        type="text"
        className="tools-search-input"
        placeholder={t("tools.search.placeholder")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="tools-search-clear"
          onClick={() => onChange("")}
          title={t("tools.search.clear")}
          aria-label={t("tools.search.clear")}
        >
          ✕
        </button>
      )}
    </div>
  );
}

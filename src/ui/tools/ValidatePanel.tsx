import { AddSourceDialog } from "../AddSourceDialog";
import { sourceRecordEditFields, type EditSourceFields } from "../../gedcom/edit";
import { useTargetFormat } from "../TargetFormatContext";
import type { ToolView } from "../ToolsView";
import { tabIndexFor, tablistKeyDown } from "../../keyboard/tablist";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isEditableTarget, isModalOpen } from "../../keyboard/shortcuts";
import { handleListKey, useListFocusKeeper } from "../../keyboard/useListKeyboard";
import { useTranslation } from "react-i18next";
import type { Dataset, Sex } from "../../gedcom/types";
import { type ValidationReport, type ValidationIssue, type IssueCategory } from "../../tools/validate";
import { inferableSexes } from "../../tools/fixSex";
import { countSwappedRoles, swappedRoleTargets } from "../../tools/fixRoleSwap";
import { formatCoord } from "../../geo/points";
import type { BrokenLinkRef } from "../../tools/fixLinks";
import { countFixableDates, type BadDateRef } from "../../tools/fixDates";
import { countDanglingRefs, type DanglingRef } from "../../tools/fixDanglingRefs";
import { countFixableConformance, type ConformanceFixKind, type ConformanceRef } from "../../tools/fixConformance";
import { countSplitCoordFills, scanPlaceCoords } from "../../tools/placeCoords";
import { type StructureReport, type StructCategory, type StructIssue } from "../../tools/structure";
import { collectLocalMediaFiles, type MediaFileUse } from "../../tools/mediaFiles";
import { eventDisplayLabel } from "../../gedcom/eventTags";
import { ConfirmDialog } from "../ConfirmDialog";
import { PersonLink } from "../PersonLink";
import { useMediaFolder } from "../MediaFolderContext";
import { charsetNotices } from "../charsetNotice";
import { completeStructure, ownVersion } from "../../save/outputFile";
import { submitterName } from "../../gedcom/newFile";
import { useSettingsSlice } from "../SettingsContext";
import { type ToolsScans } from "../useToolsScans";
import { useVirtualList } from "../useVirtualList";
import { recordByXref, recordTitle } from "../../gedcom/recordTitle";
import { ToolsError, ToolsLoading, TreeSearch, UsageList, useDebounced } from "./shared";
import { useTranslationLang } from "./TranslationLangSection";
import { MediaLinkDialog } from "../MediaLinkDialog";
import { nodeAtPath } from "../../tools/conformance/conformance";

/** One-button repair flows; the suffix is the i18n key segment (`fix<Suffix>`). */
type FixKind = "links" | "sex" | "roles" | "dates" | "nonStandard" | "dups" | "families" | "dangling" | ConformanceFixKind;
const FIX_SUFFIX: Record<FixKind, string> = { links: "Links", sex: "Sex", roles: "Roles", dates: "Dates", nonStandard: "NonStandardDates", dups: "DupPointers", families: "DupFamilies", dangling: "Dangling", values: "ConformValues", repeats: "ConformRepeats", forms: "ConformForms", relocate: "ConformRelocate", fileTitles: "ConformFileTitles", agency: "ConformAgency", stamps: "ConformStamps", coverage: "ConformCoverage", assoDates: "ConformAssoDates", smartMatch: "ConformSmartMatch", mediaInfo: "ConformMediaInfo", childPedi: "ConformChildPedi", citationPage: "ConformCitationPage", notes: "ConformNotes" };

const CATEGORIES: IssueCategory[] = [
  "brokenLink",
  "duplicatePointer",
  "duplicateFamily",
  "pedigreeLoop",
  "roleSexConflict",
  "multiSpouseSlot",
  "multipleParents",
  "parentlessFamily",
  "duplicateVital",
  "noEventConflict",
  "deathBeforeBirth",
  "eventOrder",
  "ageAtDeath",
  "livingTooOld",
  "ageAtMarriage",
  "parentAge",
  "bornAfterParentDeath",
  "parallelFamilies",
  "spouseAgeGap",
  "futureDate",
  "statedAge",
  "association",
  "missingVitals",
  "missingName",
  "missingSex",
  "island",
  "orphan",
];

/**
 * The two halves of the health check. **Data issues** are about the family
 * data itself — impossible ages, broken or missing connections, dates that
 * cannot be read — whatever format the file is in. **GEDCOM issues** are about
 * how the file is written: lines, tags and values the standard has otherwise.
 * In a file kept in its own format, those are often the program's habits, not
 * errors, so they stand apart rather than swell one alarming list.
 */
export type HealthGroup = "data" | "gedcom";

/** The structural categories that are about the data rather than the format:
 *  a date nobody can read or that cannot be, a reference to nothing. */
const DATA_STRUCT_CATEGORIES: ReadonlySet<StructCategory> = new Set<StructCategory>([
  "danglingXref", "badDate", "impossibleDate", "reversedRange", "shortYear", "ambiguousDate",
]);

function structGroup(c: StructCategory): HealthGroup {
  return DATA_STRUCT_CATEGORIES.has(c) ? "data" : "gedcom";
}

/** The xref a `brokenLink` finding names — the family a person points at, or the
 *  person a family points at. Both arrive as message interpolation values. */
function brokenTarget(issue: ValidationIssue): string | undefined {
  const target = issue.messageVars?.fam ?? issue.messageVars?.indi;
  return typeof target === "string" ? target : undefined;
}

/** Identity of one row, for the set of rows already repaired from their own
 *  button — the record it names plus whatever narrows it to this finding (the
 *  broken pointer's target, the bad date's value). */
function rowKey(issue: ValidationIssue | StructIssue): string {
  return "id" in issue
    ? `${issue.category}\0${issue.id}\0${brokenTarget(issue) ?? ""}`
    : `${issue.category}\0${issue.recordId ?? ""}\0${issue.sample ?? ""}\0${issue.path ?? ""}`;
}

/** One row's own repair: what its button says, and what clicking it does. A row
 *  carries the same fix as the button above, narrowed to that record — so a user
 *  can settle findings one at a time instead of all at once. */
interface RowFix {
  label: string;
  hint: string;
  /** A removal (danger-coloured), as opposed to a value being set or corrected. */
  removes?: boolean;
  /** The whole-file fix this row's repair is one case of — what a batch runs
   *  once when every row of the kind is picked. */
  kind: FixKind;
  run: () => void;
}

/** Sort weight per severity, so a unified list shows errors → warnings → info. */
/** The name a save would give a missing submitter record, for the notice. */
const AUTHOR_KEYS = ["authorName"] as const;

const SEV_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** The findings list's filter: a category, All, the rows with a repair, or
 *  one of the two chips carved out of a category. */
type Filter = IssueCategory | StructCategory | "all" | "fixable" | "tranLang" | "eventText";

/** A row in the unified Health Check list — a record-level finding or a structural
 *  ("spec") one. Both carry a severity so they interleave by it in the "All" view. */
type IssueRow =
  | { kind: "record"; severity: string; issue: ValidationIssue }
  | { kind: "struct"; severity: string; issue: StructIssue };

export function ValidatePanel({
  dataset,
  scans,
  onNavigate,
  active,
  onFixBrokenLinks,
  onFixSexFromRole,
  onFixSwappedRoles,
  onFixDates,
  onFixNonStandardDates,
  onFixDuplicatePointers,
  onFixDuplicateFamilies,
  onFixDanglingRefs,
  onFixConformance,
  onFixBatch,
  onFillPlaceCoords,
  onTagTranslations,
  onEditSource,
  onEditMediaFile,
  view,
  onViewChange,
}: {
  dataset: Dataset;
  scans: ToolsScans;
  onNavigate: (id: string) => void;
  active: boolean;
  onFixBrokenLinks: (only?: BrokenLinkRef) => number;
  onFixSexFromRole: (only?: string) => number;
  onFixSwappedRoles: (only?: string) => number;
  onFixDates: (only?: BadDateRef) => number;
  onFixNonStandardDates: (only?: BadDateRef) => number;
  onFixDuplicatePointers: (only?: string) => number;
  onFixDuplicateFamilies: (only?: string) => number;
  onFixDanglingRefs: (only?: DanglingRef) => number;
  onFixConformance: (kind?: ConformanceFixKind, only?: ConformanceRef) => number;
  /** Run the picked fixes as one undo step. */
  onFixBatch: (run: () => void) => void;
  onFillPlaceCoords: () => number;
  onTagTranslations: (choices: Map<string, string[]>) => number;
  /** Save an edited source record — a finding on a source opens its editor. */
  onEditSource: (sourceXref: string, fields: EditSourceFields) => void;
  /** Rewrite a media record's FILE — a file whose name says no form opens the
   *  link editor, so the address can be corrected where it is reported. */
  onEditMediaFile: (objeXref: string, path: string | undefined, url: string) => void;
  /** The open half: the tool page `gedcom`, else the data issues. A page of
   *  its own, so Back returns to the half left. */
  view: ToolView;
  onViewChange: (view: ToolView) => void;
}) {
  const { t } = useTranslation();
  const group: HealthGroup = view === "gedcom" ? "gedcom" : "data";
  const setGroup = (g: HealthGroup) => onViewChange(g === "gedcom" ? "gedcom" : "tree");
  // A file kept in its own format reads the GEDCOM half as information.
  const { target, dialect, formatOverrides } = useTargetFormat();
  // So does a file that keeps its program's flat source fields (PLAC/DATE on
  // the source itself).
  const keptCoverage = !target.strict && formatOverrides.sourceCoverage === "vendor";
  // A file kept with its variations keeps its program's event stamps: the row
  // says whose habit it is, and offers no fix.
  const keptStamps = !target.strict && !!dialect?.nestedStamps;
  /** Message vars with a GEDCOM event tag turned into its display name —
   *  validate.ts is pure and can't localize, so tags travel raw — plus the sex
   *  the wording agrees with as the i18next context, so Slovenian says "Umrla"
   *  where the record is a woman. A message with no `_M`/`_F` form of its own
   *  is unaffected: i18next falls back to the base key. */
  const issueVars = (issue: ValidationIssue) => ({
    ...issue.messageVars,
    ...(typeof issue.messageVars?.tag === "string"
      ? { tag: eventDisplayLabel(issue.messageVars.tag, t) }
      : {}),
    context: issue.sexContext,
  });
  // Both validation passes come from the worker scan cache. While a re-run is
  // in flight (a fix triggers one), the previous lists stay up via `lastRef`
  // so the panel doesn't flash back to a spinner.
  const scan = scans.validate;
  const lastRef = useRef<{ report: ValidationReport; structure: StructureReport } | null>(null);
  if (scan.status === "done") lastRef.current = scan.result;
  const report = scan.status === "done" ? scan.result.report : (lastRef.current?.report ?? null);
  const structure = scan.status === "done" ? scan.result.structure : (lastRef.current?.structure ?? null);
  // Besides the categories, two chips of their own carved out of them: the
  // translations without a language and the text on event lines.
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  // Transient confirmation after a one-button fix: which fix, and how many
  // records it repaired.
  const [fixDone, setFixDone] = useState<{ kind: FixKind; count: number } | null>(null);
  // The rows picked for a batch, by row key, and whether its confirmation is
  // up; after a batch of several kinds, how many fixes it made.
  const [picked, setPicked] = useState<Map<string, IssueRow>>(() => new Map());
  const [batchPending, setBatchPending] = useState(false);
  const [batchDone, setBatchDone] = useState<number | null>(null);
  // Findings already repaired from their own row. The re-validate they trigger
  // runs in the worker, so the old list stays up for a moment — these rows go
  // quiet meanwhile instead of inviting a second, no-op click.
  const [fixedRows, setFixedRows] = useState<Set<string>>(() => new Set());

  // A finding on a source record (a date range that ends before it starts, …)
  // opens the same source editor Tools → Sources does, so it can be settled
  // where it is reported; saving re-runs the check.
  const [editSrc, setEditSrc] = useState<string | null>(null);
  const editingSource = useMemo(() => {
    if (!editSrc) return undefined;
    const node = dataset.records.find((r) => r.tag === "SOUR" && r.xref === editSrc);
    if (!node) return undefined;
    return {
      fields: sourceRecordEditFields(dataset.records, node),
      onSave: (fields: EditSourceFields) => {
        onEditSource(editSrc, fields);
        setEditSrc(null);
        scans.refresh("validate");
      },
    };
  }, [editSrc, dataset, onEditSource, scans]);

  // A media file whose name says no form (a label in front of the address, …)
  // opens the link editor the 🔗 chip does; saving re-runs the check.
  const [editMedia, setEditMedia] = useState<{ xref: string; path?: string; url: string } | null>(null);
  function mediaLinkOf(issue: StructIssue): { xref: string; path?: string; url: string } | undefined {
    if (issue.category !== "missingLine" || issue.sample !== "FORM" || issue.fix || issue.recordTag !== "OBJE" || !issue.recordId) return undefined;
    const rec = recordByXref(dataset.records, issue.recordId);
    const file = rec && (issue.path ? nodeAtPath(rec, issue.path) : rec.children.find((c) => c.tag === "FILE"));
    return file?.tag === "FILE" && file.value ? { xref: issue.recordId, path: issue.path, url: file.value } : undefined;
  }

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

  // Places coordinated on some events but not others, grouped by place + the
  // event's address — fillable from the file itself. Detected on the main thread
  // (a PLAC walk), like the fixable-subset counts above; re-derived after a
  // fix's re-validate refreshes `report`. (The same scan's *conflicts* — one
  // pair carrying two different coordinates — are reported on the geocode page,
  // where the register and the maps that settle them are at hand.)
  const coordReport = useMemo(
    () => scanPlaceCoords(dataset),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, report],
  );
  const splitPlaces = coordReport.fills;
  const splitFills = countSplitCoordFills(splitPlaces);
  const [placeCoordDone, setPlaceCoordDone] = useState<number | null>(null);
  const [placeCoordPending, setPlaceCoordPending] = useState(false);

  function applyPlaceCoordFix() {
    setPlaceCoordPending(false);
    const changed = onFillPlaceCoords();
    setPlaceCoordDone(changed);
    // Re-validate (in the worker) so the shared report — and this section's
    // main-thread scan, which keys on it — refreshes to the fixed data.
    scans.refresh("validate");
  }

  // One finding's own repair. Every batch button above is also offered here, on
  // the row that raised the question, narrowed to that record — so a user who
  // agrees with three of eight findings can settle those three and leave the
  // rest. It also reaches what Edit cannot: a broken link is invisible there (a
  // family that isn't there draws nothing), so the finding has to carry the fix.
  function runRowFix(issue: ValidationIssue | StructIssue, fix: () => void) {
    fix();
    setFixedRows((prev) => new Set(prev).add(rowKey(issue)));
    scans.refresh("validate");
  }

  /** One whole-file fix, as a batch runs it when every row of its kind is
   *  picked; returns how many records it changed. */
  function runKind(kind: FixKind): number {
    return kind === "links" ? onFixBrokenLinks()
      : kind === "sex" ? onFixSexFromRole()
      : kind === "roles" ? onFixSwappedRoles()
      : kind === "dates" ? onFixDates()
      : kind === "nonStandard" ? onFixNonStandardDates()
      : kind === "dangling" ? onFixDanglingRefs()
      : kind === "families" ? onFixDuplicateFamilies()
      : kind === "values" || kind === "repeats" || kind === "forms" || kind === "notes" || kind === "relocate" || kind === "fileTitles" || kind === "agency" || kind === "stamps" || kind === "coverage" || kind === "assoDates" || kind === "smartMatch" || kind === "mediaInfo" || kind === "childPedi" || kind === "citationPage" ? onFixConformance(kind)
      : onFixDuplicatePointers();
  }

  useEffect(() => { setFilter("all"); }, [group]);
  // The last translation given its language takes its chip away: back to All.
  useEffect(() => {
    if (filter === "tranLang" && !structure?.issues.some(isUntaggedTran)) setFilter("all");
    if (filter === "eventText" && !structure?.issues.some(isEventText)) setFilter("all");
  }, [filter, structure]);

  useEffect(() => {
    lastRef.current = null;
    setFilter("all");
    setQuery("");
    setFixDone(null);
    setBatchDone(null);
    setPicked(new Map());
    setBatchPending(false);
    setPlaceCoordDone(null);
    setPlaceCoordPending(false);
  }, [dataset]);

  // A fresh health check has landed: its rows are the repaired truth, so the
  // "already fixed" marks from the previous list have nothing left to suppress.
  useEffect(() => {
    setFixedRows((prev) => (prev.size === 0 ? prev : new Set()));
    // Picks point at rows of the list they were made in.
    setPicked((prev) => (prev.size === 0 ? prev : new Map()));
  }, [report]);
  useEffect(() => { setPicked(new Map()); }, [group]);

  // A new dataset or a changed folder invalidates a prior photo check.
  useEffect(() => {
    setMediaMissing(null);
    setMediaChecking(false);
  }, [dataset, folderName]);

  useEffect(() => {
    if (active) scans.ensure("validate");
  }, [active, scans]);

  // The encoding the file arrived in, and what the download will make of it.
  const charsetNotes = useMemo(() => charsetNotices(dataset, t), [dataset, t]);
  // The file as GEDCOM: its version, the other one it can be saved in, and
  // what a save supplies for it to be valid at all (a header, a trailer, …).
  const version = ownVersion(dataset);
  const records = dataset.records;
  const { authorName } = useSettingsSlice(AUTHOR_KEYS);
  const fileFixes = useMemo(() => completeStructure(records, version, false), [records, version]);

  const q = useDebounced(query).trim().toLowerCase();

  // The unified Health Check list: record-level findings and structural ("spec")
  // findings merged into one stream, filtered by the active category chip and the
  // search box, then sorted errors → warnings → info so both kinds interleave.
  // The "No sex" records a family role settles, and what it settles them to (a
  // subset of the missingSex findings). Recomputed when the report changes (e.g.
  // after a fix). The same map drives the button's count and the rows' marks, so
  // the list points at exactly the records the button will change.
  const inferableSex = useMemo<Map<string, Sex>>(
    () => (report && report.counts.missingSex > 0 ? inferableSexes(dataset) : new Map()),
    [report, dataset],
  );

  // The spouses a swap would move, and the role each lands in — plus how many
  // families that is, which is what the button counts (one swap per family, two
  // findings). Both from the roleSexConflict findings a swap settles on its own.
  const swappedRoleFams = useMemo(
    () => (report && report.counts.roleSexConflict > 0 ? countSwappedRoles(dataset) : 0),
    [report, dataset],
  );
  const swappedRoles = useMemo<Map<string, "husband" | "wife">>(
    () => (report && report.counts.roleSexConflict > 0 ? swappedRoleTargets(dataset) : new Map()),
    [report, dataset],
  );
  // Media records whose title/format the relocate fix would move under FILE,
  // and those holding a second title beside the FILE's own.
  const [fixableRelocate, fixableFileTitles] = useMemo(
    () => (structure?.issues.some((i) => i.relocate)
      ? [countFixableConformance(dataset, "relocate"), countFixableConformance(dataset, "fileTitles")]
      : [0, 0]),
    [structure, dataset],
  );

  // The rows for one filter and search; the "fixable" chip is the whole list
  // narrowed to the rows that carry a repair.
  const buildRows = (f: Exclude<Filter, "fixable">, query: string): IssueRow[] => {
    const rows: IssueRow[] = [];
    let tranFirst: StructIssue | undefined;
    let tranCount = 0;
    // The same value fix on the same line (TYPE aka → AKA on every name) is
    // one row, its button fixing them all.
    const valueGroups = new Map<string, StructIssue[]>();
    for (const issue of group === "data" ? (report?.issues ?? []) : []) {
      if (f !== "all" && issue.category !== f) continue;
      if (query && !issue.subject.toLowerCase().includes(query)) continue;
      rows.push({ kind: "record", severity: issue.severity, issue });
    }
    for (const issue of structure?.issues ?? []) {
      if (structGroup(issue.category) !== group) continue;
      // Translations without a language are a chip of their own, carved out
      // of the missing lines they technically are.
      if (f === "tranLang" ? !isUntaggedTran(issue)
        : f === "eventText" ? !isEventText(issue)
        : f !== "all" && (issue.category !== f || isUntaggedTran(issue) || isEventText(issue))) continue;
      // Structural rows have no person subject; match the search on the tag/record.
      if (query && !`${issue.sample ?? ""} ${issue.recordId ?? ""}`.toLowerCase().includes(query)) continue;
      // A translation without a language is one row however often it occurs:
      // the per-name list under its chip is where they are settled.
      if (isUntaggedTran(issue)) {
        tranCount++;
        tranFirst ??= issue;
        continue;
      }
      if (issue.category === "enumValue" && issue.fix !== undefined && !issue.toNote && issue.recordId) {
        const k = `${issue.messageKey}\0${issue.messageVars?.parent}\0${issue.sample}\0${issue.fix}`;
        const list = valueGroups.get(k);
        if (list) list.push(issue);
        else valueGroups.set(k, [issue]);
        continue;
      }
      rows.push({ kind: "struct", severity: issue.severity, issue });
    }
    for (const list of valueGroups.values()) {
      const issue = list.length > 1 ? { ...list[0], groupCount: list.length } : list[0];
      rows.push({ kind: "struct", severity: issue.severity, issue });
    }
    if (tranFirst) {
      rows.push({
        kind: "struct",
        severity: tranFirst.severity,
        issue: { ...tranFirst, messageKey: TRAN_LANG_KEY, messageVars: { ...tranFirst.messageVars, count: tranCount } },
      });
    }
    rows.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
    return rows;
  };
  const rowFixOf = (row: IssueRow): RowFix | null =>
    row.kind === "record" ? recordRowFix(row.issue) : structRowFix(row.issue);
  const allRows = useMemo(
    () => buildRows("all", ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report, structure, group],
  );
  const shown = useMemo(
    () => (filter === "fixable" ? buildRows("all", q).filter((r) => rowFixOf(r)) : buildRows(filter, q)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [report, structure, filter, q, group, inferableSex, swappedRoles, keptCoverage, keptStamps, fixableRelocate, fixableFileTitles]);

  const pickable = (row: IssueRow) => !!rowFixOf(row) && !fixedRows.has(rowKey(row.issue));
  const shownPickable = useMemo(
    () => shown.filter(pickable),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, fixedRows],
  );
  const fixableTotal = useMemo(
    () => allRows.filter((r) => rowFixOf(r)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [allRows, inferableSex, swappedRoles, keptCoverage, keptStamps, fixableRelocate, fixableFileTitles],
  );
  function togglePick(row: IssueRow) {
    setPicked((prev) => {
      const next = new Map(prev);
      const k = rowKey(row.issue);
      if (next.has(k)) next.delete(k);
      else next.set(k, row);
      return next;
    });
  }
  const allShownPicked = shownPickable.length > 0 && shownPickable.every((r) => picked.has(rowKey(r.issue)));
  function toggleAllShown() {
    setPicked((prev) => {
      const next = new Map(prev);
      for (const r of shownPickable) {
        if (allShownPicked) next.delete(rowKey(r.issue));
        else next.set(rowKey(r.issue), r);
      }
      return next;
    });
  }
  /** The picked rows by the fix kind that settles them. */
  function pickedByKind(): Map<FixKind, IssueRow[]> {
    const byKind = new Map<FixKind, IssueRow[]>();
    for (const row of picked.values()) {
      const fix = rowFixOf(row);
      if (!fix) continue;
      const list = byKind.get(fix.kind);
      if (list) list.push(row);
      else byKind.set(fix.kind, [row]);
    }
    return byKind;
  }
  /** Every row of a kind picked: the batch runs the kind's whole-file fix once. */
  const wholeKind = (kind: FixKind, rows: IssueRow[]) =>
    rows.length >= allRows.filter((r) => rowFixOf(r)?.kind === kind).length;
  // The confirmed batch: every picked fix, in one undo step.
  function applyPicked() {
    setBatchPending(false);
    const plan = pickedByKind();
    let changed = 0;
    onFixBatch(() => {
      for (const [kind, rows] of plan) {
        if (wholeKind(kind, rows)) changed += runKind(kind);
        else for (const row of rows) rowFixOf(row)?.run();
      }
    });
    setFixedRows((prev) => new Set([...prev, ...picked.keys()]));
    const [only] = plan.keys();
    if (plan.size === 1 && wholeKind(only, plan.get(only)!)) {
      setFixDone({ kind: only, count: changed });
      setBatchDone(null);
    } else {
      setFixDone(null);
      setBatchDone(picked.size);
    }
    setPicked(new Map());
    // App mutated the live dataset in place — re-validate (in the worker) to
    // refresh both lists; the current ones stay up until the fresh ones arrive.
    scans.refresh("validate");
    setFilter("all");
  }

  // A big file's health check can produce six-figure finding counts — only the
  // rows near the viewport are mounted. The scroll container is the ancestor
  // `.tools-view`, which the hook discovers on its own.
  const virtual = useVirtualList({ count: shown.length, estimate: 34, itemsKey: shown });

  // The highlighted finding: ↑/↓ and Home/End step it, Enter opens its
  // record. Scrolled into view only when a key moved it — the list sits
  // under the summary, and a mount-time scroll would jump past that.
  const [selected, setSelected] = useState(0);
  const listRef = useListFocusKeeper<HTMLUListElement>();
  const shownRef = useRef(shown);
  shownRef.current = shown;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const keyMoved = useRef(false);
  useEffect(() => { setSelected((s) => Math.min(s, Math.max(0, shown.length - 1))); }, [shown.length]);
  const { scrollToIndex } = virtual;
  useEffect(() => {
    if (!keyMoved.current) return;
    keyMoved.current = false;
    scrollToIndex(selected);
  }, [selected, scrollToIndex]);
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target) || isModalOpen() || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const rows = shownRef.current;
      handleListKey(e, {
        count: rows.length,
        index: selectedRef.current,
        setIndex: (i) => { keyMoved.current = true; setSelected(i); },
        onEnter: (i) => {
          const row = rows[i];
          const id = row?.kind === "record" ? row.issue.id : row && !isGrouped(row.issue) ? row.issue.recordId : undefined;
          if (id) onNavigate(id);
        },
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, onNavigate]);


  /** This record-level finding's own repair, if a batch button covers it. The
   *  label doubles as the mark that says which rows of a category the button
   *  above would touch — "→ Female" on the three no-sex spouses among eight. */
  function recordRowFix(issue: ValidationIssue): RowFix | null {
    switch (issue.category) {
      case "brokenLink":
        return {
          label: t("tools.validate.fixOneLink"),
          hint: t("tools.validate.fixOneLinkHint"),
          removes: true,
          kind: "links",
        run: () => onFixBrokenLinks({ id: issue.id, target: brokenTarget(issue) }),
        };
      case "duplicatePointer":
        return {
          label: t("tools.validate.fixOneDup"),
          hint: t("tools.validate.fixOneDupHint"),
          removes: true,
          kind: "dups",
        run: () => onFixDuplicatePointers(issue.id),
        };
      case "duplicateFamily":
        return {
          label: t("tools.validate.fixOneDupFamily"),
          hint: t("tools.validate.fixOneDupFamilyHint"),
          kind: "families",
        run: () => onFixDuplicateFamilies(issue.id),
        };
      case "missingSex": {
        const sex = inferableSex.get(issue.id);
        if (!sex) return null;
        return {
          label: t("tools.validate.fixOneValue", { value: t(`sex.${sex}`) }),
          hint: t("tools.validate.fixOneSexHint"),
          kind: "sex",
        run: () => onFixSexFromRole(issue.id),
        };
      }
      case "roleSexConflict": {
        const role = swappedRoles.get(issue.id);
        if (!role) return null;
        return {
          label: t("tools.validate.fixOneValue", { value: t(`field.${role}`) }),
          hint: t("tools.validate.fixOneRoleHint"),
          kind: "roles",
        run: () => onFixSwappedRoles(issue.id),
        };
      }
      default:
        return null;
    }
  }

  /** The same, for a structural finding. */
  function structRowFix(issue: StructIssue): RowFix | null {
    if (issue.category === "badDate" && issue.fix && issue.recordId) {
      return {
        label: t("tools.validate.fixOneValue", { value: issue.fix }),
        hint: t("tools.validate.struct.fixableTitle", { value: issue.fix }),
        kind: "dates",
        run: () => onFixDates({ id: issue.recordId!, sample: issue.sample }),
      };
    }
    if (issue.category === "nonStandardDate" && issue.fix && issue.recordId) {
      return {
        label: t("tools.validate.fixOneValue", { value: issue.fix }),
        hint: t("tools.validate.struct.fixableTitle", { value: issue.fix }),
        kind: "nonStandard",
        run: () => onFixNonStandardDates({ id: issue.recordId!, sample: issue.sample }),
      };
    }
    if (issue.category === "danglingXref" && issue.recordId) {
      return {
        label: t("tools.validate.fixOneDangling"),
        hint: t("tools.validate.fixOneDanglingHint"),
        removes: true,
        kind: "dangling",
        run: () => onFixDanglingRefs({ id: issue.recordId!, xref: issue.sample }),
      };
    }
    // Standard conformance: a value in the wrong case, or a line repeated as
    // an exact copy — both carry what the fix needs (the line's path).
    if (issue.toNote && issue.recordId) {
      return {
        label: t("tools.validate.fixOneNote"),
        hint: t("tools.validate.fixOneNoteHint"),
        kind: "notes",
        run: () => onFixConformance("notes", { id: issue.recordId!, path: issue.path }),
      };
    }
    if (issue.category === "enumValue" && issue.fix !== undefined && issue.recordId) {
      const fix = issue.fix;
      return {
        label: t("tools.validate.fixOneValue", { value: fix }),
        hint: t("tools.validate.struct.fixableTitle", { value: fix }),
        kind: "values",
        run: () => onFixConformance(undefined, (issue.groupCount ?? 0) > 1
          ? { match: { tag: String(issue.messageVars?.tag), parent: String(issue.messageVars?.parent), sample: issue.sample ?? "", fix } }
          : { id: issue.recordId!, path: issue.path }),
      };
    }
    if (issue.category === "cardinality" && issue.repeat && issue.recordId) {
      return {
        label: t("tools.validate.fixOneRepeat"),
        hint: t("tools.validate.fixOneRepeatHint"),
        removes: true,
        kind: "repeats",
        run: () => onFixConformance("repeats", { id: issue.recordId!, path: issue.path }),
      };
    }
    // A media file's missing FORM, read off its name.
    if (issue.category === "missingLine" && issue.fix !== undefined && issue.recordId) {
      return {
        label: t("tools.validate.fixOneAdd", { tag: issue.sample, value: issue.fix }),
        hint: t("tools.validate.fixOneAddHint"),
        // A row may stand for many files: every file lacking this form gets it.
        kind: "forms",
        run: () => onFixConformance("forms", { value: issue.fix }),
      };
    }
    // Media lines beside their FILE: one row for the whole habit, so its
    // button moves them in every media record.
    if (issue.category === "misplacedTag" && issue.relocate && issue.recordId) {
      // Once nothing is left to move, a title that differs from the FILE's own
      // is settled by keeping the FILE's — the removal, on the user's word.
      if (issue.sample === "TITL" && fixableRelocate === 0 && fixableFileTitles > 0) {
        return {
          label: t("tools.validate.fixOneFileTitles"),
          hint: t("tools.validate.fixConformFileTitlesHint"),
          removes: true,
          kind: "fileTitles",
          run: () => onFixConformance("fileTitles"),
        };
      }
      return {
        label: t("tools.validate.fixOneRelocate"),
        hint: t("tools.validate.fixOneRelocateHint"),
        kind: "relocate",
        run: () => onFixConformance("relocate"),
      };
    }
    // A source's own agency: one row for the habit, moved in every source.
    if (issue.category === "misplacedTag" && issue.agency && issue.recordId) {
      return {
        label: t("tools.validate.fixOneAgency"),
        hint: t("tools.validate.fixOneAgencyHint"),
        kind: "agency",
        run: () => onFixConformance("agency"),
      };
    }
    // A media record's date or place: kept as the extension, in every record.
    if (issue.mediaInfo && issue.recordId) {
      return {
        label: t("tools.validate.fixOneMediaInfo", { tag: issue.sample === "PLAC" ? "_PLACE" : "_DATE" }),
        hint: t("tools.validate.fixOneMediaInfoHint"),
        kind: "mediaInfo",
        run: () => onFixConformance("mediaInfo"),
      };
    }
    // A page typed as SOUR inside a citation: the citation's PAGE.
    if (issue.citationPage && issue.recordId) {
      return {
        label: t("tools.validate.fixOneCitationPage"),
        hint: t("tools.validate.fixOneCitationPageHint"),
        kind: "citationPage",
        run: () => onFixConformance("citationPage"),
      };
    }
    // A child's pedigree on the family's CHIL: into the child's FAMC.
    if (issue.childPedi && issue.recordId) {
      return {
        label: t("tools.validate.fixOneChildPedi"),
        hint: t("tools.validate.fixOneChildPediHint"),
        kind: "childPedi",
        run: () => onFixConformance("childPedi"),
      };
    }
    // MyHeritage's Smart Match citations: the id into PAGE, in every record.
    if (issue.smartMatch && issue.recordId) {
      return {
        label: t("tools.validate.fixOneSmartMatch"),
        hint: t("tools.validate.fixOneSmartMatchHint"),
        kind: "smartMatch",
        run: () => onFixConformance("smartMatch"),
      };
    }
    // A date on an association: kept as its note, in every record.
    if (issue.category === "misplacedTag" && issue.assoDate && issue.recordId) {
      return {
        label: t("tools.validate.fixOneAssoDates"),
        hint: t("tools.validate.fixOneAssoDatesHint"),
        kind: "assoDates",
        run: () => onFixConformance("assoDates"),
      };
    }
    // A source's flat place or date: restated as DATA > EVEN in every source.
    if (issue.category === "misplacedTag" && issue.coverage && issue.recordId && !keptCoverage) {
      return {
        label: t("tools.validate.fixOneCoverage"),
        hint: t("tools.validate.fixOneCoverageHint"),
        kind: "coverage",
        run: () => onFixConformance("coverage"),
      };
    }
    // Change and creation stamps below the records: one row, every record.
    if (issue.category === "misplacedTag" && issue.stamps && issue.recordId && !keptStamps) {
      return {
        label: t("tools.validate.fixOneStamps"),
        hint: t("tools.validate.fixOneStampsHint"),
        kind: "stamps",
        run: () => onFixConformance("stamps"),
      };
    }
    return null;
  }

  // How many unparseable dates can be safely repaired (a subset of the badDate
  // structural findings). Recomputed when the structure report changes.
  const fixableDates = useMemo(
    () => (structure && structure.counts.badDate > 0 ? countFixableDates(dataset) : 0),
    [structure, dataset],
  );

  // Missing xrefs whose pointer lines the dangling-reference fix can drop — all
  // of the reported ones except any on a record with no xref of its own (HEAD),
  // which can't carry an undo patch.
  const fixableDangling = useMemo(
    () => (structure && structure.counts.danglingXref > 0 ? countDanglingRefs(dataset) : 0),
    [structure, dataset],
  );

  // Media dates/places and children's PEDIs the fixes would settle.
  const [fixableMediaInfo, fixableChildPedi, fixableCitationPage] = useMemo(
    () => [
      structure?.issues.some((i) => i.citationPage) ? countFixableConformance(dataset, "citationPage") : 0,
      structure?.issues.some((i) => i.mediaInfo) ? countFixableConformance(dataset, "mediaInfo") : 0,
      structure?.issues.some((i) => i.childPedi) ? countFixableConformance(dataset, "childPedi") : 0,
    ],
    [structure, dataset],
  );
  // Smart Match citations the fix would restate.
  const fixableSmartMatch = useMemo(
    () => (structure?.issues.some((i) => i.smartMatch) ? countFixableConformance(dataset, "smartMatch") : 0),
    [structure, dataset],
  );
  // Dates on associations the fix would keep as notes.
  const fixableAssoDates = useMemo(
    () => (structure?.issues.some((i) => i.assoDate) ? countFixableConformance(dataset, "assoDates") : 0),
    [structure, dataset],
  );
  // Sources whose flat PLAC/DATE the coverage fix would restate.
  const fixableCoverage = useMemo(
    () => (structure?.issues.some((i) => i.coverage) ? countFixableConformance(dataset, "coverage") : 0),
    [structure, dataset],
  );
  // Records whose nested CHAN/CREA the stamps fix would lift.
  const fixableStamps = useMemo(
    () => (structure?.issues.some((i) => i.stamps) ? countFixableConformance(dataset, "stamps") : 0),
    [structure, dataset],
  );
  // Sources whose own AGNC the agency fix would move under DATA.
  const fixableAgency = useMemo(
    () => (structure?.issues.some((i) => i.agency) ? countFixableConformance(dataset, "agency") : 0),
    [structure, dataset],
  );

  // A translation the standard wants a language on, written without one — the
  // worklist below re-reads those lines on the main thread, so only then.
  const untaggedTranCount = structure?.issues.filter(isUntaggedTran).length ?? 0;
  const eventTextCount = structure?.issues.filter(isEventText).length ?? 0;
  const hasUntaggedTran = untaggedTranCount > 0;
  const tranLang = useTranslationLang({
    dataset,
    freshness: structure,
    needed: group === "gedcom" && hasUntaggedTran,
    onApply: onTagTranslations,
    onApplied: () => scans.refresh("validate"),
  });

  if (!report) {
    return scan.status === "error" ? <ToolsError message={scan.message} /> : <ToolsLoading label={t("tools.running")} />;
  }

  // Each half's own count: the tab says it, and "All" within the half.
  const structIn = (g: HealthGroup) => structure?.issues.filter((i) => structGroup(i.category) === g).length ?? 0;
  const groupTotal: Record<HealthGroup, number> = {
    data: report.issues.length + structIn("data"),
    gedcom: structIn("gedcom"),
  };
  const total = groupTotal[group];

  // The available fix actions, with their counts, gathered into one list. The
  // media-folder check is a read-only probe and so carries no count to repair.
  const fixActions: { kind: FixKind; count: number }[] = [];
  if (report.counts.brokenLink > 0) fixActions.push({ kind: "links", count: report.counts.brokenLink });
  if (report.counts.duplicatePointer > 0) fixActions.push({ kind: "dups", count: report.counts.duplicatePointer });
  if (report.counts.duplicateFamily > 0) fixActions.push({ kind: "families", count: report.counts.duplicateFamily });
  if (fixableDangling > 0) fixActions.push({ kind: "dangling", count: fixableDangling });
  if (swappedRoleFams > 0) fixActions.push({ kind: "roles", count: swappedRoleFams });
  if (inferableSex.size > 0) fixActions.push({ kind: "sex", count: inferableSex.size });
  if (fixableDates > 0) fixActions.push({ kind: "dates", count: fixableDates });
  // Every non-standard date the check reports with a fix is one the fix restyles.
  const fixableNonStandard = structure?.issues.filter((i) => i.category === "nonStandardDate" && i.fix).length ?? 0;
  if (fixableNonStandard > 0) fixActions.push({ kind: "nonStandard", count: fixableNonStandard });
  // The conformance fixes, counted off the report the way the non-standard
  // dates are: each finding that carries its repair is one the batch makes.
  const conformValues = structure?.issues.filter((i) => i.category === "enumValue" && i.fix !== undefined && !i.toNote && i.recordId).length ?? 0;
  if (conformValues > 0) fixActions.push({ kind: "values", count: conformValues });
  const conformNotes = structure?.issues.filter((i) => i.toNote && i.recordId).length ?? 0;
  if (conformNotes > 0) fixActions.push({ kind: "notes", count: conformNotes });
  const conformRepeats = structure?.issues.filter((i) => i.category === "cardinality" && i.repeat && i.recordId).length ?? 0;
  if (conformRepeats > 0) fixActions.push({ kind: "repeats", count: conformRepeats });
  const conformForms = structure?.issues
    .filter((i) => i.category === "missingLine" && i.fix !== undefined && i.recordId)
    .reduce((n, i) => n + (Number(i.messageVars?.count) || 1), 0) ?? 0;
  if (conformForms > 0) fixActions.push({ kind: "forms", count: conformForms });
  if (fixableRelocate > 0) fixActions.push({ kind: "relocate", count: fixableRelocate });
  if (fixableFileTitles > 0) fixActions.push({ kind: "fileTitles", count: fixableFileTitles });
  if (fixableAgency > 0) fixActions.push({ kind: "agency", count: fixableAgency });
  if (fixableCitationPage > 0) fixActions.push({ kind: "citationPage", count: fixableCitationPage });
  if (fixableMediaInfo > 0) fixActions.push({ kind: "mediaInfo", count: fixableMediaInfo });
  if (fixableChildPedi > 0) fixActions.push({ kind: "childPedi", count: fixableChildPedi });
  if (fixableSmartMatch > 0) fixActions.push({ kind: "smartMatch", count: fixableSmartMatch });
  if (fixableAssoDates > 0) fixActions.push({ kind: "assoDates", count: fixableAssoDates });
  if (fixableCoverage > 0 && !keptCoverage) fixActions.push({ kind: "coverage", count: fixableCoverage });
  if (fixableStamps > 0 && !keptStamps) fixActions.push({ kind: "stamps", count: fixableStamps });
  const showMediaCheck = !!folderName && mediaFiles.length > 0 && mediaMissing === null;
  // The check runs once per file, not on every visit: fixing a record in Edit
  // and coming back would otherwise still show the old findings. Say so, and
  // let the user re-run on demand.
  //
  // Only then, though. Freshness is keyed on the dataset and the edit version,
  // so a list that isn't stale is the file as it stands and re-running it cannot
  // say anything new — offering the button anyway reads as a warning about a
  // list that is in fact current. It stays up while a re-run is in flight, which
  // is where its progress hint belongs.
  const stale = scans.isStale("validate");
  const rerunning = scan.status === "running";
  const showRerun = stale || rerunning;
  // The batch's confirmation: each picked fix with its count and what it does.
  const batchMessage = batchPending
    ? [t("tools.validate.fixPickedIntro"), ...[...pickedByKind()].map(([kind, rows]) => {
        const count = wholeKind(kind, rows) ? (fixActions.find((a) => a.kind === kind)?.count ?? rows.length) : rows.length;
        return `• ${t(`tools.validate.fix${FIX_SUFFIX[kind]}`, { count })}\n${t(`tools.validate.fix${FIX_SUFFIX[kind]}Hint`)}`;
      })].join("\n\n")
    : "";
  return (
    <>
      <div className="batch-section-toggle" role="tablist" onKeyDown={tablistKeyDown}>
        {(["data", "gedcom"] as const).map((g) => (
          <button
            key={g}
            role="tab"
            aria-selected={group === g}
            tabIndex={tabIndexFor(group === g)}
            className={`batch-section-tab ${group === g ? "active" : ""}`}
            onClick={() => setGroup(g)}
          >
            {t(`tools.validate.group.${g}`, { version })} <span className="tools-chip-count">{groupTotal[g]}</span>
          </button>
        ))}
      </div>
      <p className="tools-fix-hint tools-group-intro">
        {group === "data"
          ? t("tools.validate.group.data.hint")
          : t(target.strict ? "tools.validate.group.gedcom.hint.strict" : "tools.validate.group.gedcom.hint.own", { version })}
      </p>
      {showRerun && (
        <ul className="tools-fix-list">
          <li className="tools-fix-item">
            <button
              className={`nav-btn tools-run${stale ? " primary" : ""}`}
              onClick={() => scans.refresh("validate")}
              disabled={rerunning}
            >
              {t("tools.scan.rerun")}
            </button>
            <span className="tools-fix-hint">
              {rerunning ? t("tools.running") : t("tools.validate.stale")}
            </span>
          </li>
        </ul>
      )}
      {batchDone !== null && (
        <p className="tools-clean tools-clean--ok">{t("tools.validate.fixPickedDone", { count: batchDone })}</p>
      )}
      {fixDone !== null && (
        <p className="tools-clean tools-clean--ok">
          {t(
            `tools.validate.fix${FIX_SUFFIX[fixDone.kind]}${fixDone.count > 0 ? "Done" : "None"}`,
            { count: fixDone.count },
          )}
        </p>
      )}
      {group === "data" && mediaMissing !== null && (
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
                <li key={`${m.file}-${i}`} className={`tools-issue sev-warning${i % 2 ? " zebra" : ""}`}>
                  <span className="tools-issue-msg" title={m.title ?? m.file}>{m.file}</span>
                  {m.usedBy.length > 0 && <UsageList dataset={dataset} uses={m.usedBy} onNavigate={onNavigate} />}
                </li>
              ))}
            </ul>
          </div>
        )
      )}
      {group === "data" && placeCoordDone !== null && (
        <p className="tools-clean tools-clean--ok">
          {t(`tools.validate.placeCoord.${placeCoordDone > 0 ? "done" : "none"}`, { count: placeCoordDone })}
        </p>
      )}
      {group === "data" && splitPlaces.length > 0 && placeCoordDone === null && (
        <div className="tools-struct">
          <div className="tools-examples-title">{t("tools.validate.placeCoord.title")}</div>
          <p className="tools-fix-hint">{t("tools.validate.placeCoord.hint", { count: splitPlaces.length, fills: splitFills })}</p>
          <button className="nav-btn primary tools-run" onClick={() => setPlaceCoordPending(true)}>
            {t("tools.validate.placeCoord.fix", { count: splitFills })}
          </button>
          <ul className="tools-issues">
            {splitPlaces.slice(0, 200).map((p, i) => (
              <li key={`${p.value}\u0000${p.address}`} className={`tools-issue sev-warning${i % 2 ? " zebra" : ""}`}>
                <span className="tools-issue-msg">{p.address ? `${p.value} · ${p.address}` : p.value}</span>
                <span className="tools-chip-count" title={t("tools.validate.placeCoord.occ", { count: p.missing })}>
                  {p.missing}
                </span>
                <span className="gm-data gm-coord gm-coord--set">
                  {formatCoord(p.coord)}
                </span>
              </li>
            ))}
          </ul>
          {splitPlaces.length > 200 && (
            <p className="tools-fix-hint">{t("tools.geocode.more", { count: splitPlaces.length - 200 })}</p>
          )}
        </div>
      )}
      {placeCoordPending && (
        <ConfirmDialog
          message={`${t("tools.validate.placeCoord.fix", { count: splitFills })}\n\n${t("tools.validate.placeCoord.fixHint")}`}
          confirmLabel={t("tools.validate.applyFix")}
          busy
          onConfirm={applyPlaceCoordFix}
          onCancel={() => setPlaceCoordPending(false)}
        />
      )}
      {group === "data" && showMediaCheck && (
        <ul className="tools-fix-list">
          <li className="tools-fix-item">
            <button className="nav-btn tools-run" onClick={runMediaCheck} disabled={mediaChecking}>
              {t("tools.validate.media.check", { count: mediaFiles.length })}
            </button>
            <span className="tools-fix-hint">{t("tools.validate.media.checkHint", { name: folderName })}</span>
          </li>
        </ul>
      )}
      {tranLang.doneNote}
      {editMedia && (
        <MediaLinkDialog
          url={editMedia.url}
          t={t}
          onClose={() => setEditMedia(null)}
          onSave={(url) => {
            onEditMediaFile(editMedia.xref, editMedia.path, url);
            setEditMedia(null);
            scans.refresh("validate");
          }}
        />
      )}
      <AddSourceDialog
        isOpen={editingSource !== undefined}
        onClose={() => setEditSrc(null)}
        onAdd={() => setEditSrc(null)}
        dataset={dataset}
        t={t}
        editing={editingSource}
        standalone
      />
      {batchPending && (
        <ConfirmDialog
          message={batchMessage}
          confirmLabel={t("tools.validate.applyFix")}
          busy
          onConfirm={applyPicked}
          onCancel={() => setBatchPending(false)}
        />
      )}
      {total === 0 ? (
        group === "gedcom"
          ? <p className="tools-clean">{t("tools.validate.clean.gedcom", { version })}</p>
          : !(mediaMissing && mediaMissing.length > 0) &&
            !(splitPlaces.length > 0 && placeCoordDone === null) && <p className="tools-clean">{t("tools.validate.clean.data")}</p>
      ) : (
        <>
          <div className="tools-filter-row">
            <TreeSearch value={query} onChange={setQuery} />
            <div className="tools-chips">
              {/* "All" leads the row, as it does on the geocoding and naming
                  pages: the whole list first, then the categories that cut it. */}
              <button
                className={`tools-chip ${filter === "all" ? "active" : ""}`}
                onClick={() => setFilter("all")}
              >
                {t("tools.validate.all")} <span className="tools-chip-count">{total}</span>
              </button>
              {fixableTotal > 0 && (
                <button
                  className={`tools-chip ${filter === "fixable" ? "active" : ""}`}
                  onClick={() => setFilter("fixable")}
                >
                  {t("tools.validate.fixable")} <span className="tools-chip-count">{fixableTotal}</span>
                </button>
              )}
              {CATEGORIES.filter((c) => group === "data" && report.counts[c] > 0).map((c) => (
                <button
                  key={c}
                  className={`tools-chip ${filter === c ? "active" : ""}`}
                  onClick={() => setFilter(c)}
                >
                  {t(`tools.validate.cat.${c}`)} <span className="tools-chip-count">{report.counts[c]}</span>
                </button>
              ))}
              {STRUCT_CATEGORIES.filter((c) => structGroup(c) === group && (structure?.counts[c] ?? 0) > 0).map((c) => {
                const count = structure!.counts[c]
                  - (c === "missingLine" ? untaggedTranCount : 0)
                  - (c === "enumValue" ? eventTextCount : 0);
                return count > 0 && (
                  <button
                    key={c}
                    className={`tools-chip ${filter === c ? "active" : ""}`}
                    onClick={() => setFilter(c)}
                  >
                    {t(`tools.validate.struct.cat.${c}`)} <span className="tools-chip-count">{count}</span>
                  </button>
                );
              })}
              {group === "gedcom" && hasUntaggedTran && (
                <button
                  className={`tools-chip ${filter === "tranLang" ? "active" : ""}`}
                  onClick={() => setFilter("tranLang")}
                >
                  {t("tools.validate.tranLang.title")} <span className="tools-chip-count">{untaggedTranCount}</span>
                </button>
              )}
              {group === "gedcom" && eventTextCount > 0 && (
                <button
                  className={`tools-chip ${filter === "eventText" ? "active" : ""}`}
                  onClick={() => setFilter("eventText")}
                >
                  {t("tools.validate.eventText.title")} <span className="tools-chip-count">{eventTextCount}</span>
                </button>
              )}
            </div>
          </div>
          {/* What saving will do to a file that didn't arrive as UTF-8. It sits
              directly above the findings — so filtering to Encoding puts it
              beside the decoder's own line, which says what was read but not
              what leaves. Outside the virtual list: its rows must stay a
              uniform height. */}
          {group === "gedcom" && charsetNotes.map((note, i) => <p className="tools-note" key={i}>{note}</p>)}
          {group === "gedcom" && fileFixes.map((fix) => (
            <p className="tools-file-note" key={fix}>{t(`preview.fix.${fix}`, { name: submitterName(authorName) })}</p>
          ))}
          {/* The per-name language worklist, with its two buttons, above the
              findings it answers. */}
          {filter === "tranLang" && <>{tranLang.actions}{tranLang.list}</>}
          {/* Picking rows for one batch: all fixable rows of the view, or some. */}
          {shownPickable.length > 0 && (
            <div className="tools-pick-bar">
              <label className="tools-pick-all">
                <input type="checkbox" checked={allShownPicked} onChange={toggleAllShown} />
                {t("tools.validate.pickAll", { count: shownPickable.length })}
              </label>
              {picked.size > 0 && (
                <>
                  <span className="tools-pick-count">{t("tools.validate.picked", { count: picked.size })}</span>
                  <button className="nav-btn primary tools-run" onClick={() => setBatchPending(true)}>
                    {t("tools.validate.fixPicked", { count: picked.size })}
                  </button>
                  <button className="nav-btn tools-run" onClick={() => setPicked(new Map())}>
                    {t("tools.validate.clearPicked")}
                  </button>
                </>
              )}
            </div>
          )}
          {shown.length === 0 ? (
            <p className="tools-clean">{t("tools.search.noMatch")}</p>
          ) : (
            <ul className="tools-issues" ref={listRef} tabIndex={-1}>
              <li className="v-spacer" style={{ height: virtual.padTop }} ref={virtual.topRef} aria-hidden />
              {shown.slice(virtual.start, virtual.end).map((row, j) => {
                const i = virtual.start + j;
                const zebra = (i % 2 ? " zebra" : "") + (i === selected ? " selected" : "");
                const current = i === selected ? "true" : undefined;
                return row.kind === "record" ? (
                  <li key={`r-${row.issue.id}-${row.issue.category}-${i}`} className={`tools-issue sev-${row.issue.severity}${zebra}`} aria-current={current}>
                    <PickBox row={row} pickable={pickable(row)} picked={picked.has(rowKey(row.issue))} onToggle={togglePick} />
                    <PersonLink dataset={dataset} id={row.issue.id} fallback={row.issue.subject} onNavigate={onNavigate} />
                    <span className="tools-issue-msg">{t(row.issue.messageKey, issueVars(row.issue))}</span>
                    <RowFixButton
                      fix={recordRowFix(row.issue)}
                      done={fixedRows.has(rowKey(row.issue))}
                      onRun={(run) => runRowFix(row.issue, run)}
                    />
                  </li>
                ) : (
                  <StructRow
                    key={`s-${row.issue.category}-${i}`}
                    pick={<PickBox row={row} pickable={pickable(row)} picked={picked.has(rowKey(row.issue))} onToggle={togglePick} />}
                    onEditSource={setEditSrc}
                    issue={row.issue}
                    zebra={zebra}
                    current={current}
                    dataset={dataset}
                    onNavigate={onNavigate}
                    fix={structRowFix(row.issue)}
                    done={fixedRows.has(rowKey(row.issue))}
                    onRun={(run) => runRowFix(row.issue, run)}
                    variationOf={(keptStamps && row.issue.stamps) || (keptCoverage && row.issue.coverage) ? dialect?.software ?? "" : undefined}
                    open={row.issue.messageKey === TRAN_LANG_KEY && filter !== "tranLang"
                      ? { label: t("tools.validate.tranLang.open"), run: () => setFilter("tranLang") }
                      : mediaLinkOf(row.issue)
                        ? { label: t("mediaLink.title"), run: () => setEditMedia(mediaLinkOf(row.issue)!) }
                        : undefined}
                  />
                );
              })}
              <li className="v-spacer" style={{ height: virtual.padBottom }} ref={virtual.bottomRef} aria-hidden />
            </ul>
          )}
        </>
      )}
    </>
  );
}

/** A fixable row's checkbox, picking it for a batch; nothing on a row with no
 *  fix (or one already fixed). */
function PickBox({
  row,
  pickable,
  picked,
  onToggle,
}: {
  row: IssueRow;
  pickable: boolean;
  picked: boolean;
  onToggle: (row: IssueRow) => void;
}) {
  const { t } = useTranslation();
  if (!pickable) return null;
  return (
    <input
      type="checkbox"
      className="tools-pick"
      checked={picked}
      onChange={() => onToggle(row)}
      aria-label={t("tools.validate.pickOne")}
    />
  );
}

/** A row's own fix button — or, once clicked, the note that it ran. Rendered at
 *  the end of the row, in place of nothing when the row has no repair of its
 *  own. Removals wear the danger colour, corrections the "changed" one. */
function RowFixButton({
  fix,
  done,
  onRun,
}: {
  fix: RowFix | null;
  done: boolean;
  onRun: (run: () => void) => void;
}) {
  const { t } = useTranslation();
  if (!fix) return null;
  if (done) return <span className="tools-issue-fixed">{t("tools.validate.fixOneDone")}</span>;
  return (
    <button
      className={`tools-issue-fix${fix.removes ? "" : " sets"}`}
      title={fix.hint}
      onClick={() => onRun(fix.run)}
    >
      {fix.label}
    </button>
  );
}

/** The one row standing for every translation without a language. */
const TRAN_LANG_KEY = "tools.validate.struct.issue.missingTranLang";

/** Findings tallied across the file under one row ("(78×)"): their record is
 *  only the first of many, so the row names none. */
const GROUPED_KEYS = new Set([
  "tools.validate.struct.issue.misplaced",
  "tools.validate.struct.issue.misplacedRoot",
  "tools.validate.struct.issue.misplacedStamp",
  "tools.validate.struct.issue.missingMany",
  "tools.validate.struct.issue.smartMatch",
  TRAN_LANG_KEY,
  "tools.validate.struct.issue.misplacedStamps",
  "tools.validate.struct.issue.unknownTag",
  "tools.validate.struct.issue.customTag",
  "tools.validate.struct.issue.customTagKnown",
  "tools.validate.struct.issue.danglingXref",
]);
function isGrouped(i: StructIssue): boolean {
  return (GROUPED_KEYS.has(i.messageKey) && Number(i.messageVars?.count) > 1) || (i.groupCount ?? 0) > 1;
}

/** Text on an event line (`DEAT 1.5y old`), which the fix moves into a note. */
function isEventText(i: StructIssue): boolean {
  return i.messageKey === "tools.validate.struct.issue.badY" && !!i.toNote;
}

/** A translation the standard wants a language on, written without one. */
function isUntaggedTran(i: StructIssue): boolean {
  return i.messageKey === "tools.validate.struct.issue.missing" && i.sample === "LANG" && String(i.messageVars?.parent).endsWith(".TRAN");
}

// ── Structural ("spec") validation ───────────────────────────────────────────

const STRUCT_CATEGORIES: StructCategory[] = [
  "syntax",
  "level",
  "strayCont",
  "danglingXref",
  "duplicateXref",
  "pointerType",
  "encoding",
  "version",
  "unknownTag",
  "misplacedTag",
  "cardinality",
  "missingLine",
  "enumValue",
  "valueFormat",
  "xrefShape",
  "badDate",
  "impossibleDate",
  "reversedRange",
  "shortYear",
  "nonStandardDate",
  "ambiguousDate",
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
  onEditSource,
}: {
  dataset: Dataset;
  id?: string;
  tag?: string;
  onNavigate: (id: string) => void;
  /** A source opens its editor, as a person opens in Edit. */
  onEditSource?: (xref: string) => void;
}) {
  const { t } = useTranslation();
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
  // A source, a media object, a repository: named by its title, so the row can
  // be found again in the file — the bare id stays on the hover.
  const record = id ? recordByXref(dataset.records, id) : undefined;
  const title = record && recordTitle(record);
  const ref = [tag, id].filter(Boolean).join(" ");
  if (title && id && record?.tag === "SOUR" && onEditSource) {
    return (
      <button
        type="button"
        className="tools-struct-rec tools-struct-rec--edit"
        title={t("tools.validate.editSource", { ref })}
        onClick={() => onEditSource(id)}
      >
        {tag && <span className="tools-struct-rec-tag">{tag}</span>} {title}
      </button>
    );
  }
  if (title) {
    return (
      <span className="tools-struct-rec" title={ref}>
        {tag && <span className="tools-struct-rec-tag">{tag}</span>} {title}
      </span>
    );
  }
  // No title (HEAD, a bare id): the tag in the same small type as everywhere.
  return (
    <span className="tools-struct-rec">
      {tag && <span className="tools-struct-rec-tag">{tag}</span>}
      {id && ` ${id}`}
    </span>
  );
}

function StructRow({
  issue,
  zebra,
  current,
  dataset,
  onNavigate,
  fix,
  done,
  onRun,
  onEditSource,
  variationOf,
  open,
  pick,
}: {
  issue: StructIssue;
  /** Class suffix from the list — " zebra", " selected", or both. */
  zebra?: string;
  /** The list's highlighted row. */
  current?: "true";
  dataset: Dataset;
  onNavigate: (id: string) => void;
  fix: RowFix | null;
  done: boolean;
  onRun: (run: () => void) => void;
  onEditSource: (xref: string) => void;
  /** The program whose kept habit the finding is, in a file kept with its variations. */
  variationOf?: string;
  /** Takes the reader to where the finding is settled (no fix of its own). */
  open?: { label: string; run: () => void };
  /** The row's checkbox for a batch (empty when it has no fix). */
  pick?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li className={`tools-issue sev-${issue.severity}${zebra ?? ""}`} title={issue.tooltip} aria-current={current}>
      {pick}
      {issue.recordTag && isGrouped(issue) ? (
        <span className="tools-struct-rec"><span className="tools-struct-rec-tag">{issue.recordTag}</span></span>
      ) : issue.recordTag ? (
        <RecordRef dataset={dataset} id={issue.recordId} tag={issue.recordTag} onNavigate={onNavigate} onEditSource={onEditSource} />
      ) : issue.line != null ? (
        <span className="tools-struct-loc">{t("tools.validate.struct.atLine", { line: issue.line })}</span>
      ) : null}
      <span className="tools-issue-msg">
        {t(issue.messageKey, issue.messageVars)}
        {(issue.groupCount ?? 0) > 1 && ` (${issue.groupCount}×)`}
      </span>
      {variationOf !== undefined && (
        <span className="tools-issue-detail">
          {variationOf ? t("tools.validate.struct.variationOf", { software: variationOf }) : t("tools.validate.struct.variationOwn")}
        </span>
      )}
      <RowFixButton fix={fix} done={done} onRun={onRun} />
      {open && <button className="tools-issue-fix sets" onClick={open.run}>{open.label}</button>}
      {/* A repairable date whose record can't carry an undo patch (no xref of its
          own) keeps the plain preview mark — the batch fix skips it too. */}
      {issue.fix && !fix && (
        <span className="tools-struct-fixable" title={t("tools.validate.struct.fixableTitle", { value: issue.fix })}>
          {t("tools.validate.struct.fixable", { value: issue.fix })}
        </span>
      )}
    </li>
  );
}

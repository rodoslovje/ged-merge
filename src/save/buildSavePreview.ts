import { buildEditReport, combineReports, enrichEditReport } from "../gedcom/editReport";
import { xrefLabel } from "../gedcom/nameDisplay";
import type { Dataset, GedNode } from "../gedcom/types";
import type { Translate } from "../locales/i18n";
import type { MatchResult } from "../match/types";
import { sortEventsByDate } from "../merge/applyFields";
import { buildEditSaveRecords } from "../merge/editSaveRecords";
import { mergeDecisions, type ChangeReport, type ImportBranchRequest } from "../merge/merge";
import { parseDecisionKey, type CandidateDecision } from "../review/types";
import { findDanglingXrefs } from "../tools/structure";
import type { SharedRecordSnapshot } from "../edit-state/useDirtyTracking";
import { baseStem, savedName } from "../ui/download";

/** At most this many findings of each kind reach the preview, so a systemic
 *  problem (or a bulk edit) can't flood the dialog. */
const MAX_WARNINGS = 8;

/** Everything the preview needs that isn't derivable from the datasets. */
export interface SavePreviewInput {
  /** The live main dataset. Never mutated: the edit-only path clones, and the
   *  merge path gets its clone from `mergeDecisions`. */
  main: Dataset;
  /** Name of the loaded main file — the download stem is derived from it. */
  mainFileName: string;
  /** The incoming file, when one is loaded. A merge without it is impossible
   *  (a restored session can carry decisions whose compare failed to load). */
  compare: Dataset | undefined;
  decisions: Map<string, CandidateDecision>;
  /** The last match result, if any — `null` while none has been computed. */
  matches: MatchResult | null | undefined;
  importRequests: ImportBranchRequest[];
  /** Confirmed decisions whose main person still exists, and opted-in branch
   *  imports — together they decide whether this save is a merge. */
  confirmedCount: number;
  importCount: number;
  /** Edit-mode dirty tracking. */
  changedPersonIds: Set<string>;
  changedFamilyIds: Set<string>;
  /** Top-level shared records (SOUR/OBJE/NOTE) edited in their own right — a
   *  Tools fix, say — with no owning person/family to carry the change. */
  changedRecordIds: Set<string>;
  loadedPersonIds: Set<string>;
  loadedFamilyIds: Set<string>;
  personSnapshots: Map<string, GedNode>;
  familySnapshots: Map<string, GedNode>;
  recordSnapshots: Map<string, SharedRecordSnapshot>;
  /** True for an individual whose events this save may reorder — see
   *  {@link buildEditSaveRecords}. */
  isSortEligible: (xref: string) => boolean;
  /** Timestamp shared by the .ged and its report so they sort together in the
   *  browser's Downloads list. Injected rather than read from the clock so the
   *  output is reproducible. */
  now: Date;
  t: Translate;
}

/** The payload the save dialog renders and `handleConfirmSave` writes out. */
export interface SavePreview {
  /** The record forest to serialize. Always independent of `main.records`. */
  records: GedNode[];
  report: ChangeReport;
  title: string;
  /** The two download filenames, already date-stamped. */
  files: string[];
  downloadLabel: string;
  /** For the merge "total records" line; absent on an edit-only save. */
  mainRecordCount?: number;
  base: string;
  /** Record ids from edit mode — the preview offers navigate/remove for these. */
  editRecordIds: Set<string>;
  /** Whether this save includes confirmed merge matches (vs. edits only). */
  isMerge: boolean;
  /** Dangling-pointer and stale-decision findings, shown as a warning strip. */
  integrityWarnings: string[];
}

/**
 * Build the save-preview payload: the records to write, the change report, the
 * download names and the integrity warnings.
 *
 * Pure with respect to the app: it reads the dataset and the dirty-tracking
 * state and returns a payload, mutating nothing the caller passed in. That
 * matters — the preview is built *before* the user has agreed to anything, so
 * an in-place edit here would land the moment the dialog opens and could not be
 * undone (it appears in no `RecordPatch`).
 *
 * Returns `null` when there is nothing to save.
 */
export function buildSavePreview(input: SavePreviewInput): SavePreview | null {
  const {
    main, mainFileName, compare, decisions, matches, importRequests,
    confirmedCount, importCount, changedPersonIds, changedFamilyIds, changedRecordIds,
    loadedPersonIds, loadedFamilyIds, personSnapshots, familySnapshots, recordSnapshots,
    isSortEligible, now, t,
  } = input;

  const changedCount = changedPersonIds.size + changedFamilyIds.size + changedRecordIds.size;
  // A merge needs an incoming file actually loaded, not merely decisions about one.
  const isMerge = (confirmedCount > 0 || importCount > 0) && !!compare;
  if (!isMerge && changedCount === 0) return null;

  const base = baseStem(mainFileName);
  const editRecordIds = new Set([...changedPersonIds, ...changedFamilyIds]);

  const editReport = changedCount > 0
    ? enrichEditReport(
        buildEditReport(changedPersonIds, changedFamilyIds, main, loadedPersonIds, loadedFamilyIds, personSnapshots, familySnapshots, changedRecordIds, recordSnapshots),
        main, personSnapshots, familySnapshots, t,
      )
    : null;

  let records: GedNode[];
  let report: ChangeReport;
  let mainRecordCount: number | undefined;
  if (isMerge) {
    const { records: mergedRecords, report: mergeReport } = mergeDecisions(
      main, compare!, decisions, matches ?? { individuals: [] }, t, importRequests,
    );
    records = mergedRecords;
    report = editReport ? combineReports(editReport, mergeReport) : mergeReport;
    mainRecordCount = main.individuals.size + main.families.size;
    // Merge targets are already sorted inside mergeDecisions; edited records
    // that had no confirmed decision are not, so sort them here. (The edit-only
    // branch does this inside buildEditSaveRecords.)
    for (const r of records) {
      if (r.tag === "INDI" && r.xref && isSortEligible(r.xref)) sortEventsByDate(r);
    }
  } else {
    records = buildEditSaveRecords(main.records, isSortEligible);
    report = editReport!;
  }

  return {
    records,
    report,
    title: t("save.preview.title"),
    files: [savedName(base, "ged", now), savedName(base, "report.txt", now)],
    downloadLabel: t("save.preview.download"),
    mainRecordCount,
    base,
    editRecordIds,
    isMerge,
    integrityWarnings: integrityWarnings(records, decisions, main, t),
  };
}

/**
 * Problems worth surfacing before the user commits to the download:
 *  - a pointer in the output referencing a record that isn't there, which would
 *    corrupt the file for other software;
 *  - a confirmed match whose main person was deleted after confirming, which
 *    the merge skips entirely.
 *
 * A field edited after its match was confirmed is *not* warned about here: the
 * merge now stands down and keeps the edit, and says so per field in the
 * report's deferred list (see `CandidateDecision.mainFields`).
 */
function integrityWarnings(
  records: GedNode[],
  decisions: Map<string, CandidateDecision>,
  main: Dataset,
  t: Translate,
): string[] {
  const warnings: string[] = [];

  const dangling = findDanglingXrefs(records);
  for (const d of dangling.slice(0, MAX_WARNINGS)) {
    warnings.push(t("save.preview.dangling", { tag: d.tag, xref: d.xref, count: d.count }));
  }
  if (dangling.length > MAX_WARNINGS) {
    warnings.push(t("save.preview.danglingMore", { count: dangling.length - MAX_WARNINGS }));
  }

  const decisionWarnings: string[] = [];
  for (const [key, d] of decisions) {
    if (d.status !== "confirmed") continue;
    const parsed = parseDecisionKey(key);
    if (parsed?.kind !== "individual") continue;
    if (main.individuals.has(parsed.mainId)) continue;
    decisionWarnings.push(t("save.preview.orphanedDecision", { xref: xrefLabel(parsed.mainId) }));
  }
  warnings.push(...decisionWarnings.slice(0, MAX_WARNINGS));
  if (decisionWarnings.length > MAX_WARNINGS) {
    warnings.push(t("save.preview.decisionWarningsMore", { count: decisionWarnings.length - MAX_WARNINGS }));
  }

  return warnings;
}

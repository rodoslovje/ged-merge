import type { Dataset, GedNode, SourceCitation } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { insertGrouped } from "../gedcom/edit";
import { displayName } from "../match/relatives";
import { inferPlaceExportFormat } from "../normalize/profile";
import type { PlaceTargetFormat } from "../normalize/types";
import { applyPlaceOverrides, type FormatOverrides } from "../normalize/formatOverrides";
import { individualFieldRows } from "../review/fields";
import { decisionKey, parseDecisionKey, type CandidateDecision, type FieldChoice } from "../review/types";
import type { Translate } from "../locales/i18n";
import {
  applyRows,
  buildSourXrefMap,
  cloneNode,
  detectLinkFormat,
  importSourRecords,
  sortEventsByDate,
} from "./applyFields";
import {
  applyImportBranches,
  applyIndividualFamilies,
  applyIndividualRelations,
  makeContext,
  type ImportBranchRequest,
} from "./applyRelations";

export type { ImportBranchRequest } from "./applyRelations";

export {
  combineEventEdits,
  type EventSubEdit,
  type LinkFormat,
  materializeEventSources,
  SUB_JOIN_ORDER,
  SUB_LABEL_KEY,
  SUB_TAG,
} from "./applyFields";

/** One field the merge wrote into a main record. */
export interface FieldChange {
  recordId: string;
  field: string;
  from: string;
  to: string;
  action: FieldChoice;
  /** Marks the placeholder change for a freshly added person/family record. */
  newRecord?: boolean;
  /** Set on a `newRecord` change when the record was brought in by a whole-branch
   *  graft (import ancestors/descendants) rather than a confirmed match's
   *  stitching — lets the preview flag it as "Incoming". */
  viaGraft?: boolean;
  /** Marks the placeholder change for a deleted person/family record. */
  removedRecord?: boolean;
  /** Set by the save-time audit (`save/auditReport.ts`) on a record that reaches
   *  the file changed, added or deleted with nothing in the report to say so.
   *  There is no before-copy left to diff, so the entry carries no field detail —
   *  it says only that the record moved, which beats saying nothing. */
  undescribed?: boolean;
  /** Event name (e.g. "Birth", "Marriage") this field belongs to, so the
   *  preview can show it once as a header above its date/place/note/source. */
  group?: string;
  /** The person's own identity — given name, surname, sex — rather than a field
   *  of one of their events. The preview lists these above the event groups, and
   *  omits them from a *new* person's card, whose header already spells the name
   *  out and colours it by sex. */
  identity?: boolean;
  /** The family's own identity — who fills its husband/wife slot. The preview
   *  omits these from a *new* family's card, whose header already names both
   *  spouses with their lifespans; on an existing family the same row is a real
   *  before/after and stays. */
  spouseSlot?: boolean;
  /** Set when an existing event was modified (not newly added/removed) — the preview
   *  renders these pieces in place of `from`/`to`, coloring each by whether the edit
   *  actually touched it, instead of treating the whole line as one new value. */
  segments?: {
    text: string;
    state: "same" | "changed" | "removed";
    /** What that piece said before, for a piece the edit replaced. The preview
     *  strikes it through ahead of the new text, the way every other changed
     *  field in this dialog reads — a place rewritten by the naming check showed
     *  only what it became, and the one thing a preview is for is seeing what
     *  is being given up. Absent where there was nothing there before. */
    from?: string;
  }[];
  /** True when `to` is a verbatim, un-chosen copy of the incoming file's value (the
   *  user took "incoming" by default, didn't combine it with main or type it by
   *  hand) — the preview colors these like other incoming-sourced data rather than
   *  as an edit. Only meaningful for merge-produced changes. */
  unedited?: boolean;
  /** Source citations this change added, rendered as the same 📖/🔗 icons (with
   *  tooltip) the main UI uses — inline on the event's data line rather than as a
   *  separate text row. When set, `from`/`to` carry no display text. */
  sources?: SourceCitation[];
  /** Plain attached links (record- or event-level) this change added, rendered as
   *  🔗 icons inline like `sources`. */
  links?: string[];
  /** Suppress the field-label prefix in the save preview (the value is
   *  self-describing, e.g. a photo's full file path). The text report still
   *  uses `field` to group/label the line. */
  noLabel?: boolean;
}

/** A confirmed change the engine did not yet apply (relationship/links). */
export interface DeferredChange {
  recordId: string;
  field: string;
  reason: string;
}

/** A spouse shown on a family's preview card (husband first, then wife). */
export interface FamilySpouseInfo {
  /** Individual xref, when resolvable (lets the UI look up sex/lifespan). */
  id?: string;
  name: string;
}

/**
 * A non-standard (vendor `_TAG`) node copied in from the incoming file as part
 * of a merge, kept live (with its parent) inside the merged tree so the save
 * preview can strip it — per tag name — if the user opts out.
 */
export interface CustomTagNode {
  parent: GedNode;
  node: GedNode;
}

/**
 * One person a branch import treated as somebody the main file already has,
 * on the matcher's suggestion rather than the user's confirmation. Attaching
 * a branch is the one place the merge acts on an identity nobody reviewed
 * (it links records — it never copies fields there), so each such identity is
 * named in the save preview while the download can still be called off.
 */
export interface GraftJoin {
  /** The main record the incoming person was joined onto. */
  mainId: string;
  /** The main person, as the preview shows anyone: name, lifespan, sex colour. */
  main: GraftJoinPerson;
  /** The incoming person the graft took to be them. */
  incoming: GraftJoinPerson;
}

/** One side of a {@link GraftJoin}, carrying what a person label is made of —
 *  neither record is reachable from the save preview (the incoming one isn't in
 *  the main dataset, and the main one may be untouched), so the pieces travel
 *  with the entry rather than being looked up there. */
export interface GraftJoinPerson {
  name: string;
  /** "1944–2017", "1972", or "" when no year is known ({@link lifespanOf}). */
  years: string;
  sex: import("../gedcom/types").Sex;
}

export interface ChangeReport {
  changes: FieldChange[];
  deferred: DeferredChange[];
  /** Identities a branch import used without a confirmation (see {@link GraftJoin}). */
  graftJoins: GraftJoin[];
  /** Distinct main records touched. */
  recordsChanged: number;
  /** New individual records added from the incoming file. */
  newPersons: number;
  /** New family records created to stitch merged relationships together. */
  newFamilies: number;
  /** Display label per touched record id, for grouping the preview/report. */
  recordLabels: Record<string, string>;
  /** Whether each touched record is an individual, a family, or a top-level
   *  shared record (SOUR/OBJE/NOTE — edited on its own, e.g. by a Tools fix). */
  recordKinds: Record<string, "individual" | "family" | "record">;
  /** Husband/wife (in that order) for each touched family record. */
  familySpouses: Record<string, FamilySpouseInfo[]>;
  /** The incoming record behind each newly added person, keyed by its new main
   *  xref. A fresh record isn't in the (pre-merge) main dataset, so the save
   *  preview reads sex, lifespan and facts from here to show it like any other
   *  person instead of as a bare name. */
  newIndividuals?: Record<string, import("../gedcom/types").Individual>;
  /** Non-standard tags copied in from the incoming file, grouped by tag name,
   *  for the save preview's "exclude this tag" list. */
  customTags: Record<string, CustomTagNode[]>;
}

export interface MergeResult {
  /** A clone of the main record forest with confirmed edits applied. */
  records: GedNode[];
  report: ChangeReport;
}

/**
 * Whether a change is one of the itemized field lines — the rows the save
 * preview shows under a record and the text report lists under its header.
 * Record-level markers (a record added, deleted, or moved with no detail to
 * give) are not fields, and a row carrying neither text nor icons is nothing at
 * all.
 */
export function isItemizedChange(c: FieldChange): boolean {
  if (c.newRecord || c.removedRecord || c.undescribed) return false;
  return !!(c.from || c.to || c.segments || c.sources?.length || c.links?.length);
}

/** The numbers in the save preview's summary strip and at the head of the
 *  downloaded report — counted once, here, so the two can't disagree. Each is
 *  a count of what the surfaces actually go on to show. */
export interface ReportTotals {
  /** Records with anything to say about them. */
  recordsChanged: number;
  /** Itemized field lines ({@link isItemizedChange}). */
  fields: number;
  /** Of those, the ones filling a field the record had nothing in. */
  newFields: number;
  /** Records the file didn't have: new persons, families and shared records. */
  newRecords: number;
  /** Records the file had that this save will not write. */
  removedRecords: number;
  /** Changed records the report can't itemize — see `FieldChange.undescribed`. */
  undescribedRecords: number;
  /** Values kept as they stand in the main file. */
  deferred: number;
}

export function reportTotals(report: ChangeReport): ReportTotals {
  const added = new Set<string>();
  const removed = new Set<string>();
  const undescribed = new Set<string>();
  let fields = 0;
  let newFields = 0;
  for (const c of report.changes) {
    if (c.newRecord) added.add(c.recordId);
    if (c.removedRecord) removed.add(c.recordId);
    if (c.undescribed) undescribed.add(c.recordId);
    if (!isItemizedChange(c)) continue;
    fields++;
    if (!c.from) newFields++;
  }
  for (const id of [...added, ...removed]) undescribed.delete(id);
  return {
    recordsChanged: report.recordsChanged,
    fields,
    newFields,
    newRecords: added.size,
    removedRecords: removed.size,
    undescribedRecords: undescribed.size,
    deferred: report.deferred.length,
  };
}

/**
 * Relationship and family-event fields handled structurally (parents/partners by
 * `applyIndividualRelations`, marriage/children by `applyIndividualFamilies`) —
 * so `applyRows` skips them rather than treating them as scalar individual fields.
 */
export const INDI_HANDLED = new Set([
  "father",
  "mother",
]);

/**
 * The place layout the merge writes with: the main's own habit, overridden by
 * the reader's Settings → GEDCOM choices. One function shared by
 * `mergeDecisions` and the confirm-time `mainFields` snapshot (App's
 * `stampMainRows`), so the two build their comparison rows from the same
 * format and the edited-after-confirm gate compares like with like.
 */
export function mergePlaceFormat(main: Dataset, overrides?: FormatOverrides): PlaceTargetFormat {
  return applyPlaceOverrides(inferPlaceExportFormat(main), overrides);
}

/**
 * Apply confirmed match decisions to a clone of the main tree, taking each
 * field the user chose from the incoming side (or "both"). Untouched records are
 * left as identical clones, so serializing the result yields a minimal diff
 * against the original main.
 *
 * Individuals: scalar fields (sex, primary name, event date/place/address).
 * Families: marriage fields plus structural stitching — missing spouses and
 * children from the incoming family are linked to their matched main person
 * (via `matches`) or, when genuinely new, added as fresh records with the right
 * FAMC/FAMS/HUSB/WIFE/CHIL pointers.
 *
 * Individual relationship fields and links are still recorded as deferred.
 */
export function mergeDecisions(
  main: Dataset,
  compare: Dataset,
  decisions: Map<string, CandidateDecision>,
  matches: MatchResult,
  t: Translate,
  /** Opt-in "graft this whole branch from the incoming file" requests, made from
   *  the compare tree. Applied after the confirmed-decision loop so matched
   *  anchors (and any families those decisions stitched) exist to graft onto. */
  importBranches: Iterable<ImportBranchRequest> = [],
  /** The reader's Settings → GEDCOM choices, so a place written into the main
   *  by this merge follows them rather than only the main's own habit. */
  overrides?: FormatOverrides,
): MergeResult {
  const records = main.records.map(cloneNode);
  const sourXrefMap = buildSourXrefMap(compare.records, records);
  const indiNodes = new Map<string, GedNode>();
  const famNodes = new Map<string, GedNode>();
  for (const r of records) {
    if (!r.xref) continue;
    if (r.tag === "INDI") indiNodes.set(r.xref, r);
    else if (r.tag === "FAM") famNodes.set(r.xref, r);
  }

  const report: ChangeReport = {
    changes: [],
    deferred: [],
    graftJoins: [],
    recordsChanged: 0,
    newPersons: 0,
    newFamilies: 0,
    recordLabels: {},
    recordKinds: {},
    familySpouses: {},
    newIndividuals: {},
    customTags: {},
  };
  const touched = new Set<string>();
  // How the main writes places, so incoming places can be reshaped to match.
  const placeFmt = mergePlaceFormat(main, overrides);
  // How the main stores record-level links, so newly added links match (e.g.
  // a plain WWW line, Family Historian's _WEBTAG block, or an OBJE/FILE record).
  const linkFormat = detectLinkFormat(main);
  // Matches the user explicitly rejected: dropped from the merge's identity map
  // so a rejected pair is never reused to stitch relationships — the incoming
  // person is imported as a new record instead of folded into the wrong main.
  const rejectedPairs = new Set<string>();
  // Matches the user confirmed: the only identities that outrank the files' own
  // evidence against a pairing — everything else in the map is a suggestion.
  const confirmedPairs = new Set<string>();
  for (const [key, decision] of decisions) {
    const parsed = parseDecisionKey(key);
    if (parsed?.kind !== "individual") continue;
    if (decision.status === "rejected") rejectedPairs.add(`${parsed.mainId}|${parsed.compareId}`);
    else if (decision.status === "confirmed") confirmedPairs.add(`${parsed.mainId}|${parsed.compareId}`);
  }
  const ctx = makeContext(main, compare, matches, records, indiNodes, famNodes, report, touched, t, sourXrefMap, rejectedPairs, confirmedPairs);

  // A family with both spouses confirmed is stitched only once — on the first
  // spouse's turn (see processedFamIds). Its rows, though, were reviewed on
  // *both* spouses' cards, so merge every confirmed decision's family-row
  // choices (and child ticks) up front and let that first turn apply them all;
  // otherwise the second spouse's explicit picks would be silently dropped by
  // confirmation order. When both spouses chose the same key, the later
  // confirmation wins — the app moves an updated decision to the end of the
  // map (see withFreshDecision), so iteration order here IS recency order.
  const famFields: Record<string, FieldChoice> = {};
  const allTakenChildren = new Set<string>();
  for (const [key, decision] of decisions) {
    if (decision.status !== "confirmed") continue;
    const parsed = parseDecisionKey(key);
    if (parsed?.kind !== "individual") continue;
    // A stale decision whose records are gone (its main person deleted in
    // Edit, or the compare id no longer present) is skipped by the merge loop
    // below — its shared-family picks and child ticks must not leak in through
    // the surviving spouse's stitch either.
    if (!indiNodes.get(parsed.mainId) || !main.individuals.get(parsed.mainId) || !compare.individuals.get(parsed.compareId))
      continue;
    for (const id of decision.takenChildren ?? []) allTakenChildren.add(id);
    for (const [k, v] of Object.entries(decision.fields)) {
      if (k.startsWith("fam.")) famFields[k] = v;
    }
  }

  for (const [key, decision] of decisions) {
    if (decision.status !== "confirmed") continue;
    const parsed = parseDecisionKey(key);
    if (parsed?.kind !== "individual") continue; // families are merged via their spouses
    const { mainId, compareId } = parsed;

    const target = indiNodes.get(mainId);
    const mainIndi = main.individuals.get(mainId);
    const incoming = compare.individuals.get(compareId);
    if (!target || !mainIndi || !incoming) continue;
    report.recordLabels[mainId] = displayName(mainIndi.names[0]);
    const rejectedEvents = decision.rejectedEvents?.length ? new Set(decision.rejectedEvents) : undefined;
    const rows = individualFieldRows(t, mainIndi, incoming, main, compare, placeFmt, rejectedEvents);
    applyRows(target, incoming.raw, mainId, rows, decision.fields, report, touched, INDI_HANDLED, t, linkFormat, records, sourXrefMap, decision.mainFields);
    applyIndividualRelations(mainId, mainIndi, incoming, rows, decision.fields, main, compare, ctx);
    applyIndividualFamilies(mainId, mainIndi, incoming, rows, { ...decision.fields, ...famFields }, main, compare, ctx, allTakenChildren);
    // Canonical event order, but only when this decision actually wrote
    // something — a confirmed match that took no fields must leave the record
    // byte-identical (the minimal-diff guarantee), not silently reorder it.
    if (touched.has(mainId)) {
      // Carry the incoming record's unique ids (`_UID`/`UID`) onto the merged
      // main record: the next import of the same compare lineage then
      // auto-matches this person by identity instead of by name/date score.
      carryUids(target, incoming.raw);
      sortEventsByDate(target);
    }
  }

  // Graft any whole subtrees the user asked for from the compare tree, now that
  // confirmed matches and their families exist to anchor onto. Records added from
  // here on are reported as imported (preview flags them "Incoming").
  ctx.beginGraftPhase();
  applyImportBranches(importBranches, main, compare, ctx);

  // Derive record kinds from node maps built during merge. Deferred rows count
  // as well as changes: a family the merge left untouched *because* the two
  // files disagreed appears nowhere else, and without a kind here it would miss
  // the labelling pass below and be reported to the user as a bare xref.
  for (const c of [...report.changes, ...report.deferred]) {
    if (report.recordKinds[c.recordId]) continue;
    if (indiNodes.has(c.recordId)) report.recordKinds[c.recordId] = "individual";
    else if (famNodes.has(c.recordId)) report.recordKinds[c.recordId] = "family";
  }

  // Label each touched family by its husband/wife (pre-existing or newly
  // stitched in), husband first then wife, for the save-preview family card.
  for (const [id, kind] of Object.entries(report.recordKinds)) {
    if (kind !== "family") continue;
    const famNode = famNodes.get(id);
    if (!famNode) continue;
    const entries: FamilySpouseInfo[] = [];
    for (const role of ["HUSB", "WIFE"] as const) {
      const spouseId = famNode.children.find((c) => c.tag === role)?.value;
      if (spouseId) entries.push({ id: spouseId, name: ctx.label(spouseId) });
    }
    if (entries.length) {
      report.recordLabels[id] = entries.map((e) => e.name).join(" + ");
      report.familySpouses[id] = entries;
    }
  }

  // Import any SOUR/REPO records from compare that are now referenced in the
  // merged output but absent from it (e.g. citations on newly-added people).
  importSourRecords(records, compare, sourXrefMap, report.customTags);

  report.recordsChanged = touched.size;
  return { records, report };
}

/** Unique-id tags carried across on merge (vendor `_UID` + GEDCOM 7 `UID`). */
const UID_TAGS = new Set(["_UID", "UID"]);

/** Trailing record-audit tags a carried UID must land *before*, so the
 *  bookkeeping stays at the end of the record where every writer puts it. */
const UID_BEFORE_TAGS = ["CHAN", "CREA"] as const;

/**
 * Copy the incoming record's unique ids onto the merged main record, skipping
 * values the main already carries in any brace/dash spelling. A record may
 * legitimately hold several — GEDCOM 7 explicitly allows multiple UIDs, one per
 * lineage the record has lived in.
 *
 * Placed with {@link insertGrouped} rather than appended: `_UID`/`UID` are not
 * in `INDI_CHILD_ORDER`, so a plain push would drop them after any trailing
 * CHAN/CREA. This keeps a second UID next to the first and both ahead of the
 * audit stamps, matching how the rest of the edit layer writes.
 */
function carryUids(target: GedNode, incoming: GedNode): void {
  const canon = (v: string) => v.replace(/[{}\s-]/g, "").toUpperCase();
  const existing = new Set(
    target.children.filter((c) => UID_TAGS.has(c.tag) && c.value?.trim()).map((c) => canon(c.value!)),
  );
  for (const child of incoming.children) {
    if (!UID_TAGS.has(child.tag) || !child.value?.trim()) continue;
    if (existing.has(canon(child.value))) continue;
    existing.add(canon(child.value));
    insertGrouped(target, { level: 0, tag: child.tag, value: child.value.trim(), children: [] }, UID_BEFORE_TAGS);
  }
}

/** Human-readable change report (plain text) to download alongside the merge. */
/** A one-line, plain-text description of a citation for the change report. */
function citationText(c: SourceCitation): string {
  const parts = [c.title, c.page ? `p. ${c.page}` : undefined].filter(Boolean);
  return parts.join(", ") || c.url || c.sourceId;
}

/** What the downloaded report says about itself besides the changes: which file
 *  it belongs to, what it was saved as, and what the save did to the file as a
 *  whole (see {@link formatReport}). */
export interface ReportContext {
  t: Translate;
  /** The main file this save started from. */
  mainFileName?: string;
  /** The `.ged` written alongside this report. */
  savedFileName?: string;
  /** The incoming file, on a merge. */
  compareFileName?: string;
  /** Stamped into the header so the report says when it was made without the
   *  reader having to trust the filename. */
  savedAt?: Date;
  /** Things this save did to every record rather than to one — the encoding
   *  rewrite, the vendor tags the reader unticked, the audit stamps. Already
   *  translated by the caller, which is where each is decided. */
  fileNotes?: string[];
}

function underline(text: string, char: "=" | "-"): string[] {
  // Underline by character count, not by width — a proportional-font reader
  // won't line it up anyway, and this keeps accented names from over-running.
  return [text, char.repeat([...text].length)];
}

export function formatReport(report: ChangeReport, ctx: ReportContext): string {
  const { t } = ctx;
  const lines: string[] = [];
  const totals = reportTotals(report);

  lines.push(...underline(t("changeReport.title"), "="));
  lines.push("");

  const head: [string, string | undefined][] = [
    [t("changeReport.head.file"), ctx.mainFileName],
    [t("changeReport.head.savedAs"), ctx.savedFileName],
    [t("changeReport.head.incoming"), ctx.compareFileName],
    [t("changeReport.head.date"), ctx.savedAt?.toISOString().slice(0, 16).replace("T", " ")],
  ];
  const headRows = head.filter((r): r is [string, string] => !!r[1]);
  if (headRows.length) {
    for (const [label, value] of headRows) lines.push(`${`${label}:`.padEnd(22)}${value}`);
    lines.push("");
  }

  // Every number the summary shows is a count of something spelled out below,
  // so a reader can check the report against itself.
  const stats: [string, number][] = [
    [t("changeReport.stat.records"), totals.recordsChanged],
    [t("changeReport.stat.fields"), totals.fields],
    [t("changeReport.stat.newFields"), totals.newFields],
    [t("changeReport.stat.added"), totals.newRecords],
    [t("changeReport.stat.removed"), totals.removedRecords],
    [t("changeReport.stat.undescribed"), totals.undescribedRecords],
    [t("changeReport.stat.deferred"), totals.deferred],
  ];
  const width = Math.max(...stats.map(([label]) => [...label].length)) + 2;
  for (const [label, value] of stats) lines.push(`${`${label}:`.padEnd(width)}${String(value).padStart(6)}`);
  lines.push("");

  if (ctx.fileNotes?.length) {
    lines.push(...underline(t("changeReport.wholeFile"), "-"));
    for (const note of ctx.fileNotes) lines.push(`  ${note}`);
    lines.push("");
  }

  const recordHeader = (id: string) => {
    const label = report.recordLabels[id];
    return label ? `${label}  ${id}` : id;
  };

  const itemized = report.changes.filter(isItemizedChange);
  if (itemized.length) {
    lines.push(...underline(t("changeReport.applied"), "-"));
    const byRecord = new Map<string, FieldChange[]>();
    for (const c of itemized) {
      const group = byRecord.get(c.recordId) ?? [];
      group.push(c);
      byRecord.set(c.recordId, group);
    }
    for (const [id, group] of byRecord) {
      lines.push(...underline(recordHeader(id), "-"));
      for (const c of group) lines.push(`  ${changeLine(c, t)}`);
      lines.push("");
    }
  }

  // Records the file gains and loses, each named once, rather than left to be
  // inferred from the relationship lines of everybody around them.
  for (const [key, flag] of [
    ["changeReport.added", "newRecord"],
    ["changeReport.removed", "removedRecord"],
  ] as const) {
    const ids = [...new Set(report.changes.filter((c) => c[flag]).map((c) => c.recordId))];
    if (!ids.length) continue;
    lines.push(...underline(t(key), "-"));
    for (const id of ids) lines.push(`  ${recordHeader(id)}`);
    lines.push("");
  }

  const undescribed = [
    ...new Set(
      report.changes
        .filter((c) => c.undescribed && !c.newRecord && !c.removedRecord)
        .map((c) => c.recordId),
    ),
  ];
  if (undescribed.length) {
    lines.push(...underline(t("changeReport.undescribed"), "-"));
    lines.push(`  ${t("changeReport.undescribedHint")}`);
    for (const id of undescribed) lines.push(`  ${recordHeader(id)}`);
    lines.push("");
  }

  if (report.deferred.length) {
    lines.push(...underline(t("changeReport.kept"), "-"));
    const byRecord = new Map<string, DeferredChange[]>();
    for (const d of report.deferred) {
      const group = byRecord.get(d.recordId) ?? [];
      group.push(d);
      byRecord.set(d.recordId, group);
    }
    for (const [id, group] of byRecord) {
      lines.push(...underline(recordHeader(id), "-"));
      for (const d of group) lines.push(`  ${d.field}: ${d.reason}`);
      lines.push("");
    }
  }

  if (report.graftJoins.length) {
    lines.push(...underline(t("changeReport.grafted"), "-"));
    const named = (p: GraftJoinPerson) => (p.years ? `${p.name} ${p.years}` : p.name);
    for (const j of report.graftJoins) {
      lines.push(`  ${named(j.incoming)}  ->  ${named(j.main)}  ${j.mainId}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * One field line. The verb is read off the change itself — a value that
 * replaced another one is *changed*, not "added" — and a rewritten value is
 * shown piece by piece the way the preview shows it, so what was given up is
 * the part that stands out rather than being buried in a repeat of the whole
 * line.
 */
function changeLine(c: FieldChange, t: Translate): string {
  const label = c.field || t("changeReport.field.record");
  if (c.sources?.length || c.links?.length) {
    const items = [...(c.sources ?? []).map(citationText), ...(c.links ?? [])];
    return `${label}: ${t("changeReport.verb.added")} ${items.map((i) => `"${i}"`).join(", ")}`;
  }
  if (c.segments) {
    // The pieces the edit left alone stay bare, as context; only the ones it
    // touched are quoted. Reprinting the whole value twice — which is what the
    // report used to do here — hides the one piece the reader is looking for.
    const pieces = c.segments
      .filter((s) => s.text || s.from)
      .map((s) => {
        if (s.state === "removed") return `− "${s.text}"`;
        if (s.state !== "changed") return s.text;
        return s.from && s.from !== s.text ? `"${s.from}" → "${s.text}"` : `+ "${s.text}"`;
      });
    return `${label}: ${t("changeReport.verb.changed")} ${pieces.join(" · ")}`;
  }
  if (!c.to && c.from) return `${label}: ${t("changeReport.verb.removed")} "${c.from}"`;
  if (c.from) return `${label}: ${t("changeReport.verb.changed")} "${c.from}" → "${c.to}"`;
  return `${label}: ${t("changeReport.verb.added")} "${c.to}"`;
}

// Re-export so callers can build the decision key consistently.
export { decisionKey };

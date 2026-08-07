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
  segments?: { text: string; state: "same" | "changed" | "removed" }[];
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

export interface ChangeReport {
  changes: FieldChange[];
  deferred: DeferredChange[];
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
  for (const [key, decision] of decisions) {
    if (decision.status !== "rejected") continue;
    const parsed = parseDecisionKey(key);
    if (parsed?.kind === "individual") rejectedPairs.add(`${parsed.mainId}|${parsed.compareId}`);
  }
  const ctx = makeContext(main, compare, matches, records, indiNodes, famNodes, report, touched, t, sourXrefMap, rejectedPairs);

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

export function formatReport(report: ChangeReport, title = "GED Merge change report"): string {
  const lines: string[] = [];
  lines.push(title);
  lines.push("=".repeat(title.length));
  lines.push("");
  lines.push(`Records changed:  ${report.recordsChanged}`);
  lines.push(`Fields applied:   ${report.changes.length}`);
  lines.push(`New persons:      ${report.newPersons}`);
  lines.push(`New families:     ${report.newFamilies}`);
  lines.push(`Deferred:         ${report.deferred.length}`);
  lines.push("");

  const recordHeader = (id: string) => {
    const label = report.recordLabels[id];
    return label ? `${label}  ${id}` : id;
  };

  const meaningful = report.changes.filter((c) => c.field);
  if (meaningful.length) {
    lines.push("Applied changes");
    lines.push("---------------");
    const byRecord = new Map<string, typeof meaningful>();
    for (const c of meaningful) {
      const group = byRecord.get(c.recordId) ?? [];
      group.push(c);
      byRecord.set(c.recordId, group);
    }
    for (const [id, group] of byRecord) {
      const header = recordHeader(id);
      lines.push(header);
      lines.push("-".repeat(header.length));
      for (const c of group) {
        if (c.sources?.length || c.links?.length) {
          const items = [
            ...(c.sources ?? []).map(citationText),
            ...(c.links ?? []),
          ];
          lines.push(`  ${c.field}: added ${items.map((i) => `"${i}"`).join(", ")}`);
        } else if (!c.to && c.from) {
          lines.push(`  ${c.field}: removed "${c.from}"`);
        } else {
          const verb = c.action === "both" ? "added" : "set";
          lines.push(`  ${c.field}: ${verb} "${c.to}"${c.from ? ` (was "${c.from}")` : ""}`);
        }
      }
      lines.push("");
    }
  }

  if (report.deferred.length) {
    lines.push("Kept as in your file (the incoming file said otherwise)");
    lines.push("-------------------------------------------------------");
    const byRecord = new Map<string, typeof report.deferred>();
    for (const d of report.deferred) {
      const group = byRecord.get(d.recordId) ?? [];
      group.push(d);
      byRecord.set(d.recordId, group);
    }
    for (const [id, group] of byRecord) {
      const header = recordHeader(id);
      lines.push(header);
      lines.push("-".repeat(header.length));
      for (const d of group) lines.push(`  ${d.field}: ${d.reason}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

// Re-export so callers can build the decision key consistently.
export { decisionKey };

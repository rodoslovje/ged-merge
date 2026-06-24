import type { Dataset, GedNode, SourceCitation } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { displayName } from "../match/relatives";
import { inferPlaceExportFormat } from "../normalize/profile";
import { individualFieldRows } from "../review/fields";
import { decisionKey, type CandidateDecision, type FieldChoice } from "../review/types";
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
  applyIndividualFamilies,
  applyIndividualRelations,
  makeContext,
} from "./applyRelations";

export {
  combineEventEdits,
  type EventSubEdit,
  type LinkFormat,
  materializeEventSources,
  SUB_JOIN_ORDER,
  SUB_LABEL_KEY,
  SUB_TAG,
} from "./applyFields";

/** One field the merge wrote into a master record. */
export interface FieldChange {
  recordId: string;
  field: string;
  from: string;
  to: string;
  action: FieldChoice;
  /** Marks the placeholder change for a freshly added person/family record. */
  newRecord?: boolean;
  /** Marks the placeholder change for a deleted person/family record. */
  removedRecord?: boolean;
  /** Event name (e.g. "Birth", "Marriage") this field belongs to, so the
   *  preview can show it once as a header above its date/place/note/source. */
  group?: string;
  /** Set when an existing event was modified (not newly added/removed) — the preview
   *  renders these pieces in place of `from`/`to`, coloring each by whether the edit
   *  actually touched it, instead of treating the whole line as one new value. */
  segments?: { text: string; state: "same" | "changed" | "removed" }[];
  /** True when `to` is a verbatim, un-chosen copy of the incoming file's value (the
   *  user took "incoming" by default, didn't combine it with master or type it by
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
  /** Distinct master records touched. */
  recordsChanged: number;
  /** New individual records added from the incoming file. */
  newPersons: number;
  /** New family records created to stitch merged relationships together. */
  newFamilies: number;
  /** Display label per touched record id, for grouping the preview/report. */
  recordLabels: Record<string, string>;
  /** Whether each touched record is an individual or a family. */
  recordKinds: Record<string, "individual" | "family">;
  /** Husband/wife (in that order) for each touched family record. */
  familySpouses: Record<string, FamilySpouseInfo[]>;
  /** Non-standard tags copied in from the incoming file, grouped by tag name,
   *  for the save preview's "exclude this tag" list. */
  customTags: Record<string, CustomTagNode[]>;
}

export interface MergeResult {
  /** A clone of the master record forest with confirmed edits applied. */
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
 * Apply confirmed match decisions to a clone of the master tree, taking each
 * field the user chose from the incoming side (or "both"). Untouched records are
 * left as identical clones, so serializing the result yields a minimal diff
 * against the original master.
 *
 * Individuals: scalar fields (sex, primary name, event date/place/address).
 * Families: marriage fields plus structural stitching — missing spouses and
 * children from the incoming family are linked to their matched master person
 * (via `matches`) or, when genuinely new, added as fresh records with the right
 * FAMC/FAMS/HUSB/WIFE/CHIL pointers.
 *
 * Individual relationship fields and links are still recorded as deferred.
 */
export function mergeDecisions(
  master: Dataset,
  compare: Dataset,
  decisions: Map<string, CandidateDecision>,
  matches: MatchResult,
  t: Translate,
): MergeResult {
  const records = master.records.map(cloneNode);
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
    customTags: {},
  };
  const touched = new Set<string>();
  // How the master writes places, so incoming places can be reshaped to match.
  const placeFmt = inferPlaceExportFormat(master);
  // How the master stores record-level links, so newly added links match (e.g.
  // a plain WWW line, Family Historian's _WEBTAG block, or an OBJE/FILE record).
  const linkFormat = detectLinkFormat(master);
  const ctx = makeContext(master, compare, matches, records, indiNodes, famNodes, report, touched, t, sourXrefMap);

  for (const [key, decision] of decisions) {
    if (decision.status !== "confirmed") continue;
    const { kind, masterId, compareId } = parseKey(key);
    if (kind !== "individual") continue; // families are merged via their spouses

    const target = indiNodes.get(masterId);
    const masterIndi = master.individuals.get(masterId);
    const incoming = compare.individuals.get(compareId);
    if (!target || !masterIndi || !incoming) continue;
    report.recordLabels[masterId] = displayName(masterIndi.names[0]);
    const rejectedEvents = decision.rejectedEvents?.length ? new Set(decision.rejectedEvents) : undefined;
    const rows = individualFieldRows(t, masterIndi, incoming, master, compare, placeFmt, rejectedEvents);
    applyRows(target, incoming.raw, masterId, rows, decision.fields, report, touched, INDI_HANDLED, t, linkFormat, records, sourXrefMap);
    applyIndividualRelations(masterId, masterIndi, incoming, rows, decision.fields, master, compare, ctx);
    const takenChildIds = new Set(decision.takenChildren ?? []);
    applyIndividualFamilies(masterId, masterIndi, incoming, rows, decision.fields, master, compare, ctx, takenChildIds);
    sortEventsByDate(target);
  }

  // Derive record kinds from node maps built during merge.
  for (const c of report.changes) {
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
    lines.push("Not applied (needs relationship/link merge)");
    lines.push("-------------------------------------------");
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

function parseKey(key: string): { kind: string; masterId: string; compareId: string } {
  const [kind, masterId, compareId] = key.split(":");
  return { kind, masterId, compareId };
}

// Re-export so callers can build the decision key consistently.
export { decisionKey };

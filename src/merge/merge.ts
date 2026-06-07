import type { Dataset, GedNode } from "../gedcom/types";
import { individualFieldRows, familyFieldRows } from "../review/fields";
import { defaultChoice, decisionKey, type CandidateDecision, type FieldChoice } from "../review/types";

/** A translator (i18next `t`); only used for human-readable field labels. */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** One field the merge wrote into a master record. */
export interface FieldChange {
  recordId: string;
  field: string;
  from: string;
  to: string;
  action: FieldChoice;
}

/** A confirmed change the engine did not yet apply (relationship/links). */
export interface DeferredChange {
  recordId: string;
  field: string;
  reason: string;
}

export interface ChangeReport {
  changes: FieldChange[];
  deferred: DeferredChange[];
  /** Distinct master records touched. */
  recordsChanged: number;
}

export interface MergeResult {
  /** A clone of the master record forest with confirmed edits applied. */
  records: GedNode[];
  report: ChangeReport;
}

/** Relational fields are graph edits ("new relatives") — deferred for now. */
const RELATIONAL = new Set(["father", "mother", "partners", "children", "husband", "wife"]);

/** Map an event sub-field key suffix to its GEDCOM sub-tag. */
const SUB_TAG: Record<string, string> = { date: "DATE", place: "PLAC", addr: "ADDR" };

/**
 * Apply confirmed match decisions to a clone of the master tree, taking each
 * field the user chose from the incoming side (or "both"). Untouched records are
 * left as identical clones, so serializing the result yields a minimal diff
 * against the original master.
 *
 * Scalar fields (sex, primary name, and event date/place/address) are applied.
 * Relationship fields and links — the "new relatives" graph stitching — are
 * recorded as deferred so the report is honest about what still needs doing.
 */
export function mergeDecisions(
  master: Dataset,
  compare: Dataset,
  decisions: Map<string, CandidateDecision>,
  t: Translate,
): MergeResult {
  const records = master.records.map(cloneNode);
  const indiNodes = new Map<string, GedNode>();
  const famNodes = new Map<string, GedNode>();
  for (const r of records) {
    if (!r.xref) continue;
    if (r.tag === "INDI") indiNodes.set(r.xref, r);
    else if (r.tag === "FAM") famNodes.set(r.xref, r);
  }

  const report: ChangeReport = { changes: [], deferred: [], recordsChanged: 0 };
  const touched = new Set<string>();

  for (const [key, decision] of decisions) {
    if (decision.status !== "confirmed") continue;
    const { kind, masterId, compareId } = parseKey(key);

    if (kind === "individual") {
      const target = indiNodes.get(masterId);
      const masterIndi = master.individuals.get(masterId);
      const incoming = compare.individuals.get(compareId);
      if (!target || !incoming) continue;
      const rows = individualFieldRows(t, masterIndi, incoming, master, compare);
      applyRows(target, incoming.raw, masterId, rows, decision.fields, report, touched);
    } else {
      const target = famNodes.get(masterId);
      const masterFam = master.families.get(masterId);
      const incoming = compare.families.get(compareId);
      if (!target || !incoming) continue;
      const rows = familyFieldRows(t, masterFam, incoming, master, compare);
      applyRows(target, incoming.raw, masterId, rows, decision.fields, report, touched);
    }
  }

  report.recordsChanged = touched.size;
  return { records, report };
}

interface Row {
  key: string;
  label: string;
  master: string;
  incoming: string;
  state: string;
}

function applyRows(
  target: GedNode,
  incomingRecord: GedNode,
  recordId: string,
  rows: Row[],
  fields: Record<string, FieldChoice>,
  report: ChangeReport,
  touched: Set<string>,
): void {
  let nameApplied = false;
  for (const row of rows) {
    // Nothing on the incoming side to take, or the two already agree.
    if (row.state === "agree" || row.state === "master-only") continue;
    const choice = fields[row.key] ?? defaultChoice(row as never);
    if (choice === "master") continue;

    // Relationship and link fields need graph stitching — defer with a note.
    if (RELATIONAL.has(row.key) || row.key === "links" || row.key.endsWith(".links")) {
      report.deferred.push({ recordId, field: row.label, reason: "relationship/link merge not yet implemented" });
      continue;
    }

    let applied = false;
    if (row.key === "given" || row.key === "surname") {
      if (nameApplied) continue; // the whole NAME line is taken as a unit
      applied = applyName(target, incomingRecord, choice);
      nameApplied = applied;
    } else if (row.key === "sex") {
      applied = setChild(target, "SEX", incomingRecord, choice);
    } else {
      const [tag, sub] = row.key.split(".");
      const subTag = SUB_TAG[sub];
      if (subTag) applied = applyEventSub(target, incomingRecord, tag, subTag, choice);
    }

    if (applied) {
      report.changes.push({ recordId, field: row.label, from: row.master, to: row.incoming, action: choice });
      touched.add(recordId);
    }
  }
}

/** Replace or (for "both") add the primary NAME line from the incoming record. */
function applyName(target: GedNode, incomingRecord: GedNode, choice: FieldChoice): boolean {
  const incName = incomingRecord.children.find((c) => c.tag === "NAME");
  if (!incName) return false;
  const clone = cloneNode(incName);
  const idx = target.children.findIndex((c) => c.tag === "NAME");
  if (choice === "both" || idx < 0) {
    insertAt(target, idx < 0 ? target.children.length : idx + 1, clone);
  } else {
    target.children[idx] = clone;
  }
  return true;
}

/** Apply an event's date/place/address by copying the incoming sub-node. */
function applyEventSub(
  target: GedNode,
  incomingRecord: GedNode,
  tag: string,
  subTag: string,
  choice: FieldChoice,
): boolean {
  const incEvent = incomingRecord.children.find((c) => c.tag === tag);
  const incSub = incEvent?.children.find((c) => c.tag === subTag);
  if (!incSub) return false;
  let event = target.children.find((c) => c.tag === tag);
  if (!event) {
    event = newNode(tag);
    target.children.push(event);
  }
  return setChild(event, subTag, incEvent!, choice, incSub);
}

/**
 * Copy a single-valued child (e.g. SEX, or DATE under BIRT) from the incoming
 * side. "incoming" replaces the existing child; "both" appends a second one.
 * Returns false when the incoming side has no such child.
 */
function setChild(
  parent: GedNode,
  tag: string,
  incomingParent: GedNode,
  choice: FieldChoice,
  incChildOverride?: GedNode,
): boolean {
  const incChild = incChildOverride ?? incomingParent.children.find((c) => c.tag === tag);
  if (!incChild) return false;
  const clone = cloneNode(incChild);
  const idx = parent.children.findIndex((c) => c.tag === tag);
  if (choice === "both" || idx < 0) {
    parent.children.push(clone);
  } else {
    parent.children[idx] = clone;
  }
  return true;
}

function insertAt(parent: GedNode, index: number, child: GedNode): void {
  parent.children.splice(index, 0, child);
}

function newNode(tag: string, value?: string): GedNode {
  const node: GedNode = { level: 0, tag, children: [] };
  if (value !== undefined) node.value = value;
  return node;
}

function cloneNode(n: GedNode): GedNode {
  const c: GedNode = { level: n.level, tag: n.tag, children: n.children.map(cloneNode) };
  if (n.xref !== undefined) c.xref = n.xref;
  if (n.value !== undefined) c.value = n.value;
  return c;
}

function parseKey(key: string): { kind: string; masterId: string; compareId: string } {
  const [kind, masterId, compareId] = key.split(":");
  return { kind, masterId, compareId };
}

/** Human-readable change report (plain text) to download alongside the merge. */
export function formatReport(report: ChangeReport): string {
  const lines: string[] = [];
  lines.push("GedMerge change report");
  lines.push("======================");
  lines.push("");
  lines.push(`Records changed: ${report.recordsChanged}`);
  lines.push(`Fields applied:  ${report.changes.length}`);
  lines.push(`Deferred:        ${report.deferred.length}`);
  lines.push("");

  if (report.changes.length) {
    lines.push("Applied changes");
    lines.push("---------------");
    for (const c of report.changes) {
      const verb = c.action === "both" ? "added" : "set";
      lines.push(`${c.recordId}  ${c.field}: ${verb} "${c.to}"${c.from ? ` (was "${c.from}")` : ""}`);
    }
    lines.push("");
  }

  if (report.deferred.length) {
    lines.push("Not applied (needs relationship/link merge)");
    lines.push("-------------------------------------------");
    for (const d of report.deferred) {
      lines.push(`${d.recordId}  ${d.field}: ${d.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// Re-export so callers can build the decision key consistently.
export { decisionKey };

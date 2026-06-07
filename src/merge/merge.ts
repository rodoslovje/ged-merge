import type { Dataset, GedNode } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { displayName } from "../match/relatives";
import { individualFieldRows } from "../review/fields";
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

/**
 * Relationship and family-event fields handled structurally (parents/partners by
 * `applyIndividualRelations`, marriage/children by `applyIndividualFamilies`) —
 * so `applyRows` skips them rather than treating them as scalar individual fields.
 */
const INDI_HANDLED = new Set([
  "father",
  "mother",
  "partners",
  "children",
  "MARR.date",
  "MARR.place",
  "MARR.addr",
]);

/** Map an event sub-field key suffix to its GEDCOM sub-tag. */
const SUB_TAG: Record<string, string> = { date: "DATE", place: "PLAC", addr: "ADDR" };

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
  const indiNodes = new Map<string, GedNode>();
  const famNodes = new Map<string, GedNode>();
  for (const r of records) {
    if (!r.xref) continue;
    if (r.tag === "INDI") indiNodes.set(r.xref, r);
    else if (r.tag === "FAM") famNodes.set(r.xref, r);
  }

  const report: ChangeReport = { changes: [], deferred: [], recordsChanged: 0 };
  const touched = new Set<string>();
  const ctx = makeContext(master, compare, matches, records, indiNodes, famNodes, report, touched);

  for (const [key, decision] of decisions) {
    if (decision.status !== "confirmed") continue;
    const { kind, masterId, compareId } = parseKey(key);
    if (kind !== "individual") continue; // families are merged via their spouses

    const target = indiNodes.get(masterId);
    const masterIndi = master.individuals.get(masterId);
    const incoming = compare.individuals.get(compareId);
    if (!target || !masterIndi || !incoming) continue;
    const rows = individualFieldRows(t, masterIndi, incoming, master, compare);
    applyRows(target, incoming.raw, masterId, rows, decision.fields, report, touched, INDI_HANDLED);
    applyIndividualRelations(masterId, masterIndi, incoming, rows, decision.fields, master, compare, ctx);
    applyIndividualFamilies(masterId, masterIndi, incoming, rows, decision.fields, master, compare, ctx);
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
  handled: Set<string>,
): void {
  let nameApplied = false;
  for (const row of rows) {
    // Nothing on the incoming side to take, or the two already agree.
    if (row.state === "agree" || row.state === "master-only") continue;
    // Handled elsewhere (family spouses/children go through applyFamilyStructure).
    if (handled.has(row.key)) continue;
    const choice = fields[row.key] ?? defaultChoice(row as never);
    if (choice === "master") continue;

    if (row.key === "links" || row.key.endsWith(".links")) {
      report.deferred.push({ recordId, field: row.label, reason: "link merge not yet implemented" });
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

// --- family structural merge (spouses & children) --------------------------

interface MergeContext {
  /** incoming individual id → its matched master individual id (if any). */
  incToMaster: Map<string, string>;
  /** Look up a (cloned) master individual record node by xref. */
  indiNode: (id: string) => GedNode | undefined;
  /** Look up a (cloned) master family record node by xref. */
  famNode: (id: string) => GedNode | undefined;
  /** Create a fresh empty FAM record (inserted before TRLR, indexed). */
  createFamily: () => { id: string; node: GedNode };
  /** Resolve an incoming individual to a master id, adding it as a new record
   *  when it has no match. Returns undefined if it can't be resolved. */
  resolve: (incomingId: string) => string | undefined;
  /** Display label for a master id, for the change report. */
  label: (id: string) => string;
  report: ChangeReport;
  touched: Set<string>;
}

function makeContext(
  master: Dataset,
  compare: Dataset,
  matches: MatchResult,
  records: GedNode[],
  indiNodes: Map<string, GedNode>,
  famNodes: Map<string, GedNode>,
  report: ChangeReport,
  touched: Set<string>,
): MergeContext {
  const incToMaster = new Map<string, string>();
  for (const c of matches.individuals) incToMaster.set(c.compareId, c.masterId);

  const used = new Set<string>();
  for (const r of records) if (r.xref) used.add(r.xref);
  const counters = new Map<string, number>();
  const allocXref = (prefix = "I"): string => {
    let n = counters.get(prefix) ?? 1;
    let id: string;
    do {
      id = `@${prefix}${n++}@`;
    } while (used.has(id));
    counters.set(prefix, n);
    used.add(id);
    return id;
  };

  const createFamily = (): { id: string; node: GedNode } => {
    const id = allocXref("F");
    const node = newNode("FAM");
    node.xref = id;
    insertRecord(records, node);
    famNodes.set(id, node);
    report.changes.push({ recordId: id, field: "New family", from: "", to: "", action: "incoming" });
    touched.add(id);
    return { id, node };
  };

  const addedLabels = new Map<string, string>();
  const addedFromIncoming = new Map<string, string>(); // incomingId → new master id

  const addNewIndividual = (incomingId: string): string | undefined => {
    const cached = addedFromIncoming.get(incomingId);
    if (cached) return cached;
    const incIndi = compare.individuals.get(incomingId);
    if (!incIndi) return undefined;
    const newId = allocXref();
    const node = cloneNode(incIndi.raw);
    node.xref = newId;
    // Drop incoming family pointers; we re-link only into the family being merged.
    node.children = node.children.filter((c) => c.tag !== "FAMC" && c.tag !== "FAMS");
    insertRecord(records, node);
    indiNodes.set(newId, node);
    addedFromIncoming.set(incomingId, newId);
    const name = displayName(incIndi.names[0]);
    addedLabels.set(newId, name);
    report.changes.push({ recordId: newId, field: "New person", from: "", to: name, action: "incoming" });
    touched.add(newId);
    return newId;
  };

  return {
    incToMaster,
    indiNode: (id) => indiNodes.get(id),
    famNode: (id) => famNodes.get(id),
    createFamily,
    resolve: (incomingId) => incToMaster.get(incomingId) ?? addNewIndividual(incomingId),
    label: (id) =>
      addedLabels.get(id) ?? displayName(master.individuals.get(id)?.names[0]),
    report,
    touched,
  };
}

/**
 * Stitch an incoming family's spouses and/or children into a master family node.
 * Spouse slots are read from the (possibly already-edited) node so it works on
 * both existing and freshly-created families. Each missing spouse/child is
 * resolved to a master record (matched or newly added) and wired up.
 */
function applyFamilyStructure(
  famNode: GedNode,
  incFam: import("../gedcom/types").Family,
  ctx: MergeContext,
  opts: { spouses: boolean; children: boolean },
): void {
  const famId = famNode.xref;
  if (!famId) return;
  const slotValue = (tag: string) => famNode.children.find((c) => c.tag === tag)?.value;

  if (opts.spouses) {
    const spouses: Array<["HUSB" | "WIFE", string | undefined]> = [
      ["HUSB", incFam.husband],
      ["WIFE", incFam.wife],
    ];
    for (const [role, incSlot] of spouses) {
      if (!incSlot) continue;
      const targetId = ctx.resolve(incSlot);
      if (!targetId) continue;
      const masterSlot = slotValue(role);
      if (masterSlot) {
        if (masterSlot !== targetId) {
          ctx.report.deferred.push({
            recordId: famId,
            field: role === "HUSB" ? "Husband" : "Wife",
            reason: "master already has a different spouse",
          });
        }
        continue;
      }
      if (addPointer(famNode, role, targetId, ["HUSB", "WIFE", "CHIL"], "start")) {
        linkBack(ctx, targetId, "FAMS", famId);
        ctx.report.changes.push({
          recordId: famId,
          field: role === "HUSB" ? "Husband" : "Wife",
          from: "",
          to: ctx.label(targetId),
          action: "incoming",
        });
        ctx.touched.add(famId);
      }
    }
  }

  if (opts.children) {
    const existing = new Set(
      famNode.children.filter((c) => c.tag === "CHIL").map((c) => c.value),
    );
    for (const incChild of incFam.children) {
      const known = ctx.incToMaster.get(incChild);
      if (known && existing.has(known)) continue;
      const targetId = ctx.resolve(incChild);
      if (!targetId || existing.has(targetId)) continue;
      if (addPointer(famNode, "CHIL", targetId, ["HUSB", "WIFE", "CHIL"], "start")) {
        existing.add(targetId);
        linkBack(ctx, targetId, "FAMC", famId);
        ctx.report.changes.push({
          recordId: famId,
          field: "Child",
          from: "",
          to: ctx.label(targetId),
          action: "incoming",
        });
        ctx.touched.add(famId);
      }
    }
  }
}

/** True when the user's choice for a row means "take from incoming". */
function wantsIncoming(rows: Row[], fields: Record<string, FieldChoice>, key: string): boolean {
  const row = rows.find((r) => r.key === key);
  if (!row || row.state === "agree" || row.state === "master-only") return false;
  return (fields[key] ?? defaultChoice(row as never)) !== "master";
}

/**
 * Stitch a confirmed individual's parents taken from the incoming side into the
 * person's child-family (created if absent). The parent is linked to the matched
 * master person when known, else added as a new record.
 */
function applyIndividualRelations(
  masterId: string,
  _masterIndi: import("../gedcom/types").Individual,
  incomingIndi: import("../gedcom/types").Individual,
  rows: Row[],
  fields: Record<string, FieldChoice>,
  master: Dataset,
  compare: Dataset,
  ctx: MergeContext,
): void {
  const parents: Array<["father" | "mother", "HUSB" | "WIFE", string]> = [
    ["father", "HUSB", "Father"],
    ["mother", "WIFE", "Mother"],
  ];
  let childFam: { id: string; node: GedNode } | undefined;
  for (const [key, role, label] of parents) {
    if (!wantsIncoming(rows, fields, key)) continue;
    const incParentId = incomingParentId(incomingIndi, compare, role);
    if (!incParentId) continue;
    const targetId = ctx.resolve(incParentId);
    if (!targetId) continue;
    childFam ??= ensureChildFamily(masterId, master, ctx);
    setSpouseSlot(childFam.node, role, targetId, label, ctx);
  }
}

/**
 * Stitch a confirmed individual's marriages: spouse, marriage facts, and
 * children. Each incoming family the person belongs to is paired with the
 * master family for the same couple (created if absent), then its spouse
 * (if "partners" taken), marriage date/place/addr (per the MARR choices) and
 * children (if "children" taken) are merged in.
 */
function applyIndividualFamilies(
  masterId: string,
  masterIndi: import("../gedcom/types").Individual,
  incomingIndi: import("../gedcom/types").Individual,
  rows: Row[],
  fields: Record<string, FieldChoice>,
  master: Dataset,
  compare: Dataset,
  ctx: MergeContext,
): void {
  const takeSpouses = wantsIncoming(rows, fields, "partners");
  const takeChildren = wantsIncoming(rows, fields, "children");
  const marriageChoice = (sub: string): FieldChoice | undefined => {
    const key = `MARR.${sub}`;
    return wantsIncoming(rows, fields, key) ? fields[key] ?? "incoming" : undefined;
  };
  const wantMarriage = (["date", "place", "addr"] as const).some((s) => marriageChoice(s));
  if (!takeSpouses && !takeChildren && !wantMarriage) return;

  for (const incFamId of incomingIndi.spouseOf) {
    const incFam = compare.families.get(incFamId);
    if (!incFam) continue;
    const otherIncId = incFam.husband === incomingIndi.id ? incFam.wife : incFam.husband;
    const otherMasterId = otherIncId ? ctx.incToMaster.get(otherIncId) : undefined;

    let famNode = findMasterSpouseFamily(masterIndi, master, masterId, otherMasterId, ctx);
    if (!famNode) famNode = createPersonFamily(masterId, masterIndi, ctx);

    applyFamilyStructure(famNode, incFam, ctx, { spouses: takeSpouses, children: takeChildren });

    for (const sub of ["date", "place", "addr"] as const) {
      const choice = marriageChoice(sub);
      if (!choice) continue;
      if (applyEventSub(famNode, incFam.raw, "MARR", SUB_TAG[sub], choice)) {
        ctx.report.changes.push({
          recordId: famNode.xref!,
          field: `Marriage ${sub}`,
          from: "",
          to: incFam.events.find((e) => e.tag === "MARR")?.[sub === "addr" ? "address" : sub]?.raw ?? "",
          action: choice,
        });
        ctx.touched.add(famNode.xref!);
      }
    }
  }
}

/** Find the master family pairing this person with the given (matched) spouse. */
function findMasterSpouseFamily(
  masterIndi: import("../gedcom/types").Individual,
  master: Dataset,
  masterId: string,
  otherMasterId: string | undefined,
  ctx: MergeContext,
): GedNode | undefined {
  for (const famId of masterIndi.spouseOf) {
    const fam = master.families.get(famId);
    if (!fam) continue;
    const other = fam.husband === masterId ? fam.wife : fam.husband;
    if (otherMasterId ? other === otherMasterId : !other) return ctx.famNode(famId);
  }
  // Single marriage on each side: pair the lone families even without a match id.
  if (masterIndi.spouseOf.length === 1) return ctx.famNode(masterIndi.spouseOf[0]);
  return undefined;
}

/** Create a new family with the master person placed in their sex's slot. */
function createPersonFamily(
  masterId: string,
  masterIndi: import("../gedcom/types").Individual,
  ctx: MergeContext,
): GedNode {
  const fam = ctx.createFamily();
  const role = masterIndi.sex === "F" ? "WIFE" : "HUSB";
  addPointer(fam.node, role, masterId, ["HUSB", "WIFE", "CHIL"], "start");
  linkBack(ctx, masterId, "FAMS", fam.id);
  return fam.node;
}

/** The family node where the master person is a child, creating one if absent. */
function ensureChildFamily(
  masterId: string,
  master: Dataset,
  ctx: MergeContext,
): { id: string; node: GedNode } {
  const existing = master.individuals.get(masterId)?.childOf[0];
  if (existing) {
    const node = ctx.famNode(existing);
    if (node) return { id: existing, node };
  }
  const fam = ctx.createFamily();
  addPointer(fam.node, "CHIL", masterId, ["HUSB", "WIFE", "CHIL"], "start");
  const indi = ctx.indiNode(masterId);
  if (indi) addPointer(indi, "FAMC", fam.id, ["FAMC", "FAMS"], "end");
  return fam;
}

/** Fill a HUSB/WIFE slot if empty; note a conflict if it already differs. */
function setSpouseSlot(
  famNode: GedNode,
  role: "HUSB" | "WIFE",
  personId: string,
  label: string,
  ctx: MergeContext,
): void {
  const famId = famNode.xref!;
  const existing = famNode.children.find((c) => c.tag === role);
  if (existing) {
    if (existing.value !== personId) {
      ctx.report.deferred.push({
        recordId: famId,
        field: label,
        reason: `family already has a different ${role.toLowerCase()}`,
      });
    }
    return;
  }
  addPointer(famNode, role, personId, ["HUSB", "WIFE", "CHIL"], "start");
  linkBack(ctx, personId, "FAMS", famId);
  ctx.report.changes.push({ recordId: famId, field: label, from: "", to: ctx.label(personId), action: "incoming" });
  ctx.touched.add(famId);
}

function incomingParentId(
  incomingIndi: import("../gedcom/types").Individual,
  compare: Dataset,
  role: "HUSB" | "WIFE",
): string | undefined {
  const famId = incomingIndi.childOf[0];
  const fam = famId ? compare.families.get(famId) : undefined;
  return role === "HUSB" ? fam?.husband : fam?.wife;
}

/** Add a FAMC/FAMS pointer back on the individual record (if not already there). */
function linkBack(ctx: MergeContext, indiId: string, tag: string, famId: string): void {
  const node = ctx.indiNode(indiId);
  if (node) addPointer(node, tag, famId, ["FAMC", "FAMS"], "end");
}

/**
 * Insert a pointer line (`<tag> <id>`) into a record, grouped after the last of
 * `afterTags`. Skips if an identical pointer already exists. `fallback` controls
 * placement when no `afterTags` line exists yet.
 */
function addPointer(
  parent: GedNode,
  tag: string,
  id: string,
  afterTags: string[],
  fallback: "start" | "end",
): boolean {
  if (parent.children.some((c) => c.tag === tag && c.value === id)) return false;
  let lastIdx = -1;
  for (let i = 0; i < parent.children.length; i++) {
    if (afterTags.includes(parent.children[i].tag)) lastIdx = i;
  }
  const at = lastIdx >= 0 ? lastIdx + 1 : fallback === "start" ? 0 : parent.children.length;
  insertAt(parent, at, newNode(tag, id));
  return true;
}

function insertRecord(records: GedNode[], node: GedNode): void {
  const i = records.findIndex((r) => r.tag === "TRLR");
  if (i < 0) records.push(node);
  else records.splice(i, 0, node);
}

function parseKey(key: string): { kind: string; masterId: string; compareId: string } {
  const [kind, masterId, compareId] = key.split(":");
  return { kind, masterId, compareId };
}

/** Human-readable change report (plain text) to download alongside the merge. */
export function formatReport(report: ChangeReport): string {
  const lines: string[] = [];
  lines.push("GED Merge change report");
  lines.push("=======================");
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

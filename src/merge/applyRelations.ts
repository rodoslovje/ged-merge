import {
  FAM_CHILD_ORDER,
  INDI_CHILD_ORDER,
  insertOrdered,
  insertRecord,
} from "../gedcom/edit";
import type { Dataset, GedNode } from "../gedcom/types";
import { displayName } from "../match/relatives";
import type { MatchResult } from "../match/types";
import { defaultChoice, type FieldChoice, type FieldRow } from "../review/types";
import { newSourceCitations } from "../gedcom/source";
import type { ChangeReport } from "./merge";
import type { Translate } from "../locales/i18n";
import {
  applyEventSources,
  applyEventSub,
  applyNotes,
  cloneNodeRemapped,
  collectCustomTags,
  combineEventEdits,
  newNode,
  SUB_LABEL_KEY,
  SUB_TAG,
  type EventSubEdit,
  type SourXrefMap,
} from "./applyFields";

type Row = FieldRow;

export interface MergeContext {
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
  /** Incoming family ids already stitched in by applyIndividualFamilies, so a
   *  family shared by two confirmed spouses isn't merged in twice. */
  processedFamIds: Set<string>;
  /** Translator for human-readable change/deferred labels. */
  t: Translate;
  /** Compare SOUR/REPO xref → output xref. Used to remap nodes cloned from compare. */
  sourXrefMap: SourXrefMap;
  /** Full merged records array, needed for SOUR-link matching in applyEventSources. */
  records: GedNode[];
}

export function makeContext(
  master: Dataset,
  compare: Dataset,
  matches: MatchResult,
  records: GedNode[],
  indiNodes: Map<string, GedNode>,
  famNodes: Map<string, GedNode>,
  report: ChangeReport,
  touched: Set<string>,
  t: Translate,
  sourXrefMap: SourXrefMap,
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
    report.changes.push({ recordId: id, field: t("merge.field.newFamily"), from: "", to: "", action: "incoming", newRecord: true });
    report.newFamilies++;
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
    const node = cloneNodeRemapped(incIndi.raw, sourXrefMap);
    collectCustomTags(node, report.customTags);
    node.xref = newId;
    // Drop incoming family pointers; we re-link only into the family being merged.
    node.children = node.children.filter((c) => c.tag !== "FAMC" && c.tag !== "FAMS");
    insertRecord(records, node);
    indiNodes.set(newId, node);
    addedFromIncoming.set(incomingId, newId);
    const name = displayName(incIndi.names[0]);
    addedLabels.set(newId, name);
    report.recordLabels[newId] = name;
    report.changes.push({ recordId: newId, field: t("merge.field.newPerson"), from: "", to: name, action: "incoming", newRecord: true });
    report.newPersons++;
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
    processedFamIds: new Set<string>(),
    t,
    sourXrefMap,
    records,
  };
}

/**
 * Stitch an incoming family's spouses and/or children into a master family node.
 * Spouse slots are read from the (possibly already-edited) node so it works on
 * both existing and freshly-created families. Each missing spouse/child is
 * resolved to a master record (matched or newly added) and wired up.
 */
export function applyFamilyStructure(
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
            field: ctx.t(role === "HUSB" ? "merge.field.husband" : "merge.field.wife"),
            reason: ctx.t("merge.reason.masterHasSpouse"),
          });
        }
        continue;
      }
      if (addPointer(famNode, role, targetId, FAM_CHILD_ORDER)) {
        linkBack(ctx, targetId, "FAMS", famId);
        ctx.report.changes.push({
          recordId: famId,
          field: ctx.t(role === "HUSB" ? "merge.field.husband" : "merge.field.wife"),
          from: "",
          to: ctx.label(targetId),
          action: "incoming",
          unedited: true,
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
      if (addPointer(famNode, "CHIL", targetId, FAM_CHILD_ORDER)) {
        existing.add(targetId);
        linkBack(ctx, targetId, "FAMC", famId);
        ctx.report.changes.push({
          recordId: famId,
          field: ctx.t("merge.field.child"),
          from: "",
          to: ctx.label(targetId),
          action: "incoming",
          unedited: true,
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
export function applyIndividualRelations(
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
    ["father", "HUSB", "merge.field.father"],
    ["mother", "WIFE", "merge.field.mother"],
  ];
  let childFam: { id: string; node: GedNode } | undefined;
  for (const [key, role, labelKey] of parents) {
    if (!wantsIncoming(rows, fields, key)) continue;
    const incParentId = incomingParentId(incomingIndi, compare, role);
    if (!incParentId) continue;
    const targetId = ctx.resolve(incParentId);
    if (!targetId) continue;
    childFam ??= ensureChildFamily(masterId, master, ctx);
    setSpouseSlot(childFam.node, role, targetId, ctx.t(labelKey), ctx);
  }
}

/**
 * Stitch a confirmed individual's marriages: spouse, marriage facts, and
 * children. Each incoming family the person belongs to is paired with the
 * master family for the same couple (created if absent), then its spouse
 * (if "partners" taken), marriage date/place/addr (per the MARR choices) and
 * children (if "children" taken) are merged in.
 */
export function applyIndividualFamilies(
  masterId: string,
  masterIndi: import("../gedcom/types").Individual,
  incomingIndi: import("../gedcom/types").Individual,
  rows: Row[],
  fields: Record<string, FieldChoice>,
  master: Dataset,
  compare: Dataset,
  ctx: MergeContext,
): void {
  for (const incFamId of incomingIndi.spouseOf) {
    // A family with both spouses confirmed as matches is visited once per
    // spouse; only stitch it in on the first visit, or append-style fields
    // (notes, sources, "both" choices) would be applied twice.
    if (ctx.processedFamIds.has(incFamId)) continue;
    const incFam = compare.families.get(incFamId);
    if (!incFam) continue;
    const famKey = `fam.${incFamId}`;

    const takeSpouses = wantsIncoming(rows, fields, `${famKey}.partner`);
    const takeChildren = wantsIncoming(rows, fields, `${famKey}.children`);
    const marriageChoice = (sub: string): FieldChoice | undefined => {
      const key = `${famKey}.MARR.${sub}`;
      return wantsIncoming(rows, fields, key) ? fields[key] ?? "incoming" : undefined;
    };
    const wantMarriage = (["date", "place", "addr", "note", "agency", "sources"] as const).some((s) => marriageChoice(s));
    if (!takeSpouses && !takeChildren && !wantMarriage) continue;
    ctx.processedFamIds.add(incFamId);

    const otherIncId = incFam.husband === incomingIndi.id ? incFam.wife : incFam.husband;
    const otherMasterId = otherIncId ? ctx.incToMaster.get(otherIncId) : undefined;

    let famNode = findMasterSpouseFamily(masterIndi, master, masterId, otherMasterId, ctx);
    if (!famNode) famNode = createPersonFamily(masterId, masterIndi, ctx);

    applyFamilyStructure(famNode, incFam, ctx, { spouses: takeSpouses, children: takeChildren });

    const marrEntries: EventSubEdit[] = [];
    for (const sub of ["date", "place", "addr", "note", "agency"] as const) {
      const choice = marriageChoice(sub);
      if (!choice) continue;
      const subTag = SUB_TAG[sub];
      if (!subTag) continue;
      const rowKey = `${famKey}.MARR.${sub}`;
      const rowIncoming = rows.find((r) => r.key === rowKey)?.incoming ?? "";
      const applied = applyEventSub(famNode, incFam.raw, "MARR", subTag, choice, 0, 0, FAM_CHILD_ORDER, ctx.report.customTags);
      if (applied) {
        marrEntries.push({ sub, field: ctx.t(SUB_LABEL_KEY[sub]), from: "", to: rowIncoming, action: choice });
        ctx.touched.add(famNode.xref!);
      }
    }
    ctx.report.changes.push(...combineEventEdits(famNode.xref!, ctx.t("event.MARR"), marrEntries));

    const marrSourcesChoice = marriageChoice("sources");
    if (marrSourcesChoice && applyEventSources(famNode, incFam.raw, "MARR", marrSourcesChoice, 0, 0, FAM_CHILD_ORDER, ctx.sourXrefMap, ctx.records, ctx.report.customTags)) {
      const marrRow = rows.find((r) => r.key === `${famKey}.MARR.sources`);
      ctx.report.changes.push({ recordId: famNode.xref!, field: ctx.t("field.sources"), from: "", to: "", action: marrSourcesChoice, group: ctx.t("event.MARR"), unedited: marrSourcesChoice === "incoming", sources: newSourceCitations(marrRow?.masterSources, marrRow?.incomingSources) });
      ctx.touched.add(famNode.xref!);
    }

    // Engagement, Separation, Divorce — same pattern as MARR.
    for (const evTag of ["ENGA", "SEPA", "DIV"] as const) {
      const evName = ctx.t(`event.${evTag}`);
      const evEntries: EventSubEdit[] = [];
      for (const sub of ["date", "place", "addr", "note", "agency"] as const) {
        const key = `${famKey}.${evTag}.${sub}`;
        if (!wantsIncoming(rows, fields, key)) continue;
        const choice = fields[key] ?? "incoming";
        const subTag = SUB_TAG[sub];
        if (!subTag) continue;
        const rowIncoming = rows.find((r) => r.key === key)?.incoming ?? "";
        const applied = applyEventSub(famNode, incFam.raw, evTag, subTag, choice, 0, 0, FAM_CHILD_ORDER, ctx.report.customTags);
        if (applied) {
          evEntries.push({ sub, field: ctx.t(SUB_LABEL_KEY[sub]), from: "", to: rowIncoming, action: choice });
          ctx.touched.add(famNode.xref!);
        }
      }
      ctx.report.changes.push(...combineEventEdits(famNode.xref!, evName, evEntries));
      const evSourcesKey = `${famKey}.${evTag}.sources`;
      if (wantsIncoming(rows, fields, evSourcesKey)) {
        const choice = fields[evSourcesKey] ?? "incoming";
        if (applyEventSources(famNode, incFam.raw, evTag, choice, 0, 0, FAM_CHILD_ORDER, ctx.sourXrefMap, ctx.records, ctx.report.customTags)) {
          const evRow = rows.find((r) => r.key === evSourcesKey);
          ctx.report.changes.push({ recordId: famNode.xref!, field: ctx.t("field.sources"), from: "", to: "", action: choice, group: evName, unedited: choice === "incoming", sources: newSourceCitations(evRow?.masterSources, evRow?.incomingSources) });
          ctx.touched.add(famNode.xref!);
        }
      }
    }

    // Family notes.
    const famNotesKey = `${famKey}.notes`;
    if (wantsIncoming(rows, fields, famNotesKey)) {
      const choice = fields[famNotesKey] ?? "incoming";
      if (applyNotes(famNode, incFam.raw, choice, ctx.sourXrefMap, FAM_CHILD_ORDER, ctx.report.customTags)) {
        ctx.report.changes.push({
          recordId: famNode.xref!,
          field: ctx.t("field.notes"),
          from: "",
          to: incFam.notes?.join("\n") ?? "",
          action: choice,
          unedited: choice === "incoming",
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
  addPointer(fam.node, role, masterId, FAM_CHILD_ORDER);
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
  addPointer(fam.node, "CHIL", masterId, FAM_CHILD_ORDER);
  const indi = ctx.indiNode(masterId);
  if (indi) addPointer(indi, "FAMC", fam.id, INDI_CHILD_ORDER);
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
        reason: ctx.t(role === "HUSB" ? "merge.reason.familyHasHusband" : "merge.reason.familyHasWife"),
      });
    }
    return;
  }
  addPointer(famNode, role, personId, FAM_CHILD_ORDER);
  linkBack(ctx, personId, "FAMS", famId);
  ctx.report.changes.push({ recordId: famId, field: label, from: "", to: ctx.label(personId), action: "incoming", unedited: true });
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
  if (node) addPointer(node, tag, famId, INDI_CHILD_ORDER);
}

/**
 * Insert a pointer line (`<tag> <id>`) into a record using canonical ordering.
 * Skips if an identical pointer already exists.
 */
function addPointer(parent: GedNode, tag: string, id: string, order: string[]): boolean {
  if (parent.children.some((c) => c.tag === tag && c.value === id)) return false;
  insertOrdered(parent, newNode(tag, id), order);
  return true;
}

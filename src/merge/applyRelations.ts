import {
  FAM_CHILD_ORDER,
  INDI_CHILD_ORDER,
  insertOrdered,
  insertRecord,
} from "../gedcom/edit";
import { childrenByTag, firstChild } from "../gedcom/node";
import type { Dataset, GedNode } from "../gedcom/types";
import { displayName } from "../match/relatives";
import type { MatchResult } from "../match/types";
import { defaultChoice, type FieldChoice, type FieldRow, type ImportDirection } from "../review/types";
import { newSourceCitations } from "../gedcom/source";
import type { ChangeReport } from "./merge";
import type { Translate } from "../locales/i18n";
import {
  applyEventSources,
  applyEventSub,
  applyEventValue,
  applyNotes,
  cloneNodeRemapped,
  collectCustomTags,
  combineEventEdits,
  newNode,
  stripForeignPointers,
  SUB_LABEL_KEY,
  SUB_TAG,
  type EventSubEdit,
  type SourXrefMap,
} from "./applyFields";

type Row = FieldRow;

export interface MergeContext {
  /** incoming individual id → its matched main individual id (if any). */
  incToMain: Map<string, string>;
  /** Look up a (cloned) main individual record node by xref. */
  indiNode: (id: string) => GedNode | undefined;
  /** Look up a (cloned) main family record node by xref. */
  famNode: (id: string) => GedNode | undefined;
  /** Create a fresh empty FAM record (inserted before TRLR, indexed). */
  createFamily: () => { id: string; node: GedNode };
  /** Resolve an incoming individual to a main id, adding it as a new record
   *  when it has no match. Returns undefined if it can't be resolved. */
  resolve: (incomingId: string) => string | undefined;
  /** Display label for a main id, for the change report. */
  label: (id: string) => string;
  report: ChangeReport;
  touched: Set<string>;
  /** Incoming family ids already stitched in by applyIndividualFamilies, so a
   *  family shared by two confirmed spouses isn't merged in twice. */
  processedFamIds: Set<string>;
  /** Switch new-record changes from here on to "via graft" — called once the
   *  whole-branch import phase begins, so addNewIndividual/createFamily tag the
   *  records they add as imported subtrees (the preview shows them as "Incoming"). */
  beginGraftPhase: () => void;
  /** Translator for human-readable change/deferred labels. */
  t: Translate;
  /** Compare SOUR/REPO xref → output xref. Used to remap nodes cloned from compare. */
  sourXrefMap: SourXrefMap;
  /** Full merged records array, needed for SOUR-link matching in applyEventSources. */
  records: GedNode[];
}

export function makeContext(
  main: Dataset,
  compare: Dataset,
  matches: MatchResult,
  records: GedNode[],
  indiNodes: Map<string, GedNode>,
  famNodes: Map<string, GedNode>,
  report: ChangeReport,
  touched: Set<string>,
  t: Translate,
  sourXrefMap: SourXrefMap,
  /** `${mainId}|${compareId}` pairs the user rejected — never reused as a join
   *  point, so the incoming record is imported as a new person instead of being
   *  silently merged into the (wrongly) matched main record. */
  rejectedPairs: Set<string> = new Set(),
): MergeContext {
  const incToMain = new Map<string, string>();
  for (const c of matches.individuals) {
    if (rejectedPairs.has(`${c.mainId}|${c.compareId}`)) continue;
    incToMain.set(c.compareId, c.mainId);
  }

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
    report.changes.push({ recordId: id, field: t("merge.field.newFamily"), from: "", to: "", action: "incoming", newRecord: true, viaGraft: graftPhase || undefined });
    report.newFamilies++;
    touched.add(id);
    return { id, node };
  };

  // Flipped on by beginGraftPhase() once whole-branch imports start, so records
  // added during that phase are reported as imported subtrees, not match stitching.
  let graftPhase = false;

  const addedLabels = new Map<string, string>();
  const addedFromIncoming = new Map<string, string>(); // incomingId → new main id

  const addNewIndividual = (incomingId: string): string | undefined => {
    const cached = addedFromIncoming.get(incomingId);
    if (cached) return cached;
    const incIndi = compare.individuals.get(incomingId);
    if (!incIndi) return undefined;
    const newId = allocXref();
    const node = cloneNodeRemapped(incIndi.raw, sourXrefMap);
    collectCustomTags(node, report.customTags);
    node.xref = newId;
    // Drop pointers into the compare file's namespace: family links (re-linked
    // only into the family being merged) plus associations/submitter links,
    // which have no import path and would dangle — or hit an unrelated main
    // record — if kept. Dropped associations are surfaced as deferred.
    const dropped = stripForeignPointers(node);
    if (dropped.some((tag) => tag === "ASSO" || tag === "ALIA")) {
      report.deferred.push({
        recordId: newId,
        field: t("merge.field.associations"),
        reason: t("merge.reason.assoNotImported"),
      });
    }
    insertRecord(records, node);
    indiNodes.set(newId, node);
    addedFromIncoming.set(incomingId, newId);
    const name = displayName(incIndi.names[0]);
    addedLabels.set(newId, name);
    report.recordLabels[newId] = name;
    report.changes.push({ recordId: newId, field: t("merge.field.newPerson"), from: "", to: name, action: "incoming", newRecord: true, viaGraft: graftPhase || undefined });
    report.newPersons++;
    touched.add(newId);
    return newId;
  };

  return {
    incToMain,
    indiNode: (id) => indiNodes.get(id),
    famNode: (id) => famNodes.get(id),
    createFamily,
    resolve: (incomingId) => incToMain.get(incomingId) ?? addNewIndividual(incomingId),
    label: (id) =>
      addedLabels.get(id) ?? displayName(main.individuals.get(id)?.names[0]),
    beginGraftPhase: () => {
      graftPhase = true;
    },
    report,
    touched,
    processedFamIds: new Set<string>(),
    t,
    sourXrefMap,
    records,
  };
}

/**
 * Stitch an incoming family's spouses and/or children into a main family node.
 * Spouse slots are read from the (possibly already-edited) node so it works on
 * both existing and freshly-created families. Each missing spouse/child is
 * resolved to a main record (matched or newly added) and wired up.
 */
export function applyFamilyStructure(
  famNode: GedNode,
  incFam: import("../gedcom/types").Family,
  ctx: MergeContext,
  opts: { spouses: boolean; takenChildren: Set<string> },
): void {
  const famId = famNode.xref;
  if (!famId) return;
  const slotValue = (tag: string) => firstChild(famNode, tag)?.value;

  if (opts.spouses) {
    const spouses: Array<["HUSB" | "WIFE", string | undefined]> = [
      ["HUSB", incFam.husband],
      ["WIFE", incFam.wife],
    ];
    for (const [role, incSlot] of spouses) {
      if (!incSlot) continue;
      const targetId = ctx.resolve(incSlot);
      if (!targetId) continue;
      const mainSlot = slotValue(role);
      if (mainSlot) {
        if (mainSlot !== targetId) {
          ctx.report.deferred.push({
            recordId: famId,
            field: ctx.t(role === "HUSB" ? "merge.field.husband" : "merge.field.wife"),
            reason: ctx.t("merge.reason.mainHasSpouse"),
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

  if (opts.takenChildren.size > 0) {
    const existing = new Set(
      childrenByTag(famNode, "CHIL").map((c) => c.value),
    );
    for (const incChild of incFam.children) {
      // Children are opt-in: only stitch in the ones the user explicitly took.
      if (!opts.takenChildren.has(incChild)) continue;
      const known = ctx.incToMain.get(incChild);
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
  if (!row || row.state === "agree" || row.state === "main-only") return false;
  return (fields[key] ?? defaultChoice(row as never)) !== "main";
}

/**
 * Stitch a confirmed individual's parents taken from the incoming side into the
 * person's child-family (created if absent). The parent is linked to the matched
 * main person when known, else added as a new record.
 */
export function applyIndividualRelations(
  mainId: string,
  _mainIndi: import("../gedcom/types").Individual,
  incomingIndi: import("../gedcom/types").Individual,
  rows: Row[],
  fields: Record<string, FieldChoice>,
  main: Dataset,
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
    childFam ??= ensureChildFamily(mainId, main, ctx);
    setSpouseSlot(childFam.node, role, targetId, ctx.t(labelKey), ctx);
  }
}

/**
 * Stitch a confirmed individual's marriages: spouse, marriage facts, and
 * children. Each incoming family the person belongs to is paired with the
 * main family for the same couple (created if absent), then its spouse
 * (if "partners" taken), marriage date/place/addr (per the MARR choices) and
 * children (if "children" taken) are merged in.
 */
export function applyIndividualFamilies(
  mainId: string,
  mainIndi: import("../gedcom/types").Individual,
  incomingIndi: import("../gedcom/types").Individual,
  rows: Row[],
  fields: Record<string, FieldChoice>,
  main: Dataset,
  compare: Dataset,
  ctx: MergeContext,
  /** Incoming child ids the user opted to stitch in (see `CandidateDecision.takenChildren`). */
  takenChildIds: Set<string>,
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
    // Children this family contributes that the user opted to take.
    const famTakenChildren = new Set(incFam.children.filter((id) => takenChildIds.has(id)));
    const takeChildren = famTakenChildren.size > 0;
    const marriageChoice = (sub: string): FieldChoice | undefined => {
      const key = `${famKey}.MARR.${sub}`;
      return wantsIncoming(rows, fields, key) ? fields[key] ?? "incoming" : undefined;
    };
    const wantMarriage = (["type", "date", "place", "addr", "note", "agency", "cause", "sources"] as const).some((s) => marriageChoice(s));
    if (!takeSpouses && !takeChildren && !wantMarriage) continue;
    ctx.processedFamIds.add(incFamId);

    const otherIncId = incFam.husband === incomingIndi.id ? incFam.wife : incFam.husband;
    const otherMainId = otherIncId ? ctx.incToMain.get(otherIncId) : undefined;

    let famNode = findMainSpouseFamily(mainIndi, main, mainId, otherMainId, ctx);
    if (!famNode) famNode = createPersonFamily(mainId, mainIndi.sex, ctx);

    applyFamilyStructure(famNode, incFam, ctx, { spouses: takeSpouses, takenChildren: famTakenChildren });

    const marrEntries: EventSubEdit[] = [];
    for (const sub of ["type", "date", "place", "addr", "note", "agency", "cause"] as const) {
      const choice = marriageChoice(sub);
      if (!choice) continue;
      const subTag = SUB_TAG[sub];
      if (!subTag) continue;
      const rowKey = `${famKey}.MARR.${sub}`;
      const rowIncoming = rows.find((r) => r.key === rowKey)?.incoming ?? "";
      const applied = applyEventSub(famNode, incFam.raw, "MARR", subTag, choice, 0, 0, FAM_CHILD_ORDER, ctx.sourXrefMap, ctx.report.customTags);
      if (applied) {
        marrEntries.push({ sub, field: ctx.t(SUB_LABEL_KEY[sub]), from: "", to: rowIncoming, action: choice });
        ctx.touched.add(famNode.xref!);
      }
    }
    ctx.report.changes.push(...combineEventEdits(famNode.xref!, ctx.t("event.MARR"), marrEntries));

    const marrSourcesChoice = marriageChoice("sources");
    if (marrSourcesChoice && applyEventSources(famNode, incFam.raw, "MARR", marrSourcesChoice, 0, 0, FAM_CHILD_ORDER, ctx.sourXrefMap, ctx.records, ctx.report.customTags)) {
      const marrRow = rows.find((r) => r.key === `${famKey}.MARR.sources`);
      ctx.report.changes.push({ recordId: famNode.xref!, field: ctx.t("field.sources"), from: "", to: "", action: marrSourcesChoice, group: ctx.t("event.MARR"), unedited: marrSourcesChoice === "incoming", sources: newSourceCitations(marrRow?.mainSources, marrRow?.incomingSources) });
      ctx.touched.add(famNode.xref!);
    }

    // Engagement, Separation, Divorce, Status — same pattern as MARR; the
    // value-bearing tags (`_MSTAT Partners`) additionally carry a `.value` sub.
    for (const evTag of ["ENGA", "SEPA", "DIV", "_MSTAT"] as const) {
      const evName = ctx.t(`event.${evTag}`);
      const evEntries: EventSubEdit[] = [];
      for (const sub of ["type", "value", "date", "place", "addr", "note", "agency", "cause"] as const) {
        const key = `${famKey}.${evTag}.${sub}`;
        if (!wantsIncoming(rows, fields, key)) continue;
        const choice = fields[key] ?? "incoming";
        const rowIncoming = rows.find((r) => r.key === key)?.incoming ?? "";
        let applied: boolean;
        if (sub === "value") {
          applied = applyEventValue(famNode, incFam.raw, evTag, choice, 0, 0, FAM_CHILD_ORDER);
        } else {
          const subTag = SUB_TAG[sub];
          if (!subTag) continue;
          applied = applyEventSub(famNode, incFam.raw, evTag, subTag, choice, 0, 0, FAM_CHILD_ORDER, ctx.sourXrefMap, ctx.report.customTags);
        }
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
          ctx.report.changes.push({ recordId: famNode.xref!, field: ctx.t("field.sources"), from: "", to: "", action: choice, group: evName, unedited: choice === "incoming", sources: newSourceCitations(evRow?.mainSources, evRow?.incomingSources) });
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

/** Find the main family pairing this person with the given (matched) spouse. */
function findMainSpouseFamily(
  mainIndi: import("../gedcom/types").Individual,
  main: Dataset,
  mainId: string,
  otherMainId: string | undefined,
  ctx: MergeContext,
): GedNode | undefined {
  for (const famId of mainIndi.spouseOf) {
    const fam = main.families.get(famId);
    if (!fam) continue;
    const other = fam.husband === mainId ? fam.wife : fam.husband;
    if (otherMainId ? other === otherMainId : !other) return ctx.famNode(famId);
  }
  // Single marriage on each side: pair the lone families even without a match id
  // — but not when the incoming partner is a *different* confirmed individual
  // than the one already in the lone family. That's a genuine second union, so
  // it gets its own new family instead of colliding with this one. (An unmatched
  // partner keeps collapsing here, so a missed match still surfaces as a
  // "different spouse" conflict rather than silently spawning a duplicate.)
  if (mainIndi.spouseOf.length === 1) {
    const fam = main.families.get(mainIndi.spouseOf[0]);
    const other = fam && (fam.husband === mainId ? fam.wife : fam.husband);
    if (!(otherMainId && other && other !== otherMainId)) {
      return ctx.famNode(mainIndi.spouseOf[0]);
    }
  }
  return undefined;
}

/** Create a new family with the main person placed in their sex's slot. */
function createPersonFamily(
  mainId: string,
  sex: import("../gedcom/types").Sex,
  ctx: MergeContext,
): GedNode {
  const fam = ctx.createFamily();
  const role = sex === "F" ? "WIFE" : "HUSB";
  addPointer(fam.node, role, mainId, FAM_CHILD_ORDER);
  linkBack(ctx, mainId, "FAMS", fam.id);
  return fam.node;
}

/** The family node where the main person is a child, creating one if absent. */
function ensureChildFamily(
  mainId: string,
  main: Dataset,
  ctx: MergeContext,
): { id: string; node: GedNode } {
  // Prefer the live merged tree's FAMC over the original dataset's: a child
  // family created earlier in this merge (e.g. by the confirmed-match parent
  // stitch) is wired onto the cloned indi node but absent from `main`, so
  // reading `main` here would miss it and create a duplicate family.
  const existing =
    ctx.indiNode(mainId)?.children.find((c) => c.tag === "FAMC")?.value ??
    main.individuals.get(mainId)?.childOf[0];
  if (existing) {
    const node = ctx.famNode(existing);
    if (node) return { id: existing, node };
  }
  const fam = ctx.createFamily();
  addPointer(fam.node, "CHIL", mainId, FAM_CHILD_ORDER);
  const indi = ctx.indiNode(mainId);
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
  const existing = firstChild(famNode, role);
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

/** One "bring in this person's whole branch" request from the compare tree. */
export interface ImportBranchRequest {
  /** The incoming individual whose subtree should be grafted into the main. */
  incomingId: string;
  direction: ImportDirection;
}

/**
 * Graft entire incoming subtrees onto the main, beyond the single-person and
 * immediate-relative stitching the confirmed-match flow does. Each request walks
 * the incoming tree in one direction (ancestors or descendants) from its anchor
 * person, importing every person and family along the way. Persons that match a
 * main record (via `ctx.incToMain`) are reused as join points rather than
 * duplicated; genuinely new persons are added as fresh records. A visited guard
 * (keyed by direction + incoming id) stops cycles and pedigree collapse from
 * expanding forever.
 *
 * Run after the confirmed-decision loop so matched anchors, and any families
 * those decisions already stitched, exist to graft onto.
 */
export function applyImportBranches(
  requests: Iterable<ImportBranchRequest>,
  main: Dataset,
  compare: Dataset,
  ctx: MergeContext,
): void {
  const visited = new Set<string>();
  for (const req of requests) {
    if (req.direction === "ancestors") importAncestors(req.incomingId, main, compare, ctx, visited);
    else importDescendants(req.incomingId, main, compare, ctx, visited);
  }
}

/** Recursively import an incoming person's father/mother (and their ancestors). */
function importAncestors(
  incId: string,
  main: Dataset,
  compare: Dataset,
  ctx: MergeContext,
  visited: Set<string>,
): void {
  const vkey = `ancestors:${incId}`;
  if (visited.has(vkey)) return;
  visited.add(vkey);

  const incIndi = compare.individuals.get(incId);
  if (!incIndi) return;
  const mainId = ctx.resolve(incId);
  if (!mainId) return;
  const childFamId = incIndi.childOf[0];
  const incFam = childFamId ? compare.families.get(childFamId) : undefined;
  if (!incFam) return;

  let childFam: { id: string; node: GedNode } | undefined;
  const parents: Array<["HUSB" | "WIFE", string | undefined, string]> = [
    ["HUSB", incFam.husband, "merge.field.father"],
    ["WIFE", incFam.wife, "merge.field.mother"],
  ];
  for (const [role, incParentId, labelKey] of parents) {
    if (!incParentId) continue;
    const parentMainId = ctx.resolve(incParentId);
    if (!parentMainId) continue;
    childFam ??= ensureChildFamily(mainId, main, ctx);
    setSpouseSlot(childFam.node, role, parentMainId, ctx.t(labelKey), ctx);
    importAncestors(incParentId, main, compare, ctx, visited);
  }
}

/** Recursively import an incoming person's spouses, children, and their descendants. */
function importDescendants(
  incId: string,
  main: Dataset,
  compare: Dataset,
  ctx: MergeContext,
  visited: Set<string>,
): void {
  const vkey = `descendants:${incId}`;
  if (visited.has(vkey)) return;
  visited.add(vkey);

  const incIndi = compare.individuals.get(incId);
  if (!incIndi) return;
  const mainId = ctx.resolve(incId);
  if (!mainId) return;
  // The anchor may be an existing main person or one just added by `resolve`;
  // the latter has no main `Individual`, so fall back to the incoming sex.
  const mainIndi = main.individuals.get(mainId);
  const sex = mainIndi?.sex ?? incIndi.sex;

  for (const incFamId of incIndi.spouseOf) {
    const incFam = compare.families.get(incFamId);
    if (!incFam) continue;
    const otherIncId = incFam.husband === incId ? incFam.wife : incFam.husband;
    const otherMainId = otherIncId ? ctx.incToMain.get(otherIncId) : undefined;

    let famNode = mainIndi
      ? findMainSpouseFamily(mainIndi, main, mainId, otherMainId, ctx)
      : undefined;
    if (!famNode) famNode = createPersonFamily(mainId, sex, ctx);

    // Bring the spouse and every child of this union; `applyFamilyStructure`
    // skips slots/children already present, so re-running on a family a confirmed
    // decision touched only fills the gaps rather than duplicating.
    applyFamilyStructure(famNode, incFam, ctx, {
      spouses: true,
      takenChildren: new Set(incFam.children),
    });
    for (const childId of incFam.children) {
      importDescendants(childId, main, compare, ctx, visited);
    }
  }
}

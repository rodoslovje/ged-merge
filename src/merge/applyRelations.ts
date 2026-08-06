import {
  FAM_CHILD_ORDER,
  INDI_CHILD_ORDER,
  insertOrdered,
  insertRecord,
} from "../gedcom/edit";
import { childrenByTag, firstChild } from "../gedcom/node";
import { EDITABLE_FAM_EVENT_TAGS } from "../gedcom/eventTags";
import type { Dataset, GedNode } from "../gedcom/types";
import { displayName } from "../match/relatives";
import type { MatchResult } from "../match/types";
import { defaultChoice, type FieldChoice, type FieldRow, type ImportDirection } from "../review/types";
import { pairedMainFamilies, relativePersonSimilarity, RELATIVE_PAIR_THRESHOLD } from "../review/fields";
import { newSourceCitations } from "../gedcom/source";
import type { ChangeReport } from "./merge";
import type { Translate } from "../locales/i18n";
import {
  applyEventSources,
  applyEventSub,
  applyEventValue,
  applyNotes,
  applyPrivateFlag,
  cloneNodeRemapped,
  collectCustomTags,
  combineEventEdits,
  effectiveEventSubChoice,
  newNode,
  reservedXrefs,
  stripForeignPointers,
  SUB_LABEL_KEY,
  SUB_TAG,
  type EventSubEdit,
  type EventSubField,
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
  /** The main id an incoming individual already resolves to — a match, or a
   *  new record an earlier decision created — without creating anything. */
  resolved: (incomingId: string) => string | undefined;
  /** Import an incoming individual as a fresh main record, ignoring any match
   *  the engine suggested for it. Used where the user's explicit pick has to
   *  outrank a suggestion (see the taken-children path). */
  importNew: (incomingId: string) => string | undefined;
  /** Whether a main and an incoming record are the same relative *by the rule
   *  the review table aligns children with* — which is not the matcher's rule,
   *  and decides what the user was shown before picking. */
  pairedAsRelatives: (mainId: string, incomingId: string) => boolean;
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
  // Output xrefs promised to compare shared records (imported at the end by
  // importSourRecords): a fresh INDI/FAM id must not squat on one, or the
  // promised import would be skipped and its pointers would resolve to the
  // squatter.
  for (const outXref of reservedXrefs(sourXrefMap)) used.add(outXref);
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
    // The incoming record this person is a copy of: the save preview needs its
    // sex, lifespan and facts to show the new person the way it shows everyone
    // else — it can't look the fresh xref up in the (pre-merge) main dataset.
    (report.newIndividuals ??= {})[newId] = incIndi;
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
    resolved: (incomingId) => incToMain.get(incomingId) ?? addedFromIncoming.get(incomingId),
    importNew: addNewIndividual,
    pairedAsRelatives: (mainId, incomingId) => {
      const m = main.individuals.get(mainId);
      const c = compare.individuals.get(incomingId);
      return !!m && !!c && relativePersonSimilarity(m, c) >= RELATIVE_PAIR_THRESHOLD;
    },
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
  opts: {
    spouses: boolean;
    takenChildren: Set<string>;
    /** True when `takenChildren` are children the user ticked one by one (the
     *  review's "add this child"), rather than a whole family swept in by a
     *  branch graft. An explicit tick outranks a suggested match; a graft must
     *  not, or re-importing a branch would duplicate people. */
    explicitPicks?: boolean;
  },
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
            reason: ctx.t("merge.reason.mainHasSpouse", {
              kept: ctx.label(mainSlot),
              incoming: ctx.label(targetId),
            }),
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
          spouseSlot: true,
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
      // The matcher may pair this incoming child with a main person the family
      // already lists as a child — a pairing the review never shows, since it
      // aligns children by its own name/birth-year rule and so offered this one
      // as an addition. Ticking it is the user saying "that's somebody else",
      // and an explicit pick outranks a suggestion: import the incoming record
      // as a person of its own instead of silently dropping the tick.
      // Guarded by that same alignment rule, so this only fires for a child the
      // review really did put on a line of its own.
      const takeOver =
        opts.explicitPicks && !!known && existing.has(known) && !ctx.pairedAsRelatives(known, incChild);
      const targetId = takeOver ? ctx.importNew(incChild) : ctx.resolve(incChild);
      if (!targetId || existing.has(targetId)) continue;
      if (addPointer(famNode, "CHIL", targetId, FAM_CHILD_ORDER)) {
        existing.add(targetId);
        linkBack(ctx, targetId, "FAMC", famId);
        ctx.report.changes.push({
          recordId: famId,
          // A child that resolved to a record the main file already had is
          // linked in, not imported — said apart so the preview doesn't read as
          // if the incoming person's data came along with them.
          field: ctx.t(targetId === known ? "merge.field.childLinked" : "merge.field.child"),
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
  // The main family each incoming family was paired with in the review — the
  // pair whose rows the user actually judged. The merge writes into exactly
  // that family: its own spouse-matching heuristics below are only a fallback
  // for families the review left unpaired, so a marriage date reviewed against
  // one family can never land in another.
  const reviewPairs = pairedMainFamilies(mainIndi, incomingIndi, main, compare);
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
    const marriageChoice = (sub: EventSubField): FieldChoice | undefined => {
      const key = `${famKey}.MARR.${sub}`;
      return wantsIncoming(rows, fields, key)
        ? effectiveEventSubChoice(sub, fields[key] ?? "incoming")
        : undefined;
    };
    const EVENT_SUBS = ["type", "value", "date", "place", "addr", "note", "agency", "cause", "sources"] as const;
    const wantFamEvent = EDITABLE_FAM_EVENT_TAGS.some((etag) =>
      EVENT_SUBS.some((s) => wantsIncoming(rows, fields, `${famKey}.${etag}.${s}`)),
    );
    if (!takeSpouses && !takeChildren && !wantFamEvent) continue;
    ctx.processedFamIds.add(incFamId);

    const otherIncId = incFam.husband === incomingIndi.id ? incFam.wife : incFam.husband;
    // `resolved`, not `incToMain`: the spouse may be a new record another
    // decision already imported, and their family must be found, not re-made.
    const otherMainId = otherIncId ? ctx.resolved(otherIncId) : undefined;

    const reviewMainFamId = reviewPairs.get(incFamId);
    let famNode = reviewMainFamId ? ctx.famNode(reviewMainFamId) : undefined;
    famNode ??= findMainSpouseFamily(mainId, otherMainId, ctx, incomingIndi.spouseOf.length, mainIndi,
      // The review pairs a union with a main family whenever the two could be
      // the same marriage; leaving this one unpaired means it showed the user a
      // family of its own, with a partner it judged a different person. Honour
      // that: this union gets its own new family rather than collapsing into
      // the person's lone existing one, which would file a second wife and her
      // children under the first wife's marriage.
      !reviewPairs.has(incFamId));
    if (!famNode) famNode = createPersonFamily(mainId, mainIndi.sex, ctx);

    applyFamilyStructure(famNode, incFam, ctx, { spouses: takeSpouses, takenChildren: famTakenChildren, explicitPicks: true });

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

    // Engagement, Separation, Divorce, custom Event, Status — same pattern as
    // MARR; the value-bearing tags (`_MSTAT Partners`, `1 EVEN <v>`)
    // additionally carry a `.value` sub. A custom EVEN reports under its own
    // TYPE name ("Civil Partnership"), matching how the review labels it.
    for (const evTag of EDITABLE_FAM_EVENT_TAGS.filter((tg) => tg !== "MARR")) {
      const evName =
        (evTag === "EVEN" && incFam.events.find((e) => e.tag === "EVEN")?.type?.trim()) ||
        ctx.t(`event.${evTag}`);
      const evEntries: EventSubEdit[] = [];
      for (const sub of ["type", "value", "date", "place", "addr", "note", "agency", "cause"] as const) {
        const key = `${famKey}.${evTag}.${sub}`;
        if (!wantsIncoming(rows, fields, key)) continue;
        const choice = effectiveEventSubChoice(sub, fields[key] ?? "incoming");
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

    // Family private flag (additive — see applyPrivateFlag).
    const famPrivateKey = `${famKey}.private`;
    if (wantsIncoming(rows, fields, famPrivateKey)) {
      const choice = fields[famPrivateKey] ?? "incoming";
      if (applyPrivateFlag(famNode, ctx.records)) {
        ctx.report.changes.push({
          recordId: famNode.xref!,
          field: ctx.t("field.private"),
          from: "",
          to: "🔒",
          action: choice,
          unedited: choice === "incoming",
        });
        ctx.touched.add(famNode.xref!);
      }
    }
  }
}

/**
 * Find the main family pairing this person with the given (matched) spouse.
 *
 * Reads the *live* merged tree — the person's FAMS pointers on their cloned
 * node and each family's current HUSB/WIFE — not the pre-merge dataset: a
 * family created or stitched by an earlier decision in this same merge exists
 * only there, and re-reading the original `spouseOf` would miss it and mint a
 * duplicate family for the same couple (double FAMS/FAMC on everyone in it).
 */
function findMainSpouseFamily(
  mainId: string,
  otherMainId: string | undefined,
  ctx: MergeContext,
  /** How many families the *incoming* person belongs to — the lone-family
   *  fallback below needs a single marriage on each side, or a person with
   *  several incoming marriages would collapse them all into their first
   *  main-side family. */
  incomingFamCount: number,
  /** Pre-merge fallback for the person's family list, when the live node is
   *  somehow absent. */
  fallbackIndi?: import("../gedcom/types").Individual,
  /** The review showed this union as a family of its own — skip the lone-family
   *  collapse below, which exists for unions the review never ruled on. */
  reviewedAsOwnFamily = false,
): GedNode | undefined {
  const node = ctx.indiNode(mainId);
  const famIds = node
    ? node.children.filter((c) => c.tag === "FAMS" && c.value).map((c) => c.value!)
    : fallbackIndi?.spouseOf ?? [];
  const otherSpouse = (famNode: GedNode): string | undefined => {
    const husb = firstChild(famNode, "HUSB")?.value;
    const wife = firstChild(famNode, "WIFE")?.value;
    return husb === mainId ? wife : husb;
  };
  for (const famId of famIds) {
    const famNode = ctx.famNode(famId);
    if (!famNode) continue;
    const other = otherSpouse(famNode);
    if (otherMainId ? other === otherMainId : !other) return famNode;
  }
  // Single marriage on each side: pair the lone families even without a match id
  // — but not when the incoming partner is a *different* confirmed individual
  // than the one already in the lone family. That's a genuine second union, so
  // it gets its own new family instead of colliding with this one. (An unmatched
  // partner keeps collapsing here, so a missed match still surfaces as a
  // "different spouse" conflict rather than silently spawning a duplicate.)
  if (!reviewedAsOwnFamily && famIds.length === 1 && incomingFamCount === 1) {
    const famNode = ctx.famNode(famIds[0]);
    const other = famNode && otherSpouse(famNode);
    if (famNode && !(otherMainId && other && other !== otherMainId)) return famNode;
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
      // Both sides are named: "the family already has a different husband" says
      // nothing the user can act on, while "your file keeps Martin Drinovec, so
      // Martin Drinovc was not linked" tells them exactly which two records to
      // look at — and, usually, that the two are the same man spelled twice.
      ctx.report.deferred.push({
        recordId: famId,
        field: label,
        reason: ctx.t("merge.reason.mainHasSpouse", {
          kept: ctx.label(existing.value!),
          incoming: ctx.label(personId),
        }),
      });
    }
    return;
  }
  addPointer(famNode, role, personId, FAM_CHILD_ORDER);
  linkBack(ctx, personId, "FAMS", famId);
  ctx.report.changes.push({ recordId: famId, field: label, from: "", to: ctx.label(personId), action: "incoming", unedited: true, spouseSlot: true });
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
    childFam ??= ensureChildFamily(mainId, main, ctx);
    // Who already holds this slot decides whether the branch can be walked at
    // all. If the main file records someone else as this person's father, the
    // two files disagree about the parentage, and grafting the incoming parent
    // anyway would drop them — and every ancestor above them — into the file
    // hanging off nothing: a detached duplicate lineage the user never asked
    // for. So the walk stops here, *before* `resolve` creates anybody, and the
    // preview reports whose parent was kept and what was left behind.
    const occupant = firstChild(childFam.node, role)?.value;
    if (occupant && ctx.resolved(incParentId) !== occupant) {
      ctx.report.deferred.push({
        recordId: childFam.id,
        field: ctx.t(labelKey),
        reason: ctx.t(
          hasIncomingAncestors(incParentId, compare)
            ? "merge.reason.parentKeptAncestors"
            : "merge.reason.parentKept",
          {
            kept: ctx.label(occupant),
            incoming: displayName(compare.individuals.get(incParentId)?.names[0]),
          },
        ),
      });
      continue;
    }
    const parentMainId = ctx.resolve(incParentId);
    if (!parentMainId) continue;
    setSpouseSlot(childFam.node, role, parentMainId, ctx.t(labelKey), ctx);
    importAncestors(incParentId, main, compare, ctx, visited);
  }
}

/** Whether an incoming person has a parent of their own — i.e. whether stopping
 *  the walk at them leaves a further lineage behind, which the message says. */
function hasIncomingAncestors(incId: string, compare: Dataset): boolean {
  const famId = compare.individuals.get(incId)?.childOf[0];
  const fam = famId ? compare.families.get(famId) : undefined;
  return !!(fam?.husband || fam?.wife);
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
    // `resolved`, not `incToMain`: a confirmed decision may already have
    // imported this spouse as a new record and stitched a family around them —
    // that family must be reused, or the graft would duplicate it (double
    // FAMS/FAMC on the whole household).
    const otherMainId = otherIncId ? ctx.resolved(otherIncId) : undefined;

    let famNode = findMainSpouseFamily(mainId, otherMainId, ctx, incIndi.spouseOf.length, mainIndi);
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

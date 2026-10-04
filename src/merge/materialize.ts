import type { Dataset, GedNode } from "../gedcom/types";
import { cloneNode } from "../gedcom/node";
import { familiesNaming, removeIndividual } from "../gedcom/edit";
import { recordsNaming, remapMergedAssociations } from "../gedcom/assoc";
import type { MatchResult } from "../match/types";
import type { Translate } from "../locales/i18n";
import type { FormatOverrides } from "../normalize/formatOverrides";
import { individualFieldRows } from "../review/fields";
import { parseDecisionKey, pinnedAdds, type CandidateDecision } from "../review/types";
import {
  applyRecordPatches,
  coalescePatches,
  cloneRaw,
  patchesFromSnapshots,
  snapshotRecords,
  type RecordPatch,
} from "../ui/historyTypes";
import { buildSourXrefMap, foldMatchedSourcePages, importSourRecords } from "./applyFields";
import { applyIndividualFamilies, applyIndividualRelations, makeContext } from "./applyRelations";
import { linkPlacementFor } from "./linkPlacement";
import {
  confirmedFamilyFields,
  decisionPairs,
  fillAddedPlaceCoords,
  mergePlaceFormat,
  type ChangeReport,
} from "./merge";

/**
 * Incoming people the confirmed decisions ask the save to add: every ticked
 * child, and each parent and partner whose row is not held at "main". A row
 * left untouched counts — an incoming-only parent is taken by default.
 * Whether the person is new to the main file is not asked here; this is only
 * the test for whether an addition already made is still wanted.
 */
export function wantedAdds(
  decisions: ReadonlyMap<string, CandidateDecision>,
  main: Dataset,
  compare: Dataset,
): Set<string> {
  const wanted = new Set<string>();
  for (const [key, d] of decisions) {
    if (d.status !== "confirmed") continue;
    const parsed = parseDecisionKey(key);
    if (parsed?.kind !== "individual" || !main.individuals.has(parsed.mainId)) continue;
    const incoming = compare.individuals.get(parsed.compareId);
    if (!incoming) continue;
    for (const id of d.takenChildren ?? []) wanted.add(id);
    const parents = incoming.childOf[0] ? compare.families.get(incoming.childOf[0]) : undefined;
    if (parents?.husband && d.fields.father !== "main") wanted.add(parents.husband);
    if (parents?.wife && d.fields.mother !== "main") wanted.add(parents.wife);
    for (const famId of incoming.spouseOf) {
      const fam = compare.families.get(famId);
      const partner = fam?.husband === incoming.id ? fam?.wife : fam?.husband;
      if (partner && d.fields[`fam.${famId}.partner`] !== "main") wanted.add(partner);
    }
  }
  return wanted;
}

export interface MaterializeResult {
  /** The decisions, each carrying the people it has added (`added`). */
  decisions: Map<string, CandidateDecision>;
  /** Every record the step changed, already applied to the dataset — one
   *  undo entry's worth. */
  patches: RecordPatch[];
}

/**
 * Bring the main file in line with what the decisions ask to add, so a person
 * the merge brings in can be edited before the save.
 *
 * A decision that changed (`before` → `after`) and is confirmed adds the new
 * people it asks for — a ticked child, an incoming parent or partner the main
 * file has no record for — linked into their families the way the save would
 * link them. People the main file already has are not linked here: that stays
 * the save's work, so an addition taken back leaves nothing behind.
 *
 * Every addition made earlier that no decision wants any more (unticked,
 * unconfirmed, rejected) is removed again, with whatever was edited on it.
 *
 * Mutates `main`; the patches undo it.
 */
export function materializeAdds(
  main: Dataset,
  compare: Dataset,
  matches: MatchResult,
  before: ReadonlyMap<string, CandidateDecision>,
  after: ReadonlyMap<string, CandidateDecision>,
  t: Translate,
  overrides?: FormatOverrides,
): MaterializeResult {
  // `added` is this function's bookkeeping, not the caller's: a decision
  // rebuilt from its parts (a field choice, a tick) would otherwise lose the
  // people it added, leaving them in the file unclaimed — and the save would
  // add them a second time.
  const decisions = new Map<string, CandidateDecision>();
  for (const [key, d] of after) decisions.set(key, withAdded(d, before.get(key)?.added ?? {}));
  const patches: RecordPatch[] = [];

  // Take back what is no longer wanted.
  const wanted = wantedAdds(decisions, main, compare);
  const gone: string[] = [];
  for (const [key, d] of decisions) {
    if (!d.added) continue;
    const entries = Object.entries(d.added);
    const keep = entries.filter(([incomingId]) => wanted.has(incomingId));
    if (keep.length === entries.length) continue;
    for (const [incomingId, mainId] of entries) if (!wanted.has(incomingId)) gone.push(mainId);
    // `set` on a present key keeps its place: this is bookkeeping, not a
    // fresher decision (see `withFreshDecision`).
    decisions.set(key, withAdded(d, Object.fromEntries(keep)));
  }
  if (gone.length) patches.push(...removePeople(main, gone));

  // Add what a changed, confirmed decision asks for.
  const pinned = pinnedAdds(decisions);
  for (const [key, d] of decisions) {
    if (d.status !== "confirmed" || before.get(key) === after.get(key)) continue;
    // Most changes (a field choice) ask for nobody new; skip the stitching then.
    if (![...wantedAdds(new Map([[key, d]]), main, compare)].some((id) => !pinned.has(id))) continue;
    const added = addFor(main, compare, matches, decisions, key, d, pinned, t, overrides);
    if (!added) continue;
    patches.push(...added.patches);
    for (const [incomingId, mainId] of added.ids) pinned.set(incomingId, mainId);
    decisions.set(key, withAdded(d, { ...d.added, ...Object.fromEntries(added.ids) }));
  }

  return { decisions, patches: coalescePatches(patches) };
}

function withAdded(d: CandidateDecision, added: Record<string, string>): CandidateDecision {
  const next = { ...d };
  if (Object.keys(added).length) next.added = added;
  else delete next.added;
  return next;
}

/** Delete people this feature added, and the families that empties. */
function removePeople(main: Dataset, ids: string[]): RecordPatch[] {
  const indiIds = new Set<string>();
  const famIds = new Set<string>();
  const present = ids.filter((id) => main.individuals.has(id));
  for (const id of present) {
    const indi = main.individuals.get(id)!;
    indiIds.add(id);
    for (const famId of [...indi.spouseOf, ...indi.childOf, ...familiesNaming(main, id)]) famIds.add(famId);
  }
  for (const famId of famIds) {
    const fam = main.families.get(famId);
    for (const m of fam ? [fam.husband, fam.wife, ...fam.children] : []) if (m) indiIds.add(m);
  }
  for (const id of recordsNaming(main.records, new Set(present))) {
    if (main.individuals.has(id)) indiIds.add(id);
    else famIds.add(id);
  }
  const snapshots = snapshotRecords(main, indiIds, famIds);
  for (const id of present) {
    const indi = main.individuals.get(id);
    if (indi) removeIndividual(main, indi);
  }
  return patchesFromSnapshots(main, snapshots);
}

/**
 * A map of live records that hands out a private copy of each record the
 * first time it is asked for, so the merge's stitching code — which edits the
 * nodes it looks up — can run against the live file without touching it, and
 * the copies can be diffed into patches afterwards.
 */
class CopyOnRead extends Map<string, GedNode> {
  readonly copied = new Set<string>();
  private readonly live: ReadonlyMap<string, { raw: GedNode }>;
  constructor(live: ReadonlyMap<string, { raw: GedNode }>) {
    super();
    this.live = live;
  }
  override has(id: string): boolean {
    return super.has(id) || this.live.has(id);
  }
  override get(id: string): GedNode | undefined {
    const own = super.get(id);
    if (own) return own;
    const raw = this.live.get(id)?.raw;
    if (!raw) return undefined;
    const copy = cloneNode(raw);
    super.set(id, copy);
    this.copied.add(id);
    return copy;
  }
}

/** Add the new people one decision asks for; undefined when it adds nobody. */
function addFor(
  main: Dataset,
  compare: Dataset,
  matches: MatchResult,
  decisions: ReadonlyMap<string, CandidateDecision>,
  key: string,
  d: CandidateDecision,
  pinned: ReadonlyMap<string, string>,
  t: Translate,
  overrides?: FormatOverrides,
): { patches: RecordPatch[]; ids: Map<string, string> } | undefined {
  const parsed = parseDecisionKey(key);
  if (parsed?.kind !== "individual") return undefined;
  const mainIndi = main.individuals.get(parsed.mainId);
  const incoming = compare.individuals.get(parsed.compareId);
  if (!mainIndi || !incoming) return undefined;

  const individuals = new CopyOnRead(main.individuals);
  const families = new CopyOnRead(main.families);
  const liveIds = new Set<string>();
  for (const r of main.records) if (r.xref) liveIds.add(r.xref);
  // Sources are the one kind of shared record the stitching edits in place
  // (a matched source gains the page images its new citations name), so
  // they are copied up front; every other record is only read or added to.
  const records = main.records.map((r) => (r.tag === "SOUR" ? cloneNode(r) : r));
  const sourXrefMap = buildSourXrefMap(compare.records, records);
  const report: ChangeReport = {
    changes: [], deferred: [], graftJoins: [], recordsChanged: 0, newPersons: 0, newFamilies: 0,
    recordLabels: {}, recordKinds: {}, familySpouses: {}, newIndividuals: {}, customTags: {},
  };
  const { rejectedPairs, confirmedPairs } = decisionPairs(decisions);
  const ctx = makeContext(
    main, compare, matches, records, individuals, families, report, new Set(), t, sourXrefMap,
    rejectedPairs, confirmedPairs, linkPlacementFor(main, overrides, compare),
    { pinned, afterHighest: true, newOnly: true },
  );
  const rejectedEvents = d.rejectedEvents?.length ? new Set(d.rejectedEvents) : undefined;
  const rows = individualFieldRows(t, mainIndi, incoming, main, compare, mergePlaceFormat(main, overrides), rejectedEvents);
  applyIndividualRelations(parsed.mainId, mainIndi, incoming, rows, d.fields, main, compare, ctx);
  // A child somebody else's decision already added is that decision's.
  const taken = new Set((d.takenChildren ?? []).filter((id) => !pinned.has(id)));
  applyIndividualFamilies(
    parsed.mainId, mainIndi, incoming, rows, { ...d.fields, ...confirmedFamilyFields(decisions) },
    main, compare, ctx, taken, true,
  );
  if (!ctx.added.size) return undefined;

  dropLoneFamilies(records, liveIds, individuals, families);
  const people = records.filter((r) => r.xref && !liveIds.has(r.xref));
  // The sources the new people cite, as the save brings them across.
  foldMatchedSourcePages(
    [...people, ...records.filter((r) => r.tag === "SOUR" || r.tag === "OBJE")],
    compare,
    sourXrefMap,
  );
  importSourRecords(records, compare, sourXrefMap, report.customTags);
  remapMergedAssociations(people, (incomingId) => ctx.resolved(incomingId));
  fillAddedPlaceCoords(people, records);

  const patches: RecordPatch[] = [];
  const changed = (type: "individual" | "family" | "record", id: string, live: GedNode, copy: GedNode) => {
    if (JSON.stringify(live) !== JSON.stringify(copy)) patches.push({ type, id, before: cloneRaw(live), after: copy });
  };
  for (const id of individuals.copied) changed("individual", id, main.individuals.get(id)!.raw, individuals.get(id)!);
  for (const id of families.copied) changed("family", id, main.families.get(id)!.raw, families.get(id)!);
  const liveSources = new Map(main.records.filter((r) => r.tag === "SOUR" && r.xref).map((r) => [r.xref!, r]));
  for (const r of records) {
    if (!r.xref) continue;
    const live = liveSources.get(r.xref);
    if (live) changed("record", r.xref, live, r);
    else if (!liveIds.has(r.xref)) {
      const type = r.tag === "INDI" ? "individual" : r.tag === "FAM" ? "family" : "record";
      patches.push({ type, id: r.xref, before: null, after: r });
    }
  }
  applyRecordPatches(main, patches, "redo");
  return { patches, ids: new Map(ctx.added) };
}

/**
 * A family the stitching created that ended up holding one person — the main
 * person's union with a partner the save will link, say — is the save's to
 * make, not this step's: left in, it would sit in the file as a family of one.
 */
function dropLoneFamilies(records: GedNode[], liveIds: ReadonlySet<string>, individuals: CopyOnRead, families: CopyOnRead): void {
  for (const fam of records.filter((r) => r.tag === "FAM" && r.xref && !liveIds.has(r.xref))) {
    const members = fam.children.filter((c) => (c.tag === "HUSB" || c.tag === "WIFE" || c.tag === "CHIL") && c.value);
    if (members.length >= 2) continue;
    for (const m of members) {
      const person = individuals.get(m.value!);
      if (person) person.children = person.children.filter((c) => !((c.tag === "FAMS" || c.tag === "FAMC") && c.value === fam.xref));
    }
    families.delete(fam.xref!);
    records.splice(records.indexOf(fam), 1);
  }
}

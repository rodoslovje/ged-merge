import type { Dataset, Family, GedNode, Individual } from "../gedcom/types";
import { datePrecision, parseDate } from "../gedcom/date";
import { recordsNaming, repointAssociations } from "../gedcom/assoc";
import { INDI_EVENT_TAGS, isChangeStampEvent } from "../gedcom/eventTags";
import { LINK_TAGS } from "../gedcom/builder";
import { cloneNode, mergeSubLines, nodeFingerprint, firstChild, hasChild } from "../gedcom/node";
import { URL_RE, looksLikeUrl } from "../gedcom/uri";
import {
  EDITABLE_LINK_TAGS,
  EVENT_CHILD_ORDER,
  FAM_CHILD_ORDER,
  INDI_CHILD_ORDER,
  RECORD_OWN_TAGS,
  detachChildFromFamily,
  foldFamily,
  familyPointerHolders,
  individualsScope,
  pointerScope,
  reindexRecord,
  withPointerIndex,
  insertOrdered,
  rebuildFamily,
  rebuildIndividual,
  removeIndividual,
} from "../gedcom/edit";
import { applyRows, linkPlacementFor, type LinkPlacement } from "../merge/applyFields";
import { closeKin } from "./duplicates";
import { applyPassSafely, keepSnapshots, type PassJournal } from "./passSafety";
import { INDI_HANDLED, type ChangeReport } from "../merge/merge";
import { individualFieldRows, orderedEventTags } from "../review/fields";
import type { CandidateDecision, FieldChoice, FieldRow, RelativeCell } from "../review/types";
import {
  patchesFromSnapshots,
  snapshotRecords,
  type RecordPatch,
} from "../ui/historyTypes";
import type { Translate } from "../locales/i18n";

/**
 * Collapse two within-file duplicate records into one.
 *
 * Unlike the cross-file merge (`mergeDecisions`), both records already live in
 * the same dataset, so this operates in place and returns `RecordPatch[]` for
 * the undo stack — the same convention as `applyPlaceRename` / `fixBrokenLinks`.
 *
 * The **left/survivor** record is kept; the **right/removed** record is merged
 * into it and deleted:
 *  - Scalar and event individual fields (name, sex, BIRT/DEAT/…, notes, links,
 *    sources) are applied onto the survivor via the shared `applyRows` engine,
 *    honoring the per-field M/I/B choices in `decision.fields`.
 *  - Partners and children are re-pointed from the removed record onto the
 *    survivor unless that relationship row is set to "main". Family records the
 *    survivor then belongs to twice (the same couple modelled as two records —
 *    common for true duplicates) are collapsed into one.
 *  - Parents are one either/or choice for the whole block ({@link PARENTS_KEY}),
 *    because a person has one set of parents — see {@link parentsChoice}.
 *  - `removeIndividual` drops the removed record from any families left pointing
 *    at it and prunes families that fall below two members.
 */
export function mergeDuplicate(
  dataset: Dataset,
  survivorId: string,
  removedId: string,
  decision: CandidateDecision,
  t: Translate,
  /** Told about every record the merge snapshots, when it runs inside
   *  {@link applyPassSafely} (as every chain does). */
  journal?: PassJournal,
  /** The file's link-writing habits, read once for a whole chain rather than
   *  rescanned for every pair. */
  placement?: LinkPlacement,
): RecordPatch[] {
  const survivor = dataset.individuals.get(survivorId);
  const removed = dataset.individuals.get(removedId);
  if (!survivor || !removed || survivorId === removedId) return [];
  // A parent, child or partner of the survivor is a different person, whatever
  // the names say — refused here too, so no path (a cluster chain, a pair made
  // by hand) can make anyone their own parent.
  if (closeKin(dataset, survivorId, removedId)) return [];

  // Snapshot every record that could change: both individuals, all their
  // families, and every member of those families (a re-point or a prune can
  // touch a spouse/sibling/child). No new records are created, so this set
  // covers every record the merge can mutate or delete.
  const indiIds = new Set<string>([survivorId, removedId]);
  const famIds = new Set<string>([
    ...survivor.spouseOf,
    ...survivor.childOf,
    ...removed.spouseOf,
    ...removed.childOf,
  ]);
  for (const fid of famIds) {
    const fam = dataset.families.get(fid);
    if (!fam) continue;
    for (const m of [fam.husband, fam.wife, ...fam.children]) if (m) indiIds.add(m);
  }
  // A one-sided file can link a person to one of those families from their own
  // side only (a FAMC the family never lists); a fold or prune unlinks them too.
  for (const indi of individualsScope(dataset, famIds)) {
    if (indi.childOf.some((f) => famIds.has(f)) || indi.spouseOf.some((f) => famIds.has(f))) indiIds.add(indi.id);
  }
  // An association can be carried by any record in the file — a third person's
  // baptism naming the removed duplicate as its godparent — and so can an ALIA
  // or a vendor pointer. Those records are repointed below, so they belong in
  // the snapshot the undo patch is cut from.
  const pair = new Set([survivorId, removedId]);
  const naming = new Set([
    ...recordsNaming(pointerScope(dataset, pair), pair),
    // A fold of the survivor's doubled families repoints whatever names them.
    ...familyPointerHolders(pointerScope(dataset, famIds), famIds),
  ]);
  for (const id of naming) {
    if (dataset.individuals.has(id)) indiIds.add(id);
    else famIds.add(id);
  }
  const before = snapshotRecords(dataset, indiIds, famIds);
  keepSnapshots(journal, before);

  // 1. Scalar/event individual fields → survivor. `applyRows` already skips the
  //    relationship rows (father/mother via INDI_HANDLED, partners/children via
  //    the `fam.` key prefix), so it only touches individual-level data. The
  //    lines no row compares (photos, media, custom tags, …) are carried first,
  //    so a link they bear reads as the survivor's own in the rows built after.
  carryUncoveredLines(dataset, survivor.raw, removed.raw, decision.fields);
  rebuildIndividual(dataset, survivor);
  const rows = individualFieldRows(t, survivor, removed, dataset, dataset);
  const events = eventTargets(survivor, removed);
  const ownEvents = new Set(survivor.raw.children);
  applyRows(
    survivor.raw,
    removed.raw,
    survivorId,
    rows,
    decision.fields,
    emptyReport(),
    new Set<string>(),
    INDI_HANDLED,
    t,
    placement ? { ...placement, pendingLookups: [] } : linkPlacementFor(dataset),
    dataset.records,
    new Map(),
  );
  carryUncoveredEventLines(survivor.raw, events, ownEvents, rows);
  rebuildIndividual(dataset, survivor);

  // 2. Parents: one either/or choice for the whole block — "main" keeps the
  //    survivor's own parent family, "incoming" swaps in the removed record's,
  //    "both" keeps both (the rare adoptive/step case).
  const ownParentFams = [...(dataset.individuals.get(survivorId)?.childOf ?? [])];
  const parents = parentsChoice(decision.fields, ownParentFams.length > 0);
  for (const rFamId of [...removed.childOf]) {
    const rFam = dataset.families.get(rFamId);
    if (!rFam || (!rFam.husband && !rFam.wife)) continue;
    // Backstop, whatever the choice: dropping this link can leave the family
    // below two members, and `removeIndividual` then prunes it — stranding a
    // parent whose only tie to the tree it was. An extra parent line the user
    // can undo beats a person the tree can no longer reach, so keep the family.
    if (parents === "main" && !strandsAParent(dataset, rFam, removedId)) continue;
    addSurvivorAsChild(dataset, survivor, removed, rFam);
  }
  if (parents === "incoming") {
    for (const famId of ownParentFams) {
      const fam = dataset.families.get(famId);
      if (fam) detachChildFromFamily(dataset, fam, survivorId);
    }
  }

  // 3. Partners/children: re-point the removed record's marriages onto the
  //    survivor (unless the row is set to "main").
  for (const rFamId of [...removed.spouseOf]) {
    const rFam = dataset.families.get(rFamId);
    if (!rFam) continue;
    const base = `fam.${rFamId}`;
    if (wantsRelative(decision.fields, `${base}.partner`) || wantsRelative(decision.fields, `${base}.children`)) {
      repointSpouse(dataset, survivor, removed, rFam);
    }
  }

  // 4. Whoever named the duplicate names the survivor now — the two records are
  //    one person, so the godparent of a baptism did not stop being one.
  //    Done before the removal, which would otherwise drop these lines.
  for (const id of repointAssociations(pointerScope(dataset, pair), removedId, survivorId)) {
    const indi = dataset.individuals.get(id);
    if (indi) rebuildIndividual(dataset, indi);
    else {
      const fam = dataset.families.get(id);
      if (fam) rebuildFamily(dataset, fam);
    }
  }

  // 5. Drop the absorbed duplicate (and prune any family it leaves degenerate).
  removeIndividual(dataset, removed);

  // 6. Collapse families the survivor now belongs to twice (same couple / same parents).
  dedupSurvivorFamilies(dataset, survivorId);

  // Every record this merge can change is in the snapshot: index them again,
  // so a chain's next step sees each line they gained, rebuilt or not.
  for (const id of [...before.individuals.keys(), ...before.families.keys()]) {
    const raw = dataset.individuals.get(id)?.raw ?? dataset.families.get(id)?.raw;
    if (raw) reindexRecord(dataset.records, raw);
  }
  return patchesFromSnapshots(dataset, before);
}

/** One step of a {@link mergeDuplicateChain}. */
export interface DuplicateMergeStep {
  survivorId: string;
  removedId: string;
  decision: CandidateDecision;
}

/**
 * Run several duplicate merges as a single undoable action.
 *
 * The order matters: when the two records being merged have relatives that are
 * themselves a duplicate pair (each side's own "Matevž Demšar" record), merging
 * those relatives **first** makes their two families collapse into one on their
 * own — so the pair that follows finds a single set of parents and no link has
 * to be dropped. Merging the child first instead severs the trail to the other
 * side's family, which is what `relatedSeparateRecords` warns about. Duplicated
 * *children* run the other way and belong at the end of the chain — see
 * {@link relatedMergeOrder}.
 *
 * Per-record patches are composed (first `before`, last `after`) so the whole
 * chain undoes in one go, whatever a record was touched by.
 */
export function mergeDuplicateChain(
  dataset: Dataset,
  steps: DuplicateMergeStep[],
  t: Translate,
): RecordPatch[] {
  const byKey = new Map<string, RecordPatch>();
  // Where each record removed so far sat before the chain, ascending. A step's
  // deletion index is read off the list as earlier steps left it; undo puts the
  // records back into the list as the chain left it, in ascending order, so
  // each index must be the record's position in the file *before the chain*.
  const removedAt: number[] = [];
  const originalIndex = (mid: number): number => {
    let at = mid;
    for (const r of removedAt) {
      if (r <= at) at++;
      else break;
    }
    return at;
  };
  // A step that throws takes the whole chain back with it — the earlier steps'
  // merges included, whose patches would otherwise never reach the undo stack.
  // One index of who names whom for the whole chain: each step then asks the
  // few records that name its pair instead of walking the file several times.
  applyPassSafely(dataset, (journal) => withPointerIndex(dataset, () => {
    const placement = steps.length > 1 ? linkPlacementFor(dataset) : undefined;
    for (const step of steps) {
      const removedNow: number[] = [];
      for (const p of mergeDuplicate(dataset, step.survivorId, step.removedId, step.decision, t, journal, placement)) {
        if (p.after === null && p.index !== undefined) {
          p.index = originalIndex(p.index);
          removedNow.push(p.index);
        }
        const key = `${p.type}:${p.id}`;
        const first = byKey.get(key);
        // First `before`, last `after` — and the index that goes with the
        // deletion, wherever in the chain it happened.
        byKey.set(key, first ? { ...p, before: first.before } : p);
      }
      // All of one step's indices are read off the same list, so they join the
      // removed set only once the whole step is translated.
      if (removedNow.length) {
        removedAt.push(...removedNow);
        removedAt.sort((a, b) => a - b);
      }
    }
  }));
  // A record both created and removed inside the chain (none today, but the
  // composition should stay honest) has nothing to record.
  return [...byKey.values()].filter((p) => p.before !== null || p.after !== null);
}

/**
 * Fold the incoming duplicates the matcher found (`incomingDuplicates`) into
 * their kept record, each with the confirmed default decision. The worker and
 * the main thread's replay both run this, so their copies agree record for
 * record. Like a chain, it reads the file's link habits once and keeps one
 * pointer index for all pairs: bare, each pair walked the whole file — ~1 s
 * per pair on a 100k-person index file, minutes for its ~150 duplicates.
 */
export function consolidateDuplicates(dataset: Dataset, clusters: Array<{ keepId: string; mergeIds: string[] }>): void {
  withPointerIndex(dataset, () => {
    const placement = linkPlacementFor(dataset);
    for (const { keepId, mergeIds } of clusters) {
      for (const id of mergeIds) mergeDuplicate(dataset, keepId, id, { status: "confirmed", fields: {} }, rawLabel, undefined, placement);
      const from = (dataset.consolidatedFrom ??= new Map());
      from.set(keepId, [...new Set([...(from.get(keepId) ?? [keepId]), ...mergeIds])]);
    }
  });
}

/** Consolidation has no reader to show field labels to (the worker has no
 *  i18n), and the replay must write the very same text. */
const rawLabel = (key: string) => key;

/** A partner/children row is taken (re-pointed onto the survivor) unless the
 *  user explicitly chose "main" for it. Default is union ("both"). */
function wantsRelative(fields: Record<string, FieldChoice>, key: string): boolean {
  return (fields[key] ?? "both") !== "main";
}

/** The single choice key covering the whole parents block. Father and mother
 *  are not independent: they are two slots of one `FAM`, and a person has one
 *  set of parents — so the panel offers one control for both rows. */
export const PARENTS_KEY = "parents";

/**
 * Which parent family the survivor ends up in. Unlike partners (where a union
 * is right — a person can have several marriages), duplicate records almost
 * never mean a second set of parents, so the default is *not* a union:
 *  - `"main"` — keep the survivor's own parents, drop the link to the removed
 *    record's parent family (that family and its people stay, just without this
 *    child; merging the duplicate parents afterwards folds them together);
 *  - `"incoming"` — use the removed record's parents instead;
 *  - `"both"` — keep both parent families (adoptive/step parents).
 * With no explicit choice the survivor keeps its own parents, or inherits the
 * removed record's when it has none of its own.
 */
function parentsChoice(fields: Record<string, FieldChoice>, survivorHasParents: boolean): FieldChoice {
  return fields[PARENTS_KEY] ?? (survivorHasParents ? "main" : "incoming");
}

/**
 * True when losing `childId` would take `fam` below two members — so
 * `pruneDegenerateFamily` removes it — and a parent in it has no other family
 * to fall back on. Their record and its facts would survive, but nothing in the
 * tree would point at them any more. See {@link mergeDuplicate} step 2.
 */
function strandsAParent(dataset: Dataset, fam: Family, childId: string): boolean {
  const membersLeft =
    (fam.husband ? 1 : 0) + (fam.wife ? 1 : 0) + fam.children.filter((c) => c !== childId).length;
  if (membersLeft >= 2) return false;
  return [fam.husband, fam.wife].some((pid) => {
    const parent = pid ? dataset.individuals.get(pid) : undefined;
    return !!parent && parent.spouseOf.length + parent.childOf.length <= 1;
  });
}

/** A relative that aligns across the two duplicate records but is itself two
 *  separate records — see {@link relatedSeparateRecords}. */
export interface RelatedSeparateRecord {
  /** The survivor-side relative's record id. */
  aId: string;
  /** The removed-side relative's record id (a distinct record). */
  bId: string;
  /** Display name for the hint. */
  label: string;
  /** Which relation surfaced it, for the message wording and the merge order. */
  relation: "partner" | "father" | "mother" | "child";
}

/**
 * Where a related pair belongs in the chain around the merge it was surfaced by.
 *
 * Parents and partners have to go **first**: it is their two records that keep
 * the two families apart, so until they are one record nothing folds and the
 * pair being merged has to drop a link.
 *
 * Children are the mirror image — the dependency runs the other way. Two child
 * records don't stop anything from folding; they are simply carried into the one
 * surviving family and left sitting there as two siblings. Merging a child
 * *first* would not help and would hit the very parents choice this ordering
 * exists to avoid (each child record still has its own parent family at that
 * point). Once the pair is merged the parents are one family, so the child pair
 * merges cleanly with no choice to make — hence **after**.
 */
export function relatedMergeOrder(relation: RelatedSeparateRecord["relation"]): "before" | "after" {
  return relation === "child" ? "after" : "before";
}

/**
 * Relatives that align *by name* across the two records being merged but are
 * themselves **distinct records** — e.g. each "Pavel Fabjan" is married to his
 * own "Barbara Gorjanc" record. Merging only the Pavels can't tell those two
 * Barbaras are one person, so their families (and the children under them) won't
 * be folded together. The duplicates panel surfaces these so the user merges
 * them too, completing the collapse.
 *
 * Children are surfaced for the opposite reason: folding *does* work without
 * them, and that is the problem — both records are carried into the one
 * surviving family and stay there as two siblings, with nothing pointing them
 * out. They merge after the pair rather than before it; see
 * {@link relatedMergeOrder}.
 *
 * Derived from the already-computed comparison rows so it matches exactly what
 * the panel aligns side-by-side (a pair with both an `id` on the main side and
 * a *different* `id` on the incoming side is one such relative). Parents and
 * partners are structural — one father, one mother, one spouse per family — but
 * children are aligned by name similarity across two sibling sets, so a pair of
 * genuinely different same-named siblings can show up here. The panel scores
 * every pair and leaves them unticked, so nothing merges unasked.
 */
export function relatedSeparateRecords(rows: FieldRow[]): RelatedSeparateRecord[] {
  const out: RelatedSeparateRecord[] = [];
  const seen = new Set<string>();
  const add = (aId: string, bId: string, label: string, relation: RelatedSeparateRecord["relation"]) => {
    const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ aId, bId, label, relation });
  };

  for (const row of rows) {
    const relation: RelatedSeparateRecord["relation"] | undefined =
      row.key === "father" ? "father"
      : row.key === "mother" ? "mother"
      : row.key.endsWith(".partner") ? "partner"
      : row.key.endsWith(".children") ? "child"
      : undefined;
    if (!relation || !row.relatives) continue;

    if (relation === "father" || relation === "mother") {
      // A person has one father and one mother, so the two records line up by
      // role — even when their names are too different to have been paired onto
      // one line ("Štefanija" against "Štefka Kržišnik"), which is exactly the
      // case where the duplicate is easiest to miss.
      const mains = distinctById(row.relatives.map((p) => p.main));
      const incoming = distinctById(row.relatives.map((p) => p.incoming));
      if (mains.length === 1 && incoming.length === 1 && mains[0].id !== incoming[0].id) {
        add(mains[0].id!, incoming[0].id!, cellLabel(mains[0]) || cellLabel(incoming[0]), relation);
      }
      continue;
    }

    for (const p of row.relatives) {
      const aId = p.main?.id;
      const bId = p.incoming?.id;
      if (!aId || !bId || aId === bId) continue;
      add(aId, bId, p.main?.name || p.main?.text || p.incoming?.name || "?", relation);
    }
  }
  return out;
}

/** The cells that carry a record id, one per distinct id. */
function distinctById(cells: Array<RelativeCell | undefined>): RelativeCell[] {
  const byId = new Map<string, RelativeCell>();
  for (const c of cells) if (c?.id && !byId.has(c.id)) byId.set(c.id, c);
  return [...byId.values()];
}

function cellLabel(cell: RelativeCell): string {
  return cell.name || cell.text || "?";
}

/** True for the partner/children rows, which merge as a union. */
function isRelationship(key: string): boolean {
  return key.endsWith(".partner") || key.endsWith(".children");
}

/** True for the two rows of the parents block, which share one choice. */
export function isParentRow(key: string): boolean {
  return key === "father" || key === "mother";
}

/** Whether the survivor (left) side of the compared rows has any parent at all. */
export function hasParentsOnMain(rows: FieldRow[]): boolean {
  return rows.some((r) => isParentRow(r.key) && !!r.main);
}

/**
 * Default per-field choices for a duplicate merge, used to seed the panel:
 *  - one-sided fields are taken from the side that has them (combine both);
 *  - partners and children default to union;
 *  - parents keep the survivor's own (see {@link parentsChoice});
 *  - conflicting dates take the more precise side;
 *  - other conflicts keep the survivor (left).
 */
export function duplicateDefaults(rows: FieldRow[]): Record<string, FieldChoice> {
  const fields: Record<string, FieldChoice> = {};
  if (rows.some((r) => isParentRow(r.key))) {
    fields[PARENTS_KEY] = hasParentsOnMain(rows) ? "main" : "incoming";
  }
  for (const row of rows) {
    if (row.isGroupHeader || isParentRow(row.key) || row.state === "agree" || row.state === "main-only") continue;
    if (isRelationship(row.key)) {
      fields[row.key] = "both";
    } else if (row.state === "incoming-only") {
      fields[row.key] = "incoming";
    } else if (row.key.endsWith(".date")) {
      fields[row.key] = datePrecision(parseDate(row.incoming ?? "")) > datePrecision(parseDate(row.main ?? "")) ? "incoming" : "main";
    } else {
      fields[row.key] = "main";
    }
  }
  return fields;
}


// ── Lines no comparison row covers ───────────────────────────────────────────

/** Record-level tags the comparison rows decide on (names, sex, notes, sources,
 *  links, FamilySearch ids, the private flag) or the relationship steps
 *  re-point (FAMC/FAMS). Events are recognized by tag on their own. */
const ROW_INDI_TAGS = new Set([
  "NAME", "SEX", "NOTE", "SOUR", "FAMC", "FAMS", "_FID", "_FSFTID", "PRIV", "_PRIV", "RESN", ...LINK_TAGS,
]);
/** Event sub-tags the event rows decide on. */
const ROW_EVENT_TAGS = new Set([
  "TYPE", "DATE", "PLAC", "ADDR", "NOTE", "AGNC", "CAUS", "SOUR", "ASSO", "_ASSO", ...EDITABLE_LINK_TAGS,
]);
/** Uncovered tags that hold one value: the survivor's own wins when it has one. */
const SINGLE_VALUED = new Set(["_PHOTO", "AGE", "RELI", "RESN", "PRIV", "_PRIV"]);

/** Clone onto `target` each line of `from` that `skip` lets through, unless
 *  the target holds an identical line or already has a value for a
 *  one-value tag. Compared on what the line says, as `foldFamily` does. */
function carryLines(target: GedNode, from: GedNode, order: string[], skip: (line: GedNode) => boolean): void {
  const have = new Set(target.children.map(nodeFingerprint));
  for (const line of from.children) {
    if (RECORD_OWN_TAGS.has(line.tag) || skip(line)) continue;
    if (have.has(nodeFingerprint(line))) continue;
    if (SINGLE_VALUED.has(line.tag) && hasChild(target, line.tag)) continue;
    insertOrdered(target, cloneNode(line), order);
  }
}

/**
 * Carry the absorbed record's record-level lines that no comparison row offers
 * — media (`OBJE`, `_PHOTO`), `SUBM`, `ALIA`, `ASSO`, custom `_` tags — onto
 * the survivor, the way `foldFamily` keeps a dropped family's lines. With the
 * links row set to keep the survivor's own, a line that carries a web address
 * stays behind with the rest of the absorbed record's links.
 */
function carryUncoveredLines(
  dataset: Dataset,
  survivor: GedNode,
  removed: GedNode,
  fields: Record<string, FieldChoice>,
): void {
  const keepOwnLinks = fields.links === "main";
  carryLines(survivor, removed, INDI_CHILD_ORDER, (line) =>
    ROW_INDI_TAGS.has(line.tag) || INDI_EVENT_TAGS.has(line.tag) || (keepOwnLinks && carriesLink(line, dataset.records)));
}

/** Whether a line names a web address — in a value, or as a media record whose file is one. */
function carriesLink(line: GedNode, records: GedNode[]): boolean {
  const v = line.value?.trim() ?? "";
  if (line.tag === "OBJE" && /^@[^@]+@$/.test(v)) {
    const file = records.find((r) => r.xref === v)?.children.find((c) => c.tag === "FILE")?.value?.trim();
    if (file && looksLikeUrl(file)) return true;
  } else if (new RegExp(URL_RE.source, "i").test(v)) return true;
  return line.children.some((c) => carriesLink(c, records));
}

/** One absorbed event and the survivor event its rows write to. */
interface EventTarget {
  tag: string;
  compareIdx: number;
  from: GedNode;
  /** The survivor's paired event; absent for an event only the absorbed record has. */
  into?: GedNode;
}

/** An individual's raw event lines of `tag`, indexed as its typed events are. */
function rawEvents(record: GedNode, tag: string): GedNode[] {
  return record.children.filter((c) => c.tag === tag && !isChangeStampEvent(c));
}

/** The absorbed record's events with the survivor event each pairs with —
 *  the same pairing the event rows are built from. Read before the rows are
 *  applied, while the survivor's events still sit at the indices it names. */
function eventTargets(survivor: Individual, removed: Individual): EventTarget[] {
  const out: EventTarget[] = [];
  for (const { tag, mainIdx, compareIdx } of orderedEventTags(survivor, removed)) {
    const from = compareIdx >= 0 ? rawEvents(removed.raw, tag)[compareIdx] : undefined;
    if (!from) continue;
    out.push({ tag, compareIdx, from, into: mainIdx >= 0 ? rawEvents(survivor.raw, tag)[mainIdx] : undefined });
  }
  return out;
}

/**
 * Merge each absorbed event's lines no row covers (`OBJE`, `AGE`, custom `_`
 * tags, …) into the survivor event it was paired with. An event only the
 * absorbed record has lands as the node its rows created (found among the
 * survivor's new lines); one with no comparable field at all — nothing its rows
 * could create it from — comes across whole. One whose rows were all declined
 * stays behind.
 */
function carryUncoveredEventLines(
  survivor: GedNode,
  events: EventTarget[],
  ownLines: ReadonlySet<GedNode>,
  rows: FieldRow[],
): void {
  const created = survivor.children.filter((c) => !ownLines.has(c));
  const skip = (line: GedNode) => ROW_EVENT_TAGS.has(line.tag);
  for (const ev of events) {
    let into = ev.into;
    if (!into) {
      const i = created.findIndex((c) => c.tag === ev.tag && isSubsetOf(c, ev.from));
      if (i !== -1) into = created.splice(i, 1)[0];
    }
    if (into) {
      carryLines(into, ev.from, EVENT_CHILD_ORDER, skip);
      continue;
    }
    const offered = rows.some((r) =>
      !r.isGroupHeader && r.eventCompareIdx === ev.compareIdx && r.key.split(".")[0] === ev.tag);
    if (!offered) insertOrdered(survivor, cloneNode(ev.from), INDI_CHILD_ORDER);
  }
}

/** Every line of `part` appears, identically, among `whole`'s lines. */
function isSubsetOf(part: GedNode, whole: GedNode): boolean {
  const lines = new Set(whole.children.map(nodeFingerprint));
  return part.children.every((c) => lines.has(nodeFingerprint(c)));
}

// ── Relationship re-pointing ─────────────────────────────────────────────────

/** Add the survivor as a child of `fam` (so it inherits the removed record's
 *  parents), with the reciprocal FAMC. Both lines take the removed record's
 *  qualifiers (`_FREL`/`_MREL`, `PEDI adopted`) — the link is the same one. The
 *  removed record is dropped from `fam` later by `removeIndividual`. */
function addSurvivorAsChild(dataset: Dataset, survivor: Individual, removed: Individual, fam: Family): void {
  if (fam.children.includes(survivor.id)) return;
  const chil = ptr(fam.raw, "CHIL", survivor.id);
  const oldChil = fam.raw.children.find((c) => c.tag === "CHIL" && c.value === removed.id);
  if (oldChil) mergeSubLines(chil, oldChil);
  insertOrdered(fam.raw, chil, FAM_CHILD_ORDER);
  rebuildFamily(dataset, fam);
  addLink(dataset, survivor, "FAMC", fam.id, removed.raw.children.find((c) => c.tag === "FAMC" && c.value === fam.id));
}

/** Replace the removed record's spouse role in `fam` with the survivor, moving
 *  the marriage (spouse, children and marriage facts) onto the survivor whole. */
function repointSpouse(dataset: Dataset, survivor: Individual, removed: Individual, fam: Family): void {
  if (fam.husband === survivor.id || fam.wife === survivor.id) return; // already in this family
  const role = fam.husband === removed.id ? "HUSB" : fam.wife === removed.id ? "WIFE" : undefined;
  if (!role) return;
  const slot = firstChild(fam.raw, role);
  if (slot) slot.value = survivor.id;
  else insertOrdered(fam.raw, ptr(fam.raw, role, survivor.id), FAM_CHILD_ORDER);
  rebuildFamily(dataset, fam);
  addLink(dataset, survivor, "FAMS", fam.id);
}

// ── Duplicate-family collapse ────────────────────────────────────────────────

/** After re-pointing, the survivor can sit in two records for the same couple
 *  (its own and the absorbed one). Fold same-couple spouse families and
 *  same-parents child families into one. */
function dedupSurvivorFamilies(dataset: Dataset, survivorId: string): void {
  const survivor = dataset.individuals.get(survivorId);
  if (!survivor) return;

  // Spouse families keyed by the other spouse.
  groupAndFold(dataset, survivor.spouseOf, (fam) => {
    const other = fam.husband === survivorId ? fam.wife : fam.husband;
    return other || "";
  });

  const after = dataset.individuals.get(survivorId);
  if (!after) return;
  // Child families keyed by the parent couple.
  groupAndFold(dataset, after.childOf, (fam) => `${fam.husband ?? ""}|${fam.wife ?? ""}`);
}

/** Group the given family ids by `keyOf` and fold every group with a non-empty
 *  key and more than one member into its first family. */
function groupAndFold(dataset: Dataset, famIds: string[], keyOf: (fam: Family) => string): void {
  const groups = new Map<string, string[]>();
  for (const fid of [...famIds]) {
    const fam = dataset.families.get(fid);
    if (!fam) continue;
    const key = keyOf(fam);
    if (!key.replace("|", "")) continue; // both sides empty → don't guess
    const bucket = groups.get(key);
    if (bucket) bucket.push(fid);
    else groups.set(key, [fid]);
  }
  for (const fids of groups.values()) {
    if (fids.length < 2) continue;
    for (let i = 1; i < fids.length; i++) foldFamily(dataset, fids[0], fids[i]);
  }
}

// ── small helpers ────────────────────────────────────────────────────────────

/** A pointer line node (`<tag> <id>`) at the right level under `parent`. */
function ptr(parent: GedNode, tag: string, id: string): GedNode {
  return { level: parent.level + 1, tag, value: id, children: [] };
}

/** Add a FAMC/FAMS pointer on an individual if it's not already there, with
 *  the subordinate lines of `like` (the line it replaces), if given. */
function addLink(dataset: Dataset, indi: Individual, tag: "FAMC" | "FAMS", famId: string, like?: GedNode): void {
  if (indi.raw.children.some((c) => c.tag === tag && c.value === famId)) return;
  const line = ptr(indi.raw, tag, famId);
  if (like) mergeSubLines(line, like);
  insertOrdered(indi.raw, line, INDI_CHILD_ORDER);
  rebuildIndividual(dataset, indi);
}

function emptyReport(): ChangeReport {
  return {
    changes: [],
    deferred: [],
    graftJoins: [],
    recordsChanged: 0,
    newPersons: 0,
    newFamilies: 0,
    recordLabels: {},
    recordKinds: {},
    familySpouses: {},
    customTags: {},
  };
}

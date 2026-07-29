import type { Dataset, Family, GedNode, Individual } from "../gedcom/types";
import { parseDate } from "../gedcom/date";
import { EDITABLE_FAM_EVENT_TAGS } from "../gedcom/eventTags";
import {
  FAM_CHILD_ORDER,
  INDI_CHILD_ORDER,
  detachChildFromFamily,
  insertOrdered,
  rebuildFamily,
  rebuildIndividual,
  removeFamily,
  removeIndividual,
} from "../gedcom/edit";
import { applyRows, detectLinkFormat } from "../merge/applyFields";
import { INDI_HANDLED, type ChangeReport } from "../merge/merge";
import { individualFieldRows } from "../review/fields";
import type { CandidateDecision, FieldChoice, FieldRow } from "../review/types";
import {
  cloneRaw,
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
): RecordPatch[] {
  const survivor = dataset.individuals.get(survivorId);
  const removed = dataset.individuals.get(removedId);
  if (!survivor || !removed || survivorId === removedId) return [];

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
  const before = snapshotRecords(dataset, indiIds, famIds);

  // 1. Scalar/event individual fields → survivor. `applyRows` already skips the
  //    relationship rows (father/mother via INDI_HANDLED, partners/children via
  //    the `fam.` key prefix), so it only touches individual-level data.
  const rows = individualFieldRows(t, survivor, removed, dataset, dataset);
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
    detectLinkFormat(dataset),
    dataset.records,
    new Map(),
  );
  rebuildIndividual(dataset, survivor);

  // 2. Parents: one either/or choice for the whole block — "main" keeps the
  //    survivor's own parent family, "incoming" swaps in the removed record's,
  //    "both" keeps both (the rare adoptive/step case).
  const ownParentFams = [...(dataset.individuals.get(survivorId)?.childOf ?? [])];
  const parents = parentsChoice(decision.fields, ownParentFams.length > 0);
  if (parents !== "main") {
    for (const rFamId of [...removed.childOf]) {
      const rFam = dataset.families.get(rFamId);
      if (!rFam || (!rFam.husband && !rFam.wife)) continue;
      addSurvivorAsChild(dataset, survivor, rFam);
    }
    if (parents === "incoming") {
      for (const famId of ownParentFams) {
        const fam = dataset.families.get(famId);
        if (fam) detachChildFromFamily(dataset, fam, survivorId);
      }
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

  // 4. Drop the absorbed duplicate (and prune any family it leaves degenerate).
  removeIndividual(dataset, removed);

  // 5. Collapse families the survivor now belongs to twice (same couple / same parents).
  dedupSurvivorFamilies(dataset, survivorId);

  return patchesFromSnapshots(dataset, before);
}

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

/** A relative that aligns across the two duplicate records but is itself two
 *  separate records — see {@link relatedSeparateRecords}. */
export interface RelatedSeparateRecord {
  /** The survivor-side relative's record id. */
  aId: string;
  /** The removed-side relative's record id (a distinct record). */
  bId: string;
  /** Display name for the hint. */
  label: string;
  /** Which relation surfaced it, for the message wording. */
  relation: "partner" | "father" | "mother";
}

/**
 * Relatives that align *by name* across the two records being merged but are
 * themselves **distinct records** — e.g. each "Pavel Fabjan" is married to his
 * own "Barbara Gorjanc" record. Merging only the Pavels can't tell those two
 * Barbaras are one person, so their families (and the children under them) won't
 * be folded together. The duplicates panel surfaces these so the user merges
 * them too, completing the collapse.
 *
 * Derived from the already-computed comparison rows so it matches exactly what
 * the panel aligns side-by-side (a pair with both an `id` on the main side and
 * a *different* `id` on the incoming side is one such relative).
 */
export function relatedSeparateRecords(rows: FieldRow[]): RelatedSeparateRecord[] {
  const out: RelatedSeparateRecord[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const relation: RelatedSeparateRecord["relation"] | undefined =
      row.key === "father" ? "father"
      : row.key === "mother" ? "mother"
      : row.key.endsWith(".partner") ? "partner"
      : undefined;
    if (!relation || !row.relatives) continue;
    for (const p of row.relatives) {
      const aId = p.main?.id;
      const bId = p.incoming?.id;
      if (!aId || !bId || aId === bId) continue;
      const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ aId, bId, label: p.main?.name || p.main?.text || p.incoming?.name || "?", relation });
    }
  }
  return out;
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
      fields[row.key] = datePrecision(row.incoming) > datePrecision(row.main) ? "incoming" : "main";
    } else {
      fields[row.key] = "main";
    }
  }
  return fields;
}

/** Rough date precision rank: exact day/month/year beat a bare or approximate year. */
function datePrecision(raw: string): number {
  if (!raw) return 0;
  const d = parseDate(raw);
  if (d.qualifier === "exact") return d.day ? 4 : d.month ? 3 : 2;
  return d.year != null ? 1 : 0;
}

// ── Relationship re-pointing ─────────────────────────────────────────────────

/** Add the survivor as a child of `fam` (so it inherits the removed record's
 *  parents), with the reciprocal FAMC. The removed record is dropped from `fam`
 *  later by `removeIndividual`. */
function addSurvivorAsChild(dataset: Dataset, survivor: Individual, fam: Family): void {
  if (fam.children.includes(survivor.id)) return;
  insertOrdered(fam.raw, ptr(fam.raw, "CHIL", survivor.id), FAM_CHILD_ORDER);
  rebuildFamily(dataset, fam);
  addLink(dataset, survivor, "FAMC", fam.id);
}

/** Replace the removed record's spouse role in `fam` with the survivor, moving
 *  the marriage (spouse, children and marriage facts) onto the survivor whole. */
function repointSpouse(dataset: Dataset, survivor: Individual, removed: Individual, fam: Family): void {
  if (fam.husband === survivor.id || fam.wife === survivor.id) return; // already in this family
  const role = fam.husband === removed.id ? "HUSB" : fam.wife === removed.id ? "WIFE" : undefined;
  if (!role) return;
  const slot = fam.raw.children.find((c) => c.tag === role);
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

/** Merge `dropId` into `keepId`: move children and any missing spouse slots and
 *  marriage events over, then remove the now-redundant family. */
function foldFamily(dataset: Dataset, keepId: string, dropId: string): void {
  const keep = dataset.families.get(keepId);
  const drop = dataset.families.get(dropId);
  if (!keep || !drop) return;

  for (const childId of [...drop.children]) {
    if (keep.children.includes(childId)) continue;
    insertOrdered(keep.raw, ptr(keep.raw, "CHIL", childId), FAM_CHILD_ORDER);
    const child = dataset.individuals.get(childId);
    if (child) addLink(dataset, child, "FAMC", keepId);
  }

  for (const role of ["HUSB", "WIFE"] as const) {
    if (keep.raw.children.some((c) => c.tag === role)) continue;
    const spouseId = drop.raw.children.find((c) => c.tag === role)?.value;
    if (!spouseId) continue;
    insertOrdered(keep.raw, ptr(keep.raw, role, spouseId), FAM_CHILD_ORDER);
    const spouse = dataset.individuals.get(spouseId);
    if (spouse) addLink(dataset, spouse, "FAMS", keepId);
  }

  for (const ev of drop.raw.children) {
    if (FAM_EVENT_TAGS.has(ev.tag) && !keep.raw.children.some((c) => c.tag === ev.tag)) {
      insertOrdered(keep.raw, cloneRaw(ev), FAM_CHILD_ORDER);
    }
  }

  rebuildFamily(dataset, keep);
  removeFamily(dataset, drop); // unlinks every remaining member's FAMS/FAMC to drop
}

const FAM_EVENT_TAGS = new Set(EDITABLE_FAM_EVENT_TAGS);

// ── small helpers ────────────────────────────────────────────────────────────

/** A pointer line node (`<tag> <id>`) at the right level under `parent`. */
function ptr(parent: GedNode, tag: string, id: string): GedNode {
  return { level: parent.level + 1, tag, value: id, children: [] };
}

/** Add a FAMC/FAMS pointer on an individual if it's not already there. */
function addLink(dataset: Dataset, indi: Individual, tag: "FAMC" | "FAMS", famId: string): void {
  if (indi.raw.children.some((c) => c.tag === tag && c.value === famId)) return;
  insertOrdered(indi.raw, ptr(indi.raw, tag, famId), INDI_CHILD_ORDER);
  rebuildIndividual(dataset, indi);
}

function emptyReport(): ChangeReport {
  return {
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
}

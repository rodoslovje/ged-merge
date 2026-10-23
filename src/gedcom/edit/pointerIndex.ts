import type { Dataset, Family, GedNode, Individual } from "../types";
import { isPointer } from "../uri";

/**
 * Which people and families hold a line naming a given xref, at any depth —
 * kept for the span of a chain of edits (a duplicate-merge chain), so each
 * step's "who names this record?" asks the few records that do instead of
 * walking the whole file. On a 500k-person file one such walk is ~100 ms, and
 * a duplicate merge asked it half a dozen times per pair.
 *
 * The index answers a superset: a record that once named the xref stays
 * listed after the line is gone, and each caller still asks the record itself.
 * Lines added after the index was built are seen because every edit helper
 * rebuilds the record it changed (`rebuildIndividual`/`rebuildFamily`), and
 * the rebuild indexes the record again ({@link reindexRecord}).
 */
interface PointerIndex {
  dataset: Dataset;
  holders: Map<string, Set<GedNode>>;
  /** Records taken out of the file since the index was built. */
  removed: WeakSet<GedNode>;
  /** Xrefs of the file's shared records (sources, media, notes, …), which no
   *  caller asks about — left out to keep the index small. */
  shared: Set<string>;
}

const active = new WeakMap<GedNode[], PointerIndex>();

function indexNode(index: PointerIndex, record: GedNode, node: GedNode): void {
  for (const child of node.children) {
    const v = child.value?.trim();
    if (v && isPointer(v) && !index.shared.has(v)) {
      let set = index.holders.get(v);
      if (!set) index.holders.set(v, (set = new Set()));
      set.add(record);
    }
    if (child.children.length) indexNode(index, record, child);
  }
}

/**
 * Run `run` with a pointer index over `dataset` in force: the record walks of
 * the family/association helpers (`familyMembers`, `familiesNaming`,
 * `repointAssociations`, `recordsNaming`, …) then ask only the indexed holders.
 * Nested calls reuse the outer index.
 */
export function withPointerIndex<T>(dataset: Dataset, run: () => T): T {
  if (active.has(dataset.records)) return run();
  const index: PointerIndex = { dataset, holders: new Map(), removed: new WeakSet(), shared: new Set() };
  for (const r of dataset.records) if (r.xref && r.tag !== "INDI" && r.tag !== "FAM") index.shared.add(r.xref);
  for (const r of dataset.records) if (r.tag === "INDI" || r.tag === "FAM") indexNode(index, r, r);
  active.set(dataset.records, index);
  try {
    return run();
  } finally {
    active.delete(dataset.records);
  }
}

/** Index `record` again after it changed — called by every typed rebuild. */
export function reindexRecord(records: GedNode[], record: GedNode): void {
  const index = active.get(records);
  if (index && (record.tag === "INDI" || record.tag === "FAM")) {
    index.removed.delete(record);
    indexNode(index, record, record);
  }
}

/** Tell the index `record` has left the file. */
export function unindexRecord(records: GedNode[], record: GedNode): void {
  active.get(records)?.removed.add(record);
}

/**
 * The people and families of `dataset` to search for lines naming any of
 * `ids`: with an index in force the records that may hold one (in no
 * particular order), otherwise the whole record list.
 */
export function pointerScope(dataset: Dataset, ids: Iterable<string>): Iterable<GedNode> {
  const index = active.get(dataset.records);
  if (!index) return dataset.records;
  const out = new Set<GedNode>();
  for (const id of ids) {
    for (const node of index.holders.get(id) ?? []) if (!index.removed.has(node)) out.add(node);
  }
  return out;
}

/** The typed people of `dataset` who may hold a line naming any of `ids` —
 *  every person, when no index is in force. */
export function individualsScope(dataset: Dataset, ids: Iterable<string>): Iterable<Individual> {
  if (!active.has(dataset.records)) return dataset.individuals.values();
  const out = new Map<string, Individual>();
  for (const node of pointerScope(dataset, ids)) {
    const indi = node.tag === "INDI" && node.xref ? dataset.individuals.get(node.xref) : undefined;
    if (indi) out.set(indi.id, indi);
  }
  return out.values();
}

/** The typed families of `dataset` that may hold a line naming any of `ids` —
 *  every family, when no index is in force. */
export function familiesScope(dataset: Dataset, ids: Iterable<string>): Iterable<Family> {
  if (!active.has(dataset.records)) return dataset.families.values();
  const out = new Map<string, Family>();
  for (const node of pointerScope(dataset, ids)) {
    const fam = node.tag === "FAM" && node.xref ? dataset.families.get(node.xref) : undefined;
    if (fam) out.set(fam.id, fam);
  }
  return out.values();
}

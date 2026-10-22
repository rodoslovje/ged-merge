import type { Dataset, Family, GedNode, Individual } from "../gedcom/types";
import { cloneNode } from "../gedcom/node";
import { bumpSourceCacheVersion, rebuildFamily, rebuildIndividual, rebuildNoteReferrers } from "../gedcom/edit";
import { clearObjeNodeCache } from "../gedcom/source";
import type { RecordSnapshots } from "../ui/historyTypes";

/**
 * What a whole-file pass tells {@link applyPassSafely} about the records it is
 * about to change, so a pass that throws halfway can be taken back.
 */
export interface PassJournal {
  /** Snapshot a record (by xref) before the pass first changes it. A second
   *  call for the same record keeps the first snapshot. */
  touch(xref: string): void;
  /** Hand over a snapshot the pass already took for its own undo patch (a
   *  `before` clone), so nothing is cloned twice. The first one given wins. */
  keep(xref: string, before: GedNode): void;
  /** Forget a record's snapshot again — the pass looked and changed nothing. */
  release(xref: string): void;
}

/**
 * Run a pass that rewrites the live dataset in place, and put the dataset back
 * exactly as it was if the pass throws partway — rather than leave records
 * half-rewritten with no undo entry for them.
 *
 * The cost on the way through is proportional to what the pass changes, not
 * to the file: the record list is copied by reference (which records, in what
 * order — this also covers records the pass creates or deletes), and a
 * record's contents are kept only once the pass reports it through the
 * journal — most passes hand over the `before` clone their undo patch takes
 * anyway. Only a failure pays for walking the file, to put the typed model
 * back in step.
 *
 * Rethrows the error once the dataset is restored.
 */
export function applyPassSafely<T>(dataset: Dataset, run: (journal: PassJournal) => T): T {
  const records = dataset.records.slice();
  const kept = new Map<string, GedNode>();
  let byXref: Map<string, GedNode> | undefined;
  const nodeOf = (xref: string): GedNode | undefined => {
    const typed = dataset.individuals.get(xref)?.raw ?? dataset.families.get(xref)?.raw;
    if (typed) return typed;
    byXref ??= new Map(records.filter((r) => r.xref).map((r) => [r.xref!, r]));
    return byXref.get(xref);
  };
  const journal: PassJournal = {
    touch(xref) {
      if (kept.has(xref)) return;
      const node = nodeOf(xref);
      if (node) kept.set(xref, cloneNode(node));
    },
    keep(xref, before) {
      if (!kept.has(xref)) kept.set(xref, before);
    },
    release(xref) {
      kept.delete(xref);
    },
  };
  try {
    return run(journal);
  } catch (err) {
    restore(dataset, records, kept);
    throw err;
  }
}

/** Hand a pass's own undo snapshot (see `snapshotRecords`) to the journal. */
export function keepSnapshots(journal: PassJournal | undefined, snapshots: RecordSnapshots): void {
  if (!journal) return;
  for (const [id, raw] of snapshots.individuals) journal.keep(id, raw);
  for (const [id, raw] of snapshots.families) journal.keep(id, raw);
}

/** Put the record list back, each kept record's contents into the node the
 *  file had (the one every typed `.raw` points at), and the typed model in step. */
function restore(dataset: Dataset, records: GedNode[], kept: Map<string, GedNode>): void {
  const byXref = new Map<string, GedNode>();
  for (const r of records) if (r.xref) byXref.set(r.xref, r);
  for (const [xref, before] of kept) {
    const node = byXref.get(xref);
    if (!node) continue; // created by the pass: dropped with the list below
    const copy = cloneNode(before);
    node.value = copy.value;
    node.children = copy.children;
  }
  // Pushed one by one: a spread of a large file's records overflows the stack.
  dataset.records.length = 0;
  for (const r of records) dataset.records.push(r);
  bumpSourceCacheVersion(dataset.records);
  clearObjeNodeCache(dataset.records);

  const live = new Set(records);
  for (const [id, indi] of dataset.individuals) if (!live.has(indi.raw)) dataset.individuals.delete(id);
  for (const [id, fam] of dataset.families) if (!live.has(fam.raw)) dataset.families.delete(id);
  for (const r of records) {
    if (!r.xref) continue;
    if (r.tag === "INDI" && (kept.has(r.xref) || !dataset.individuals.has(r.xref))) {
      rebuildIndividual(dataset, { raw: r } as Individual);
    } else if (r.tag === "FAM" && (kept.has(r.xref) || !dataset.families.has(r.xref))) {
      rebuildFamily(dataset, { raw: r } as Family);
    }
  }
  const notes = [...kept.keys()].filter((xref) => byXref.get(xref)?.tag === "NOTE").map((xref) => ({ xref }));
  rebuildNoteReferrers(dataset, notes);
}

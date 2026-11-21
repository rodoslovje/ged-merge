import type { Dataset, GedNode } from "./types";

/**
 * Content fingerprints of the records a file arrived with, so a save can check
 * its own change report against what it is about to write.
 *
 * The report is assembled from dirty tracking: every edit marks the records it
 * touched, and the report describes those. Anything that reaches the file
 * without going through that path — a cascade applied outside the tracked push,
 * a dirty flag cleared by an undo/redo cycle over a deletion — leaves the file
 * changed and the report silent, which is the one thing a change report may
 * never do. Keeping a whole second copy of the tree to diff against is not an
 * option at index scale, so each record is reduced to one number at load time
 * and re-reduced at save time: equal numbers mean the record is going out as it
 * came in, and a record whose number moved (or whose id is gone) must appear in
 * the report, whatever tracking thinks.
 *
 * A fingerprint answers "did this change?", never "what changed?" — a collision
 * would hide a change, so the walk covers tag, value and shape rather than a
 * cheap subset.
 */
export interface BaselineRecord {
  hash: number;
  kind: "individual" | "family" | "record";
  /** How the record read when the file arrived — the only name left to report
   *  by if the record is deleted before the save. */
  label?: string;
}

/** Baseline fingerprints keyed by xref, as captured at load or last save. */
export type SaveBaseline = Map<string, BaselineRecord>;

/** FNV-1a, 32-bit — mixes in each character of every tag and value. */
function mix(hash: number, text: string): number {
  let h = hash;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Separator mixed in around a node's children, so `1 A / 2 B` and `1 A / 1 B`
 *  (same tags and values, different nesting) can't hash alike. Written as an
 *  escape on purpose: a literal control character in source reads as nothing,
 *  and makes git take the whole file for a binary. */
const NEST = "\u0001";

function walk(node: GedNode, hash: number): number {
  let h = mix(mix(hash, node.tag), node.value ?? "");
  h = mix(h, NEST);
  for (const child of node.children) h = walk(child, h);
  return mix(h, NEST);
}

/**
 * A record's content fingerprint. Covers only what serializing writes — the
 * runtime-only annotations (`reshapedFrom`, edit markers) are deliberately
 * ignored, since a record carrying one still reaches the file unchanged.
 */
export function recordFingerprint(node: GedNode): number {
  return walk(node, 0x811c9dc5);
}

/**
 * Fingerprint every top-level record of a dataset — the baseline a later save
 * audits itself against.
 *
 * Individuals and families also keep their display label: a record deleted
 * between load and save is gone from the dataset by the time the report is
 * built, and its name is what the reader needs to see next to "removed".
 */
export function captureBaseline(
  dataset: Dataset,
  labelIndividual: (id: string) => string | undefined,
  labelFamily: (id: string) => string | undefined,
): SaveBaseline {
  const steps = baselineSteps(dataset, labelIndividual, labelFamily);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Records fingerprinted between two pauses of {@link baselineSteps}. */
const BASELINE_CHUNK = 256;

/**
 * {@link captureBaseline} as a pass that can be paused: it yields every few
 * hundred records and returns the baseline at the end. The whole pass is two
 * seconds on a file of half a million people — too long for one idle moment.
 *
 * The records must not change while a pass is paused: whoever is about to
 * change one runs the pass to its end first.
 */
export function* baselineSteps(
  dataset: Dataset,
  labelIndividual: (id: string) => string | undefined,
  labelFamily: (id: string) => string | undefined,
): Generator<void, SaveBaseline, void> {
  const baseline: SaveBaseline = new Map();
  let sinceYield = 0;
  for (const record of dataset.records) {
    if (++sinceYield > BASELINE_CHUNK) {
      sinceYield = 1;
      yield;
    }
    if (!record.xref) continue;
    const kind = record.tag === "INDI" ? "individual" : record.tag === "FAM" ? "family" : "record";
    const label =
      kind === "individual" ? labelIndividual(record.xref)
      : kind === "family" ? labelFamily(record.xref)
      : undefined;
    baseline.set(record.xref, { hash: recordFingerprint(record), kind, ...(label ? { label } : {}) });
  }
  return baseline;
}

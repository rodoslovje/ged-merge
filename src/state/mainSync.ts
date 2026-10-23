import { buildDataset } from "../gedcom/builder";
import { parseGedcomText } from "../gedcom/parser";
import { downloadOptions, serializeGedcom } from "../gedcom/serialize";
import type { Dataset, GedNode } from "../gedcom/types";

/**
 * Keeping a worker's copy of the main file in step with the live one without
 * sending the whole file after every edit.
 *
 * A structured clone of the typed dataset cost ~11 s on a 500k-person file
 * (~7 s for the bare record forest), and re-serializing it ~1.5 s — per edit
 * pause. Every edit, though, already names the records it touched (its
 * `RecordPatch`es), so a copy that was in step at some edit version needs only
 * those records, plus the record order to place them by.
 */

/** Where a copy of the main stands: in step with the live one at `version`,
 *  within one run of the journal (see {@link ChangeJournal.reset}). */
export interface SyncMark {
  epoch: number;
  version: number;
}

/** Which main records changed since an edit version — fed by every edit
 *  version bump, reset when a main load restarts the edit version. */
export class ChangeJournal {
  private entries: { version: number; ids: readonly string[] | null }[] = [];
  private epoch = 0;

  /** Forget everything: a main load set the edit version back to 0. Marks
   *  taken before cannot be answered any more — the versions restart, and a
   *  load that fails leaves the old file open to be edited from version 1. */
  reset(): void {
    this.entries = [];
    this.epoch++;
  }

  /** The edit version moved to `version` by changing the records `ids` —
   *  or, with `null`, by changing what no list names (a save's rebuild). */
  record(version: number, ids: Iterable<string> | null): void {
    this.entries.push({ version, ids: ids ? [...ids] : null });
  }

  /** A mark for a copy that is in step with the live main at `version`. */
  mark(version: number): SyncMark {
    return { epoch: this.epoch, version };
  }

  /** The records changed after `mark`; null when that cannot be told — no
   *  mark, one from before a reset, or a change no list names came after. */
  since(mark: SyncMark | undefined): Set<string> | null {
    if (!mark || mark.epoch !== this.epoch) return null;
    const out = new Set<string>();
    for (const e of this.entries) {
      if (e.version <= mark.version) continue;
      if (!e.ids) return null;
      for (const id of e.ids) out.add(id);
    }
    return out;
  }
}

/** What the typed dataset holds besides its records — the part a worker
 *  cannot rebuild from them. */
export interface MainMeta {
  version: Dataset["version"];
  charset: Dataset["charset"];
  eol: string;
  finalNewline: boolean;
  bom?: boolean;
  warnings: Dataset["warnings"];
  chanCreaUsage: Dataset["chanCreaUsage"];
}

/** The whole main, for a worker that holds no copy (or a copy it lost). */
export interface MainSnapshot {
  meta: MainMeta;
  /** The records serialized — a third of the cost of cloning them, and a
   *  string crosses the boundary as one copy. */
  text: string;
}

/** Changed records and the order to place them in. */
export interface RecordsPatch {
  meta: MainMeta;
  /** Every record's xref in file order; "" for a record without one. */
  order: string[];
  /** The changed records' xrefs (whether still present or not). */
  changed: string[];
  /** In file order: each record whose xref is in `changed`, and every record
   *  without an xref (the header and trailer — few, and never journaled). */
  nodes: GedNode[];
}

/** Below this many changed records a patch is always the cheaper send. */
const PATCH_FLOOR = 2000;

function metaOf(ds: Dataset): MainMeta {
  return {
    version: ds.version,
    charset: ds.charset,
    eol: ds.eol,
    finalNewline: ds.finalNewline,
    bom: ds.bom,
    warnings: ds.warnings,
    chanCreaUsage: ds.chanCreaUsage,
  };
}

export function mainSnapshot(ds: Dataset): MainSnapshot {
  // With the download's wrapping, so the file's own CONC breaks are written
  // back where they were and the copy saves to the same text.
  const text = serializeGedcom(ds.records, { ...downloadOptions(ds), eol: "\n", finalNewline: true, bom: false });
  return { meta: metaOf(ds), text };
}

/**
 * The patch that brings a copy taken before the records in `changed` changed
 * up to `ds`. Undefined when a snapshot is the better buy: more than a fifth
 * of the file changed (a whole-file tool pass), and cloning that many records
 * costs more than serializing them all.
 */
export function recordsPatch(ds: Dataset, changed: ReadonlySet<string>): RecordsPatch | undefined {
  if (changed.size > PATCH_FLOOR && changed.size > ds.records.length / 5) return undefined;
  const order: string[] = new Array(ds.records.length);
  const nodes: GedNode[] = [];
  ds.records.forEach((r, i) => {
    const xref = r.xref ?? "";
    order[i] = xref;
    if (!xref || changed.has(xref)) nodes.push(r);
  });
  return { meta: metaOf(ds), order, changed: [...changed], nodes };
}

function buildWithMeta(records: GedNode[], meta: MainMeta): Dataset {
  const ds = buildDataset({ ...meta, records, warnings: [...meta.warnings] });
  // Both as the main thread has them: the usage is detected once at load and
  // kept, and the warnings are the file's own — not this rebuild's.
  ds.chanCreaUsage = meta.chanCreaUsage;
  ds.warnings = meta.warnings;
  return ds;
}

/** A worker's copy of the main from a {@link MainSnapshot}. */
export function datasetFromSnapshot(snap: MainSnapshot): Dataset {
  const { records } = parseGedcomText({ text: snap.text, charset: snap.meta.charset, warnings: [] });
  return buildWithMeta(records, snap.meta);
}

/**
 * Apply a {@link RecordsPatch} to a worker's copy, rebuilding its typed model.
 * Undefined when the copy is not the one the patch was made against (a record
 * it should keep is missing) — the caller then asks for a snapshot.
 */
export function applyRecordsPatch(ds: Dataset, patch: RecordsPatch): Dataset | undefined {
  const changed = new Set(patch.changed);
  const kept = new Map<string, GedNode>();
  for (const r of ds.records) {
    if (r.xref && !changed.has(r.xref)) kept.set(r.xref, r);
  }
  const records: GedNode[] = [];
  let k = 0;
  for (const xref of patch.order) {
    const node = !xref || changed.has(xref) ? patch.nodes[k++] : kept.get(xref);
    if (!node || (node.xref ?? "") !== xref) return undefined;
    records.push(node);
  }
  if (k !== patch.nodes.length) return undefined;
  return buildWithMeta(records, patch.meta);
}

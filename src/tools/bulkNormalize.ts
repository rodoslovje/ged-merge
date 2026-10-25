import type { Dataset, GedNode } from "../gedcom/types";
import type { NormChange, NormalizationReport, NormalizeOptions } from "../normalize/types";
import { childValue, cloneNode, nodesEqual } from "../gedcom/node";
import { bumpSourceCacheVersion, rebuildNoteReferrers } from "../gedcom/edit";
import { clearObjeNodeCache } from "../gedcom/source";
import type { RecordPatch } from "../ui/historyTypes";
import { recordPatch } from "./fixConformance";
import { DATE_REPAIRS, normalizeRepairKinds, runNormalizeRepair } from "./normalizeRepairs";

/** Every pass, for the preview — which shows what each would change. */
const DEFAULT_PASSES: NormalizeOptions = { dates: true, places: true, links: true, names: true, vendorTags: true, stripInternal: true };
import { applyPassSafely, type PassJournal } from "./passSafety";
import { foreignAliasTags, isNativeTag, producerSoftware } from "../gedcom/vendorTags";
import { inferMainProfile, collectLayoutValues } from "../normalize/profile";
import { applyFormatOverrides, type FormatOverrides } from "../normalize/formatOverrides";
import { normalizeDataset, recordExample } from "../normalize/normalize";
import { detectSourceCoverage } from "../gedcom/source";
import { baptismTargetTag, normalizeSourceCoverage } from "./sourceReshape";
import { detectNoteShapes, reshapeNotes } from "./noteReshape";

/**
 * Enforce the main file's own "house style" across the whole file.
 *
 * The normalization machinery is normally used to reshape an *incoming* compare
 * file to the main's conventions. Here we point it at the main itself: infer
 * the dominant date/place/link conventions from the file, then re-render every
 * record to them so outliers (a stray `MM/DD/YYYY` date, a foreign-language
 * Matricula link) are brought in line. The returned dataset is a clone — the
 * live main is untouched until the caller chooses to save/apply.
 *
 * `options` selects which passes to run; by default all do — including the
 * opt-in internal-tag strip, so the preview report can show what it *would*
 * remove (the panel's checkbox then decides whether the download includes it;
 * load-time normalization never runs it).
 *
 * `overrides` are the reader's Settings → GEDCOM choices. They win over what
 * the file's own habit says, exactly as they do when an incoming compare file
 * is reshaped on load — otherwise "enforce the house style" would ignore the
 * house style the reader actually picked.
 */
export function bulkNormalize(
  ds: Dataset,
  options?: NormalizeOptions,
  overrides?: FormatOverrides,
): { dataset: Dataset; report: NormalizationReport } {
  const profile = applyFormatOverrides(inferMainProfile(ds), overrides);
  const { dateValues } = collectLayoutValues(ds);
  // Vendor-tag aliases canonicalize toward the spelling *this app* supports —
  // right for an incoming compare file, wrong on one's own, where the rename
  // trades one foreign dialect for another (`MISE` → `_MILT` on a MyHeritage
  // file is MacFamilyTree's spelling swapped for Brother's Keeper's) and the
  // fact is lost on re-import. Only a rename into the producer's own dialect
  // runs, identified from the HEAD>SOUR system id.
  const head = ds.records.find((r) => r.tag === "HEAD");
  const headSour = head && childValue(head, "SOUR");
  const preserveVendorTags = foreignAliasTags(headSour);
  const preserveFamilyStatus = !isNativeTag("_MSTAT", producerSoftware(headSour));
  const result = normalizeDataset(ds, profile, dateValues, {
    ...(options ?? DEFAULT_PASSES),
    preserveVendorTags,
    preserveFamilyStatus,
    // Never on one's own file — see `NormalizeOptions.tidyPlaceWhitespace`.
    tidyPlaceWhitespace: false,
  });
  // The health check's own repairs, so a normalized file leaves none of them
  // for the health check to offer. Before the note and coverage shapes, which
  // then restate a note or a source DATA a repair wrote as the house writes it.
  // The date repairs are the health check's own date fixes, run with the date
  // pass and counted with it, so every date Normalize changes is one row.
  const runDates = (options ?? DEFAULT_PASSES).dates;
  const seenDates = new Set<string>();
  const onDate = (before: string, after: string) => {
    result.report.datesChanged++;
    recordExample(result.report.dateExamples, seenDates, before, after);
  };
  const repairs: Record<string, number> = {};
  for (const kind of normalizeRepairKinds(ds, overrides)) {
    const isDate = DATE_REPAIRS.has(kind);
    if (isDate ? !runDates : options?.repairs === false) continue;
    const changed = runNormalizeRepair(result.dataset, kind, overrides, onDate).length;
    if (changed && !isDate) repairs[kind] = changed;
  }
  result.report.repairs = repairs;
  // Note shape: restate every note as the file writes notes — a shared record
  // the referrer points at, or inline. The two levels are asked separately:
  // a file's records and its events can hold opposite habits, and "Auto"
  // follows each of them rather than forcing one on both.
  if (options?.noteShape !== false) {
    const detected = detectNoteShapes(ds.records);
    const recordTarget = overrides?.notes ?? detected.record;
    const eventTarget = overrides?.eventNotes ?? detected.event;
    const passes = [
      { target: recordTarget, scope: { record: true, event: false } },
      { target: eventTarget, scope: { record: false, event: true } },
    ];
    let changed = 0;
    const examples: NormChange[] = [];
    for (const { target, scope } of passes) {
      const r = reshapeNotes(result.dataset.records, target, scope);
      changed += r.changed;
      for (const ex of r.examples) if (examples.length < 12) examples.push(ex);
    }
    result.report.notesReshaped = changed;
    result.report.noteShapeExamples = examples;
  }
  // Source coverage: restate each source's what-it-covers in the house shape —
  // the Settings choice, or the file's own majority. An outlier brought in by
  // a merge (a DATA > EVEN source in a flat file, or the reverse) comes in
  // line like a stray date format does.
  if (options?.sourceCoverage !== false) {
    const target = overrides?.sourceCoverage ?? detectSourceCoverage(ds.records);
    const baptismTag = overrides?.baptism ?? baptismTargetTag(ds.records);
    const coverage = normalizeSourceCoverage(result.dataset.records, target, baptismTag);
    result.report.coverageReshaped = coverage.changed;
    result.report.coverageExamples = coverage.examples;
  }
  return result;
}

/**
 * Normalize the live main file in place: the passes `options` selects run on
 * a copy, as {@link bulkNormalize} does, and every record that came out
 * different is written back into the node the file has, so the typed model
 * and every `.raw` stay the same objects. Records a pass created (a shared
 * note) are inserted where it put them; records it dropped (a note made
 * inline) are removed.
 *
 * Returns the undo patches, one per record — the caller pushes them as one
 * step, and the save preview then shows each change.
 */
export function applyBulkNormalize(ds: Dataset, options: NormalizeOptions, overrides?: FormatOverrides): RecordPatch[] {
  const { dataset: out } = bulkNormalize(ds, options, overrides);
  return applyPassSafely(ds, (journal) => adoptRecords(ds, out.records, journal));
}

function adoptRecords(ds: Dataset, next: GedNode[], journal: PassJournal): RecordPatch[] {
  const live = new Map<string, GedNode>();
  const liveIndex = new Map<string, number>();
  ds.records.forEach((r, i) => {
    if (!r.xref) return;
    live.set(r.xref, r);
    liveIndex.set(r.xref, i);
  });
  const nextXrefs = new Set<string>();
  for (const r of next) if (r.xref) nextXrefs.add(r.xref);

  const patches: RecordPatch[] = [];
  const changed: { node: GedNode; before: GedNode }[] = [];
  const notes: { xref: string }[] = [];
  // Records with no xref (HEAD, TRLR) are not the passes' to change: the live
  // ones keep their places, in their order.
  const headless = ds.records.filter((r) => !r.xref);
  const records: GedNode[] = [];
  for (const r of next) {
    if (!r.xref) {
      const kept = headless.shift();
      if (kept) records.push(kept);
      continue;
    }
    const node = live.get(r.xref);
    if (!node) {
      patches.push({ type: "record", id: r.xref, before: null, after: cloneNode(r), index: records.length });
      if (r.tag === "NOTE") notes.push({ xref: r.xref });
      records.push(r);
      continue;
    }
    records.push(node);
    if (nodesEqual(node, r)) continue;
    const before = cloneNode(node);
    journal.keep(r.xref, before);
    node.value = r.value;
    node.children = r.children;
    if (node.tag === "NOTE") notes.push({ xref: r.xref });
    changed.push({ node, before });
  }
  records.push(...headless);
  for (const [xref, node] of live) {
    if (nextXrefs.has(xref)) continue;
    journal.keep(xref, node);
    patches.push({ type: "record", id: xref, before: node, after: null, index: liveIndex.get(xref) });
    if (node.tag === "NOTE") notes.push({ xref });
  }
  if (!patches.length && !changed.length) return [];
  // Pushed one by one: a spread of a large file's records overflows the stack.
  ds.records.length = 0;
  for (const r of records) ds.records.push(r);
  bumpSourceCacheVersion(ds.records);
  clearObjeNodeCache(ds.records);
  // The typed model is rebuilt once the record list holds the new notes it
  // may point at.
  for (const { node, before } of changed) patches.push(recordPatch(ds, node.xref!, node, before));
  rebuildNoteReferrers(ds, notes);
  return patches;
}

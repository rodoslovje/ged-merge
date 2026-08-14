import { recordFingerprint, type SaveBaseline } from "../gedcom/fingerprint";
import type { GedNode } from "../gedcom/types";
import type { ChangeReport } from "../merge/merge";

/**
 * Hold the change report against the file the save is actually about to write.
 *
 * Everything the report says comes from change tracking: an edit marks the
 * records it touched and the report describes those. That leaves the report
 * only as honest as the tracking — and tracking can lose a record (a cascade
 * applied outside the tracked push, a flag cleared by undo/redo over a
 * deletion), after which the record still changes in the downloaded file and
 * the report says nothing about it. Silence there is the worst thing this
 * report can do: the reader takes it as "nothing else happened" and keeps the
 * download.
 *
 * So before the preview is shown, every outgoing record is fingerprinted and
 * compared with how it arrived (see `gedcom/fingerprint.ts`). Anything that
 * moved without a word in the report is added to it — as a record-level entry,
 * since with no before-copy to diff there is nothing truthful to say field by
 * field beyond "this changed". The preview and the text report then both count
 * and show it, and the summary lines up with the file.
 *
 * Mutates `report` in place: it is built fresh for this preview and belongs to
 * nobody else yet.
 */
export function auditAgainstBaseline(
  records: GedNode[],
  baseline: SaveBaseline,
  report: ChangeReport,
): void {
  if (baseline.size === 0) return; // no baseline captured (e.g. a tree started from nothing)

  const described = new Set(report.changes.map((c) => c.recordId));
  for (const d of report.deferred) described.add(d.recordId);

  /** Record-level entry for something the report doesn't yet account for.
   *  `undescribed` marks the ones with no field lines anywhere — a record whose
   *  removal is new news but whose fields were reported stays described. */
  const mark = (
    recordId: string,
    kind: "individual" | "family" | "record",
    flag: "newRecord" | "removedRecord" | undefined,
    label?: string,
  ) => {
    report.recordKinds[recordId] ??= kind;
    if (label && !report.recordLabels[recordId]) report.recordLabels[recordId] = label;
    report.changes.push({
      recordId,
      field: "",
      from: "",
      to: "",
      action: "incoming",
      ...(described.has(recordId) ? {} : { undescribed: true }),
      ...(flag === "newRecord" ? { newRecord: true } : {}),
      ...(flag === "removedRecord" ? { removedRecord: true } : {}),
    });
  };

  const written = new Set<string>();
  for (const record of records) {
    if (!record.xref) continue;
    written.add(record.xref);
    const was = baseline.get(record.xref);
    const kind = record.tag === "INDI" ? "individual" : record.tag === "FAM" ? "family" : "record";
    if (!was) {
      // A record the file never had. The merge already reports the ones it
      // brings in, so anything left here arrived some other way.
      if (described.has(record.xref)) continue;
      mark(record.xref, kind, "newRecord");
      if (kind === "individual") report.newPersons++;
      else if (kind === "family") report.newFamilies++;
      continue;
    }
    if (described.has(record.xref)) continue;
    if (recordFingerprint(record) !== was.hash) mark(record.xref, kind, undefined);
  }

  // Records the file arrived with that the save will not write. A deleted
  // record can still be *mentioned* in the report — the relatives it was
  // unlinked from put its name there — without anything saying it is gone, so
  // the removal is marked whether or not the id is already described.
  const alreadyMarkedGone = new Set(
    report.changes.filter((c) => c.removedRecord).map((c) => c.recordId),
  );
  for (const [xref, was] of baseline) {
    if (written.has(xref) || alreadyMarkedGone.has(xref)) continue;
    mark(xref, was.kind, "removedRecord", was.label);
  }

  report.recordsChanged = new Set(report.changes.map((c) => c.recordId)).size;
}

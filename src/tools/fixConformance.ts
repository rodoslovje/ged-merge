import type { Dataset, GedNode } from "../gedcom/types";
import { cloneNode, nodesEqual } from "../gedcom/node";
import { hangMediaLinesUnderFile, mimeFormOf } from "../gedcom/mediaForm";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { type RecordPatch } from "../ui/historyTypes";
import { fixableConformance, nodeAtPath, tableFor, type ConformanceIssue } from "./conformance/conformance";
import { applyPassSafely } from "./passSafety";

/**
 * The four repairs the conformance check can make without losing anything:
 *
 *  - **values** — an enumerated value written in another case than the
 *    standard's (`PEDI Adopted` → `adopted`, 7.0's `TYPE married` →
 *    `MARRIED`), and a 7.0 date still carrying a 5.5.1 calendar escape
 *    (`@#DJULIAN@ 1700` → `JULIAN 1700`);
 *  - **repeats** — a line the standard allows once, repeated as an exact copy
 *    (same value, same lines beneath): the copies go, the first stays;
 *  - **forms** — a media file with no `FORM`, where the file's name says what
 *    it is (`.jpg`, a web address): the line is added;
 *  - **relocate** — a media record's `TITL`/`FORM` kept beside its `FILE`
 *    (the 5.5 shape): moved under the `FILE` in every media record at once,
 *    as the finding is one row for the whole habit.
 *
 * A value outside the list, or a repeat that differs from the first, is the
 * user's question and is only reported. Lines on a record without an xref
 * (HEAD) are left alone, as an undo patch is keyed by xref.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack.
 */
export type ConformanceFixKind = "values" | "repeats" | "forms" | "relocate";

/** One finding's own fix: its record, and the path of the line inside it. */
export interface ConformanceRef {
  id: string;
  path?: string;
}

function kindOf(issue: ConformanceIssue): ConformanceFixKind {
  return issue.relocate ? "relocate" : issue.repeat ? "repeats" : issue.category === "missingLine" ? "forms" : "values";
}

/** How many findings of `kind` the fix would settle — the count on its button;
 *  for `relocate`, the media records it would change. */
export function countFixableConformance(dataset: Dataset, kind: ConformanceFixKind): number {
  const issues = fixableConformance(dataset.records).filter((i) => kindOf(i) === kind);
  if (kind !== "relocate" || !issues.length) return issues.length;
  return dataset.records.filter((r) => r.tag === "OBJE" && r.xref && hangMediaLinesUnderFile(cloneNode(r)).length > 0).length;
}

/** @param only — settle just the one finding a row names. */
export function fixConformance(dataset: Dataset, kind?: ConformanceFixKind, only?: ConformanceRef): RecordPatch[] {
  const issues = fixableConformance(dataset.records, only?.id).filter(
    (i) => (!kind || kindOf(i) === kind) && (!only || only.path === undefined || i.path === only.path),
  );
  const relocating = issues.some((i) => i.relocate);
  const byRecord = new Map<string, ConformanceIssue[]>();
  for (const issue of issues) {
    if (issue.relocate) continue;
    const list = byRecord.get(issue.recordId!);
    if (list) list.push(issue);
    else byRecord.set(issue.recordId!, [issue]);
  }
  if (!byRecord.size && !relocating) return [];

  const records = new Map<string, GedNode>();
  for (const r of dataset.records) if (r.xref && byRecord.has(r.xref)) records.set(r.xref, r);

  const patches: RecordPatch[] = [];
  applyPassSafely(dataset, (journal) => {
    for (const [xref, list] of byRecord) {
      const rec = records.get(xref);
      if (!rec) continue;
      const before = cloneNode(rec);
      journal.keep(xref, before);
      // Every line is found before any is removed, so the paths stay valid;
      // values first, so copies whose shared value was recased still match.
      const targets = list
        .map((issue) => ({ issue, node: nodeAtPath(rec, issue.path ?? "") }))
        .sort((a, b) => Number(!!a.issue.repeat) - Number(!!b.issue.repeat));
      for (const { issue, node } of targets) {
        if (!node) continue;
        if (issue.repeat) {
          const tag = issue.sample!;
          const first = node.children.find((c) => c.tag === tag);
          node.children = node.children.filter((c) => c === first || c.tag !== tag || !nodesEqual(c, first!));
        } else if (issue.category === "missingLine" && issue.fix !== undefined) {
          node.children.unshift({ level: node.level + 1, tag: issue.sample!, value: issue.fix, children: [] });
        } else if (issue.fix !== undefined) {
          node.value = issue.fix;
        }
      }
      const indi = dataset.individuals.get(xref);
      const fam = dataset.families.get(xref);
      if (indi && indi.raw === rec) {
        rebuildIndividual(dataset, indi);
        patches.push({ type: "individual", id: xref, before, after: cloneNode(rec) });
      } else if (fam && fam.raw === rec) {
        rebuildFamily(dataset, fam);
        patches.push({ type: "family", id: xref, before, after: cloneNode(rec) });
      } else {
        patches.push({ type: "record", id: xref, before, after: cloneNode(rec) });
      }
    }
    if (relocating) {
      // 7.0 writes a FORM as a media type, so a moved `jpg` arrives as one.
      const form = tableFor(dataset.records)?.version.startsWith("7") ? mimeFormOf : undefined;
      for (const rec of dataset.records) {
        if (rec.tag !== "OBJE" || !rec.xref) continue;
        const before = cloneNode(rec);
        if (!hangMediaLinesUnderFile(cloneNode(rec), form).length) continue;
        journal.keep(rec.xref, before);
        hangMediaLinesUnderFile(rec, form);
        patches.push({ type: "record", id: rec.xref, before, after: cloneNode(rec) });
      }
    }
  });
  return patches;
}

import type { Dataset, GedNode } from "../gedcom/types";
import { cloneNode, nodesEqual } from "../gedcom/node";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { type RecordPatch } from "../ui/historyTypes";
import { fixableConformance, nodeAtPath, type ConformanceIssue } from "./conformance/conformance";
import { applyPassSafely } from "./passSafety";

/**
 * The two repairs the conformance check can make without losing anything:
 *
 *  - **values** — an enumerated value written in another case than the
 *    standard's (`PEDI Adopted` → `adopted`, 7.0's `TYPE married` →
 *    `MARRIED`), a 7.0 name type outside the enumeration (`variation` →
 *    `AKA`, `formal` → `OTHER` with the word as its `PHRASE`), and a 7.0 date still carrying a 5.5.1 calendar escape
 *    (`@#DJULIAN@ 1700` → `JULIAN 1700`);
 *  - **repeats** — a line the standard allows once, repeated as an exact copy
 *    (same value, same lines beneath): the copies go, the first stays.
 *
 * A value outside the list, or a repeat that differs from the first, is the
 * user's question and is only reported. Lines on a record without an xref
 * (HEAD) are left alone, as an undo patch is keyed by xref.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack.
 */
export type ConformanceFixKind = "values" | "repeats";

/** One finding's own fix: its record, and the path of the line inside it. */
export interface ConformanceRef {
  id: string;
  path?: string;
}

function kindOf(issue: ConformanceIssue): ConformanceFixKind {
  return issue.repeat ? "repeats" : "values";
}

/** How many findings of `kind` the fix would settle — the count on its button. */
export function countFixableConformance(dataset: Dataset, kind: ConformanceFixKind): number {
  return fixableConformance(dataset.records).filter((i) => kindOf(i) === kind).length;
}

/** @param only — settle just the one finding a row names. */
export function fixConformance(dataset: Dataset, kind?: ConformanceFixKind, only?: ConformanceRef): RecordPatch[] {
  const issues = fixableConformance(dataset.records, only?.id).filter(
    (i) => (!kind || kindOf(i) === kind) && (!only || only.path === undefined || i.path === only.path),
  );
  const byRecord = new Map<string, ConformanceIssue[]>();
  for (const issue of issues) {
    const list = byRecord.get(issue.recordId!);
    if (list) list.push(issue);
    else byRecord.set(issue.recordId!, [issue]);
  }
  if (!byRecord.size) return [];

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
        } else if (issue.fix !== undefined) {
          node.value = issue.fix;
          if (issue.fixPhrase && !node.children.some((c) => c.tag === "PHRASE")) {
            node.children.unshift({ level: node.level + 1, tag: "PHRASE", value: issue.fixPhrase, children: [] });
          }
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
  });
  return patches;
}

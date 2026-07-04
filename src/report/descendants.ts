// The descendant register report: the root person's descendants in register
// (NGSQ-style) numbering — sequential numbers in order of appearance, grouped
// by generation, each generation's children grouped under their parent's
// entry ("Children of no. X"). Spouses are named on the ⚭ fact lines, not
// numbered. Pure dataset → entries logic (shapes and fact helpers in
// report/model.ts).

import type { Dataset, Individual } from "../gedcom/types";
import { birthSortKey } from "../gedcom/lifespan";
import {
  extraFacts,
  factFor,
  familiesOf,
  makeEntry,
  marriageFact,
  type FactLine,
  type NameOf,
  type ReportData,
  type ReportEntry,
  type ReportFactOptions,
  type ReportGeneration,
} from "./model";

/**
 * Build the numbered descendant list for a root person. A descendant reached
 * twice (a child of two people who are both in the tree — cousin marriage)
 * keeps their first number, becomes a `dupOf` reference under the second
 * parent, and is not expanded again — which also guards against cycles.
 */
export function buildDescendants(
  ds: Dataset,
  rootId: string,
  nameOf: NameOf,
  nowYear: number = new Date().getFullYear(),
  opts: ReportFactOptions = {},
): ReportData | undefined {
  const root = ds.individuals.get(rootId);
  if (!root) return undefined;

  const firstNum = new Map<string, number>();
  const generations: ReportGeneration[] = [];
  let counter = 0;
  let total = 0;
  let queue: { indi: Individual; parentNum?: number; parentName?: string }[] = [{ indi: root }];

  for (let gen = 0; queue.length > 0; gen++) {
    const entries: ReportEntry[] = [];
    const next: typeof queue = [];

    for (const { indi, parentNum, parentName } of queue) {
      const dupOf = firstNum.get(indi.id);
      // A repeat appearance keeps the person's original register number.
      const num = dupOf ?? ++counter;
      const entry = makeEntry(indi, num, nameOf, vitals(ds, indi, nameOf, opts), nowYear, dupOf);
      entry.parentNum = parentNum;
      entry.parentName = parentName;
      entries.push(entry);
      total++;
      if (dupOf !== undefined) continue; // their children are listed there
      firstNum.set(indi.id, num);

      // Each union's children in birth order; union order follows the record.
      for (const fam of familiesOf(ds, indi.spouseOf)) {
        const kids = fam.children
          .map((id) => ds.individuals.get(id))
          .filter((c): c is Individual => c !== undefined)
          .sort((a, b) => birthSortKey(a) - birthSortKey(b));
        for (const kid of kids) {
          next.push({ indi: kid, parentNum: num, parentName: entry.name });
        }
      }
    }

    generations.push({ gen, entries });
    queue = next;
  }

  return { generations, total };
}

/** Facts in report order: * ~, every union's ⚭, the optional ⚒/⌂ lines, † ▭. */
function vitals(ds: Dataset, indi: Individual, nameOf: NameOf, opts: ReportFactOptions): FactLine[] {
  const marriages = familiesOf(ds, indi.spouseOf)
    .map((fam) => {
      const partnerId = fam.husband === indi.id ? fam.wife : fam.husband;
      const partner = partnerId ? ds.individuals.get(partnerId) : undefined;
      return marriageFact(fam, partner && nameOf(partner));
    })
    .filter((f): f is FactLine => f !== undefined);
  return [
    factFor(indi, ["BIRT"]),
    factFor(indi, ["BAPM", "CHR"]),
    ...marriages,
    ...extraFacts(indi, opts),
    factFor(indi, ["DEAT"]),
    factFor(indi, ["BURI", "CREM"]),
  ].filter((f): f is FactLine => f !== undefined);
}

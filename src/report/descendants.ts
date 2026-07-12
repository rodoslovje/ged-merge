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
  marriageFacts,
  personExtras,
  personRef,
  type FactLine,
  type NameOf,
  type PersonRef,
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
  interface QueueItem {
    indi: Individual;
    parentNum?: number;
    parent?: PersonRef;
    parentSpouse?: PersonRef;
    parentFam?: string;
    childIndex?: number;
  }
  let queue: QueueItem[] = [{ indi: root }];

  for (let gen = 0; queue.length > 0; gen++) {
    const entries: ReportEntry[] = [];
    const next: QueueItem[] = [];

    for (const { indi, ...family } of queue) {
      const dupOf = firstNum.get(indi.id);
      // A repeat appearance keeps the person's original register number.
      const num = dupOf ?? ++counter;
      const entry = makeEntry(indi, num, nameOf, vitals(ds, indi, nameOf, opts, nowYear), nowYear, dupOf, ds);
      Object.assign(entry, family);
      if (dupOf === undefined) personExtras(entry, indi, opts);
      entries.push(entry);
      total++;
      if (dupOf !== undefined) continue; // their children are listed there
      firstNum.set(indi.id, num);

      // Each union's children in birth order; union order follows the record.
      // Children are grouped per union, so each carries the union's family id,
      // the other parent's name, and its roman child index.
      for (const fam of familiesOf(ds, indi.spouseOf)) {
        const partnerId = fam.husband === indi.id ? fam.wife : fam.husband;
        const partner = partnerId ? ds.individuals.get(partnerId) : undefined;
        const kids = fam.children
          .map((id) => ds.individuals.get(id))
          .filter((c): c is Individual => c !== undefined)
          .sort((a, b) => birthSortKey(a) - birthSortKey(b));
        kids.forEach((kid, i) => {
          next.push({
            indi: kid,
            parentNum: num,
            parent: personRef(indi, nameOf, nowYear, ds),
            parentSpouse: partner && personRef(partner, nameOf, nowYear, ds),
            parentFam: fam.id,
            childIndex: i + 1,
          });
        });
      }
    }

    generations.push({ gen, entries });
    queue = next;
  }

  return { generations, total };
}

/** Facts in report order: * ~, every union's ⚭, the optional ⚒/⌂ lines, † ▭. */
function vitals(ds: Dataset, indi: Individual, nameOf: NameOf, opts: ReportFactOptions, nowYear: number): FactLine[] {
  return [
    factFor(indi, ["BIRT"], opts, ds),
    factFor(indi, ["BAPM", "CHR"], opts),
    ...marriageFacts(ds, indi, nameOf, opts, nowYear),
    ...extraFacts(indi, opts),
    factFor(indi, ["DEAT"], opts),
    factFor(indi, ["BURI", "CREM"], opts),
  ].filter((f): f is FactLine => f !== undefined);
}

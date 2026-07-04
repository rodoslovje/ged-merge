// The Ahnentafel report: the root person's ancestors as the classic numbered
// list (root = 1, a person's father = 2n, mother = 2n + 1), grouped by
// generation. Pure dataset → entries logic (shapes and fact helpers in
// report/model.ts), so it's unit-testable; the component (ui/ReportView.tsx)
// and the text serializer (report/text.ts) only render what's built here.

import type { Dataset, Family, Individual } from "../gedcom/types";
import {
  extraFacts,
  factFor,
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
 * Build the numbered ancestor list for a root person. Missing parents simply
 * leave number gaps; an ancestor reached twice (pedigree collapse) becomes a
 * `dupOf` reference to their first number and is not expanded again — which
 * also guards against cyclic parent links.
 */
export function buildAhnentafel(
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
  let total = 0;
  let queue: { num: number; indi: Individual; marriage?: FactLine }[] = [{ num: 1, indi: root }];

  for (let gen = 0; queue.length > 0; gen++) {
    const entries: ReportEntry[] = [];
    const next: typeof queue = [];

    for (const { num, indi, marriage } of queue) {
      const dupOf = firstNum.get(indi.id);
      entries.push(makeEntry(indi, num, nameOf, vitals(indi, marriage, opts), nowYear, dupOf));
      total++;
      if (dupOf !== undefined) continue; // the line already continues there
      firstNum.set(indi.id, num);

      // Parents, each from the first child-family that records that role (the
      // same per-role scan the Timeline uses for multi-FAMC records).
      const families = indi.childOf
        .map((id) => ds.families.get(id))
        .filter((f): f is Family => f !== undefined);
      const famF = families.find((f) => f.husband && ds.individuals.has(f.husband));
      const famM = families.find((f) => f.wife && ds.individuals.has(f.wife));
      const father = famF ? ds.individuals.get(famF.husband!) : undefined;
      const mother = famM ? ds.individuals.get(famM.wife!) : undefined;

      // The parents' ⚭ line goes on the father's entry by convention (his
      // family's record), naming that family's wife; with no father it moves
      // to the mother's entry so the date/place isn't lost.
      if (father) {
        const wife = famF!.wife ? ds.individuals.get(famF!.wife) : undefined;
        next.push({ num: 2 * num, indi: father, marriage: marriageFact(famF!, wife && nameOf(wife)) });
      }
      if (mother) {
        next.push({
          num: 2 * num + 1,
          indi: mother,
          marriage: father ? undefined : marriageFact(famM!, undefined),
        });
      }
    }

    generations.push({ gen, entries });
    queue = next;
  }

  return { generations, total };
}

/** Facts in report order: * ~ ⚭, the optional ⚒/⌂ lines, then † ▭. */
function vitals(indi: Individual, marriage: FactLine | undefined, opts: ReportFactOptions): FactLine[] {
  return [
    factFor(indi, ["BIRT"]),
    factFor(indi, ["BAPM", "CHR"]),
    marriage,
    ...extraFacts(indi, opts),
    factFor(indi, ["DEAT"]),
    factFor(indi, ["BURI", "CREM"]),
  ].filter((f): f is FactLine => f !== undefined);
}

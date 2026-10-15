import type { Dataset } from "../gedcom/types";
import type { MatchResult } from "../match/types";
import { pinnedAdds, type CandidateDecision } from "../review/types";
import type { ImportBranchRequest } from "./applyRelations";
import { decisionPairs } from "./merge";

/**
 * The records the marked branch imports would add on save — the new people
 * and the new families that hold them — as xref-free keys, so the Save badge
 * can count a whole ancestral line by its size rather than as one action.
 *
 * Walks the incoming tree the way `applyImportBranches` does (ancestors: the
 * birth family's parents; descendants: each union's spouse and children) and
 * calls a person new unless the merge would join them to a main record: a
 * matcher candidate the user has not rejected, a confirmed pair, or someone a
 * confirmed decision already added. It does not replay the merge's identity
 * vetoes or the stops at a disagreeing parent, so it is an estimate — the
 * save preview remains the exact account.
 */
export function branchImportRecords(
  requests: Iterable<ImportBranchRequest>,
  main: Dataset,
  compare: Dataset,
  decisions: ReadonlyMap<string, CandidateDecision>,
  matches: MatchResult | null | undefined,
): Set<string> {
  const { rejectedPairs, confirmedPairs } = decisionPairs(decisions);
  const incToMain = new Map<string, string>();
  for (const c of matches?.individuals ?? []) {
    if (rejectedPairs.has(`${c.mainId}|${c.compareId}`)) continue;
    if (main.individuals.has(c.mainId)) incToMain.set(c.compareId, c.mainId);
  }
  for (const pair of confirmedPairs) {
    const [mainId, compareId] = pair.split("|");
    if (main.individuals.has(mainId)) incToMain.set(compareId, mainId);
  }
  for (const [incomingId, mainId] of pinnedAdds(decisions)) {
    if (main.individuals.has(mainId)) incToMain.set(incomingId, mainId);
    else incToMain.delete(incomingId);
  }

  const out = new Set<string>();
  const person = (incId: string): string | undefined => {
    const mainId = incToMain.get(incId);
    if (!mainId) out.add(`I:${incId}`);
    return mainId;
  };
  const visited = new Set<string>();

  const ancestors = (incId: string): void => {
    if (visited.has(`a:${incId}`)) return;
    visited.add(`a:${incId}`);
    const famId = compare.individuals.get(incId)?.childOf[0];
    const fam = famId ? compare.families.get(famId) : undefined;
    if (!fam || (!fam.husband && !fam.wife)) return;
    // The birth family is new unless the person is already in the main file
    // with parents there.
    const mainId = person(incId);
    const mainFamId = mainId ? main.individuals.get(mainId)?.childOf[0] : undefined;
    const mainFam = mainFamId ? main.families.get(mainFamId) : undefined;
    if (!mainFam) out.add(`F:${famId}`);
    for (const [parent, occupant] of [[fam.husband, mainFam?.husband], [fam.wife, mainFam?.wife]]) {
      // A parent slot the main file fills with someone else stops the walk,
      // as the merge does.
      if (!parent || (occupant && incToMain.get(parent) !== occupant)) continue;
      person(parent);
      ancestors(parent);
    }
  };

  const descendants = (incId: string): void => {
    if (visited.has(`d:${incId}`)) return;
    visited.add(`d:${incId}`);
    const indi = compare.individuals.get(incId);
    if (!indi) return;
    const mainId = person(incId);
    for (const famId of indi.spouseOf) {
      const fam = compare.families.get(famId);
      if (!fam) continue;
      const spouse = fam.husband === incId ? fam.wife : fam.husband;
      const spouseMainId = spouse ? person(spouse) : undefined;
      // A union both of whose partners the main file already holds together
      // is reused; any other is written as a new family.
      const shared = !!mainId && (!spouse || !!spouseMainId) && main.individuals.get(mainId)?.spouseOf.some((f) => {
        const m = main.families.get(f);
        return !!m && (spouseMainId ? m.husband === spouseMainId || m.wife === spouseMainId : !(m.husband && m.wife));
      });
      if (!shared) out.add(`F:${famId}`);
      for (const child of fam.children) descendants(child);
    }
  };

  for (const req of requests) {
    if (req.direction === "ancestors") ancestors(req.incomingId);
    else descendants(req.incomingId);
  }
  return out;
}

import type { Dataset } from "../gedcom/types";
import type { MatchCandidate } from "../match/types";
import { parseDecisionKey, pinnedAdds, type CandidateDecision } from "../review/types";

/**
 * The match list as the app shows it after matching ran again over files you
 * have been working on.
 *
 * - **A pair you decided stays listed.** The new scores may drop it below the
 *   matcher's cut, but your confirmation, rejection or deferral is still
 *   yours: it keeps its earlier row (and score), so the decision can still be
 *   seen and changed — and a confirmed one still merges.
 * - **A person a decision already added is not matched with themselves.** The
 *   record a confirmed match added ahead of the save is a copy of its incoming
 *   person, and scores as a perfect pair with them; that pair says nothing.
 *
 * `carried` is the list the re-match replaced; pairs whose people no longer
 * exist on either side are not brought back.
 */
export function rematchedCandidates(
  fresh: readonly MatchCandidate[],
  carried: readonly MatchCandidate[],
  decisions: ReadonlyMap<string, CandidateDecision>,
  main: Dataset,
  compare: Dataset,
): MatchCandidate[] {
  const pinned = pinnedAdds(decisions);
  const pairKey = (c: { mainId: string; compareId: string }) => `${c.mainId}|${c.compareId}`;
  const out = fresh.filter((c) => pinned.get(c.compareId) !== c.mainId);
  const listed = new Set(out.map(pairKey));
  const decided = new Set<string>();
  for (const [key, d] of decisions) {
    if (d.status === "undecided") continue;
    const parsed = parseDecisionKey(key);
    if (parsed?.kind === "individual") decided.add(pairKey(parsed));
  }
  for (const c of carried) {
    const key = pairKey(c);
    if (!decided.has(key) || listed.has(key)) continue;
    if (!main.individuals.has(c.mainId) || !compare.individuals.has(c.compareId)) continue;
    if (pinned.get(c.compareId) === c.mainId) continue;
    listed.add(key);
    out.push(c);
  }
  return out;
}

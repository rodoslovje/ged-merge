import { buildMatchMaps, importableMemo } from "../chart/personTree";
import type { Dataset, Individual } from "../gedcom/types";
import type { MatchCandidate } from "../match/types";
import type { FormatOverrides } from "../normalize/formatOverrides";
import { mergePlaceFormat } from "../merge/merge";
import { confirmedPeople, decisionKey, parseDecisionKey, type CandidateDecision } from "../review/types";
import { fieldCounts, importCount, type CandidateCounts, type CountContext } from "../worker/annotateCounts";

const pairKey = (c: { mainId: string; compareId: string }) => `${c.mainId}|${c.compareId}`;

/** The main people whose decision changed status between two decision maps —
 *  confirmed, rejected, deferred, or taken back. */
export function redecidedPeople(
  before: ReadonlyMap<string, CandidateDecision>,
  after: ReadonlyMap<string, CandidateDecision>,
): Set<string> {
  const out = new Set<string>();
  if (before === after) return out;
  const add = (key: string) => {
    const parsed = parseDecisionKey(key);
    if (parsed?.kind === "individual") out.add(parsed.mainId);
  };
  for (const [key, d] of after) if ((before.get(key)?.status ?? "undecided") !== d.status) add(key);
  for (const [key, d] of before) if (!after.has(key) && d.status !== "undecided") add(key);
  return out;
}

/** Everyone reachable from `start` by `step`, `start` included. */
function reach(start: Iterable<string>, main: Dataset, step: (p: Individual) => Iterable<string | undefined>): Set<string> {
  const seen = new Set(start);
  const queue = [...seen];
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    const person = main.individuals.get(id);
    if (!person) continue;
    for (const next of step(person)) {
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * The match list's counts as they stand now, for the candidates whose counts a
 * change can have moved — the worker counted the list once, against the main
 * file as it was then and knowing no decision, while the review rows and the
 * compare tree read the live file: a confirmed match adds its relatives ahead
 * of the save, and the list would go on offering them as new.
 *
 * `seeds` names what changed: main records (people, families) and the people
 * whose decision changed status. Counted again are
 * - the field counts of those people and of everyone sharing a family with
 *   them — a row names the relatives;
 * - the ancestors a match brings in, for their descendants;
 * - the descendants it brings in, for their ancestors.
 *
 * Returns the counts that differ from the listed ones, by `main|compare`.
 */
export function recountCandidates(
  list: MatchCandidate[],
  seeds: Iterable<string>,
  main: Dataset,
  compare: Dataset,
  decisions: ReadonlyMap<string, CandidateDecision>,
  overrides: FormatOverrides | undefined,
): Map<string, CandidateCounts> {
  const out = new Map<string, CandidateCounts>();
  const near = new Set<string>();
  const family = (famId: string) => {
    const fam = main.families.get(famId);
    if (!fam) return;
    if (fam.husband) near.add(fam.husband);
    if (fam.wife) near.add(fam.wife);
    for (const child of fam.children) near.add(child);
  };
  for (const id of seeds) {
    family(id);
    const person = main.individuals.get(id);
    if (!person) continue;
    near.add(id);
    person.childOf.forEach(family);
    person.spouseOf.forEach(family);
  }
  if (!near.size) return out;
  const parents = function* (p: Individual) {
    for (const famId of p.childOf) {
      const fam = main.families.get(famId);
      yield fam?.husband;
      yield fam?.wife;
    }
  };
  const children = function* (p: Individual) {
    for (const famId of p.spouseOf) yield* main.families.get(famId)?.children ?? [];
  };
  const above = reach(near, main, parents);
  const below = reach(near, main, children);

  // Built for the first candidate the change reaches: an edit to a person no
  // match lists (most of a large file) costs one pass over the list, no more.
  let ctx: CountContext | undefined;
  for (const c of list) {
    const fields = near.has(c.mainId);
    const up = below.has(c.mainId);
    const down = above.has(c.mainId);
    if (!fields && !up && !down) continue;
    ctx ??= {
      main,
      compare,
      maps: buildMatchMaps({ individuals: list }),
      placeFmt: mergePlaceFormat(main, overrides),
      memo: importableMemo(),
      confirmed: confirmedPeople(decisions),
      isRejected: (mainId, compareId) => decisions.get(decisionKey("individual", mainId, compareId))?.status === "rejected",
    };
    const counts: CandidateCounts = {
      newCount: c.newCount ?? 0,
      diffCount: c.diffCount ?? 0,
      linkCount: c.linkCount ?? 0,
      ancestorCount: c.ancestorCount ?? 0,
      descendantCount: c.descendantCount ?? 0,
      ...(fields ? fieldCounts(c, ctx) : null),
      ...(up ? { ancestorCount: importCount(c, ctx, "ancestors") } : null),
      ...(down ? { descendantCount: importCount(c, ctx, "descendants") } : null),
    };
    const moved = (Object.keys(counts) as (keyof CandidateCounts)[]).some((k) => counts[k] !== (c[k] ?? 0));
    if (moved) out.set(pairKey(c), counts);
  }
  return out;
}

/** `list` with the recounted candidates replaced — the same array when none
 *  of them is listed, and the same object for every candidate left as it was. */
export function withCounts<C extends MatchCandidate>(list: readonly C[], counts: ReadonlyMap<string, CandidateCounts>): C[] {
  if (!counts.size) return list as C[];
  let changed = false;
  const out = list.map((c) => {
    const next = counts.get(pairKey(c));
    if (!next) return c;
    changed = true;
    return { ...c, ...next };
  });
  return changed ? out : (list as C[]);
}

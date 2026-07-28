import type { Individual } from "../gedcom/types";
import { lifespanOf, birthSortKey } from "../gedcom/lifespan";
import { nameSearchText } from "../match/relatives";
import { foldSearch } from "./globalSearch";

/**
 * Find-in-chart: locate a person *already drawn* on the current diagram and move
 * the view to them, as opposed to the global search (`/`), which opens a person
 * and thereby re-roots the whole chart. Big pedigrees run far off screen, so
 * "where is X in this diagram" needs its own answer.
 *
 * A person can occupy several places on one chart — pedigree collapse draws a
 * shared ancestor once per line of descent, and namesakes match the same query —
 * so a query yields a *list* of positions the user cycles through, in layout
 * order.
 */

/** One findable position on the chart: a laid-out node and its search text. */
export interface FindEntry {
  /** Layout node key — what the canvas centres on. */
  key: string;
  /** The person's record id, so off-chart matches can be told apart. */
  id: string;
  /** Folded haystack: every name form of everyone in the node, plus lifespans. */
  text: string;
}

/** A chart node handed to the index: its key plus whoever it draws. Compare-side
 *  nodes carry two people (main + incoming), so both are searchable. */
export interface FindSource {
  key: string;
  people: (Individual | undefined)[];
}

/** Folded name + lifespan text for one person, matching the global search's
 *  haystack so the two searches find a person on the same spellings. */
function personText(indi: Individual): string {
  const span = lifespanOf(indi);
  return foldSearch(span ? `${nameSearchText(indi)} ${span}` : nameSearchText(indi));
}

/**
 * Build the find index from the chart's nodes, keeping the caller's order — the
 * layout order — so cycling walks the diagram predictably instead of jumping
 * about. Nodes drawing nobody (spacers, unresolved links) are skipped.
 */
export function buildFindEntries(sources: Iterable<FindSource>): FindEntry[] {
  const entries: FindEntry[] = [];
  for (const src of sources) {
    const people = src.people.filter((p): p is Individual => !!p);
    if (!people.length) continue;
    entries.push({
      key: src.key,
      id: people[0].id,
      text: people.map(personText).join(" "),
    });
  }
  return entries;
}

/** Split a query into folded terms; empty when the query is blank. */
function queryTerms(query: string): string[] {
  return foldSearch(query.trim()).split(/\s+/).filter(Boolean);
}

/**
 * Every position on the chart matching the query — all terms must appear, in any
 * order, so "kov marija" finds "Marija Kovačič". An empty query matches nothing:
 * find is a jump-to, not a browse.
 */
export function findHits(entries: FindEntry[], query: string): FindEntry[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  return entries.filter((e) => terms.every((term) => e.text.includes(term)));
}

/**
 * The best person in the whole file matching the query who is *not* on the chart
 * — what turns "no match" into "not here, but here they are". Ordered like the
 * global search results (oldest namesake first) so the offer is the same person
 * that search would have put on top. Returns undefined when the query matches
 * nobody in the file, or only people already drawn.
 */
export function findOffChart(
  individuals: Map<string, Individual>,
  query: string,
  onChart: Set<string>,
): Individual | undefined {
  const terms = queryTerms(query);
  if (!terms.length) return undefined;
  let best: Individual | undefined;
  let bestKey = Infinity;
  for (const indi of individuals.values()) {
    if (onChart.has(indi.id)) continue;
    const text = personText(indi);
    if (!terms.every((term) => text.includes(term))) continue;
    const key = birthSortKey(indi);
    if (!best || key < bestKey) {
      best = indi;
      bestKey = key;
    }
  }
  return best;
}

import type { PersonFacts } from "./facts";
import type { ScopedFacts } from "./scope";
import { birthYearOf, byLabel } from "./aggregate";

/**
 * The Places page: where the people were born, against where their parents
 * were born, and which places the births of each decade come from.
 */

/** What a flow's places are read at: the place as written, or its country. */
export type FlowLevel = "place" | "country";

/** The places each side of the flow names on its own; the rest are "other places". */
export const FLOW_TOP = 8;
/** The places the decade grid gives a row each. */
export const DECADE_TOP = 13;

/** The key of the side's "other places" node. */
export const OTHER = "\u0000other";

export interface FlowNode {
  /** The folded place, the country facet, or {@link OTHER}. */
  key: string;
  /** The place as most often written; for a country, its facet code. */
  label: string;
  /** Parent-and-child pairs through the node. */
  count: number;
}

export interface Flow {
  from: string;
  to: string;
  /** Parent-and-child pairs: a child whose parents were born in one place counts twice. */
  count: number;
  /** The children, each once. */
  ids: string[];
}

export interface PlaceFlowStats {
  /** Parents' birth places, then the children's, most pairs first, {@link OTHER} last. */
  parents: FlowNode[];
  children: FlowNode[];
  flows: Flow[];
  /** Parent-and-child pairs with both birth places known. */
  pairs: number;
  /** Of those, the pairs whose two places differ (at the flow's level). */
  moved: number;
  /** The children of those pairs, each once. */
  movedIds: string[];
}

/** A person's birth place at a level, with its label; undefined for none. */
function placeAt(p: PersonFacts | undefined, level: FlowLevel): { key: string; label: string } | undefined {
  if (!p?.birthPlace) return undefined;
  return level === "place" ? { key: p.birthPlaceKey, label: p.birthPlace } : { key: p.birthCountry, label: p.birthCountry };
}

/** The spelling written most often, of a key's spellings. */
export function commonest(spellings: Map<string, number>): string {
  let label = "";
  let best = -1;
  for (const [s, c] of spellings) if (c > best) { best = c; label = s; }
  return label;
}

/** Each in-scope child with a birth place, paired with each parent who has one. */
export function placeFlows(s: ScopedFacts, level: FlowLevel, top = FLOW_TOP): PlaceFlowStats {
  const pairs: { from: string; to: string; child: string }[] = [];
  const spellings = new Map<string, Map<string, number>>();
  const spell = (key: string, label: string) => {
    let m = spellings.get(key);
    if (!m) spellings.set(key, (m = new Map()));
    m.set(label, (m.get(label) ?? 0) + 1);
  };
  for (const child of s.people) {
    const to = placeAt(child, level);
    if (!to) continue;
    for (const pid of [child.father, child.mother]) {
      const from = placeAt(pid ? s.byId.get(pid) : undefined, level);
      if (!from) continue;
      pairs.push({ from: from.key, to: to.key, child: child.id });
      spell(from.key, from.label);
      spell(to.key, to.label);
    }
  }

  // Each side names its own most common places; the rest fold into one node.
  const side = (keyOf: (p: (typeof pairs)[number]) => string) => {
    const counts = new Map<string, number>();
    for (const p of pairs) counts.set(keyOf(p), (counts.get(keyOf(p)) ?? 0) + 1);
    const ranked = [...counts]
      .map(([key, count]) => ({ key, label: commonest(spellings.get(key)!), count }))
      .sort((a, b) => b.count - a.count || byLabel.compare(a.label, b.label));
    const named = ranked.slice(0, top);
    const rest = ranked.slice(top).reduce((n, r) => n + r.count, 0);
    const keep = new Set(named.map((n) => n.key));
    const nodes: FlowNode[] = rest ? [...named, { key: OTHER, label: "", count: rest }] : named;
    return { nodes, nodeOf: (key: string) => (keep.has(key) ? key : OTHER) };
  };
  const parents = side((p) => p.from);
  const children = side((p) => p.to);

  const flows = new Map<string, Flow>();
  const seen = new Map<string, Set<string>>();
  const moved = new Set<string>();
  let movedPairs = 0;
  for (const p of pairs) {
    if (p.from !== p.to) {
      movedPairs++;
      moved.add(p.child);
    }
    const from = parents.nodeOf(p.from);
    const to = children.nodeOf(p.to);
    const key = `${from}>${to}`;
    let f = flows.get(key);
    if (!f) {
      flows.set(key, (f = { from, to, count: 0, ids: [] }));
      seen.set(key, new Set());
    }
    f.count++;
    const ids = seen.get(key)!;
    if (!ids.has(p.child)) {
      ids.add(p.child);
      f.ids.push(p.child);
    }
  }

  return {
    parents: parents.nodes,
    children: children.nodes,
    flows: [...flows.values()].sort((a, b) => b.count - a.count),
    pairs: pairs.length,
    moved: movedPairs,
    movedIds: [...moved],
  };
}

export interface DecadeRow {
  key: string;
  label: string;
  /** Births with a year, in all decades. */
  count: number;
  /** The people born there, by decade (its first year). */
  byDecade: Map<number, string[]>;
}

export interface PlaceDecades {
  rows: DecadeRow[];
  /** The first and the last decade any row has a birth in. */
  first?: number;
  last?: number;
  /** The most births one cell holds. */
  max: number;
  /** Distinct birth places in scope (with a year or not). */
  places: number;
}

/** The commonest birth places among the dated births, by decade. */
export function placeDecades(s: ScopedFacts, top = DECADE_TOP): PlaceDecades {
  const year = birthYearOf(s);
  const groups = new Map<string, { spellings: Map<string, number>; people: { id: string; decade: number }[] }>();
  const places = new Set<string>();
  for (const p of s.people) {
    if (!p.birthPlace) continue;
    places.add(p.birthPlaceKey);
    const y = year(p);
    if (y === undefined) continue;
    let g = groups.get(p.birthPlaceKey);
    if (!g) groups.set(p.birthPlaceKey, (g = { spellings: new Map(), people: [] }));
    g.spellings.set(p.birthPlace, (g.spellings.get(p.birthPlace) ?? 0) + 1);
    g.people.push({ id: p.id, decade: Math.floor(y / 10) * 10 });
  }
  const rows: DecadeRow[] = [...groups]
    .map(([key, g]) => ({ key, label: commonest(g.spellings), count: g.people.length, people: g.people }))
    .sort((a, b) => b.count - a.count || byLabel.compare(a.label, b.label))
    .slice(0, top)
    .map(({ key, label, count, people }) => {
      const byDecade = new Map<number, string[]>();
      for (const { id, decade } of people) {
        const ids = byDecade.get(decade);
        if (ids) ids.push(id);
        else byDecade.set(decade, [id]);
      }
      return { key, label, count, byDecade };
    });
  let first: number | undefined;
  let last: number | undefined;
  let max = 0;
  for (const r of rows) {
    for (const [d, ids] of r.byDecade) {
      if (first === undefined || d < first) first = d;
      if (last === undefined || d > last) last = d;
      if (ids.length > max) max = ids.length;
    }
  }
  return { rows, first, last, max, places: places.size };
}

/** The places the stacked decades colour on their own. */
export const STACK_TOP = 8;
/** The key of the births with a year but no place. */
export const NO_PLACE = "\u0000none";

export interface DecadeStack {
  /** First year of the decade. */
  decade: number;
  /** People per part, in the order of {@link PlaceStack.parts}. */
  parts: string[][];
  count: number;
}

export interface PlaceStack {
  /** The named places, then {@link OTHER} and {@link NO_PLACE} where they hold anyone. */
  parts: FlowNode[];
  /** Every decade from the first to the last birth, the empty ones too. */
  decades: DecadeStack[];
  /** People with a birth year. */
  people: number;
}

/** Births by decade, each split by the birth place's commonest places. */
export function placeStack(s: ScopedFacts, top = STACK_TOP): PlaceStack {
  const year = birthYearOf(s);
  const dated: { p: PersonFacts; decade: number }[] = [];
  const counts = new Map<string, { spellings: Map<string, number>; count: number }>();
  for (const p of s.people) {
    const y = year(p);
    if (y === undefined) continue;
    dated.push({ p, decade: Math.floor(y / 10) * 10 });
    if (!p.birthPlace) continue;
    let g = counts.get(p.birthPlaceKey);
    if (!g) counts.set(p.birthPlaceKey, (g = { spellings: new Map(), count: 0 }));
    g.count++;
    g.spellings.set(p.birthPlace, (g.spellings.get(p.birthPlace) ?? 0) + 1);
  }
  const named: FlowNode[] = [...counts]
    .map(([key, g]) => ({ key, label: commonest(g.spellings), count: g.count }))
    .sort((a, b) => b.count - a.count || byLabel.compare(a.label, b.label))
    .slice(0, top);
  const other: FlowNode = { key: OTHER, label: "", count: 0 };
  const none: FlowNode = { key: NO_PLACE, label: "", count: 0 };
  const all = [...named, other, none];
  const index = new Map(all.map((n, i) => [n.key, i]));
  const byDecade = new Map<number, string[][]>();
  for (const { p, decade } of dated) {
    let parts = byDecade.get(decade);
    if (!parts) byDecade.set(decade, (parts = all.map(() => [])));
    const i = !p.birthPlace ? index.get(NO_PLACE)! : index.get(p.birthPlaceKey) ?? index.get(OTHER)!;
    parts[i].push(p.id);
    if (i >= named.length) all[i].count++;
  }
  const keep = all.map((n, i) => i < named.length || n.count > 0);
  const decades: DecadeStack[] = [];
  if (byDecade.size) {
    const ds = [...byDecade.keys()];
    const first = Math.min(...ds);
    const last = Math.max(...ds);
    for (let d = first; d <= last; d += 10) {
      const parts = (byDecade.get(d) ?? all.map(() => [])).filter((_, i) => keep[i]);
      decades.push({ decade: d, parts, count: parts.reduce((n, ids) => n + ids.length, 0) });
    }
  }
  return { parts: all.filter((_, i) => keep[i]), decades, people: dated.length };
}

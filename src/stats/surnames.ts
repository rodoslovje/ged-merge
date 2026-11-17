import type { ScopedFacts } from "./scope";
import { byLabel } from "./aggregate";
import { commonest, decadeGrid, DECADE_TOP, type PlaceDecades } from "./placeFlows";

/**
 * The Names page's surname pictures: which surnames married each other, and
 * how the commonest surnames come and go over the decades.
 */

/** The surnames the marriage network draws. */
export const NETWORK_TOP = 40;
/** A pair the network draws a line for has at least this many marriages. */
export const NETWORK_MIN_PAIR = 2;

/** Two surnames that married each other, and the families that wed them. */
export interface SurnamePair {
  /** `a>b`, the two keys in order. */
  key: string;
  a: string;
  b: string;
  /** Family ids. */
  ids: string[];
}

/** A surname's marriages: with any surname, and with its own. */
export interface SurnameNode {
  key: string;
  label: string;
  /** People in scope who carry the surname. */
  people: number;
  /** Family ids of every counted marriage the surname is in. */
  ids: string[];
  /** Of those, the marriages of two people of this surname. */
  within: string[];
}

export interface SurnameMarriages {
  /** Two different surnames, most marriages first. */
  pairs: SurnamePair[];
  nodes: Map<string, SurnameNode>;
  /** Families whose two spouses both have a surname. */
  couples: number;
}

/**
 * Every family in scope whose husband and wife both carry a surname, counted
 * under the pair of surnames. A spouse outside the scope still names the
 * family's other side, as the family pages count a family with one spouse in
 * scope. Surnames fold accent- and case-blind, as the surname list counts them.
 */
export function surnameMarriages(s: ScopedFacts): SurnameMarriages {
  const spellings = new Map<string, Map<string, number>>();
  const people = new Map<string, number>();
  for (const p of s.people) {
    if (!p.surname || !p.surnameKey) continue;
    people.set(p.surnameKey, (people.get(p.surnameKey) ?? 0) + 1);
  }
  const pairs = new Map<string, SurnamePair>();
  const nodes = new Map<string, SurnameNode>();
  const node = (key: string) => {
    let n = nodes.get(key);
    if (!n) nodes.set(key, (n = { key, label: "", people: people.get(key) ?? 0, ids: [], within: [] }));
    return n;
  };
  let couples = 0;
  for (const f of s.families) {
    const h = f.husband ? s.byId.get(f.husband) : undefined;
    const w = f.wife ? s.byId.get(f.wife) : undefined;
    if (!h?.surname || !h.surnameKey || !w?.surname || !w.surnameKey) continue;
    couples++;
    for (const p of [h, w]) {
      let sp = spellings.get(p.surnameKey!);
      if (!sp) spellings.set(p.surnameKey!, (sp = new Map()));
      sp.set(p.surname!, (sp.get(p.surname!) ?? 0) + 1);
    }
    if (h.surnameKey === w.surnameKey) {
      const n = node(h.surnameKey);
      n.ids.push(f.id);
      n.within.push(f.id);
      continue;
    }
    node(h.surnameKey).ids.push(f.id);
    node(w.surnameKey).ids.push(f.id);
    const [a, b] = [h.surnameKey, w.surnameKey].sort();
    const key = `${a}>${b}`;
    let pair = pairs.get(key);
    if (!pair) pairs.set(key, (pair = { key, a, b, ids: [] }));
    pair.ids.push(f.id);
  }
  for (const n of nodes.values()) n.label = commonest(spellings.get(n.key)!);
  const label = (key: string) => nodes.get(key)!.label;
  return {
    pairs: [...pairs.values()].sort((x, y) =>
      y.ids.length - x.ids.length || byLabel.compare(label(x.a), label(y.a)) || byLabel.compare(label(x.b), label(y.b))),
    nodes,
    couples,
  };
}

/** What the marriage network draws: the surnames of the strongest pairs (at
 *  least `minPair` marriages), strongest first, until `top` surnames are in,
 *  and every such pair among them. */
export function surnameNetwork(m: SurnameMarriages, top = NETWORK_TOP, minPair = NETWORK_MIN_PAIR): { nodes: SurnameNode[]; pairs: SurnamePair[] } {
  const strong = m.pairs.filter((p) => p.ids.length >= minPair);
  const chosen = new Set<string>();
  for (const p of strong) {
    const room = top - chosen.size;
    if (room <= 0) break;
    const missing = (chosen.has(p.a) ? 0 : 1) + (chosen.has(p.b) ? 0 : 1);
    if (missing > room) continue;
    chosen.add(p.a);
    chosen.add(p.b);
  }
  const across = (n: SurnameNode) => n.ids.length - n.within.length;
  const nodes = [...chosen]
    .map((key) => m.nodes.get(key)!)
    .sort((a, b) => across(b) - across(a) || byLabel.compare(a.label, b.label));
  return { nodes, pairs: strong.filter((p) => chosen.has(p.a) && chosen.has(p.b)) };
}

/** The commonest surnames among the dated births, by decade. */
export function surnameDecades(s: ScopedFacts, top = DECADE_TOP): Omit<PlaceDecades, "places"> {
  return decadeGrid(s, (p) => (p.surname && p.surnameKey ? [p.surnameKey, p.surname] : undefined), top);
}

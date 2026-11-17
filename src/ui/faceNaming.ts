// Who a face on a photo may be: the people offered when a detected face is
// named. With nothing typed, the person whose photo it is and their close
// family — the likeliest faces on a family photo; typing searches the file.
import type { Dataset, Individual } from "../gedcom/types";
import { displayName, primaryName } from "../match/relatives";
import { foldToken } from "../match/text";

/** The person, then spouses, children, parents, siblings, and the spouses'
 *  parents and siblings — each once, in that order. */
export function closeFamily(ds: Dataset, id: string): string[] {
  const out: string[] = [];
  const add = (x: string | undefined) => { if (x && !out.includes(x) && ds.individuals.has(x)) out.push(x); };
  const fams = (ids: string[]) => ids.map((f) => ds.families.get(f)).filter((f) => f !== undefined);
  const parentsAndSiblings = (pid: string) => {
    const p = ds.individuals.get(pid);
    if (!p) return;
    for (const f of fams(p.childOf)) { add(f.husband); add(f.wife); }
    for (const f of fams(p.childOf)) f.children.forEach(add);
  };
  add(id);
  const me = ds.individuals.get(id);
  if (!me) return out;
  const spouses: string[] = [];
  for (const f of fams(me.spouseOf)) for (const s of [f.husband, f.wife]) if (s && s !== id) { add(s); spouses.push(s); }
  for (const f of fams(me.spouseOf)) f.children.forEach(add);
  parentsAndSiblings(id);
  spouses.forEach(parentsAndSiblings);
  return out;
}

/** Up to `limit` people for the name box: close family when `query` is empty;
 *  otherwise everyone whose name has a word starting with each typed word
 *  (accents optional), close family first. */
export function nameCandidates(ds: Dataset, openerId: string, query: string, limit = 8, exclude: string[] = []): Individual[] {
  const family = closeFamily(ds, openerId).filter((x) => !exclude.includes(x));
  const words = foldToken(query).split(" ").filter(Boolean);
  const pick = (ids: Iterable<string>) => [...ids].map((x) => ds.individuals.get(x)).filter((i) => i !== undefined);
  if (words.length === 0) return pick(family).slice(0, limit);
  const matches = (indi: Individual) => {
    const tokens = foldToken(displayName(primaryName(indi))).split(" ");
    return words.every((w) => tokens.some((t) => t.startsWith(w)));
  };
  const near = pick(family).filter(matches);
  const out = near.slice(0, limit);
  for (const indi of ds.individuals.values()) {
    if (out.length >= limit) break;
    if (!family.includes(indi.id) && !exclude.includes(indi.id) && matches(indi)) out.push(indi);
  }
  return out;
}

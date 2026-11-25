// Who a face on a photo may be: the people offered when a detected face is
// named. With nothing typed, the person whose photo it is and their close
// family — the likeliest faces on a family photo; typing searches the file.
import type { Dataset, Individual } from "../gedcom/types";
import type { PersonOption } from "./edit/RelativePickerCard";
import { matchesTerms, queryTerms } from "./globalSearch";

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
 *  otherwise the people of `options` the query finds — searched as every
 *  person box searches (each typed word on its own, over every name the person
 *  carries or is shown by, so a married surname finds them) — close family
 *  first. */
export function nameCandidates(
  ds: Dataset,
  openerId: string,
  query: string,
  limit = 8,
  exclude: string[] = [],
  options: Pick<PersonOption, "id" | "indi" | "search">[] = [],
): Individual[] {
  const family = closeFamily(ds, openerId).filter((x) => !exclude.includes(x));
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return family.map((x) => ds.individuals.get(x)).filter((i) => i !== undefined).slice(0, limit);
  }
  const near = new Map<string, Individual>();
  const others: Individual[] = [];
  const left = new Set(exclude);
  for (const p of options) {
    if (left.has(p.id) || !matchesTerms(p.search, terms)) continue;
    if (family.includes(p.id)) near.set(p.id, p.indi);
    else if (others.length < limit) others.push(p.indi);
  }
  // Family in its own order (the person, spouse, children…), then the rest.
  return [...family.map((x) => near.get(x)).filter((i) => i !== undefined), ...others].slice(0, limit);
}

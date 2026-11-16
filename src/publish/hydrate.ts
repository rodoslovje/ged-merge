import type { Dataset, GedNode } from "../gedcom/types";
import { buildDataset } from "../gedcom/builder";
import type { PubEvent, PublishedTree } from "./model";

/**
 * The family website's data, back as a `Dataset` — so the published page draws
 * it with the app's own charts and statistics. The records are built in memory
 * only and never offered as a file.
 */

const node = (level: number, tag: string, value?: string, children: GedNode[] = [], xref?: string): GedNode => {
  const n: GedNode = { level, tag, children };
  if (value !== undefined) n.value = value;
  if (xref) n.xref = xref;
  return n;
};

const ref = (id: string) => `@${id}@`;

const coord = (v: number, pos: string, neg: string) => `${v < 0 ? neg : pos}${Math.abs(v)}`;

function eventNode(e: PubEvent): GedNode {
  const sub: GedNode[] = [];
  if (e.type) sub.push(node(2, "TYPE", e.type));
  if (e.date) sub.push(node(2, "DATE", e.date));
  if (e.place) {
    const map = e.lat !== undefined && e.lon !== undefined
      ? [node(3, "MAP", undefined, [node(4, "LATI", coord(e.lat, "N", "S")), node(4, "LONG", coord(e.lon, "E", "W"))])]
      : [];
    sub.push(node(2, "PLAC", e.place, map));
  }
  if (e.cause) sub.push(node(2, "CAUS", e.cause));
  return node(1, e.tag, e.value, sub);
}

export function hydrateTree(tree: PublishedTree): Dataset {
  const famc = new Map<string, string[]>();
  const fams = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  for (const f of tree.families) {
    if (f.husband) push(fams, f.husband, f.id);
    if (f.wife) push(fams, f.wife, f.id);
    for (const c of f.children ?? []) push(famc, c, f.id);
  }

  const records: GedNode[] = [node(0, "HEAD", undefined, [node(1, "GEDC", undefined, [node(2, "VERS", "7.0")])])];
  for (const p of tree.people) {
    const nameParts = [p.given ?? "", p.surname ? `/${p.surname}/` : ""].filter(Boolean).join(" ");
    const nameSub: GedNode[] = [];
    if (p.given) nameSub.push(node(2, "GIVN", p.given));
    if (p.surname) nameSub.push(node(2, "SURN", p.surname));
    const children: GedNode[] = [node(1, "NAME", nameParts, nameSub)];
    for (const m of p.married ?? []) children.push(node(1, "NAME", `/${m}/`, [node(2, "TYPE", "married"), node(2, "SURN", m)]));
    if (p.sex) children.push(node(1, "SEX", p.sex));
    for (const e of p.events ?? []) children.push(eventNode(e));
    for (const f of famc.get(p.id) ?? []) children.push(node(1, "FAMC", ref(f)));
    for (const f of fams.get(p.id) ?? []) children.push(node(1, "FAMS", ref(f)));
    records.push(node(0, "INDI", undefined, children, ref(p.id)));
  }
  for (const f of tree.families) {
    const children: GedNode[] = [];
    if (f.husband) children.push(node(1, "HUSB", ref(f.husband)));
    if (f.wife) children.push(node(1, "WIFE", ref(f.wife)));
    for (const c of f.children ?? []) children.push(node(1, "CHIL", ref(c)));
    for (const e of f.events ?? []) children.push(eventNode(e));
    records.push(node(0, "FAM", undefined, children, ref(f.id)));
  }
  records.push(node(0, "TRLR"));

  return buildDataset({ version: "7.0", charset: "UTF-8", records, warnings: [], eol: "\n", finalNewline: true });
}

/** The published id of a dataset record (`@p1x@` → `p1x`), for the site's links. */
export const pubId = (xref: string) => xref.replace(/^@|@$/g, "");
export const xrefOf = (id: string) => ref(id);

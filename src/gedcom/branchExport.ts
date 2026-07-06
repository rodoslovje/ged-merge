import { cloneNode } from "./node";
import type { Dataset, GedNode } from "./types";

/**
 * Branch export: cut a shareable GEDCOM out of the main file containing
 * exactly the people shown in a chart (plus whatever is needed to keep the
 * file valid and self-contained). The recipient loads it in GED Merge as a
 * compare file and merges it into their own main.
 *
 * What goes in, given a set of individual ids:
 * - the INDI records for those ids, in original file order;
 * - every FAM record with at least two included members (spouses/children) —
 *   the families that actually connect two exported people. A family with a
 *   single included member carries no relationship, so it is dropped rather
 *   than exported as a husk;
 * - supporting records the kept records point to, transitively: sources with
 *   their repositories, shared notes, media records, the header's submitter;
 * - a clone of the main's HEAD (so version/charset conventions carry over)
 *   and the TRLR.
 *
 * Every remaining pointer whose target did not make it into the output is
 * scrubbed — a FAMS to a dropped family, a CHIL to an excluded sibling, an
 * ASSO to a person outside the branch — so the file never contains dangling
 * xrefs. Vendor-extension (`_`) subtrees are left untouched (their vocabulary
 * is not ours to edit), but pointer targets found inside them still count as
 * reachable and are carried along when they are supporting records.
 */

export interface BranchExport {
  /** Cloned records ready to serialize — the source dataset is not touched. */
  records: GedNode[];
  /** People exported. */
  individuals: number;
  /** Connecting FAM records exported. */
  families: number;
  /** Supporting records carried along (SOUR / NOTE / OBJE / REPO / SUBM …). */
  supporting: number;
}

/** A standalone pointer value (`@X1@`), as opposed to a `@#…@` escape. */
function pointerValue(node: GedNode): string | undefined {
  const v = node.value?.trim();
  return v && /^@[^@]+@$/.test(v) && !v.startsWith("@#") ? v : undefined;
}

export function extractBranch(ds: Dataset, personIds: Iterable<string>): BranchExport {
  const keepIndi = new Set<string>();
  for (const id of personIds) if (ds.individuals.has(id)) keepIndi.add(id);

  // A family earns its place by connecting two exported people.
  const keepFam = new Set<string>();
  for (const fam of ds.families.values()) {
    const members = [fam.husband, fam.wife, ...fam.children];
    const included = members.filter((id) => id && keepIndi.has(id)).length;
    if (included >= 2) keepFam.add(fam.id);
  }

  const byXref = new Map<string, GedNode>();
  for (const rec of ds.records) if (rec.xref) byXref.set(rec.xref, rec);

  // Chase pointers out of the kept records (and HEAD) into the supporting
  // records they cite, transitively — SOUR → REPO/NOTE/OBJE, OBJE → NOTE, the
  // header's SUBM, … INDI/FAM targets are never pulled in this way: people are
  // chosen by the caller, families by the ≥2-members rule above.
  const supporting = new Set<string>();
  const queue: GedNode[] = [];
  const head = ds.records.find((r) => r.tag === "HEAD");
  if (head) queue.push(head);
  for (const rec of ds.records) {
    if (rec.xref && (keepIndi.has(rec.xref) || keepFam.has(rec.xref))) queue.push(rec);
  }
  const chase = (node: GedNode) => {
    const v = pointerValue(node);
    if (v && !keepIndi.has(v) && !keepFam.has(v) && !supporting.has(v)) {
      const target = byXref.get(v);
      if (target && target.tag !== "INDI" && target.tag !== "FAM") {
        supporting.add(v);
        queue.push(target);
      }
    }
    for (const child of node.children) chase(child);
  };
  for (let rec = queue.shift(); rec; rec = queue.shift()) chase(rec);

  const kept = new Set([...keepIndi, ...keepFam, ...supporting]);

  // Drop any pointer line whose target is not in the output. Vendor (`_`)
  // subtrees are skipped, mirroring the dangling-xref validator: their
  // contents follow the vendor's own vocabulary.
  const scrub = (node: GedNode): void => {
    node.children = node.children.filter((child) => {
      if (child.tag.startsWith("_")) return true;
      const v = pointerValue(child);
      if (v && !kept.has(v)) return false;
      scrub(child);
      return true;
    });
  };

  const records: GedNode[] = [];
  for (const rec of ds.records) {
    const keep =
      rec.tag === "HEAD" || rec.tag === "TRLR" || (rec.xref !== undefined && kept.has(rec.xref));
    if (!keep) continue;
    const clone = cloneNode(rec);
    scrub(clone);
    records.push(clone);
  }

  return { records, individuals: keepIndi.size, families: keepFam.size, supporting: supporting.size };
}

import type { Dataset, GedNode } from "../gedcom/types";
import { cloneNode } from "../gedcom/node";
import { conformingXref } from "../gedcom/xrefShape";
import { applyRecordPatches, type RecordPatch } from "../ui/historyTypes";

/**
 * Two whole-file rewrites the health check offers on one row, built as undo
 * patches first and then applied forward — a rename changes a record's key,
 * which an in-place pass keyed by xref cannot express:
 *
 *  - {@link renameXref}: a record whose id the version's rules refuse gets one
 *    they accept, unique in the file, and every line pointing at it follows;
 *  - {@link removeCustomTag}: every line of one extension tag goes, with what
 *    is beneath it — and a top-level record of that tag, with every line
 *    pointing at it;
 *  - {@link removeMisplacedTag}: every line of a standard tag standing where
 *    the version has no place for it (a `DATE` under `REPO.WWW`) goes, with
 *    what is beneath it — only there, the tag's rightful places are untouched.
 *
 * Records without an xref (HEAD) are left alone, as an undo patch is keyed by
 * xref. Both return the patches they applied, empty when nothing changed.
 */

function patchType(dataset: Dataset, rec: GedNode): RecordPatch["type"] {
  const xref = rec.xref!;
  if (dataset.individuals.get(xref)?.raw === rec) return "individual";
  if (dataset.families.get(xref)?.raw === rec) return "family";
  return "record";
}

/** Whether a line anywhere beneath `node` meets `hit`. */
function anyBeneath(node: GedNode, hit: (line: GedNode) => boolean): boolean {
  return node.children.some((c) => hit(c) || anyBeneath(c, hit));
}

/** A patch for every record holding a line that meets `hit`, its `after` the
 *  record as `edit` leaves a clone of it. Only those records are cloned. */
function editedPatches(
  dataset: Dataset,
  skip: ReadonlySet<string>,
  hit: (line: GedNode) => boolean,
  edit: (clone: GedNode) => void,
): RecordPatch[] {
  const patches: RecordPatch[] = [];
  for (const rec of dataset.records) {
    if (!rec.xref || skip.has(rec.xref) || !anyBeneath(rec, hit)) continue;
    const after = cloneNode(rec);
    edit(after);
    patches.push({ type: patchType(dataset, rec), id: rec.xref, before: cloneNode(rec), after });
  }
  return patches;
}

/** Give record `xref` an id the version accepts; returns the patches applied. */
export function renameXref(dataset: Dataset, xref: string, is70: boolean): RecordPatch[] {
  const index = dataset.records.findIndex((r) => r.xref === xref);
  if (index < 0) return [];
  const rec = dataset.records[index];
  const taken = new Set(dataset.records.map((r) => r.xref).filter((x): x is string => !!x));
  const next = conformingXref(xref, is70, taken);
  // The lines beneath a record that point at it (the record's own value is
  // text, never a pointer).
  const points = (line: GedNode) => line.value?.trim() === xref;
  const repoint = (node: GedNode): void => {
    for (const c of node.children) {
      if (points(c)) c.value = next;
      repoint(c);
    }
  };
  const renamed = cloneNode(rec);
  renamed.xref = next;
  repoint(renamed);
  const type = patchType(dataset, rec);
  const patches: RecordPatch[] = [
    // The old id goes and the new one takes its place in the record list.
    { type, id: xref, before: cloneNode(rec), after: null, index },
    { type, id: next, before: null, after: renamed, index },
    ...editedPatches(dataset, new Set([xref]), points, repoint),
  ];
  applyRecordPatches(dataset, patches, "redo");
  return patches;
}

/** Remove every line tagged `tag` (and a record of that tag, with the lines
 *  pointing at it); returns the patches applied. */
export function removeCustomTag(dataset: Dataset, tag: string): RecordPatch[] {
  const patches: RecordPatch[] = [];
  const gone = new Set<string>();
  dataset.records.forEach((rec, index) => {
    if (rec.tag !== tag || !rec.xref) return;
    gone.add(rec.xref);
    patches.push({ type: patchType(dataset, rec), id: rec.xref, before: cloneNode(rec), after: null, index });
  });
  const drops = (line: GedNode) => line.tag === tag || gone.has(line.value?.trim() ?? "");
  const strip = (node: GedNode): void => {
    node.children = node.children.filter((c) => !drops(c));
    for (const c of node.children) strip(c);
  };
  patches.push(...editedPatches(dataset, gone, drops, strip));
  if (patches.length) applyRecordPatches(dataset, patches, "redo");
  return patches;
}

/** Remove every line tagged `tag` standing directly under `parent` — the
 *  dotted tag path from the record, as a misplaced-tag finding names it
 *  (`REPO.WWW`) — with what is beneath it; returns the patches applied. */
export function removeMisplacedTag(dataset: Dataset, tag: string, parent: string): RecordPatch[] {
  const [root, ...chain] = parent.split(".");
  /** The lines at the end of the path under `node`, each handed to `visit`. */
  const reach = (node: GedNode, depth: number, visit: (owner: GedNode) => void): void => {
    if (depth === chain.length) return visit(node);
    for (const c of node.children) if (c.tag === chain[depth]) reach(c, depth + 1, visit);
  };
  const patches: RecordPatch[] = [];
  for (const rec of dataset.records) {
    if (rec.tag !== root || !rec.xref) continue;
    let found = false;
    reach(rec, 0, (owner) => { found ||= owner.children.some((c) => c.tag === tag); });
    if (!found) continue;
    const after = cloneNode(rec);
    reach(after, 0, (owner) => { owner.children = owner.children.filter((c) => c.tag !== tag); });
    patches.push({ type: patchType(dataset, rec), id: rec.xref, before: cloneNode(rec), after });
  }
  if (patches.length) applyRecordPatches(dataset, patches, "redo");
  return patches;
}

/**
 * The records behind a finding that names a tag: each one holding a line
 * tagged `tag`, with how many — directly under `parent` (the dotted path a
 * misplaced-tag finding names, `SOUR`, `REPO.WWW`) when one is given, anywhere
 * in the record otherwise (an extension tag). File order; records without an
 * xref (HEAD) are left out, as nothing can open them.
 */
export function recordsWithTag(records: readonly GedNode[], tag: string, parent?: string): { id: string; count: number }[] {
  const [root, ...chain] = parent ? parent.split(".") : [];
  const under = (node: GedNode, depth: number): number =>
    depth === chain.length
      ? node.children.filter((c) => c.tag === tag).length
      : node.children.reduce((n, c) => n + (c.tag === chain[depth] ? under(c, depth + 1) : 0), 0);
  const anywhere = (node: GedNode): number =>
    node.children.reduce((n, c) => n + (c.tag === tag ? 1 : 0) + anywhere(c), 0);
  const out: { id: string; count: number }[] = [];
  for (const rec of records) {
    if (!rec.xref || (parent && rec.tag !== root)) continue;
    const count = parent ? under(rec, 0) : anywhere(rec);
    if (count > 0) out.push({ id: rec.xref, count });
  }
  return out;
}

import type { Association, Dataset, Family, Individual } from "../gedcom/types";
import { ROLE_TO_RELA, roleFromRela } from "../gedcom/assoc";
import { rebuildFamily, rebuildIndividual } from "../gedcom/edit";
import { cloneNode, firstChild } from "../gedcom/node";
import { type RecordPatch } from "../ui/historyTypes";

/**
 * One-button repair for a godparent named at a marriage.
 *
 * A wedding has witnesses; godparents belong to a baptism. The role lands on a
 * marriage anyway — an editor that proposes "godparent" for every associate, or
 * an import that knew one role only — and each such associate reads wrongly on
 * both records from then on. The repair restates the role as witness and
 * touches nothing else: who was named, the notes and the citations stay.
 *
 * "At a marriage" is every association a family carries (on the record or under
 * any of its events — a family has no baptism to stand godparent at), and a
 * person's association that points at a family, which is how a 5.5-era file
 * names a wedding witness.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack,
 * following the same convention as `fixSwappedRoles`.
 */

/** The godparents `record` names at a marriage — what the health check reports
 *  and the fix rewrites, so the two cannot diverge. */
export function marriageGodparents(dataset: Dataset, record: Individual | Family): Association[] {
  const isFamily = dataset.families.get(record.id) === record;
  const own = record.associations ?? [];
  const candidates = isFamily
    ? [...own, ...record.events.flatMap((e) => e.associations ?? [])]
    : own.filter((a) => a.targetKind === "FAM" || dataset.families.has(a.targetId));
  return candidates.filter((a) => a.role === "GODP");
}

/** Restate one association's role as witness, in the dialect the line is
 *  already written in. Wording of the file's own is dropped only where it says
 *  "godparent" too — any other phrase is not ours to judge. */
function toWitness(assoc: Association): void {
  const role = firstChild(assoc.raw, "ROLE");
  if (role) {
    role.value = "WITN";
    role.children = role.children.filter(
      (c) => !(c.tag === "PHRASE" && roleFromRela(c.value ?? "") === "GODP"),
    );
    return;
  }
  const rela = firstChild(assoc.raw, "RELA");
  if (rela) rela.value = ROLE_TO_RELA.WITN;
}

/** @param only — repair just this record (its row's own button), instead of
 *  every marriage in the file. */
export function fixMarriageGodparents(dataset: Dataset, only?: string): RecordPatch[] {
  const patches: RecordPatch[] = [];
  const repair = (record: Individual | Family, type: "individual" | "family") => {
    if (only && record.id !== only) return;
    const found = marriageGodparents(dataset, record);
    if (!found.length) return;
    const before = cloneNode(record.raw);
    for (const assoc of found) toWitness(assoc);
    if (type === "family") rebuildFamily(dataset, record as Family);
    else rebuildIndividual(dataset, record as Individual);
    patches.push({ type, id: record.id, before, after: cloneNode(record.raw) });
  };
  for (const fam of [...dataset.families.values()]) repair(fam, "family");
  for (const indi of [...dataset.individuals.values()]) repair(indi, "individual");
  return patches;
}

import type { Dataset, Family, GedNode } from "../gedcom/types";
import { rebuildFamily } from "../gedcom/edit";
import { cloneRaw, type RecordPatch } from "../ui/historyTypes";

/**
 * One-button repair for the "Sex vs. role" health-check category: a family whose
 * two spouses are in each other's slots — a man written as `WIFE`, a woman as
 * `HUSB`.
 *
 * Only the **mutual** swap is repaired, and that is the point: when both slots
 * contradict the recorded sex, one mistake (the two pointers exchanged) explains
 * both findings, and swapping them back is the only reading that leaves nothing
 * contradicted. A one-sided conflict — a female `HUSB` married to a man, or a
 * lone spouse in the wrong slot — has no such answer: either the role or the
 * `SEX` is wrong and the file gives no way to tell, so it stays reported for the
 * user to settle by hand.
 *
 * Nothing but the two pointer values moves. A spouse's `FAMS` link names the
 * family, not the slot, and the children are the family's either way, so the
 * swap is confined to the `FAM` record.
 *
 * Mutates the dataset in place and returns `RecordPatch[]` for the undo stack,
 * following the same convention as `fixSexFromRole`.
 */

/** The single `HUSB` and `WIFE` lines of a family whose spouses are swapped, or
 *  `undefined` if this family isn't an unambiguous swap.
 *
 *  Held to one line per slot: a family carrying two `HUSB` lines is its own
 *  finding (`multiSpouseSlot`), and which of them the swap should move is
 *  exactly the question that check asks. Lines with a subtree below them (a
 *  GEDCOM 7 `PHRASE` qualifying the role) are left alone too — the value would
 *  move out from under the words describing it. */
function swappedSlots(dataset: Dataset, fam: Family): { husb: GedNode; wife: GedNode } | undefined {
  const husband = fam.husband ? dataset.individuals.get(fam.husband) : undefined;
  const wife = fam.wife ? dataset.individuals.get(fam.wife) : undefined;
  if (!husband || !wife) return undefined;
  if (husband.sex !== "F" || wife.sex !== "M") return undefined;

  const husbLines = fam.raw.children.filter((c) => c.tag === "HUSB");
  const wifeLines = fam.raw.children.filter((c) => c.tag === "WIFE");
  if (husbLines.length !== 1 || wifeLines.length !== 1) return undefined;
  const [husb] = husbLines;
  const [wifeLine] = wifeLines;
  if (husb.children.length > 0 || wifeLine.children.length > 0) return undefined;
  return { husb, wife: wifeLine };
}

/** How many families have their two spouses in each other's slots — the count on
 *  the fix's button. Shared with the fix itself so the two can't diverge. */
export function countSwappedRoles(dataset: Dataset): number {
  let count = 0;
  for (const fam of dataset.families.values()) {
    if (swappedSlots(dataset, fam)) count += 1;
  }
  return count;
}

/**
 * Each person the swap would move, mapped to the role they'd land in — so the
 * health check can mark the findings this button answers, and say what becomes
 * of each. Keyed by individual, since that's what a `roleSexConflict` finding
 * is reported on; a person swapped in two families lands in the same role in
 * both (their own sex decides it), so one entry per person tells the truth.
 */
export function swappedRoleTargets(dataset: Dataset): Map<string, "husband" | "wife"> {
  const targets = new Map<string, "husband" | "wife">();
  for (const fam of dataset.families.values()) {
    if (!swappedSlots(dataset, fam)) continue;
    if (fam.husband) targets.set(fam.husband, "wife");
    if (fam.wife) targets.set(fam.wife, "husband");
  }
  return targets;
}

/** @param only — swap just the families this individual is a swapped spouse in
 *  (their row's own button), instead of every swapped family in the file. */
export function fixSwappedRoles(dataset: Dataset, only?: string): RecordPatch[] {
  const patches: RecordPatch[] = [];
  for (const fam of dataset.families.values()) {
    const slots = swappedSlots(dataset, fam);
    if (!slots) continue;
    if (only && fam.husband !== only && fam.wife !== only) continue;
    const before = cloneRaw(fam.raw);
    const husbValue = slots.husb.value;
    slots.husb.value = slots.wife.value;
    slots.wife.value = husbValue;
    rebuildFamily(dataset, fam);
    patches.push({ type: "family", id: fam.id, before, after: cloneRaw(fam.raw) });
  }
  return patches;
}

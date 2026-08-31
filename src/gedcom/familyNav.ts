// Keyboard navigation through the family, one step at a time — the target of
// Edit's ⌥+arrow shortcuts. Pure lookups over the dataset: the caller decides
// what to do with the id that comes back (and nothing happens when the step
// has nowhere to go).
//
// The axes mirror the Edit layout: vertical is the generation (parents above,
// children below), horizontal is the person's own generation (siblings, and
// with Shift the partner). Everything walks the same order the cards show —
// children by birth (childrenByBirth), unions by marriage (familiesByMarriage).

import type { Dataset } from "./types";
import { childrenByBirth, familiesByMarriage } from "./familySort";

export type FamilyStep =
  | "father"
  | "mother"
  | "prevSibling"
  | "nextSibling"
  | "firstChild"
  | "lastChild"
  | "prevPartner"
  | "nextPartner";

/** Every child of every parent family, in the order the cards read, deduplicated.
 *  Includes the person: siblings are their neighbours in this run. */
function siblingRun(ds: Dataset, id: string): string[] {
  const person = ds.individuals.get(id);
  if (!person) return [];
  const ids: string[] = [];
  for (const famId of person.childOf) {
    for (const childId of childrenByBirth(ds.families.get(famId), ds.individuals)) {
      if (!ids.includes(childId)) ids.push(childId);
    }
  }
  return ids;
}

/** The person's partners, one per union, in marriage order. A union with no
 *  second spouse recorded contributes nobody. */
function partnersOf(ds: Dataset, id: string): string[] {
  const person = ds.individuals.get(id);
  if (!person) return [];
  const out: string[] = [];
  for (const fam of familiesByMarriage(ds, person.spouseOf)) {
    const other = fam.husband === id ? fam.wife : fam.husband;
    if (other && other !== id && !out.includes(other)) out.push(other);
  }
  return out;
}

/**
 * Where one keyboard step from `id` lands, or undefined when that step has no
 * target.
 *
 * - `father` / `mother` — the parent shown on the card. When only one parent is
 *   recorded, both steps reach that one: "up a generation" should not dead-end
 *   because the file names a mother and no father.
 * - `prevSibling` / `nextSibling` — the neighbour among the parent family's
 *   children, by birth. Half-siblings count: they stand on the same card row.
 *   The run does not wrap, so the eldest and the youngest are felt as ends.
 * - `firstChild` / `lastChild` — the eldest and the youngest child; from there
 *   the sibling steps walk the rest.
 * - `prevPartner` / `nextPartner` — the partner of a union, and this one *does*
 *   wrap, which is what makes it useful: `cameFromId` (the person this one was
 *   opened from) positions the step, so with a single partner the key toggles
 *   between the two spouses, and with several it tours them one after another.
 */
export function familyStepTarget(
  ds: Dataset,
  id: string,
  step: FamilyStep,
  cameFromId?: string,
): string | undefined {
  const person = ds.individuals.get(id);
  if (!person) return undefined;

  if (step === "father" || step === "mother") {
    const fams = person.childOf.map((famId) => ds.families.get(famId));
    const father = fams.find((f) => f?.husband)?.husband;
    const mother = fams.find((f) => f?.wife)?.wife;
    return step === "father" ? father ?? mother : mother ?? father;
  }

  if (step === "prevSibling" || step === "nextSibling") {
    const run = siblingRun(ds, id);
    const i = run.indexOf(id);
    if (i === -1) return undefined;
    return run[step === "prevSibling" ? i - 1 : i + 1];
  }

  if (step === "firstChild" || step === "lastChild") {
    const fams = familiesByMarriage(ds, person.spouseOf);
    if (step === "lastChild") fams.reverse();
    for (const fam of fams) {
      const kids = childrenByBirth(fam, ds.individuals);
      const target = step === "firstChild" ? kids[0] : kids[kids.length - 1];
      if (target) return target;
    }
    return undefined;
  }

  const partners = partnersOf(ds, id);
  if (partners.length === 0) return undefined;
  const from = cameFromId ? partners.indexOf(cameFromId) : -1;
  if (from === -1) return step === "nextPartner" ? partners[0] : partners[partners.length - 1];
  const delta = step === "nextPartner" ? 1 : -1;
  return partners[(from + delta + partners.length) % partners.length];
}

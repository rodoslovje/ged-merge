import type { Dataset, Family, Individual } from "./types";

/**
 * Whether two spouses form a same-sex couple — both present and sharing the
 * same *known* sex (`SEX U` is treated as unknown, never same-sex). GEDCOM has
 * no neutral spouse tag, so a same-sex couple is stored with one partner in the
 * `HUSB` slot and the other in `WIFE` (both carrying their true `SEX`); this
 * predicate lets the UI relabel such couples neutrally and stops the health
 * check from flagging the slot/sex mismatch as an error.
 */
export function isSameSexCouple(husband: Individual | undefined, wife: Individual | undefined): boolean {
  return !!husband && !!wife && husband.sex !== "U" && husband.sex === wife.sex;
}

/** PEDI / _MREL values that still mean "this child was born to these parents". */
const BIOLOGICAL_PEDI = new Set(["birth", "natural", ""]);

/** The families named by an individual's adoption events (`ADOP.FAMC`) — the
 *  5.5.1 way of recording an adoptive family when the `FAMC` link itself carries
 *  no `PEDI`. */
function adoptiveFamilyIds(indi: Individual): Set<string> {
  const ids = new Set<string>();
  for (const ev of indi.raw.children) {
    if (ev.tag !== "ADOP") continue;
    for (const c of ev.children) {
      if (c.tag === "FAMC" && c.value) ids.add(c.value.trim());
    }
  }
  return ids;
}

/**
 * The parent families an individual claims as their *birth* family: `FAMC` links
 * whose `PEDI`/`_MREL` says birth, or says nothing at all.
 *
 * Adoptive, foster and sealing links are a legitimate second set of parents, so
 * they're excluded — as are links naming a family the person's own `ADOP` event
 * points at. A family that doesn't exist is left to the health check's
 * `brokenLink` rule, and a repeated line to `duplicatePointer`, so neither is
 * counted twice here.
 *
 * A person has exactly one of these: the health check flags a second as
 * `multipleParents`, and the editor moves a child rather than mint one
 * (`connectExistingChild`).
 */
export function birthParentFamilies(indi: Individual, ds: Dataset): Family[] {
  const adoptive = adoptiveFamilyIds(indi);
  const out: Family[] = [];
  const seen = new Set<string>();
  for (const node of indi.raw.children) {
    if (node.tag !== "FAMC" || !node.value) continue;
    const id = node.value.trim();
    if (seen.has(id) || adoptive.has(id)) continue;
    const pedi = node.children.find((c) => c.tag === "PEDI" || c.tag === "_MREL")?.value;
    if (pedi !== undefined && !BIOLOGICAL_PEDI.has(pedi.trim().toLowerCase())) continue;
    const fam = ds.families.get(id);
    if (!fam) continue;
    seen.add(id);
    out.push(fam);
  }
  return out;
}

/** True when this child is linked to the family as *born* to it: no `PEDI` /
 *  `_MREL` at all, or one that still means birth. An adopted or foster child is
 *  not bound by the couple's own lifespans or birth intervals. */
export function isBirthChildLink(child: Individual, famId: string): boolean {
  const famc = child.raw.children.find((c) => c.tag === "FAMC" && c.value === famId);
  const pedi = famc?.children.find((c) => c.tag === "PEDI" || c.tag === "_MREL")?.value;
  return pedi === undefined || BIOLOGICAL_PEDI.has(pedi.trim().toLowerCase());
}

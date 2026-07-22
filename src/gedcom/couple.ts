import type { Individual } from "./types";

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

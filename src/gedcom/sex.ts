import type { GedNode, Sex } from "./types";

/**
 * A person's `SEX`, in either dialect.
 *
 * GEDCOM 7 adds `X` — "does not fit the typical definition of only male or
 * only female" — beside 5.5.1's `M`/`F`/`U`. 5.5.1 has no letter for it, so a
 * 7.0 file downgraded to 5.5.1 (and a 5.5.1 file this app edits to X) keeps the
 * fact as `1 SEX U` with a `2 _SEX X` extension line: every 5.5.1 reader still
 * sees a valid "unknown", and the upgrade turns it back into `SEX X`.
 */

/** The extension tag carrying `X` under a 5.5.1 `SEX U`. */
export const SEX_X_EXTENSION = "_SEX";

/** Read a `SEX` line — its value, or the 5.5.1 extension that says X. */
export function readSex(node: GedNode): Sex {
  const v = node.value?.trim().toUpperCase();
  if (v === "M" || v === "F" || v === "X") return v;
  const ext = node.children.find((c) => c.tag === SEX_X_EXTENSION)?.value?.trim().toUpperCase();
  return ext === "X" ? "X" : "U";
}

/** True for male or female — the only values that can disagree with each other
 *  or with a family role. `U` and `X` never conflict: matching's sex gate and
 *  the health check's role checks treat them alike. */
export function isBinarySex(sex: Sex | string | undefined): sex is "M" | "F" {
  return sex === "M" || sex === "F";
}

import { VOID_XREF } from "./assoc";

/** A record id 7.0 accepts: capital letters, digits and `_`, and not `@VOID@`. */
export const XREF_70 = /^@[A-Z0-9_]+@$/;

/** The longest record id 5.5.1 allows, at signs included. */
const MAX_551 = 22;

/** Whether the version's rules accept a record id as written. */
export function xrefConforms(xref: string, is70: boolean): boolean {
  if (is70) return XREF_70.test(xref) && xref !== VOID_XREF;
  return xref.length <= MAX_551 && /^@[A-Za-z0-9]/.test(xref);
}

/**
 * The id a record gets when its own breaks the version's rules — `@f1_I1@` →
 * `@F1_I1@` for 7.0 (upper case, any other character as `_`); for 5.5.1 a
 * leading letter where the id starts with another character, and a cut where
 * it runs past 22 characters. A suffix (`_2`, `_3`…) keeps it apart from
 * every id in `taken`; the caller adds the result to `taken`.
 */
export function conformingXref(xref: string, is70: boolean, taken: ReadonlySet<string>): string {
  let base = xref.replace(/^@|@$/g, "");
  if (is70) base = base.toUpperCase().replace(/[^A-Z0-9_]/g, "_") || "X";
  else {
    if (!/^[A-Za-z0-9]/.test(base)) base = `X${base}`;
    base = base.slice(0, MAX_551 - 2);
  }
  const free = (id: string) => !taken.has(id) && id !== VOID_XREF;
  if (free(`@${base}@`)) return `@${base}@`;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const id = `@${is70 ? base : base.slice(0, MAX_551 - 2 - suffix.length)}${suffix}@`;
    if (free(id)) return id;
  }
}

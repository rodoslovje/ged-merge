/**
 * The shape of a GEDCOM structure table, as the conformance check reads it.
 *
 * One table per standard version. Each structure (a record, or a sub-structure
 * in one context — "the FAMC of an individual", "the DATE of a change stamp")
 * has an id, a payload code saying what its line value must be, and the
 * children it may carry. Kept as compact strings so the 7.0 table can be
 * generated straight from the spec's own extract (scripts/gedcom7-spec-table.ts)
 * and the 5.5.1 one typed in the same notation.
 *
 * **Payload codes**
 *  - `""`        no value
 *  - `"T"`       free text (not checked)
 *  - `"Y"`       `Y` or nothing (7.0 event lines)
 *  - `"@INDI"`   a pointer to an INDI record (likewise any record tag);
 *                `"@INDI?"` also accepts a text value instead (5.5.1's
 *                `NOTE @N1@` | `NOTE text` and similar)
 *  - `"E:set"`   one value of the enumeration `set`; `"L:set"` a comma list of them
 *  - `"D"`       a date, `"A"` an age, `"G"` a language tag
 *
 * **Children** — space-separated `TAG:card` (the child's structure id is its
 * tag) or `TAG=id:card`, where `card` is `01`, `11`, `0M`, `1M` or `03` — the
 * spec's `{0:1}`, `{1:1}`, `{0:M}`, `{1:M}`, `{0:3}`.
 *
 * **Enumerations** — space-separated values. A value `()` admits any text in
 * parentheses (5.5.1's `ROLE (godfather)`).
 */
export interface SpecTable {
  /** The standard it describes, as the findings name it. */
  version: string;
  /** Level-0 tag → the record structure's id. */
  roots: Record<string, string>;
  structs: Record<string, [payload: string, children: string]>;
  enums: Record<string, string>;
}

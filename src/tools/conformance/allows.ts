import { compile, type Compiled } from "./compile";
import { SPEC_551 } from "./spec551";
import { SPEC_70 } from "./spec70";

function tableOf(version: "5.5.1" | "7.0"): Compiled {
  return compile(version === "7.0" ? SPEC_70 : SPEC_551);
}

/** The structure id the line at `path` has in `table`, if the version has one there. */
function structAt(table: Compiled, path: readonly string[]): string | undefined {
  let id: string | undefined = table.roots[path[0]];
  for (const step of path.slice(1)) {
    if (!id) return undefined;
    id = table.structs.get(id)?.children.get(step)?.id;
  }
  return id;
}

/**
 * Whether a GEDCOM version has a structure where a writer is about to put
 * one — asked of the spec tables, the one place that knows (see AGENTS.md,
 * "One source of truth for the standard").
 *
 * `path` is the tags from the level-0 record down to the parent: `["INDI"]`
 * for a line on a person record, `["INDI", "BIRT"]` for one under its birth.
 * A path the version does not have allows nothing.
 */
export function allowsChild(version: "5.5.1" | "7.0", path: readonly string[], tag: string): boolean {
  const table = tableOf(version);
  const id = structAt(table, path);
  return !!id && !!table.structs.get(id)?.children.has(tag);
}

/**
 * The values a version's enumeration admits for the line at `path` — the tags
 * from the level-0 record down to the line's own, `["INDI", "FAMC", "PEDI"]` —
 * spelled as that version spells them. Undefined where the version has no
 * line there, or the line there is not an enumeration. For a list payload
 * (7.0's `RESN`) these are the values each item may take.
 */
export function enumValuesAt(version: "5.5.1" | "7.0", path: readonly string[]): readonly string[] | undefined {
  const table = tableOf(version);
  const id = structAt(table, path);
  const payload = id ? table.structs.get(id)?.payload : undefined;
  if (!payload || !/^[EL]:/.test(payload)) return undefined;
  return table.enums.get(payload.slice(2));
}

/**
 * Whether the line at `path` — the tags from the level-0 record down to the
 * line's own, `["INDI", "ASSO"]` — carries a pointer in `version`. Only such a
 * line can stand as 7.0's `@VOID@`: a 7.0 `NOTE` is text, so a `NOTE @N1@`
 * there names no record to void.
 */
export function takesPointerAt(version: "5.5.1" | "7.0", path: readonly string[]): boolean {
  const table = tableOf(version);
  const id = structAt(table, path);
  return !!id && !!table.structs.get(id)?.payload.startsWith("@");
}

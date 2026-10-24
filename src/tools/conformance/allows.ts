import { compile } from "./compile";
import { SPEC_551 } from "./spec551";
import { SPEC_70 } from "./spec70";

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
  const table = compile(version === "7.0" ? SPEC_70 : SPEC_551);
  let id: string | undefined = table.roots[path[0]];
  for (const step of path.slice(1)) {
    if (!id) return false;
    id = table.structs.get(id)?.children.get(step)?.id;
  }
  return !!id && !!table.structs.get(id)?.children.has(tag);
}

import type { SpecTable } from "./types";

/**
 * A spec table (`spec551.ts`, `spec70.ts`) compiled into lookups, once per
 * table: what the conformance check walks, and what `allows.ts` asks when a
 * writer needs to know whether the standard has a structure where it is about
 * to write one.
 */

export interface ChildSpec {
  id: string;
  min: number;
  max: number;
}
export interface Struct {
  payload: string;
  children: Map<string, ChildSpec>;
  /** The children with a minimum, checked even when absent. */
  required: [string, ChildSpec][];
}
export interface Compiled {
  version: string;
  is70: boolean;
  roots: Record<string, string>;
  structs: Map<string, Struct>;
  enums: Map<string, string[]>;
  /** Every tag the table names anywhere — a tag outside it is unknown, not misplaced. */
  universe: Set<string>;
}

const CARDS: Record<string, [number, number]> = {
  "01": [0, 1], "11": [1, 1], "0M": [0, Infinity], "1M": [1, Infinity], "03": [0, 3],
};

const compiled = new Map<SpecTable, Compiled>();

export function compile(table: SpecTable): Compiled {
  const hit = compiled.get(table);
  if (hit) return hit;
  const universe = new Set(Object.keys(table.roots));
  const structs = new Map<string, Struct>();
  for (const [id, [payload, list]] of Object.entries(table.structs)) {
    const children = new Map<string, ChildSpec>();
    for (const item of list.split(" ")) {
      if (!item) continue;
      const m = /^([A-Z0-9_]+)(?:=([^:]+))?:(\w\w)$/.exec(item);
      if (!m || !CARDS[m[3]]) throw new Error(`conformance table ${table.version}: bad child "${item}" in ${id}`);
      const [min, max] = CARDS[m[3]];
      children.set(m[1], { id: m[2] ?? m[1], min, max });
      universe.add(m[1]);
    }
    structs.set(id, { payload, children, required: [...children].filter(([, c]) => c.min > 0) });
  }
  const enums = new Map(Object.entries(table.enums).map(([k, v]) => [k, v.split(" ")]));
  const out: Compiled = {
    version: table.version, is70: table.version.startsWith("7"), roots: table.roots, structs, enums, universe,
  };
  compiled.set(table, out);
  return out;
}


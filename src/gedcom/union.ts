import type { Family } from "./types";
import { EVENT_GLYPHS, UNMARRIED_UNION_GLYPH } from "./eventTags";
import { hasChild } from "./node";

/**
 * How married a union looks, judged only on what the file itself records:
 *  - `married` — a `MARR` event (even undated or a bare `Y`: its presence is
 *    the assertion), a `DIV`/`DIVF`/`ANUL` that presupposes one, `_MSTAT
 *    Married` or Brother's Keeper's `_MARRIED Y`;
 *  - `unmarried` — the file says so: `_MSTAT Partners` (the canonical form
 *    {@link normalizeFamilyStatus} consolidates the vendor vocabularies into),
 *    a bare `_NMR` ("never married"), `_MARRIED N`;
 *  - `unknown` — no signal either way, the ordinary case in files built from
 *    parish records.
 *
 * A status the file spells out always wins over an inferred one.
 */
export type UnionMarriage = "married" | "unmarried" | "unknown";

/** `_MSTAT` values asserting the couple never married. `Unknown` (MyHeritage's
 *  REL_UNKNOWN) is deliberately absent — it states the opposite of knowing. */
const UNMARRIED_STATUS = new Set(["partners", "partner", "unmarried", "never married", "not married", "single"]);
/** Family events that only exist if a marriage did. */
const MARRIAGE_EVIDENCE_TAGS = new Set(["MARR", "DIV", "DIVF", "ANUL"]);
/** Family events that end a marriage. */
const DISSOLUTION_TAGS = new Set(["DIV", "DIVF", "ANUL"]);

export function unionMarriage(fam: Family): UnionMarriage {
  let unmarried = false;
  for (const node of fam.raw.children) {
    if (MARRIAGE_EVIDENCE_TAGS.has(node.tag)) return "married";
    const value = node.value?.trim().toLowerCase() ?? "";
    if (node.tag === "_MSTAT") {
      if (value === "married") return "married";
      if (UNMARRIED_STATUS.has(value)) unmarried = true;
    }
    if (node.tag === "_MARRIED") {
      if (value === "y") return "married";
      if (value === "n") unmarried = true;
    }
    if (node.tag === "_NMR" && !value) unmarried = true;
  }
  return unmarried ? "unmarried" : "unknown";
}

/**
 * The genealogy mark for a couple, saying only what the file records: ⚮ for a
 * marriage it records as dissolved (`DIV`, `DIVF`, `ANUL`), ⚬⚬ for a couple it
 * records as separated (`SEPA`), ⚯ for a union it records as unmarried,
 * otherwise ⚭ — a union with no record either way is read as the marriage it
 * usually is. How the union ended is also reported, as `ended`.
 */
export function unionMark(fam: Family | undefined): { glyph: string; ended?: "divorced" | "separated" } {
  if (!fam) return { glyph: EVENT_GLYPHS.MARR };
  if (fam.raw.children.some((c) => DISSOLUTION_TAGS.has(c.tag))) return { glyph: EVENT_GLYPHS.DIV, ended: "divorced" };
  if (hasChild(fam.raw, "SEPA")) return { glyph: EVENT_GLYPHS.SEPA, ended: "separated" };
  return { glyph: unionMarriage(fam) === "unmarried" ? UNMARRIED_UNION_GLYPH : EVENT_GLYPHS.MARR };
}

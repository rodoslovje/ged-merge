import type { Family, Sex, SourceCitation } from "../../gedcom/types";
import { EDITABLE_FAM_EVENT_TAGS, INDI_EVENT_TAG_ORDER } from "../../gedcom/eventTags";
import type { MatchDecisionStatus } from "../../review/types";

/** Event tags that carry a direct text value on the tag line (e.g. `1 OCCU Farmer`).
 *  Includes the GEDCOM attribute tags and the value-bearing vendor events. */
export const VALUE_EVENT_TAGS = new Set([
  "OCCU", "EDUC", "RETI",
  "TITL", "DSCR", "RELI", "NATI", "NCHI", "REFN",
  "_MILT", "_MILI", "_MEDC",
]);

/** Groups for the "Add event" dropdown — BIRT is always shown so it's excluded.
 * The generic `EVEN` ("Event") and `FACT` live under Estate so they can be
 * added and switched to/from like any other event. */
export const INDIVIDUAL_EVENT_GROUPS = [
  { labelKey: "eventGroup.earlyLife",  tags: ["BAPM", "CHR", "CONF", "ADOP", "FCOM"] },
  { labelKey: "eventGroup.career",     tags: ["OCCU", "EDUC", "GRAD", "RETI", "_MILT"] },
  { labelKey: "eventGroup.attributes", tags: ["TITL", "DSCR", "RELI", "NATI", "NCHI", "_MEDC", "REFN"] },
  { labelKey: "eventGroup.residence",  tags: ["RESI", "EMIG", "IMMI", "NATU", "CENS"] },
  { labelKey: "eventGroup.estate",     tags: ["WILL", "PROB", "EVEN", "FACT"] },
  { labelKey: "eventGroup.death",      tags: ["DEAT", "_FNRL", "BURI", "_INTE", "CREM"] },
] as const;

/** Tags a main individual event's type can be changed to/from (matches
 * `INDIVIDUAL_EVENT_GROUPS`) — BIRT is excluded (always shown separately). */
export const ASSIGNABLE_EVENT_TAGS: Set<string> = new Set(INDIVIDUAL_EVENT_GROUPS.flatMap((g) => g.tags));

/** Family events that are hidden until explicitly added (marriage is always shown). */
export const FAMILY_HIDDEN_EVENT_TAGS = EDITABLE_FAM_EVENT_TAGS.filter((tag) => tag !== "MARR");

/** Family event tags the type-change dropdown can switch between. */
export const FAMILY_EVENT_TAGS = EDITABLE_FAM_EVENT_TAGS;

/** Tags `tag`'s type-change dropdown may switch to: every `FAMILY_EVENT_TAGS`
 * tag not already used by a different event on `fam` (switching into one
 * already in use would silently shadow it, since each family event tag maps
 * to exactly one row), plus `tag` itself. */
export function familyTagChoices(fam: Family, tag: string): string[] {
  return FAMILY_EVENT_TAGS.filter((tg) => tg === tag || !fam.events.some((e) => e.tag === tg));
}

/** Whether a confirmed merge has incoming data for a normally-hidden family
 * event (`<famMergeKeyBase>.<tag>.*`), so the row should show even though the
 * family doesn't have that event yet. */
export function familyEventHasMergeData(
  famMergeKeyBase: string | undefined,
  tag: string,
  mergeHighlight: Map<string, string>,
  mergeIncomingSources: Map<string, SourceCitation[]>,
): boolean {
  if (!famMergeKeyBase) return false;
  const base = `${famMergeKeyBase}.${tag}`;
  const EVENT_SUBS = ["date", "place", "addr", "note", "agency", "type", "cause"] as const;
  if (EVENT_SUBS.some((s) => mergeHighlight.has(`${base}.${s}`))) return true;
  return (mergeIncomingSources.get(`${base}.sources`)?.length ?? 0) > 0;
}

/** Width (in `ch`) that fits `value` (or, while empty, `placeholder`)
 * without the input growing/shrinking awkwardly as the user types — used to
 * keep name fields compact instead of stretching to fill the row. */
export function fieldWidth(value: string, placeholder: string, minLen = 3): string {
  const len = value.length > 0 ? value.length : placeholder.length;
  return `${Math.max(len, minLen) + 3}ch`;
}

/** Display order for extra merge events (tags not yet in main) and secondary
 *  event sort key — the canonical order minus BIRT (always shown separately)
 *  and the generic EVEN (no fixed slot). */
export const EXTRA_EVENT_ORDER = INDI_EVENT_TAG_ORDER.filter((tag) => tag !== "BIRT" && tag !== "EVEN");

export const MATCH_STATUSES: Exclude<MatchDecisionStatus, "undecided">[] = ["confirmed", "rejected", "deferred"];

export const SEX_OPTIONS: Sex[] = ["M", "F", "U"];

/** M/F/U toggle for the individual's `SEX` line. */
export const SEX_GLYPHS: Record<string, string> = { M: "♂", F: "♀", U: "?" };

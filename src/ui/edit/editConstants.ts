import type { Family, Sex, SourceCitation } from "../../gedcom/types";
import type { MatchDecisionStatus } from "../../review/types";

/** Event tags that carry a direct text value on the tag line (e.g. `1 OCCU Farmer`). */
export const VALUE_EVENT_TAGS = new Set(["OCCU", "EDUC", "RETI"]);

/** Groups for the "Add event" dropdown — BIRT is always shown so it's excluded. */
export const INDIVIDUAL_EVENT_GROUPS = [
  { labelKey: "eventGroup.earlyLife", tags: ["BAPM", "CHR", "CONF", "ADOP", "FCOM"] },
  { labelKey: "eventGroup.career",    tags: ["OCCU", "EDUC", "RETI"] },
  { labelKey: "eventGroup.residence", tags: ["RESI", "EMIG", "IMMI", "NATU", "CENS"] },
  { labelKey: "eventGroup.estate",    tags: ["WILL", "PROB"] },
  { labelKey: "eventGroup.death",     tags: ["DEAT", "BURI", "CREM"] },
] as const;

/** Tags a master individual event's type can be changed to/from (matches
 * `INDIVIDUAL_EVENT_GROUPS`) — BIRT and the freeform `EVEN` tag are excluded. */
export const ASSIGNABLE_EVENT_TAGS: Set<string> = new Set(INDIVIDUAL_EVENT_GROUPS.flatMap((g) => g.tags));

/** Family events that are hidden until explicitly added (marriage is always shown). */
export const FAMILY_HIDDEN_EVENT_TAGS = ["ENGA", "SEPA", "DIV"];

/** Family event tags the type-change dropdown can switch between. */
export const FAMILY_EVENT_TAGS = ["MARR", "ENGA", "SEPA", "DIV"];

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

/** Display order for extra merge events (tags not yet in master) and secondary event sort key. */
export const EXTRA_EVENT_ORDER = [
  "BAPM", "CHR", "CONF", "ADOP", "FCOM",
  "OCCU", "EDUC", "RETI",
  "RESI", "EMIG", "IMMI", "NATU", "CENS",
  "WILL", "PROB",
  "DEAT", "BURI", "CREM",
];

export const MATCH_STATUSES: Exclude<MatchDecisionStatus, "undecided">[] = ["confirmed", "rejected", "deferred"];

export const SEX_OPTIONS: Sex[] = ["M", "F", "U"];

/** M/F/U toggle for the individual's `SEX` line. */
export const SEX_GLYPHS: Record<string, string> = { M: "♂", F: "♀", U: "?" };

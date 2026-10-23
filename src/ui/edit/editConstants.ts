import type { Family, Sex, SourceCitation } from "../../gedcom/types";
import { EDITABLE_FAM_EVENT_TAGS, INDI_EVENT_TAG_ORDER } from "../../gedcom/eventTags";
import { EVENT_TEXT_SUBS, type MatchDecisionStatus } from "../../review/types";

export { VALUE_EVENT_TAGS, SECONDARY_VALUE_EVENT_TAGS } from "../../gedcom/eventTags";

/** Groups for the "Add event" dropdown — BIRT is always shown so it's excluded.
 * The generic `EVEN` ("Event") and `FACT` close the menu under Other so they
 * can be added and switched to/from like any other event. A non-standard tag
 * (`isNonStandardTag`) closes its group, after every standard one. */
export const INDIVIDUAL_EVENT_GROUPS = [
  // Life order: the baptisms (a child's, then an adult's) and a blessing, then
  // first communion, confirmation and the bar/bat mitzvah that stand where
  // confirmation does; adoption last, since it is not tied to a point in that
  // sequence.
  { labelKey: "eventGroup.earlyLife",  tags: ["BAPM", "CHR", "CHRA", "BLES", "FCOM", "CONF", "BARM", "BASM", "ADOP"] },
  // An ordination is the entry into a calling, so it sits with the schooling
  // that leads to one.
  { labelKey: "eventGroup.career",     tags: ["OCCU", "EDUC", "GRAD", "ORDN", "RETI", "_MILT"] },
  { labelKey: "eventGroup.attributes", tags: ["TITL", "DSCR", "CAST", "RELI", "NATI", "NCHI", "NMR", "REFN", "IDNO", "SSN", "RACE", "NOBI", "ILL", "_MEDC"] },
  { labelKey: "eventGroup.residence",  tags: ["RESI", "EMIG", "IMMI", "NATU", "CENS"] },
  // What a person owned and the legal acts about it, in life and after it.
  { labelKey: "eventGroup.estate",     tags: ["PROP", "WILL", "PROB", "LATR", "DEED"] },
  // Death, then what becomes of the body in sequence (cremation precedes the
  // laying to rest of the ashes), with the funeral service last.
  { labelKey: "eventGroup.death",      tags: ["DEAT", "CREM", "BURI", "_INTE", "_FNRL"] },
  // The Latter-day Saint ordinances, in the order the church performs them.
  { labelKey: "eventGroup.lds",        tags: ["BAPL", "CONL", "ENDL", "SLGC"] },
  { labelKey: "eventGroup.other",      tags: ["EVEN", "FACT"] },
] as const;

/** Tags a main individual event's type can be changed to/from (matches
 * `INDIVIDUAL_EVENT_GROUPS`) — BIRT is excluded (always shown separately). */
export const ASSIGNABLE_EVENT_TAGS: Set<string> = new Set(INDIVIDUAL_EVENT_GROUPS.flatMap((g) => g.tags));

/** Family event tags — each gets a row only once the family really has that
 * event (or a merge brings one in), and is otherwise offered by the "Add family
 * event" menu. Marriage is no exception: an always-shown empty MARR row claimed
 * an event the file doesn't hold, and its type dropdown could not do anything
 * (retagging needs a node). Also the tags the type-change dropdown switches
 * between. */
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
  if (EVENT_TEXT_SUBS.some((s) => mergeHighlight.has(`${base}.${s}`))) return true;
  return (mergeIncomingSources.get(`${base}.sources`)?.length ?? 0) > 0;
}

/** Width (in `ch`) that fits `value` (or, while empty, `placeholder`)
 * without the input growing/shrinking awkwardly as the user types — used to
 * keep name fields compact instead of stretching to fill the row. */
export function fieldWidth(value: string, placeholder: string, minLen = 3): string {
  const len = value.length > 0 ? value.length : placeholder.length;
  // +4, not a snug +2: the input reserves ~2.5ch on the right for the × clear
  // button (see .clearable-wrap in index.css), which must not cover the text.
  return `${Math.max(len, minLen) + 4}ch`;
}

/** Display order for extra merge events (tags not yet in main) and secondary
 *  event sort key — the canonical order minus BIRT (always shown separately)
 *  and the generic EVEN (no fixed slot). */
export const EXTRA_EVENT_ORDER = INDI_EVENT_TAG_ORDER.filter((tag) => tag !== "BIRT" && tag !== "EVEN");

export const MATCH_STATUSES: Exclude<MatchDecisionStatus, "undecided">[] = ["confirmed", "rejected", "deferred"];

export const SEX_OPTIONS: Sex[] = ["M", "F", "U"];

/** M/F/U toggle for the individual's `SEX` line. */
export const SEX_GLYPHS: Record<string, string> = { M: "♂", F: "♀", U: "?" };

/** The next sex in the picker's own order, wrapping round — what ⌥⇧X sets, so
 *  three presses come back to where they started. A sex the file spells some
 *  other way starts the cycle from the top. */
export function nextSex(current: Sex | undefined): Sex {
  const at = SEX_OPTIONS.indexOf(current as Sex);
  return SEX_OPTIONS[(at + 1) % SEX_OPTIONS.length];
}

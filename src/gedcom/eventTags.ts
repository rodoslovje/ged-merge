/**
 * Single source of truth for GEDCOM event-bearing tags and their canonical
 * life-cycle ordering. The tag sets and display/serialization orders used by
 * the parser lift (`builder`), Edit-mode child ordering (`edit`), CHAN/CREA
 * stamping (`chanCrea`), the edit report (`editReport`) and the review/edit
 * UIs all derive from these lists — add a new event tag here and every
 * consumer picks it up together.
 */

import type { Translate } from "../locales/i18n";
import { firstChild } from "./node";
import type { GedNode } from "./types";
import { UPD_STAMP_TYPE, VENDOR_TAGS, VENDOR_TAG_ALIASES, isInternalEventType, vendorEventTypeInfo } from "./vendorTags";

/** Individual event tags in canonical life-cycle order (birth → … → death).
 *  Includes the GEDCOM attribute tags (TITL, DSCR, RELI, …) — the app models
 *  attributes as value-bearing events, like OCCU — and the Brother's Keeper
 *  vendor events (_MILT military, _MEDC medical, _FNRL funeral, _INTE
 *  interment), which carry the same DATE/PLAC substructure. */
export const INDI_EVENT_TAG_ORDER = [
  "BIRT", "BAPM", "CHR", "FCOM", "CONF", "ADOP",
  "OCCU", "EDUC", "GRAD", "RETI", "_MILT", "_MILI",
  "TITL", "DSCR", "RELI", "NATI", "RACE", "NCHI", "NOBI", "LATR", "DEED", "_MEDC", "ILL",
  "RESI", "EMIG", "IMMI", "NATU", "CENS",
  "WILL", "PROB",
  "EVEN", "FACT", "REFN",
  "DEAT", "CREM", "BURI", "_INTE", "_FNRL",
];

/** Family event tags in canonical order. `EVEN` is the generic custom event
 *  (named by its `TYPE`, e.g. "Civil Partnership"). `_MSTAT` is the canonical
 *  partnership-status tag (Brother's Keeper vocabulary — "Partners", …) that
 *  normalization consolidates the other vendor encodings into. */
export const FAM_EVENT_TAG_ORDER = ["MARR", "ENGA", "SEPA", "MARB", "MARL", "DIV", "EVEN", "_MSTAT"];

/**
 * Classic genealogy symbols for the event types that have one — language-
 * neutral, so they need no translation: * born, ~ baptized, ⚭ married,
 * † died, ▭ buried, ⌂ residence, →/← emigrated/immigrated. The union marks
 * come from Unicode's own genealogy block (U+26AC…U+26AF: ⚬ betrothed,
 * ⚭ married, ⚮ divorced, ⚯ unmarried partnership), which is where a reader of
 * German or Slovenian parish registers already expects to find them.
 *
 * Two marks are conventions of this app rather than of the craft: no symbol
 * exists for occupation or education, and ⚒ and the graduation cap are the
 * closest widely understood ones. The cap carries U+FE0E after it, the text
 * presentation selector: it is an emoji codepoint, and without that the system
 * would draw its own colour emoji instead of the plain outline the subset in
 * `theme/fonts.css` serves. (A pencil read as education in the reports, but in
 * the app ✎ is the button that edits a record, and a mark that looks like the
 * control beside it is worse than an approximate symbol.)
 * A tag with no honest mark is left out on purpose — the
 * UI draws those as a neutral dot and the charts as their generic one, rather
 * than inventing a symbol nobody reads.
 *
 * One map for every surface — the Timeline marks, the text reports' fact
 * lines, the Edit event rows and the place worklists — so an event type is
 * drawn the same way wherever it appears. The glyphs outside the Latin-1
 * range are carried by the subset in `theme/fonts.css`, so they render
 * identically on every platform instead of falling to a system font.
 */
export const EVENT_GLYPHS: Record<string, string> = {
  BIRT: "*",
  BAPM: "~",
  CHR: "~",
  ENGA: "⚬",
  MARR: "⚭",
  DIV: "⚮",
  _MSTAT: "⚯",
  DEAT: "†",
  BURI: "▭",
  CREM: "⚱",
  RESI: "⌂",
  OCCU: "⚒",
  EDUC: "🎓︎",
  EMIG: "→",
  IMMI: "←",
  NATU: "⚑",
  CENS: "▤",
  WILL: "§",
  PROB: "§",
  LATR: "§",
  DEED: "§",
};

/** The mark an event tag is drawn with, or the neutral one for a tag the
 *  vocabulary has no symbol for — a dot says "an event happened here" without
 *  claiming to say which, and the name always travels with it in a tooltip. */
export const GENERIC_EVENT_GLYPH = "·";

/** Distinct tags in canonical life-cycle order — a person's events before a
 *  family's, each in its own order, and anything unknown at the end in the
 *  order it arrived. What a list of glyphs beside a name is sorted by, so the
 *  same set of events always reads the same way round. */
export function orderedEventTags(tags: Iterable<string>): string[] {
  const rank = (tag: string) => {
    const indi = INDI_EVENT_TAG_ORDER.indexOf(tag);
    if (indi >= 0) return indi;
    const fam = FAM_EVENT_TAG_ORDER.indexOf(tag);
    return fam >= 0 ? INDI_EVENT_TAG_ORDER.length + fam : Number.MAX_SAFE_INTEGER;
  };
  return [...new Set(tags)]
    .map((tag, i) => ({ tag, i }))
    .sort((a, b) => rank(a.tag) - rank(b.tag) || a.i - b.i)
    .map((e) => e.tag);
}

/**
 * Localized display name for an event tag. Non-standard (`_`-prefixed vendor)
 * tags get the raw tag appended — "Funeral (_FNRL)" — so they read apart from
 * similarly named standard events (BURI "Burial"). `fallback` replaces the
 * default untranslated-name fallback (the tag itself).
 */
export function eventDisplayLabel(tag: string, t: Translate, fallback?: string): string {
  const name = t(`event.${tag}`, { defaultValue: fallback ?? tag });
  return tag.startsWith("_") && name !== tag ? `${name} (${tag})` : name;
}

/**
 * True for an `EVEN`/`FACT` node that records software bookkeeping instead of
 * a fact about the person — MyHeritage writes its last-touched stamp as
 * `1 EVEN 31 JAN 2020 13:12:03 GMT -0500` + `2 TYPE _UPD`, the event spelling
 * of its `_UPD` tag. These are not lifted into the typed `events`, so they
 * never reach the event list, the charts or the reports; the raw line tree
 * keeps them, and `stampChanCrea` refreshes them like a CHAN.
 */
export function isChangeStampEvent(node: GedNode): boolean {
  if (node.tag !== "EVEN" && node.tag !== "FACT") return false;
  return isInternalEventType(firstChild(node, "TYPE")?.value);
}

/** The event nodes of an `INDI` record, in file order — exactly the nodes
 *  the builder lifts into `Individual.events`, so an index into `events`
 *  addresses the same node here. Every consumer that maps an event index
 *  back to its raw node must go through this, not filter `INDI_EVENT_TAGS`
 *  itself: a MyHeritage change stamp (`EVEN` + `TYPE _UPD`) carries an event
 *  tag but is *not* an event, and a filter that keeps it shifts every index
 *  after it by one — an edit or delete then lands on the neighbouring event. */
export function indiEventNodes(record: GedNode): GedNode[] {
  return record.children.filter((c) => INDI_EVENT_TAGS.has(c.tag) && !isChangeStampEvent(c));
}

/** Family-record twin of {@link indiEventNodes}. */
export function famEventNodes(record: GedNode): GedNode[] {
  return record.children.filter((c) => FAM_EVENT_TAGS.has(c.tag) && !isChangeStampEvent(c));
}

/** The `_UPD` change stamp on a record, in whichever of MyHeritage's two
 *  spellings the record uses: the `_UPD` tag, or the `EVEN` above. */
export function changeStampNode(record: GedNode): GedNode | undefined {
  return record.children.find((c) => c.tag === UPD_STAMP_TYPE || isChangeStampEvent(c));
}

/**
 * Display name for a custom event (`EVEN`/`FACT`), which is named by its
 * `TYPE` rather than by its tag. A type the user wrote ("Twin", "Comment") is
 * its own label. Two kinds are not readable as they stand, and both get the
 * name that fits with the raw value kept in parentheses — the same shape
 * `eventDisplayLabel` uses for vendor tags, so the row never hides what the
 * file actually says:
 *
 * - a program's namespaced type → the registry's name and the producing
 *   software, "Partners (MyHeritage)" for `MYHERITAGE:REL_PARTNERS`;
 * - a standard event tag used as the type — MyHeritage writes a person's
 *   marriage as `1 EVEN` + `2 TYPE MARR` — → that event's own name,
 *   "Marriage (MARR)".
 *
 * Returns "" for an untyped event, leaving the caller's generic "Event" label.
 */
export function customEventLabel(type: string | undefined, t: Translate, lang: string): string {
  const raw = type?.trim() ?? "";
  if (!raw) return "";
  const info = vendorEventTypeInfo(raw);
  if (info) {
    const label = lang.startsWith("sl") ? info.label.sl : info.label.en;
    return `${label} (${info.software})`;
  }
  // EVEN/FACT themselves say nothing a generic label doesn't already say.
  const tag = raw.toUpperCase();
  if (ALL_EVENT_TAGS.has(tag) && tag !== "EVEN" && tag !== "FACT") {
    const name = t(`event.${tag}`, { defaultValue: "" });
    if (name) return `${name} (${tag})`;
  }
  return raw;
}

/**
 * Tooltip for a custom event whose `TYPE` the registry knows — naming the raw
 * value, since the row no longer shows it. Undefined for a user-written type,
 * whose label already says everything the value does.
 */
export function customEventTooltip(type: string | undefined, t: Translate, lang: string): string | undefined {
  const raw = type?.trim() ?? "";
  const info = vendorEventTypeInfo(raw);
  if (!info) return undefined;
  const meaning = lang.startsWith("sl") ? info.meaning.sl : info.meaning.en;
  return t("event.vendorTypeTooltip", { type: raw, software: info.software, meaning });
}

/**
 * Tooltip explaining a vendor event's origin — "Non-standard tag _FNRL
 * (Brother's Keeper): funeral" — or undefined for standard tags.
 */
export function vendorEventTooltip(tag: string, t: Translate, lang: string): string | undefined {
  if (!tag.startsWith("_")) return undefined;
  const info = VENDOR_TAGS[tag] ?? VENDOR_TAGS[VENDOR_TAG_ALIASES[tag]];
  if (!info) return t("event.vendorTooltip", { tag });
  const meaning = lang.startsWith("sl") ? info.meaning.sl : info.meaning.en;
  return t("event.vendorTooltip.known", { tag, software: info.software, meaning });
}

/** Event-bearing INDI children lifted into the typed `events` array. Includes
 *  MARR: some exports write a marriage event directly on the individual. */
export const INDI_EVENT_TAGS: Set<string> = new Set([...INDI_EVENT_TAG_ORDER, "MARR"]);

/** Event-bearing FAM children lifted into the typed `events` array. */
export const FAM_EVENT_TAGS: Set<string> = new Set(FAM_EVENT_TAG_ORDER);

/** Every event-bearing tag on either record kind. */
export const ALL_EVENT_TAGS: Set<string> = new Set([...INDI_EVENT_TAGS, ...FAM_EVENT_TAGS]);

/** Family events Edit mode can create and edit (MARB/MARL are preserved on
 *  load/save but not surfaced), and therefore the ones the edit report diffs.
 *  Like the other tags here, `EVEN` is modelled as one row per family — a
 *  second `EVEN` on the same FAM round-trips untouched but isn't editable. */
export const EDITABLE_FAM_EVENT_TAGS = ["MARR", "ENGA", "SEPA", "DIV", "EVEN", "_MSTAT"];

/** Event tags that carry a direct text value on the tag line
 *  (e.g. `1 OCCU Farmer`, `1 _MSTAT Partners`) — shown/edited as an inline
 *  value field and compared as a `.value` row. */
export const VALUE_EVENT_TAGS: Set<string> = new Set([
  "OCCU", "EDUC", "RETI",
  "TITL", "DSCR", "RELI", "NATI", "RACE", "NCHI", "NOBI", "LATR", "DEED", "ILL", "REFN",
  "RESI",
  "_MILT", "_MILI", "_MEDC",
  "_MSTAT",
]);

/** Value-bearing tags whose value is *supplementary* rather than the event's
 *  substance. An occupation is its value ("Farmer"), so that value leads the
 *  row; a residence reads as a date and a place, and its value line — where
 *  many exporters write the street address (`1 RESI Bojanja vas 17, Metlika`)
 *  — belongs beside them on the extras line, not in the headline slot. */
export const SECONDARY_VALUE_EVENT_TAGS: Set<string> = new Set(["RESI"]);

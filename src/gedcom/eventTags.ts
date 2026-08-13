/**
 * Single source of truth for GEDCOM event-bearing tags and their canonical
 * life-cycle ordering. The tag sets and display/serialization orders used by
 * the parser lift (`builder`), Edit-mode child ordering (`edit`), CHAN/CREA
 * stamping (`chanCrea`), the edit report (`editReport`) and the review/edit
 * UIs all derive from these lists — add a new event tag here and every
 * consumer picks it up together.
 */

import type { Translate } from "../locales/i18n";
import { VENDOR_TAGS, VENDOR_TAG_ALIASES, vendorEventTypeInfo } from "./vendorTags";

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

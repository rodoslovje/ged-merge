/**
 * Single source of truth for GEDCOM event-bearing tags and their canonical
 * life-cycle ordering. The tag sets and display/serialization orders used by
 * the parser lift (`builder`), Edit-mode child ordering (`edit`), CHAN/CREA
 * stamping (`chanCrea`), the edit report (`editReport`) and the review/edit
 * UIs all derive from these lists — add a new event tag here and every
 * consumer picks it up together.
 */

/** Individual event tags in canonical life-cycle order (birth → … → death). */
export const INDI_EVENT_TAG_ORDER = [
  "BIRT", "BAPM", "CHR", "CONF", "ADOP", "FCOM",
  "OCCU", "EDUC", "RETI",
  "RESI", "EMIG", "IMMI", "NATU", "CENS",
  "WILL", "PROB",
  "EVEN",
  "DEAT", "BURI", "CREM",
];

/** Family event tags in canonical order. */
export const FAM_EVENT_TAG_ORDER = ["MARR", "ENGA", "SEPA", "MARB", "MARL", "DIV"];

/** Event-bearing INDI children lifted into the typed `events` array. Includes
 *  MARR: some exports write a marriage event directly on the individual. */
export const INDI_EVENT_TAGS: Set<string> = new Set([...INDI_EVENT_TAG_ORDER, "MARR"]);

/** Event-bearing FAM children lifted into the typed `events` array. */
export const FAM_EVENT_TAGS: Set<string> = new Set(FAM_EVENT_TAG_ORDER);

/** Every event-bearing tag on either record kind. */
export const ALL_EVENT_TAGS: Set<string> = new Set([...INDI_EVENT_TAGS, ...FAM_EVENT_TAGS]);

/** Family events Edit mode can create and edit (MARB/MARL are preserved on
 *  load/save but not surfaced), and therefore the ones the edit report diffs. */
export const EDITABLE_FAM_EVENT_TAGS = ["MARR", "ENGA", "SEPA", "DIV"];
